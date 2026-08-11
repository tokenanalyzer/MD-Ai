import type { ChatMessage, ChatResponseChunk, ModelProvider, RoutingCriteria, RoutingDecision } from "@mdai/shared-types";
import { getProviderAdapter, PROVIDER_DEFAULT_MODELS } from "../providers/registry.js";
import { getCircuitBreaker } from "./circuitBreaker.js";
import { ProviderCallError } from "../providers/errors.js";

export class NoAvailableModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoAvailableModelError";
  }
}

/**
 * M1 deterministic router (docs/architecture/06-provider-model-interfaces.md
 * §4.1). Every candidate must come from `criteria.availableProviderIds` —
 * the router has no stored credential to fall back on
 * (docs/architecture/07-security-model.md §3).
 */
export function selectModel(criteria: RoutingCriteria): RoutingDecision {
  if (criteria.availableProviderIds.length === 0) {
    throw new NoAvailableModelError("No provider key supplied for this request");
  }

  let primaryProviderId: string;
  let reason: RoutingDecision["reason"];

  const preferredProviderFromModel =
    criteria.preferredModelId && criteria.availableProviderIds.find((p) => criteria.preferredModelId?.startsWith(`${p}/`));

  if (preferredProviderFromModel) {
    primaryProviderId = preferredProviderFromModel;
    reason = "user_override";
  } else if (criteria.preferredProviderId && criteria.availableProviderIds.includes(criteria.preferredProviderId)) {
    primaryProviderId = criteria.preferredProviderId;
    reason = "user_default";
  } else {
    primaryProviderId = criteria.availableProviderIds[0] as string;
    reason = "capability_match";
  }

  const fallbackChain = criteria.availableProviderIds.filter((p) => p !== primaryProviderId);
  const modelId =
    criteria.preferredModelId?.startsWith(`${primaryProviderId}/`)
      ? criteria.preferredModelId
      : `${primaryProviderId}/${PROVIDER_DEFAULT_MODELS[primaryProviderId] ?? "default"}`;

  return { modelId, providerId: primaryProviderId, reason, fallbackChain };
}

interface RetryPolicy {
  maxAttemptsPerProvider: number;
  baseDelayMs: number;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttemptsPerProvider: 2, baseDelayMs: 300 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredDelay(attempt: number, base: number): number {
  return base * attempt + Math.random() * base;
}

export interface StreamedChunk extends ChatResponseChunk {
  providerId: string;
  modelId: string;
}

export interface StreamChatWithFallbackInput {
  criteria: RoutingCriteria;
  providerKeys: Record<string, string>;
  messages: ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  retryPolicy?: RetryPolicy;
  getProvider?: (id: string) => ModelProvider | undefined;
  onModelSelected?: (decision: RoutingDecision) => void;
  onModelSwitched?: (from: string, to: string, reason: string) => void;
  onCallSample?: (sample: { modelId: string; providerId: string; latencyMs: number; success: boolean; errorCode?: string }) => void;
}

/**
 * Selects a model, then executes the chat call with per-provider retry,
 * circuit breaking, and fallback across the rest of the caller's supplied
 * provider keys. Yields streamed chunks tagged with which provider/model
 * actually served them, so the caller can surface a live "answered by
 * <provider>" indicator and emit `model.switched` on fallback.
 */
export async function* streamChatWithFallback(input: StreamChatWithFallbackInput): AsyncGenerator<StreamedChunk> {
  const decision = selectModel(input.criteria);
  input.onModelSelected?.(decision);

  const resolveProvider = input.getProvider ?? getProviderAdapter;
  const retryPolicy = input.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const candidates = [
    { providerId: decision.providerId, modelId: decision.modelId },
    ...decision.fallbackChain.map((providerId) => ({
      providerId,
      modelId: `${providerId}/${PROVIDER_DEFAULT_MODELS[providerId] ?? "default"}`,
    })),
  ];

  /** "providerId/model-ref" -> "model-ref", the shape provider.chat() expects. */
  const toProviderModelRef = (providerId: string, fullModelId: string): string =>
    fullModelId.startsWith(`${providerId}/`) ? fullModelId.slice(providerId.length + 1) : fullModelId;

  let lastError: Error | undefined;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (!candidate) continue;
    const { providerId, modelId } = candidate;
    const apiKey = input.providerKeys[providerId];
    const provider = resolveProvider(providerId);
    const breaker = getCircuitBreaker(providerId);

    if (!apiKey || !provider) {
      lastError = new NoAvailableModelError(`No adapter/key available for provider ${providerId}`);
      continue;
    }
    if (!breaker.canAttempt()) {
      lastError = new ProviderCallError(providerId, `Circuit open for ${providerId}`, { retryable: true });
      continue;
    }

    if (i > 0) {
      const from = candidates[i - 1]?.providerId ?? decision.providerId;
      input.onModelSwitched?.(from, providerId, lastError?.message ?? "previous provider failed");
    }

    let attempt = 0;
    while (attempt < retryPolicy.maxAttemptsPerProvider) {
      attempt++;
      const start = Date.now();
      let yieldedAny = false;
      try {
        for await (const chunk of provider.chat(apiKey, {
          modelId: toProviderModelRef(providerId, modelId),
          messages: input.messages,
          temperature: input.temperature,
          maxOutputTokens: input.maxOutputTokens,
        })) {
          yieldedAny = true;
          yield { ...chunk, providerId, modelId };
        }
        breaker.recordSuccess();
        input.onCallSample?.({ modelId, providerId, latencyMs: Date.now() - start, success: true });
        if (!yieldedAny) {
          // Stream completed with no content — treat as a soft failure worth trying the next candidate, not a crash.
          lastError = new ProviderCallError(providerId, `${providerId} returned an empty stream`, { retryable: true });
          break;
        }
        return;
      } catch (err) {
        const providerErr =
          err instanceof ProviderCallError ? err : new ProviderCallError(providerId, (err as Error).message, { retryable: true });
        breaker.recordFailure();
        input.onCallSample?.({
          modelId,
          providerId,
          latencyMs: Date.now() - start,
          success: false,
          errorCode: providerErr.status?.toString() ?? providerErr.name,
        });
        // Once any content has reached the consumer, a retry/fallback would
        // re-generate the answer from scratch and duplicate what's already
        // shown — surface the error instead and let the chat UI's explicit
        // retry action (docs/architecture — M1 chat UX) restart cleanly.
        if (yieldedAny) throw providerErr;
        lastError = providerErr;
        if (!providerErr.retryable || attempt >= retryPolicy.maxAttemptsPerProvider) break;
        await sleep(jitteredDelay(attempt, retryPolicy.baseDelayMs));
      }
    }
  }

  throw lastError ?? new NoAvailableModelError("No candidate providers succeeded");
}
