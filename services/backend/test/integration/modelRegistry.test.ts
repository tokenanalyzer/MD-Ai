import "../setupEnv.js";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import pino from "pino";
import { Redis } from "ioredis";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { createApp } from "../../src/api/app.js";
import { EventBus } from "../../src/core/events/eventBus.js";
import { ModelRegistryService } from "../../src/core/registry/modelRegistryService.js";
import { ensureOwner } from "../../src/db/repositories/ownerRepo.js";
import { generatePairingCode } from "../../src/core/security/pairing.js";
import { insertModelCallSample, computeHealthRollup, applyHealthRollup } from "../../src/db/repositories/modelRegistryRepo.js";
import { getTestPool, resetTestData, closeTestPool } from "../helpers/testDb.js";
import { buildTestAgentRegistry } from "../helpers/appDeps.js";

const pool = await getTestPool();
const redis = new Redis(process.env.REDIS_URL as string);
const logger = pino({ level: "silent" });
const modelRegistry = new ModelRegistryService(pool);
const { agentRegistry, memoryEngine } = buildTestAgentRegistry(pool);
const app = createApp({ pool, redis, queues: [], eventBus: new EventBus(pool), modelRegistry, agentRegistry, memoryEngine, logger });

let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;

beforeEach(async () => {
  await resetTestData(pool);
  await ensureOwner(pool, "Test Owner");
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
});

afterAll(async () => {
  await redis.quit();
  await closeTestPool();
});

async function pairedToken(): Promise<string> {
  const code = await generatePairingCode(pool);
  const res = await request(app).post("/auth/pair").send({ pairingCode: code, deviceName: "phone", platform: "android" });
  return res.body.data.accessToken as string;
}

describe("GET /models", () => {
  it("returns the M1-seeded default models before any discovery", async () => {
    const token = await pairedToken();
    const res = await request(app).get("/models").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain("nvidia-nemotron/nvidia/llama-3.1-nemotron-70b-instruct");
    const nemotron = res.body.data.find((m: { id: string }) => m.id === "nvidia-nemotron/nvidia/llama-3.1-nemotron-70b-instruct");
    expect(nemotron.capabilities.supportsReasoning).toBe(true);
    expect(nemotron.capabilities.contextLength).toBe(128000);
  });

  it("filters by providerId", async () => {
    const token = await pairedToken();
    const res = await request(app).get("/models?providerId=groq").set("Authorization", `Bearer ${token}`);
    expect(res.body.data.every((m: { providerId: string }) => m.providerId === "groq")).toBe(true);
  });
});

describe("M2.1 discovery via test-connection", () => {
  it("upserts newly-discovered models with catalog capabilities when known", async () => {
    const token = await pairedToken();
    mockAgent
      .get("https://api.groq.com")
      .intercept({ path: "/openai/v1/models", method: "GET" })
      .reply(200, { data: [{ id: "llama-3.3-70b-versatile" }, { id: "some-brand-new-model-nobody-curated-yet" }] });

    const res = await request(app)
      .post("/providers/groq/test-connection")
      .set("Authorization", `Bearer ${token}`)
      .send({ apiKey: "gsk-test-1234567890" });

    expect(res.status).toBe(200);
    expect(res.body.data.discoveredModelCount).toBe(2);

    const models = await request(app).get("/models?providerId=groq").set("Authorization", `Bearer ${token}`);
    const known = models.body.data.find((m: { id: string }) => m.id === "groq/llama-3.3-70b-versatile");
    const unknown = models.body.data.find((m: { id: string }) => m.id === "groq/some-brand-new-model-nobody-curated-yet");

    expect(known.capabilities.supportsTools).toBe(true); // from the capability catalog
    expect(known.availability).toBe("available");

    // "Do not assume capabilities merely from model names" — an
    // uncurated model gets conservative/unverified defaults, not a guess.
    expect(unknown).toBeDefined();
    expect(unknown.capabilities.tags).toContain("unverified");
    expect(unknown.capabilities.supportsTools).toBe(false);
    expect(unknown.capabilities.supportsVision).toBe(false);
  });

  it("re-discovery refreshes capabilities without resetting user config", async () => {
    const token = await pairedToken();
    // First discovery.
    mockAgent
      .get("https://api.groq.com")
      .intercept({ path: "/openai/v1/models", method: "GET" })
      .reply(200, { data: [{ id: "llama-3.3-70b-versatile" }] });
    await request(app).post("/providers/groq/test-connection").set("Authorization", `Bearer ${token}`).send({ apiKey: "gsk-1" });

    // User disables it and lowers priority.
    await request(app)
      .patch("/models")
      .set("Authorization", `Bearer ${token}`)
      .send({ modelId: "groq/llama-3.3-70b-versatile", userEnabled: false, userPriority: -5 });

    // Re-discovery (e.g. a second test-connection) must not silently re-enable it.
    mockAgent
      .get("https://api.groq.com")
      .intercept({ path: "/openai/v1/models", method: "GET" })
      .reply(200, { data: [{ id: "llama-3.3-70b-versatile" }] });
    await request(app).post("/providers/groq/test-connection").set("Authorization", `Bearer ${token}`).send({ apiKey: "gsk-1" });

    const after = await request(app).get("/models?providerId=groq").set("Authorization", `Bearer ${token}`);
    const model = after.body.data.find((m: { id: string }) => m.id === "groq/llama-3.3-70b-versatile");
    expect(model.userEnabled).toBe(false);
    expect(model.userPriority).toBe(-5);
  });
});

