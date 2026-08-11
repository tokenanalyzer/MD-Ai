import type {
  ChatMessage,
  ChatResponseChunk,
  ModelProvider,
  ModelRegistryEntry,
  RoutingCriteria,
  RoutingDecision,
} from "@mdai/shared-types";
import { getProviderAdapter, PROVIDER_DEFAULT_MODELS } from "../providers/registry.js";
import { getCircuitBreaker } from "./circuitBreaker.js";
import { ProviderCallError } from "../providers/errors.js";
import { rankCandidates } from "./scoreModel.js";

export class NoAvailableModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoAvailableModelError";
  }
}

export function extractProviderId(modelId: string): string {
  const idx = modelId.indexOf("/");
  return idx === -1 ? modelId : modelId.slice(0, idx);
}

function defaultModelIdFor(providerId: string): string {
  return `${providerId}/${PROVIDER_DEFAULT_MODELS[providerId] ?? "default"}`;
}

/**
 * M2.4 deterministic router entry point. `candidates` are the caller's
 * pre-fetched Model Registry rows already scoped to
 * `criteria.availableProviderIds` (see `resolveRoutingDecision.ts` for the
 * DB-backed wrapper) — kept as a plain array argument so this function
 * stays pure and unit-testable without a database.
 *
 * "manual" mode bypasses scoring entirely and pins exactly the requested
 * provider/model, per the M2 instruction that MANUAL must always use the
 * selected provider/model with no substitution.
 */
