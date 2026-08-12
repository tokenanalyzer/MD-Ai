import type { Agent, AgentRuntimeContext, ResearchResult } from "@mdai/shared-types";
import type { BackendAgentRuntimeContext } from "../runtimeContext.js";
import { extractJson } from "../structuredOutput.js";
import { ToolNotAvailableError } from "../../mcp/errors.js";

const SYSTEM_PROMPT = `You are the Research Agent inside MD AI, a private personal AI system.

You have NO live web access and NO connected tools in this version of the system.
You must never claim to have searched the web, browsed a page, or verified
a claim against a live source. Everything you produce comes from your own
training knowledge only, which may be outdated or incomplete.

Given a research objective, respond with ONLY a JSON object of this exact shape:
{
  "objective": "<restated objective>",
  "findings": [
    { "claim": "<a specific claim>", "kind": "fact" | "assumption" | "uncertain", "source": null }
  ],
  "limitations": ["<honest capability gaps, e.g. 'web_search_unavailable — findings are from model knowledge only, not verified against current sources'>"],
  "toolsUsed": []
}

Rules:
- "source" must always be null unless you were given actual retrieved tool output to cite (you were not, in this version).
- Label every finding "fact" only for well-established, stable knowledge you are highly confident in. Use "assumption" for reasonable inference. Use "uncertain" for anything you are not confident about or that may have changed since your training.
- Always include at least one entry in "limitations" disclosing the lack of live tool/web access.
- Do not fabricate sources, statistics, or citations.
- Output ONLY the JSON object, no prose before or after.`;

export function createResearchAgent(): Agent {
  return {
    card: {
      id: "research",
      displayName: "Research Agent",
      description:
        "Gathers and structures findings for a stated research objective, honestly disclosing when no live tool/web access is connected.",
      version: "0.1.0",
      capabilities: ["research"],
      supportedTaskTypes: ["research"],
      isInternal: true,
      modelPreferences: { taskCategory: "research" },
      toolRequirements: ["web.search"],
      status: "idle",
    },

    async handleTask(ctx: AgentRuntimeContext): Promise<void> {
      const backendCtx = ctx as BackendAgentRuntimeContext;
      const objective = String(backendCtx.task.input["objective"] ?? "").trim();

      backendCtx.emit({ taskId: backendCtx.task.id, kind: "agent_progress", label: "Research Agent gathering findings…" });

      if (!objective) {
        await backendCtx.finishFailure({
          code: "missing_objective",
          message: "No research objective was provided.",
          retryable: false,
        });
        return;
      }

      // Tool-ready wiring for M4: this call is real, not decorative — it
      // will succeed once an MCP host is connected. Today it always throws
      // ToolNotAvailableError, and that's reported honestly, not hidden.
      const toolLimitations: string[] = [];
      try {
        await backendCtx.callTool("web.search", { query: objective });
      } catch (err) {
        if (err instanceof ToolNotAvailableError) {
          toolLimitations.push(
            "web_search_unavailable — no MCP tool host is connected yet; findings below are from model knowledge only, not live sources.",
          );
        } else {
          throw err;
        }
      }

      let revisionNote = "";
      const priorFeedback = backendCtx.task.input["reviewerFeedback"];
      if (typeof priorFeedback === "string" && priorFeedback.trim()) {
        revisionNote = `\n\nA reviewer previously flagged issues with an earlier attempt at this objective: ${priorFeedback}\nRevise your findings to address this feedback directly.`;
      }

      const { text } = await backendCtx.completeChat({
        taskCategory: "research",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Research objective: ${objective}${revisionNote}` },
        ],
      });

      const parsed = extractJson<ResearchResult>(text);
      if (!parsed || !Array.isArray(parsed.findings) || typeof parsed.objective !== "string") {
        await backendCtx.finishFailure({
          code: "research_output_invalid",
          message: "The research model did not return a well-formed structured result.",
          retryable: true,
        });
        return;
      }

      const result: ResearchResult = {
        objective: parsed.objective || objective,
        findings: parsed.findings,
        limitations: [...new Set([...(parsed.limitations ?? []), ...toolLimitations])],
        toolsUsed: parsed.toolsUsed ?? [],
      };

      await backendCtx.finishSuccess(result as unknown as Record<string, unknown>);
    },

    async healthCheck() {
      return { healthy: true };
    },
  };
}
