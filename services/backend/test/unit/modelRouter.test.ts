import "../setupEnv.js";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatRequest, ChatResponseChunk, ModelProvider } from "@mdai/shared-types";
import { NoAvailableModelError, selectModel, streamChatWithFallback } from "../../src/core/router/modelRouter.js";
import { resetAllCircuitBreakersForTests } from "../../src/core/router/circuitBreaker.js";
import { ProviderCallError } from "../../src/core/providers/errors.js";

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

describe("selectModel", () => {
  it("throws NoAvailableModelError when no provider key was supplied", () => {
    expect(() => selectModel({ taskType: "chat", availableProviderIds: [] })).toThrow(NoAvailableModelError);
  });

  it("picks the first available provider by default", () => {
    const decision = selectModel({ taskType: "chat", availableProviderIds: ["groq", "openrouter"] });
    expect(decision.providerId).toBe("groq");
    expect(decision.reason).toBe("capability_match");
    expect(decision.fallbackChain).toEqual(["openrouter"]);
  });

  it("honors an explicit preferredProviderId", () => {
    const decision = selectModel({
      taskType: "chat",
      availableProviderIds: ["groq", "openrouter"],
      preferredProviderId: "openrouter",
    });
    expect(decision.providerId).toBe("openrouter");
    expect(decision.reason).toBe("user_default");
  });

  it("honors an explicit preferredModelId over provider order", () => {
    const decision = selectModel({
      taskType: "chat",
      availableProviderIds: ["groq", "nvidia-nemotron"],
      preferredModelId: "nvidia-nemotron/nvidia/llama-3.1-nemotron-70b-instruct",
    });
    expect(decision.providerId).toBe("nvidia-nemotron");
    expect(decision.reason).toBe("user_override");
    expect(decision.modelId).toBe("nvidia-nemotron/nvidia/llama-3.1-nemotron-70b-instruct");
  });

  it("never returns a provider outside availableProviderIds", () => {
    const decision = selectModel({
      taskType: "chat",
      availableProviderIds: ["groq"],
      preferredProviderId: "gemini", // not available — must be ignored, not honored
    });
    expect(decision.providerId).toBe("groq");
  });
});

describe("streamChatWithFallback", () => {
  it("streams chunks from the primary provider on success", async () => {
    const groq = fakeProvider("groq", { chunks: ["hi ", "there"] });
    const chunks = [];
    for await (const c of streamChatWithFallback({
      criteria: { taskType: "chat", availableProviderIds: ["groq"] },
      providerKeys: { groq: "fake-key" },
      messages: [{ role: "user", content: "hi" }],
      getProvider: (id) => (id === "groq" ? groq : undefined),
    })) {
      chunks.push(c);
    }
    expect(chunks.map((c) => c.delta).filter(Boolean)).toEqual(["hi ", "there"]);
    expect(chunks.every((c) => c.providerId === "groq")).toBe(true);
  });

  it("falls back to the next provider when the primary fails before yielding anything", async () => {
    const groq = fakeProvider("groq", { fail: true, retryable: true });
    const openrouter = fakeProvider("openrouter", { chunks: ["fallback answer"] });
    const switches: { from: string; to: string }[] = [];

    const chunks = [];
    for await (const c of streamChatWithFallback({
      criteria: { taskType: "chat", availableProviderIds: ["groq", "openrouter"] },
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
    expect(switches).toEqual([{ from: "groq", to: "openrouter" }]);
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
        criteria: { taskType: "chat", availableProviderIds: ["groq", "openrouter"] },
        providerKeys: { groq: "k1", openrouter: "k2" },
        messages: [{ role: "user", content: "hi" }],
        getProvider: (id) => (id === "groq" ? groq : fakeProvider("openrouter")),
      })) {
        collected.push(c);
      }
    }).rejects.toThrow(ProviderCallError);

    // Exactly the one partial chunk reached the caller — no duplicate
    // re-generation from a retry or fallback after content was already shown.
    expect(collected).toHaveLength(1);
    expect(collected[0]?.delta).toBe("partial answer");
  });

  it("throws when every candidate provider is exhausted", async () => {
    const groq = fakeProvider("groq", { fail: true, retryable: true });
    const openrouter = fakeProvider("openrouter", { fail: true, retryable: true });

    await expect(async () => {
      for await (const _c of streamChatWithFallback({
        criteria: { taskType: "chat", availableProviderIds: ["groq", "openrouter"] },
        providerKeys: { groq: "k1", openrouter: "k2" },
        messages: [{ role: "user", content: "hi" }],
        retryPolicy: { maxAttemptsPerProvider: 1, baseDelayMs: 1 },
        getProvider: (id) => ({ groq, openrouter })[id],
      })) {
        // drain
      }
    }).rejects.toThrow();
  });

  it("skips a provider whose circuit breaker is open", async () => {
    const groq = fakeProvider("groq", { fail: true, retryable: true });
    const openrouter = fakeProvider("openrouter", { chunks: ["ok"] });

    const run = () =>
      (async () => {
        const collected: ChatResponseChunk[] = [];
        for await (const c of streamChatWithFallback({
          criteria: { taskType: "chat", availableProviderIds: ["groq", "openrouter"] },
          providerKeys: { groq: "k1", openrouter: "k2" },
          messages: [{ role: "user", content: "hi" }],
          retryPolicy: { maxAttemptsPerProvider: 1, baseDelayMs: 1 },
          getProvider: (id) => ({ groq, openrouter })[id],
        })) {
          collected.push(c);
        }
        return collected;
      })();

    // Trip groq's breaker (default threshold 3) across a few requests.
    await run();
    await run();
    await run();
    const finalRun = await run();
    expect(finalRun.length).toBeGreaterThan(0);
    expect(finalRun.every((c) => c.providerId === "openrouter")).toBe(true);
  });
});
