import "../setupEnv.js";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import pino from "pino";
import { Redis } from "ioredis";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { Writable } from "node:stream";
import { createApp } from "../../src/api/app.js";
import { EventBus } from "../../src/core/events/eventBus.js";
import { ModelRegistryService } from "../../src/core/registry/modelRegistryService.js";
import { ensureOwner } from "../../src/db/repositories/ownerRepo.js";
import { generatePairingCode } from "../../src/core/security/pairing.js";
import { getTestPool, resetTestData, closeTestPool } from "../helpers/testDb.js";
import { buildTestAgentRegistry } from "../helpers/appDeps.js";

const pool = await getTestPool();
const redis = new Redis(process.env.REDIS_URL as string);

// Capture every log line pino writes, so the no-secret-in-logs assertion
// checks real serialized output, not just source code discipline.
const capturedLogLines: string[] = [];
const captureStream = new Writable({
  write(chunk, _enc, callback) {
    capturedLogLines.push(chunk.toString());
    callback();
  },
});
const logger = pino({ level: "debug" }, captureStream);
const modelRegistry = new ModelRegistryService(pool);
const { agentRegistry, memoryEngine, toolRegistry } = buildTestAgentRegistry(pool);
const app = createApp({ pool, redis, queues: [], eventBus: new EventBus(pool), modelRegistry, agentRegistry, memoryEngine, toolRegistry, logger });

let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;

beforeEach(async () => {
  await resetTestData(pool);
  await ensureOwner(pool, "Test Owner");
  capturedLogLines.length = 0;
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

describe("provider vault (no server-side key storage)", () => {
  it("lists the seeded provider catalog", async () => {
    const token = await pairedToken();
    const res = await request(app).get("/providers").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((p: { id: string }) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["nvidia-nemotron", "gemini", "groq", "sambanova", "openrouter"]));
  });

  it("test-connection uses the key transiently and persists only metadata", async () => {
    const token = await pairedToken();
    const FAKE_KEY = "nvapi-VERY-SECRET-1234567890abcdef";

    const pool_ = mockAgent.get("https://integrate.api.nvidia.com");
    pool_.intercept({ path: "/v1/models", method: "GET" }).reply(200, { data: [{ id: "nvidia/llama-3.1-nemotron-70b-instruct" }] });

    const res = await request(app)
      .post("/providers/nvidia-nemotron/test-connection")
      .set("Authorization", `Bearer ${token}`)
      .send({ apiKey: FAKE_KEY });

    expect(res.status).toBe(200);
    expect(res.body.data.result.ok).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_KEY);
    expect(res.body.data.config.keyLast4).toBe("cdef");

    const configs = await request(app).get("/providers/nvidia-nemotron/configs").set("Authorization", `Bearer ${token}`);
    expect(configs.body.data).toHaveLength(1);
    expect(configs.body.data[0].status).toBe("connected");
    expect(configs.body.data[0].keyLast4).toBe("cdef");
    expect(JSON.stringify(configs.body)).not.toContain(FAKE_KEY);

    // The defining guarantee (docs/architecture/07-security-model.md §3):
    // no table anywhere holds the actual key.
    const raw = await pool.query("SELECT * FROM provider_configs");
    expect(JSON.stringify(raw.rows)).not.toContain(FAKE_KEY);

    // And the explicit no-secret-in-logs test (docs/architecture/09-roadmap.md M1 requirement):
    const allLogs = capturedLogLines.join("\n");
    expect(allLogs).not.toContain(FAKE_KEY);
  });

  it("records a failed test-connection as status error, still without leaking the key", async () => {
    const token = await pairedToken();
    const FAKE_KEY = "nvapi-BAD-SECRET-abcdef1234567890";

    mockAgent.get("https://integrate.api.nvidia.com").intercept({ path: "/v1/models", method: "GET" }).reply(401, "unauthorized");

    const res = await request(app)
      .post("/providers/nvidia-nemotron/test-connection")
      .set("Authorization", `Bearer ${token}`)
      .send({ apiKey: FAKE_KEY });

    expect(res.status).toBe(200);
    expect(res.body.data.result.ok).toBe(false);
    expect(res.body.data.config.status).toBe("error");
    expect(capturedLogLines.join("\n")).not.toContain(FAKE_KEY);
  });

  it("deletes a provider config", async () => {
    const token = await pairedToken();
    mockAgent.get("https://integrate.api.nvidia.com").intercept({ path: "/v1/models", method: "GET" }).reply(200, { data: [] });
    const created = await request(app)
      .post("/providers/nvidia-nemotron/test-connection")
      .set("Authorization", `Bearer ${token}`)
      .send({ apiKey: "nvapi-tmp-1234567890" });
    const configId = created.body.data.config.id as string;

    const del = await request(app).delete(`/providers/nvidia-nemotron/configs/${configId}`).set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(204);

    const after = await request(app).get("/providers/nvidia-nemotron/configs").set("Authorization", `Bearer ${token}`);
    expect(after.body.data).toHaveLength(0);
  });

  it("rejects an unknown provider id", async () => {
    const token = await pairedToken();
    const res = await request(app)
      .post("/providers/does-not-exist/test-connection")
      .set("Authorization", `Bearer ${token}`)
      .send({ apiKey: "whatever-1234567890" });
    expect(res.status).toBe(404);
  });
});
