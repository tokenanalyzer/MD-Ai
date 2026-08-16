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
import { getTestPool, resetTestData, closeTestPool } from "../helpers/testDb.js";
import { collectTaskStream } from "../helpers/wsClient.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { attachChatGateway } from "../../src/api/ws/chatGateway.js";
import { buildTestAgentRegistry } from "../helpers/appDeps.js";
import { NO_DELEGATE_CLASSIFICATION, isClassifierRequestBody } from "../helpers/classifierMock.js";

const pool = await getTestPool();
const redis = new Redis(process.env.REDIS_URL as string);
const logger = pino({ level: "silent" });
const modelRegistry = new ModelRegistryService(pool);
const { agentRegistry, memoryEngine, toolRegistry, botRegistry, botEngine, automationEngine } = buildTestAgentRegistry(pool);
const app = createApp({ pool, redis, queues: [], eventBus: new EventBus(pool), modelRegistry, agentRegistry, memoryEngine, toolRegistry, botRegistry, botEngine, automationEngine, logger });

let server: Server;
let wsBaseUrl: string;

beforeEach(async () => {
  await resetTestData(pool);
  await ensureOwner(pool, "Test Owner");
});

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

beforeEach(async () => {
  server = createServer(app);
  attachChatGateway(server, pool);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  wsBaseUrl = `ws://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

afterAll(async () => {
  await redis.quit();
  await closeTestPool();
});

function sseBody(deltas: string[]): string {
  const events = deltas.map((d) => ({ choices: [{ delta: { content: d } }] }));
  events.push({ choices: [{ delta: {} as { content?: string }, finish_reason: "stop" } as never] });
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

async function pairedToken(): Promise<string> {
  const code = await generatePairingCode(pool);
  const res = await request(app).post("/auth/pair").send({ pairingCode: code, deviceName: "phone", platform: "android" });
  return res.body.data.accessToken as string;
}

describe("routing modes", () => {
  it("AUTO picks a candidate and reports it via model.selected + task.modelId", async () => {
    mockAgent
      .get("https://api.groq.com")
      .intercept({ path: "/openai/v1/chat/completions", method: "POST", body: isClassifierRequestBody })
      .reply(200, sseBody([NO_DELEGATE_CLASSIFICATION]))
      .persist();
    mockAgent
      .get("https://api.groq.com")
      .intercept({ path: "/openai/v1/chat/completions", method: "POST" })
      .reply(200, sseBody(["auto ", "picked"]));

    const token = await pairedToken();
    const conv = await request(app).post("/conversations").set("Authorization", `Bearer ${token}`).send({});
    const taskRes = await request(app)
      .post(`/conversations/${conv.body.data.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ parts: [{ type: "text", text: "hi" }], providerKeys: { groq: "gsk-1234567890" }, routingMode: "auto" });

    await collectTaskStream(`${wsBaseUrl}/ws/tasks/${taskRes.body.data.id}?token=${token}`);

    const tasksRes = await request(app).get(`/conversations/${conv.body.data.id}/tasks`).set("Authorization", `Bearer ${token}`);
    expect(tasksRes.body.data[0].modelId).toBe("groq/openai/gpt-oss-120b");

    const events = await pool.query("SELECT payload FROM events WHERE task_id = $1 AND event_type = 'model.selected'", [
      taskRes.body.data.id,
    ]);
    // Only one candidate (groq's seeded default model) and no provider
    // default-model configured in this test, so it wins on capability
    // match alone, not a "this is the configured default" bonus.
    expect(events.rows[0].payload.reason).toBe("capability_match");
  });

  it("MANUAL pins exactly the requested model even when a higher-scoring alternative exists", async () => {
    // Make nvidia-nemotron's default model look objectively better (available,
    // low latency, high priority) so AUTO would clearly prefer it — then prove
    // MANUAL ignores that and uses the explicitly pinned groq model anyway.
    await pool.query(
      `UPDATE model_registry SET availability = 'available', avg_latency_ms = 50, error_rate_pct = 0, user_priority = 10
       WHERE id = 'nvidia-nemotron/nvidia/llama-3.1-nemotron-70b-instruct'`,
    );
    await pool.query(
      `UPDATE model_registry SET availability = 'degraded', avg_latency_ms = 4000, error_rate_pct = 40
       WHERE id = 'groq/llama-3.3-70b-versatile'`,
    );

    mockAgent
      .get("https://api.groq.com")
      .intercept({ path: "/openai/v1/chat/completions", method: "POST", body: isClassifierRequestBody })
      .reply(200, sseBody([NO_DELEGATE_CLASSIFICATION]))
      .persist();
    mockAgent
      .get("https://integrate.api.nvidia.com")
      .intercept({ path: "/v1/chat/completions", method: "POST", body: isClassifierRequestBody })
      .reply(200, sseBody([NO_DELEGATE_CLASSIFICATION]))
      .persist();
    mockAgent
      .get("https://api.groq.com")
      .intercept({ path: "/openai/v1/chat/completions", method: "POST" })
      .reply(200, sseBody(["manual ", "pin"]));

    const token = await pairedToken();
    const conv = await request(app).post("/conversations").set("Authorization", `Bearer ${token}`).send({});
    const taskRes = await request(app)
      .post(`/conversations/${conv.body.data.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        parts: [{ type: "text", text: "hi" }],
        providerKeys: { groq: "gsk-1", "nvidia-nemotron": "nvapi-1" },
        routingMode: "manual",
        preferredProviderId: "groq",
        preferredModelId: "groq/llama-3.3-70b-versatile",
      });

    const frames = await collectTaskStream(`${wsBaseUrl}/ws/tasks/${taskRes.body.data.id}?token=${token}`);
    const text = frames.map((f) => f.delta).filter(Boolean).join("");
    expect(text).toBe("manual pin");

    const tasksRes = await request(app).get(`/conversations/${conv.body.data.id}/tasks`).set("Authorization", `Bearer ${token}`);
    expect(tasksRes.body.data[0].modelId).toBe("groq/llama-3.3-70b-versatile");

    const events = await pool.query("SELECT payload FROM events WHERE task_id = $1 AND event_type = 'model.selected'", [
      taskRes.body.data.id,
    ]);
    expect(events.rows[0].payload.reason).toBe("manual_pin");
  });

  it("rejects manual mode without preferredProviderId at the API layer", async () => {
    const token = await pairedToken();
    const conv = await request(app).post("/conversations").set("Authorization", `Bearer ${token}`).send({});
    const res = await request(app)
      .post(`/conversations/${conv.body.data.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ parts: [{ type: "text", text: "hi" }], providerKeys: { groq: "gsk-1" }, routingMode: "manual" });
    expect(res.status).toBe(400);
  });
});
