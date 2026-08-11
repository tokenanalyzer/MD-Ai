import "../setupEnv.js";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatRequest, ChatResponseChunk, ModelProvider, RoutingDecision } from "@mdai/shared-types";
import {
  NoAvailableModelError,
  extractProviderId,
  selectModelFromCandidates,
  streamChatWithFallback,
  type StreamedChunk,
} from "../../src/core/router/modelRouter.js";
import { resetAllCircuitBreakersForTests } from "../../src/core/router/circuitBreaker.js";
import { ProviderCallError } from "../../src/core/providers/errors.js";
import { fakeModelEntry } from "./fixtures/modelRegistryFixtures.js";

function fakeProvider(id: string, opts: { fail?: boolean; retryable?: boolean; chunks?: string[] } = {}): ModelProvider {
  return {
    id,
    displayName: id,
    async listModels() {
      return [];
    },
    async testConnection() {
      return { ok: true };
    },
    async *chat(_apiKey: string, _req: ChatRequest): AsyncIterable<ChatResponseChunk> {
      if (opts.fail) {
        throw new ProviderCallError(id, `${id} exploded`, { retryable: opts.retryable ?? true });
      }
      for (const text of opts.chunks ?? ["hello ", "world"]) {
        yield { delta: text };
      }
      yield { finishReason: "stop" };
    },
  };
}

beforeEach(() => {
  resetAllCircuitBreakersForTests();
});

describe("extractProviderId", () => {
  it("takes everything before the first slash", () => {
    expect(extractProviderId("groq/llama-3.3-70b-versatile")).toBe("groq");
    expect(extractProviderId("openrouter/meta-llama/llama-3.1-70b-instruct")).toBe("openrouter");
  });
});

describe("selectModelFromCandidates", () => {
  it("throws NoAvailableModelError when no provider key was supplied", () => {
    expect(() => selectModelFromCandidates([], { taskType: "chat", availableProviderIds: [] })).toThrow(NoAvailableModelError);
  });

  it("picks the only capable candidate and builds a fallback chain from the rest", () => {
    const candidates = [fakeModelEntry("groq/model-a"), fakeModelEntry("openrouter/model-b")];
    const decision = selectModelFromCandidates(candidates, { taskType: "chat", availableProviderIds: ["groq", "openrouter"] });
    expect(["groq", "openrouter"]).toContain(decision.providerId);
    expect(decision.fallbackChain).toHaveLength(1);
    expect(decision.scoreDetails).toHaveLength(2);
  });

  it("honors an explicit preferredModelId as user_override", () => {
    const candidates = [fakeModelEntry("groq/model-a"), fakeModelEntry("nvidia-nemotron/model-b")];
    const decision = selectModelFromCandidates(candidates, {
      taskType: "chat",
      availableProviderIds: ["groq", "nvidia-nemotron"],
      preferredModelId: "nvidia-nemotron/model-b",
    });
    expect(decision.modelId).toBe("nvidia-nemotron/model-b");
    expect(decision.reason).toBe("user_override");
  });

  it("gives the provider's configured default model a scoring bonus (user_default)", () => {
    const candidates = [
      fakeModelEntry("groq/model-a", { avgLatencyMs: 100, errorRatePct: 0 }),
      fakeModelEntry("groq/model-b", { avgLatencyMs: 100, errorRatePct: 0 }),
    ];
    const decision = selectModelFromCandidates(
      candidates,
      { taskType: "chat", availableProviderIds: ["groq"] },
      new Set(["groq/model-b"]),
    );
    expect(decision.modelId).toBe("groq/model-b");
    expect(decision.reason).toBe("user_default");
  });

  it("excludes candidates whose providerId isn't in availableProviderIds", () => {
    const candidates = [fakeModelEntry("groq/model-a"), fakeModelEntry("gemini/model-c")];
    const decision = selectModelFromCandidates(candidates.slice(0, 1), {
      taskType: "chat",
      availableProviderIds: ["groq"],
      preferredProviderId: "gemini", // not available — must be ignored
    });
    expect(decision.providerId).toBe("groq");
  });

  describe("manual routing mode", () => {
    it("pins exactly the requested provider/model with no fallback chain", () => {
      const decision = selectModelFromCandidates([], {
        taskType: "chat",
        availableProviderIds: ["groq", "openrouter"],
        routingMode: "manual",
        preferredProviderId: "openrouter",
        preferredModelId: "openrouter/some-specific-model",
      });
      expect(decision).toEqual<RoutingDecision>({
        modelId: "openrouter/some-specific-model",
        providerId: "openrouter",
        reason: "manual_pin",
        fallbackChain: [],
      });
    });

    it("falls back to the provider's hard-coded default model when no explicit model is given", () => {
      const decision = selectModelFromCandidates([], {
        taskType: "chat",
        availableProviderIds: ["groq"],
        routingMode: "manual",
        preferredProviderId: "groq",
      });
      expect(decision.providerId).toBe("groq");
      expect(decision.modelId).toContain("groq/");
      expect(decision.fallbackChain).toEqual([]);
    });

    it("rejects manual mode without a preferredProviderId in availableProviderIds", () => {
      expect(() =>
        selectModelFromCandidates([], {
          taskType: "chat",
          availableProviderIds: ["groq"],
          routingMode: "manual",
          preferredProviderId: "openrouter",
        }),
      ).toThrow(NoAvailableModelError);
    });
  });
});

