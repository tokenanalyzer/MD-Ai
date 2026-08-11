import "../setupEnv.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { PROVIDER_ADAPTERS } from "../../src/core/providers/registry.js";
import { ProviderCallError } from "../../src/core/providers/errors.js";

/**
 * Exercises the real ModelProvider adapters end-to-end against mocked HTTP
 * responses shaped exactly like each vendor's OpenAI-compatible API
 * (docs/architecture/06-provider-model-interfaces.md §2). This is as close
 * to a live integration test as this sandboxed environment allows — its
 * outbound network policy blocks arbitrary hosts (confirmed: `curl` to
 * api.groq.com/integrate.api.nvidia.com fails at the proxy with 403),
 * so a real vendor API call could not be exercised here even with a real
 * key. NVIDIA Nemotron is covered first per the milestone's provider
 * priority, then the same shared client is proven against a second vendor
 * to demonstrate the "no duplicated provider logic" claim holds.
 */

let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;

beforeEach(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
});

function sseBody(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

describe("NVIDIA Nemotron adapter", () => {
  it("streams a chat completion via the real request/response shape", async () => {
    const pool = mockAgent.get("https://integrate.api.nvidia.com");
    pool
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(
        200,
        sseBody([
          { choices: [{ delta: { content: "Hello" } }] },
          { choices: [{ delta: { content: " from Nemotron" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
        ]),
        { headers: { "content-type": "text/event-stream" } },
      );

    const adapter = PROVIDER_ADAPTERS["nvidia-nemotron"]!;
    const chunks = [];
    for await (const chunk of adapter.chat("nvapi-test-key", {
      modelId: "",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.map((c) => c.delta).filter(Boolean).join("")).toBe("Hello from Nemotron");
    expect(chunks.at(-1)?.finishReason).toBe("stop");
    expect(chunks.at(-1)?.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
  });

  it("sends the API key as a Bearer header and the requested model", async () => {
    let capturedAuth: string | undefined;
    let capturedBody: string | undefined;
    const pool = mockAgent.get("https://integrate.api.nvidia.com");
    pool
      .intercept({
        path: "/v1/chat/completions",
        method: "POST",
        headers: (headers) => {
          capturedAuth = (headers as Record<string, string>)["authorization"];
          return true;
        },
      })
      .reply((opts) => {
        capturedBody = opts.body as string;
        return { statusCode: 200, data: sseBody([{ choices: [{ delta: {}, finish_reason: "stop" }] }]) };
      });

    const adapter = PROVIDER_ADAPTERS["nvidia-nemotron"]!;
    for await (const _c of adapter.chat("nvapi-secret-123", {
      modelId: "nvidia/llama-3.1-nemotron-70b-instruct",
      messages: [{ role: "user", content: "hi" }],
    })) {
      // drain
    }

    expect(capturedAuth).toBe("Bearer nvapi-secret-123");
    expect(JSON.parse(capturedBody ?? "{}")).toMatchObject({ model: "nvidia/llama-3.1-nemotron-70b-instruct" });
  });

  it("surfaces a non-retryable ProviderCallError on 401", async () => {
    const pool = mockAgent.get("https://integrate.api.nvidia.com");
    pool.intercept({ path: "/v1/chat/completions", method: "POST" }).reply(401, "invalid api key");

    const adapter = PROVIDER_ADAPTERS["nvidia-nemotron"]!;
    await expect(async () => {
      for await (const _c of adapter.chat("bad-key", { modelId: "", messages: [{ role: "user", content: "hi" }] })) {
        // drain
      }
    }).rejects.toThrow(ProviderCallError);
  });

  it("testConnection reports failure without throwing on an invalid key", async () => {
    const pool = mockAgent.get("https://integrate.api.nvidia.com");
    pool.intercept({ path: "/v1/models", method: "GET" }).reply(401, "invalid api key");

    const result = await PROVIDER_ADAPTERS["nvidia-nemotron"]!.testConnection("bad-key");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("testConnection reports success and discovered models on a valid key", async () => {
    const pool = mockAgent.get("https://integrate.api.nvidia.com");
    pool
      .intercept({ path: "/v1/models", method: "GET" })
      .reply(200, { data: [{ id: "nvidia/llama-3.1-nemotron-70b-instruct" }] });

    const result = await PROVIDER_ADAPTERS["nvidia-nemotron"]!.testConnection("good-key");
    expect(result.ok).toBe(true);
    expect(result.discoveredModels?.[0]?.providerModelRef).toBe("nvidia/llama-3.1-nemotron-70b-instruct");
  });
});

describe("Groq adapter (proves the shared client generalizes to a second vendor)", () => {
  it("streams a chat completion", async () => {
    const pool = mockAgent.get("https://api.groq.com");
    pool
      .intercept({ path: "/openai/v1/chat/completions", method: "POST" })
      .reply(200, sseBody([{ choices: [{ delta: { content: "fast answer" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]));

    const chunks = [];
    for await (const chunk of PROVIDER_ADAPTERS["groq"]!.chat("gsk-test", {
      modelId: "",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }
    expect(chunks.map((c) => c.delta).filter(Boolean).join("")).toBe("fast answer");
  });
});
