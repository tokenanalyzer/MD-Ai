import type pg from "pg";
import type { ChatMessage, ModelRegistry, RoutingCriteria } from "@mdai/shared-types";
import { resolveRoutingDecision } from "./resolveRoutingDecision.js";
import { streamChatWithFallback } from "./modelRouter.js";

export interface CompleteChatResult {
  text: string;
  modelId: string;
  providerId: string;
}

/**
 * Non-streaming chat completion for callers that need one finished answer
 * — agents producing structured JSON (Research, Reviewer, Master's intent
 * classifier) rather than a token stream to the user. Reuses the exact
 * same routing/retry/fallback/telemetry path as the streaming chat pipeline
 * (`docs/architecture/06-provider-model-interfaces.md` §4) — it just
 * drains the generator instead of yielding through it.
 */
export async function completeChatOnce(
  pool: pg.Pool,
  modelRegistry: ModelRegistry,
  providerKeys: Record<string, string>,
  criteria: RoutingCriteria,
  messages: ChatMessage[],
): Promise<CompleteChatResult> {
  const decision = await resolveRoutingDecision(pool, modelRegistry, criteria);

  let text = "";
  let modelId = decision.modelId;
  let providerId = decision.providerId;

  for await (const chunk of streamChatWithFallback({
    decision,
    providerKeys,
    messages,
    onCallSample: (sample) => {
      void modelRegistry.recordCallSample({
        modelId: sample.modelId,
        providerId: sample.providerId,
        latencyMs: sample.latencyMs,
        success: sample.success,
        errorCode: sample.errorCode,
        taskCategory: criteria.taskCategory,
        timedOut: sample.timedOut,
        usedAsFallback: sample.usedAsFallback,
        inputTokens: sample.inputTokens,
        outputTokens: sample.outputTokens,
        responseStatus: sample.responseStatus,
      });
    },
  })) {
    if (chunk.delta) text += chunk.delta;
    modelId = chunk.modelId;
    providerId = chunk.providerId;
  }

  return { text, modelId, providerId };
}