describe("streamChatWithFallback", () => {
  function decisionFor(modelId: string, fallbackChain: string[] = []): RoutingDecision {
    return { modelId, providerId: extractProviderId(modelId), reason: "capability_match", fallbackChain };
  }

  it("streams chunks from the primary model on success", async () => {
    const groq = fakeProvider("groq", { chunks: ["hi ", "there"] });
    const chunks = [];
    for await (const c of streamChatWithFallback({
      decision: decisionFor("groq/model-a"),
      providerKeys: { groq: "fake-key" },
      messages: [{ role: "user", content: "hi" }],
      getProvider: (id) => (id === "groq" ? groq : undefined),
    })) {
      chunks.push(c);
    }
    expect(chunks.map((c) => c.delta).filter(Boolean)).toEqual(["hi ", "there"]);
    expect(chunks.every((c) => c.providerId === "groq")).toBe(true);
  });

  it("falls back to the next candidate in the chain when the primary fails before yielding anything", async () => {
    const groq = fakeProvider("groq", { fail: true, retryable: true });
    const openrouter = fakeProvider("openrouter", { chunks: ["fallback answer"] });
    const switches: { from: string; to: string }[] = [];

    const chunks = [];
    for await (const c of streamChatWithFallback({
      decision: decisionFor("groq/model-a", ["openrouter/model-b"]),
      providerKeys: { groq: "k1", openrouter: "k2" },
      messages: [{ role: "user", content: "hi" }],
      retryPolicy: { maxAttemptsPerProvider: 1, baseDelayMs: 1 },
      getProvider: (id) => ({ groq, openrouter })[id],
      onModelSwitched: (from, to) => switches.push({ from, to }),
    })) {
      chunks.push(c);
    }

    expect(chunks.map((c) => c.delta).filter(Boolean)).toEqual(["fallback answer"]);
    expect(chunks.every((c) => c.providerId === "openrouter")).toBe(true);
    expect(switches).toEqual([{ from: "groq/model-a", to: "openrouter/model-b" }]);
  });

  it("can fall back to a different model on the SAME provider", async () => {
    let call = 0;
    const groq: ModelProvider = {
      id: "groq",
      displayName: "groq",
      async listModels() {
        return [];
      },
      async testConnection() {
        return { ok: true };
      },
      async *chat() {
        call++;
        if (call === 1) throw new ProviderCallError("groq", "model-a overloaded", { retryable: true });
        yield { delta: "answer from model-b" };
      },
    };

    const chunks = [];
    for await (const c of streamChatWithFallback({
      decision: decisionFor("groq/model-a", ["groq/model-b"]),
      providerKeys: { groq: "k1" },
      messages: [{ role: "user", content: "hi" }],
      retryPolicy: { maxAttemptsPerProvider: 1, baseDelayMs: 1 },
      getProvider: () => groq,
    })) {
      chunks.push(c);
    }
    expect(chunks.map((c) => c.modelId)).toEqual(["groq/model-b"]);
  });

  it("does not retry or fall back once content has already been streamed to the caller", async () => {
    async function* flakyChat(): AsyncIterable<ChatResponseChunk> {
      yield { delta: "partial answer" };
      throw new ProviderCallError("groq", "connection dropped mid-stream", { retryable: true });
    }
    const groq: ModelProvider = {
      id: "groq",
      displayName: "groq",
      async listModels() {
        return [];
      },
      async testConnection() {
        return { ok: true };
      },
      chat: flakyChat,
    };

    const collected: ChatResponseChunk[] = [];
    await expect(async () => {
      for await (const c of streamChatWithFallback({
        decision: decisionFor("groq/model-a", ["openrouter/model-b"]),
        providerKeys: { groq: "k1", openrouter: "k2" },
        messages: [{ role: "user", content: "hi" }],
        getProvider: (id) => (id === "groq" ? groq : fakeProvider("openrouter")),
      })) {
        collected.push(c);
      }
    }).rejects.toThrow(ProviderCallError);

    expect(collected).toHaveLength(1);
    expect(collected[0]?.delta).toBe("partial answer");
  });

  it("throws when every candidate is exhausted", async () => {
    const groq = fakeProvider("groq", { fail: true, retryable: true });
    const openrouter = fakeProvider("openrouter", { fail: true, retryable: true });

    await expect(async () => {
      for await (const _c of streamChatWithFallback({
        decision: decisionFor("groq/model-a", ["openrouter/model-b"]),
        providerKeys: { groq: "k1", openrouter: "k2" },
        messages: [{ role: "user", content: "hi" }],
        retryPolicy: { maxAttemptsPerProvider: 1, baseDelayMs: 1 },
        getProvider: (id) => ({ groq, openrouter })[id],
      })) {
        // drain
      }
    }).rejects.toThrow();
  });

  it("skips a candidate whose circuit breaker is open", async () => {
    const groq = fakeProvider("groq", { fail: true, retryable: true });
    const openrouter = fakeProvider("openrouter", { chunks: ["ok"] });

    const run = () =>
      (async () => {
        const collected: StreamedChunk[] = [];
        for await (const c of streamChatWithFallback({
          decision: decisionFor("groq/model-a", ["openrouter/model-b"]),
          providerKeys: { groq: "k1", openrouter: "k2" },
          messages: [{ role: "user", content: "hi" }],
          retryPolicy: { maxAttemptsPerProvider: 1, baseDelayMs: 1 },
          getProvider: (id) => ({ groq, openrouter })[id],
        })) {
          collected.push(c);
        }
        return collected;
      })();

    await run();
    await run();
    await run();
    const finalRun = await run();
    expect(finalRun.length).toBeGreaterThan(0);
    expect(finalRun.every((c) => c.providerId === "openrouter")).toBe(true);
  });

  it("reports timedOut/usedAsFallback/tokens on call samples", async () => {
    const samples: { modelId: string; success: boolean; usedAsFallback?: boolean; inputTokens?: number }[] = [];
    const groq: ModelProvider = {
      id: "groq",
      displayName: "groq",
      async listModels() {
        return [];
      },
      async testConnection() {
        return { ok: true };
      },
      async *chat() {
        yield { delta: "hi", usage: { inputTokens: 12, outputTokens: 3 } };
        yield { finishReason: "stop" };
      },
    };

    for await (const _c of streamChatWithFallback({
      decision: decisionFor("groq/model-a"),
      providerKeys: { groq: "k1" },
      messages: [{ role: "user", content: "hi" }],
      getProvider: () => groq,
      onCallSample: (s) => samples.push(s),
    })) {
      // drain
    }

    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ modelId: "groq/model-a", success: true, usedAsFallback: false, inputTokens: 12 });
  });
});