export function selectModelFromCandidates(
  candidates: ModelRegistryEntry[],
  criteria: RoutingCriteria,
  defaultModelIds: ReadonlySet<string> = new Set(),
): RoutingDecision {
  if (criteria.availableProviderIds.length === 0) {
    throw new NoAvailableModelError("No provider key supplied for this request");
  }

  if (criteria.routingMode === "manual") {
    const providerId = criteria.preferredProviderId;
    if (!providerId || !criteria.availableProviderIds.includes(providerId)) {
      throw new NoAvailableModelError("routingMode 'manual' requires preferredProviderId to be one of the available providers");
    }
    const modelId = criteria.preferredModelId ?? defaultModelIdFor(providerId);
    return { modelId, providerId, reason: "manual_pin", fallbackChain: [] };
  }

  const ranked = rankCandidates(candidates, criteria, defaultModelIds);

  // An explicit preferredModelId wins outright over scoring, same as M1's
  // "user_override" semantics — the caller asked for this exact model by
  // id, so give it to them rather than let a higher-scoring alternative
  // quietly win the tiebreak.
  const forced = criteria.preferredModelId ? ranked.find((c) => c.modelId === criteria.preferredModelId) : undefined;

  let top: (typeof ranked)[number];
  let reason: RoutingDecision["reason"];
  if (forced) {
    top = forced;
    reason = "user_override";
  } else {
    const survivors = ranked.filter((c) => !c.excluded);
    if (survivors.length === 0) {
      throw new NoAvailableModelError("No candidate model satisfies the requested capabilities among the available providers");
    }
    top = survivors[0]!;
    reason = defaultModelIds.has(top.modelId) ? "user_default" : "capability_match";
  }

  return {
    modelId: top.modelId,
    providerId: top.providerId,
    reason,
    fallbackChain: ranked.filter((c) => c.modelId !== top.modelId && !c.excluded).map((c) => c.modelId),
    scoreDetails: ranked,
  };
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

export interface CallSampleEvent {
  modelId: string;
  providerId: string;
  latencyMs: number;
  success: boolean;
  errorCode?: string;
  timedOut?: boolean;
  usedAsFallback?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  responseStatus?: string;
}

export interface StreamChatWithFallbackInput {
  decision: RoutingDecision;
  providerKeys: Record<string, string>;
  messages: ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  retryPolicy?: RetryPolicy;
  getProvider?: (id: string) => ModelProvider | undefined;
  onModelSwitched?: (from: string, to: string, reason: string) => void;
  onCallSample?: (sample: CallSampleEvent) => void;
}

/**
 * Executes a routing decision with per-model retry, circuit breaking, and
 * fallback across `decision.fallbackChain` (which, since M2, may contain
 * other models on the *same* provider as well as other providers — see
 * `selectModelFromCandidates`). Pure execution given a decision: it does
 * not re-run scoring or touch the database itself.
 */
export async function* streamChatWithFallback(input: StreamChatWithFallbackInput): AsyncGenerator<StreamedChunk> {
  const { decision } = input;
  const resolveProvider = input.getProvider ?? getProviderAdapter;
  const retryPolicy = input.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const candidates = [{ modelId: decision.modelId }, ...decision.fallbackChain.map((modelId) => ({ modelId }))];

  const toProviderModelRef = (providerId: string, fullModelId: string): string =>
    fullModelId.startsWith(`${providerId}/`) ? fullModelId.slice(providerId.length + 1) : fullModelId;

  let lastError: Error | undefined;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (!candidate) continue;
    const { modelId } = candidate;
    const providerId = extractProviderId(modelId);
    const apiKey = input.providerKeys[providerId];
    const provider = resolveProvider(providerId);
    const breaker = getCircuitBreaker(providerId);
    const usedAsFallback = i > 0;

    if (!apiKey || !provider) {
      lastError = new NoAvailableModelError(`No adapter/key available for provider ${providerId}`);
      continue;
    }
    if (!breaker.canAttempt()) {
      lastError = new ProviderCallError(providerId, `Circuit open for ${providerId}`, { retryable: true });
      continue;
    }

    if (i > 0) {
      const from = candidates[i - 1]?.modelId ?? decision.modelId;
      input.onModelSwitched?.(from, modelId, lastError?.message ?? "previous candidate failed");
    }

    let attempt = 0;
    while (attempt < retryPolicy.maxAttemptsPerProvider) {
      attempt++;
      const start = Date.now();
      let yieldedAny = false;
      let usage: { inputTokens: number; outputTokens: number } | undefined;
      let finishReason: string | undefined;
      try {
        for await (const chunk of provider.chat(apiKey, {
          modelId: toProviderModelRef(providerId, modelId),
          messages: input.messages,
          temperature: input.temperature,
          maxOutputTokens: input.maxOutputTokens,
        })) {
          yieldedAny = true;
          if (chunk.usage) usage = chunk.usage;
          if (chunk.finishReason) finishReason = chunk.finishReason;
          yield { ...chunk, providerId, modelId };
        }
        breaker.recordSuccess();
        input.onCallSample?.({
          modelId,
          providerId,
          latencyMs: Date.now() - start,
          success: true,
          usedAsFallback,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          responseStatus: finishReason,
        });
        if (!yieldedAny) {
          lastError = new ProviderCallError(providerId, `${providerId} returned an empty stream`, { retryable: true });
          break;
        }
        return;
      } catch (err) {
        const providerErr =
          err instanceof ProviderCallError ? err : new ProviderCallError(providerId, (err as Error).message, { retryable: true });
        const timedOut = /timed out/i.test(providerErr.message);
        breaker.recordFailure();
        input.onCallSample?.({
          modelId,
          providerId,
          latencyMs: Date.now() - start,
          success: false,
          errorCode: providerErr.status?.toString() ?? providerErr.name,
          timedOut,
          usedAsFallback,
          responseStatus: providerErr.status?.toString(),
        });
        if (yieldedAny) throw providerErr;
        lastError = providerErr;
        if (!providerErr.retryable || attempt >= retryPolicy.maxAttemptsPerProvider) break;
        await sleep(jitteredDelay(attempt, retryPolicy.baseDelayMs));
      }
    }
  }

  throw lastError ?? new NoAvailableModelError("No candidate providers succeeded");
}
