import type {
  Agent,
  AgentRegistry,
  AgentRuntimeContext,
  ChatMessage,
  MemoryCategory,
  MemoryEngine,
  ResearchResult,
  ReviewResult,
  RoutingMode,
  TaskCategory,
} from "@mdai/shared-types";
import type { BackendAgentRuntimeContext } from "../runtimeContext.js";
import { TaskCanceledError } from "../errors.js";
import { classifyIntent } from "./intentClassifier.js";

export interface MasterAgentDeps {
  agentRegistry: AgentRegistry;
  memoryEngine: MemoryEngine;
}

export interface MasterTaskInput {
  currentUserText?: string;
  conversationMessages?: ChatMessage[];
  preferredProviderId?: string;
  preferredModelId?: string;
  taskCategory?: TaskCategory;
  routingMode?: RoutingMode;
}

const SYSTEM_PROMPT =
  "You are the Master Agent inside MD AI, a private single-user personal intelligence system. " +
  "Answer directly and concisely. You are speaking with your one owner, not the public. " +
  "If a note below tells you research findings were gathered or that a capability is unavailable, use that information honestly — never claim access you don't have.";

/** Bounded revision loop: an initial research attempt plus at most one revision, per docs/architecture/04-agent-interfaces.md §7. */
const MAX_RESEARCH_ATTEMPTS = 2;

function isMemoryCategory(value: string): value is MemoryCategory {
  return (
    [
      "personal_context",
      "projects",
      "goals",
      "preferences",
      "decisions",
      "research",
      "knowledge",
      "conversations",
      "agent_lessons",
    ] as string[]
  ).includes(value);
}

/**
 * M3.2 Master Agent: real orchestrator. Classifies intent, retrieves
 * relevant memory context, handles explicit remember/forget commands,
 * delegates to a capability-matched specialist (Research today) with a
 * bounded Reviewer revision loop, then synthesizes and streams the final
 * answer. Every delegation and review step goes through the shared
 * `AgentRuntimeContext`/A2A task lifecycle — Master never calls another
 * agent's code directly.
 */
