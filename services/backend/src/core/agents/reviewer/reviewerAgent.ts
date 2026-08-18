import type { Agent, AgentRuntimeContext, ResearchResult, ReviewResult } from "@mdai/shared-types";
import type { BackendAgentRuntimeContext } from "../runtimeContext.js";
import { extractJson } from "../structuredOutput.js";

const SYSTEM_PROMPT = `You are the Reviewer inside MD AI, a private personal AI system.

You validate another agent's structured research result before it reaches
the user. You do not do research yourself and you do not soften or hide
problems to be agreeable — your only job is honest quality control.

Check the given research result for:
- completeness: does it actually address the stated objective?
- schema validity: does every finding have a real, non-empty claim?
- contradictions: do any findings conflict with each other?
- unsupported claims: is anything labeled "fact" that should really be "assumption" or "uncertain"?
- missing evidence: are there claims that need a "source" but have none, without that gap being disclosed as a limitation?
- hallucination risk: any suspiciously specific claim (exact numbers, named sources) despite the agent having no real tool access?

Respond with ONLY a JSON object of this exact shape:
{
  "decision": "APPROVE" | "REVISE" | "REJECT",
  "issues": [ { "type": "incomplete" | "schema_invalid" | "contradiction" | "unsupported_claim" | "missing_evidence" | "hallucination_risk", "description": "<specific, short>" } ],
  "summary": "<one or two sentences, safe to show the user>"
}

Rules:
- APPROVE only if there are no issues at all, or only trivial ones that don't affect trustworthiness.
- REVISE if there are fixable issues (e.g. missing disclosure, a mislabeled finding) — the research agent will get one chance to address your feedback.
- REJECT only if the result is fundamentally unusable (empty, off-topic, or dominated by unsupported/hallucinated claims).
- Output ONLY the JSON object, no prose before or after.`;

export function createReviewerAgent(): Agent {
  return {
    card: {
      id: "reviewer",
      displayName: "Reviewer",
      description: "Validates another agent's structured output — completeness, schema, contradictions, unsupported claims. Never reviews its own output.",
      version: "0.1.0",
      capabilities: ["review"],
      supportedTaskTypes: ["review"],
      isInternal: true,
      modelPreferences: { taskCategory: "reasoning" },
      toolRequirements: [],
      status: "idle",
    },

    async handleTask(ctx: AgentRuntimeContext): Promise<void> {
      const backendCtx = ctx as BackendAgentRuntimeContext;
      const input = backendCtx.task.input as { targetTaskId?: string; targetAgentId?: string; result?: ResearchResult };

      // Structural guard against the one thing M3.5 explicitly forbids:
      // a Reviewer task must never target output the Reviewer itself produced.
      if (input.targetAgentId === "reviewer") {
        await backendCtx.finishFailure({
          code: "reviewer_cannot_review_self",
          message: "Refused: a Reviewer task cannot target another Reviewer task's output.",
          retryable: false,
        });
        return;
      }

      if (!input.result || !Array.isArray(input.result.findings)) {
        await backendCtx.finishFailure({
          code: "missing_review_target",
          message: "No structured result was provided to review.",
          retryable: false,
        });
        return;
      }

      await backendCtx.publishEvent({ type: "review.started", taskId: backendCtx.task.id, targetTaskId: input.targetTaskId ?? "" });
      backendCtx.emit({ taskId: backendCtx.task.id, kind: "agent_progress", label: "Reviewer validating…" });

      const { text, modelId } = await backendCtx.completeChat({
        taskCategory: "reasoning",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Research result to review:\n${JSON.stringify(input.result, null, 2)}` },
        ],
      });

      const parsed = extractJson<ReviewResult>(text);
      const result: ReviewResult = parsed && ["APPROVE", "REVISE", "REJECT"].includes(parsed.decision)
        ? { decision: parsed.decision, issues: parsed.issues ?? [], summary: parsed.summary ?? "" }
        : {
            decision: "REVISE",
            issues: [{ type: "schema_invalid", description: "Reviewer model did not return a well-formed verdict." }],
            summary: "Review could not be completed cleanly; treating as needing revision to be safe.",
          };

      await backendCtx.publishEvent({
        type: "review.completed",
        taskId: backendCtx.task.id,
        targetTaskId: input.targetTaskId ?? "",
        decision: result.decision,
      });

      await backendCtx.finishSuccess(result as unknown as Record<string, unknown>, modelId);
    },

    async healthCheck() {
      return { healthy: true };
    },
  };
}