describe("PATCH /models", () => {
  it("updates userEnabled and userPriority", async () => {
    const token = await pairedToken();
    const res = await request(app)
      .patch("/models")
      .set("Authorization", `Bearer ${token}`)
      .send({ modelId: "groq/llama-3.3-70b-versatile", userEnabled: false, userPriority: 3 });
    expect(res.status).toBe(200);
    expect(res.body.data.userEnabled).toBe(false);
    expect(res.body.data.userPriority).toBe(3);
  });

  it("404s for an unknown model id", async () => {
    const token = await pairedToken();
    const res = await request(app).patch("/models").set("Authorization", `Bearer ${token}`).send({ modelId: "groq/does-not-exist" });
    expect(res.status).toBe(404);
  });
});

describe("M2.2 telemetry: model_call_samples + health rollup", () => {
  it("records a call sample with provider/task-category/tokens and never contains secret material", async () => {
    await insertModelCallSample(pool, {
      modelId: "groq/llama-3.3-70b-versatile",
      providerId: "groq",
      latencyMs: 250,
      success: true,
      taskCategory: "chat",
      usedAsFallback: false,
      inputTokens: 42,
      outputTokens: 17,
      responseStatus: "stop",
    });
    const { rows } = await pool.query("SELECT * FROM model_call_samples WHERE model_id = $1", ["groq/llama-3.3-70b-versatile"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider_id: "groq", task_category: "chat", input_tokens: 42, output_tokens: 17 });
    expect(JSON.stringify(rows[0])).not.toMatch(/gsk-|sk-|nvapi-/);
  });

  it("rolls recent samples up into model_registry availability/latency/error-rate", async () => {
    const modelId = "sambanova/Meta-Llama-3.1-70B-Instruct";
    for (let i = 0; i < 5; i++) {
      await insertModelCallSample(pool, { modelId, providerId: "sambanova", latencyMs: 200 + i * 10, success: true });
    }
    for (let i = 0; i < 5; i++) {
      await insertModelCallSample(pool, { modelId, providerId: "sambanova", latencyMs: 5000, success: false, errorCode: "500" });
    }

    const rollup = await computeHealthRollup(pool, 20);
    const entry = rollup.find((r) => r.modelId === modelId);
    expect(entry).toBeDefined();
    expect(entry!.errorRatePct).toBe(50);

    await applyHealthRollup(pool, rollup);
    const { rows } = await pool.query("SELECT availability, error_rate_pct FROM model_registry WHERE id = $1", [modelId]);
    expect(Number(rows[0].error_rate_pct)).toBe(50);
    expect(rows[0].availability).toBe("degraded"); // 50% >= 30% threshold, < 80% unavailable threshold
  });
});