export function createMasterAgent(deps: MasterAgentDeps): Agent {
  return {
    card: {
      id: "master",
      displayName: "Master Agent",
      description:
        "Primary orchestrator and default chat surface. Classifies intent, delegates to specialist agents by capability, synthesizes final responses.",
      version: "0.2.0",
      capabilities: ["chat", "general-qa", "orchestration"],
      supportedTaskTypes: ["chat"],
      isInternal: true,
      modelPreferences: { taskCategory: "chat" },
      toolRequirements: [],
      status: "idle",
    },

    async handleTask(ctx: AgentRuntimeContext): Promise<void> {
      const backendCtx = ctx as BackendAgentRuntimeContext;
      const input = backendCtx.task.input as MasterTaskInput;
      const userText = (input.currentUserText ?? "").trim();
      const conversationMessages = input.conversationMessages ?? [];

      if (!userText) {
        await backendCtx.finishFailure({ code: "empty_message", message: "No message text was provided.", retryable: false });
        return;
      }

      try {
        await backendCtx.start();
        backendCtx.emit({ taskId: backendCtx.task.id, kind: "agent_progress", label: "Thinking…" });

        // ---- M3.7: context retrieval — relevant memories only, never the whole DB ----
        const notes: string[] = [];
        try {
          const relevant = await deps.memoryEngine.search({ query: userText, topK: 5 });
          if (relevant.length > 0) {
            notes.push(
              "Relevant memory (use only if actually helpful; do not recite this list mechanically):\n" +
                relevant.map((m) => `- [${m.category}] ${m.content}`).join("\n"),
            );
            await backendCtx.publishEvent({
              type: "memory.retrieved",
              taskId: backendCtx.task.id,
              count: relevant.length,
              memoryIds: relevant.map((m) => m.id),
            });
          }
        } catch {
          // Memory retrieval must never break chat — degrade to no extra context.
        }

        // ---- M3.2/M3.6: intent classification (capability-based, dynamic) ----
        const delegationOptions = await deps.agentRegistry.getDelegationOptions("master");
        const classifiableCapabilities = [
          ...new Set(delegationOptions.flatMap((c) => c.capabilities).filter((cap) => cap !== "review")),
        ];
        const classification = await classifyIntent(backendCtx, userText, conversationMessages, classifiableCapabilities);

        // ---- explicit "Remember this." / "Forget this." commands ----
        if (classification.memoryCommand?.action === "remember") {
          const item = await deps.memoryEngine.write({
            category: "personal_context",
            content: classification.memoryCommand.content ?? userText,
            source: "user_command",
            sourceTaskId: backendCtx.task.id,
            approvalStatus: "approved",
          });
          await backendCtx.publishEvent({
            type: "memory.created",
            memoryId: item.id,
            category: item.category,
            approvalStatus: item.approvalStatus,
          });
          notes.push(`You just stored this in memory at the user's explicit request: "${item.content}". Confirm this naturally.`);
        } else if (classification.memoryCommand?.action === "forget") {
          const target = classification.memoryCommand.content ?? "";
          const matches = target ? await deps.memoryEngine.search({ query: target, topK: 1 }) : [];
          const match = matches[0];
          if (match) {
            await deps.memoryEngine.forget(match.id);
            notes.push(`You just deleted this memory at the user's explicit request: "${match.content}". Confirm this naturally.`);
          } else {
            notes.push("The user asked you to forget something, but no matching stored memory was found. Say so honestly.");
          }
        }

        // ---- system-proposed memory candidate: stored pending, never auto-approved ----
        if (classification.memoryCandidate && isMemoryCategory(classification.memoryCandidate.category)) {
          const item = await deps.memoryEngine.write({
            category: classification.memoryCandidate.category,
            content: classification.memoryCandidate.content,
            confidence: classification.memoryCandidate.confidence,
            source: "system_proposed",
            sourceTaskId: backendCtx.task.id,
            approvalStatus: "pending",
          });
          await backendCtx.publishEvent({
            type: "memory.created",
            memoryId: item.id,
            category: item.category,
            approvalStatus: "pending",
          });
        }

        // ---- delegation: capability-matched specialist + bounded Reviewer loop ----
        if (classification.delegate && classification.capability && classification.taskObjective) {
          const candidates = await deps.agentRegistry.findByCapability(classification.capability);
          if (candidates.length === 0) {
            notes.push(
              `The user's request needed the "${classification.capability}" capability, but no agent offering it is currently available. Say so honestly rather than pretending to have done the work.`,
            );
          } else {
            const targetAgentId = candidates[0]!.id;
            let researchResult: ResearchResult | undefined;
            let reviewerFeedback: string | undefined;
            let attempt = 0;

            while (attempt < MAX_RESEARCH_ATTEMPTS) {
              attempt++;
              const childTask = await backendCtx.delegate(
                targetAgentId,
                { objective: classification.taskObjective, reviewerFeedback },
                "research",
              );

              if (childTask.state !== "completed" || !childTask.output) {
                notes.push(
                  `The ${targetAgentId} agent could not complete this: ${childTask.error?.message ?? "unknown error"}. Be honest with the user about this limitation.`,
                );
                researchResult = undefined;
                break;
              }

              const candidateResult = childTask.output as unknown as ResearchResult;

              const reviewTask = await backendCtx.delegate(
                "reviewer",
                { targetTaskId: childTask.id, targetAgentId, result: candidateResult },
                "review",
              );

              if (reviewTask.state !== "completed" || !reviewTask.output) {
                notes.push(
                  "The findings below were not reviewed (the Reviewer agent could not complete validation) — disclose this to the user.",
                );
                researchResult = candidateResult;
                break;
              }

              const review = reviewTask.output as unknown as ReviewResult;

              if (review.decision === "APPROVE") {
                researchResult = candidateResult;
                break;
              }
              if (review.decision === "REJECT") {
                notes.push(
                  `Research was attempted for this request but reviewed and rejected as unreliable: ${review.summary} Do not present it as fact — be honest that you don't have a trustworthy answer.`,
                );
                researchResult = undefined;
                break;
              }

              // REVISE: one more attempt with the reviewer's feedback, if attempts remain.
              reviewerFeedback = review.issues.map((i) => `${i.type}: ${i.description}`).join("; ") || review.summary;
              if (attempt >= MAX_RESEARCH_ATTEMPTS) {
                notes.push(
                  `Research needed further revision but the revision limit was reached. Reviewer's last feedback: ${review.summary} Disclose this uncertainty to the user.`,
                );
                researchResult = candidateResult;
              }
            }

            if (researchResult) {
              const findingsText = researchResult.findings.map((f) => `- (${f.kind}) ${f.claim}`).join("\n");
              const limitationsText =
                researchResult.limitations.length > 0 ? `\nLimitations: ${researchResult.limitations.join("; ")}` : "";
              notes.push(
                `Research findings gathered for this request:\n${findingsText}${limitationsText}\nUse these to inform your answer where relevant. Do not claim live web access — these come from the Research Agent's own model knowledge.`,
              );
            }
          }
        }

        // ---- synthesis: stream the final answer with the user's actual routing preference ----
        const messages: ChatMessage[] =
          conversationMessages.length > 0
            ? conversationMessages.map((m) => ({ ...m }))
            : [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userText }];

        if (messages[0]?.role === "system" && notes.length > 0) {
          messages[0] = { ...messages[0], content: `${messages[0].content}\n\n${notes.join("\n\n")}` };
        } else if (notes.length > 0) {
          messages.splice(messages.length - 1, 0, { role: "system", content: notes.join("\n\n") });
        }

        const { text, modelId, providerId } = await backendCtx.streamChat({
          messages,
          taskCategory: input.taskCategory,
          preferredProviderId: input.preferredProviderId,
          preferredModelId: input.preferredModelId,
          routingMode: input.routingMode,
        });

        await backendCtx.addAssistantMessage(text);
        await backendCtx.finishSuccess({ text, modelId, providerId }, modelId);
      } catch (err) {
        if (err instanceof TaskCanceledError) {
          await backendCtx.finishCanceled("canceled by user");
          return;
        }
        const error = err as Error;
        await backendCtx.finishFailure({ code: error.name || "master_agent_error", message: error.message, retryable: false });
        throw err;
      }
    },

    async healthCheck() {
      return { healthy: true };
    },
  };
}
