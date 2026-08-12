import "../setupEnv.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import pino from "pino";
import { Redis } from "ioredis";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { createApp } from "../../src/api/app.js";
import { attachChatGateway } from "../../src/api/ws/chatGateway.js";
import { EventBus } from "../../src/core/events/eventBus.js";
import { ModelRegistryService } from "../../src/core/registry/modelRegistryService.js";
import { ensureOwner } from "../../src/db/repositories/ownerRepo.js";
import { generatePairingCode } from "../../src/core/security/pairing.js";
import { getTestPool, resetTestData, closeTestPool } from "../helpers/testDb.js";
import { collectTaskStream } from "../helpers/wsClient.js";
import { buildTestAgentRegistry } from "../helpers/appDeps.js";
import { NO_DELEGATE_CLASSIFICATION, isClassifierRequestBody } from "../helpers/classifierMock.js";

const pool = await getTestPool();
const redis = new Redis(process.env.REDIS_URL as string);
const logger = pino({ level: "silent" });
const modelRegistry = new ModelRegistryService(pool);
const { agentRegistry, memoryEngine, toolRegistry } = buildTestAgentRegistry(pool);
const app = createApp({ pool, redis, queues: [], eventBus: new EventBus(pool), modelRegistry, agentRegistry, memoryEngine, toolRegistry, logger });

let server: Server;
let baseUrl: string;
let wsBaseUrl: string;

beforeAll(async () => {
  server = createServer(app);
  attachChatGateway(server, pool);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  wsBaseUrl = `ws://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await redis.quit();
  await closeTestPool();
});

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

describe("chat: full REST + WS pipeline against a real backend + real DB", () => {
  it("streams a completion end-to-end and persists the final message", async () => {
    mockAgent
      .get("https://api.groq.com")
      .intercept({ path: "/openai/v1/chat/completions", method: "POST", body: isClassifierRequestBody })
      .reply(200, sseBody([NO_DELEGATE_CLASSIFICATION]))
      .persist();
    mockAgent
      .get("https://api.groq.com")
      .intercept({ path: "/openai/v1/chat/completions", method: "POST" })
      .reply(200, sseBody(["MD AI ", "is online."]));

    const token = await pairedToken();
    const conv = await request(app).post("/conversations").set("Authorization", `Bearer ${token}`).send({ title: "e2e" });
    const conversationId = conv.body.data.id as string;

    const taskRes = await request(app)
      .post(`/conversations/${conversationId}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ parts: [{ type: "text", text: "status?" }], providerKeys: { groq: "gsk-test-1234567890" } });
    expect(taskRes.status).toBe(201);
    const taskId = taskRes.body.data.id as string;

    const frames = await collectTaskStream(`${wsBaseUrl}/ws/tasks/${taskId}?token=${token}`);
    const text = frames.map((f) => f.delta).filter(Boolean).join("");
    expect(text).toBe("MD AI is online.");
    expect(frames.at(-1)).toMatchObject({ kind: "status", state: "completed" });

    const tasksRes = await request(app).get(`/conversations/${conversationId}/tasks`).set("Authorization", `Bearer ${token}`);
    const task = tasksRes.body.data[0];
    expect(task.state).toBe("completed");
    expect(task.modelId).toContain("groq/");
    const agentMessage = task.messages.find((m: { role: string }) => m.role === "agent");
    expect(agentMessage.parts[0].text).toBe("MD AI is online.");

    const events = await pool.query("SELECT event_type FROM events WHERE task_id = $1 ORDER BY id", [taskId]);
    expect(events.rows.map((r) => r.event_type)).toEqual([
      "task.created",
      "task.started",
      "agent.started",
      "model.selected",
      "task.completed",
      "agent.completed",
    ]);
  });

  it("falls back to the second configured provider end-to-end when the first fails", async () => {
    mockAgent
      .get("https://api.groq.com")
      .intercept({ path: "/openai/v1/chat/completions", method: "POST", body: isClassifierRequestBody })
      .reply(200, sseBody([NO_DELEGATE_CLASSIFICATION]))
      .persist();
    mockAgent
      .get("https://openrouter.ai")
      .intercept({ path: "/api/v1/chat/completions", method: "POST", body: isClassifierRequestBody })
      .reply(200, sseBody([NO_DELEGATE_CLASSIFICATION]))
      .persist();
    mockAgent.get("https://api.groq.com").intercept({ path: "/openai/v1/chat/completions", method: "POST" }).reply(500, "server error");
    mockAgent
      .get("https://openrouter.ai")
      .intercept({ path: "/api/v1/chat/completions", method: "POST" })
      .reply(200, sseBody(["fallback ", "worked"]));

    const token = await pairedToken();
    const conv = await request(app).post("/conversations").set("Authorization", `Bearer ${token}`).send({});
    const conversationId = conv.body.data.id as string;

    const taskRes = await request(app)
      .post(`/conversations/${conversationId}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        parts: [{ type: "text", text: "hi" }],
        providerKeys: { groq: "gsk-primary-1234567890", openrouter: "sk-or-secondary-1234567890" },
        preferredProviderId: "groq",
      });
    const taskId = taskRes.body.data.id as string;

    const frames = await collectTaskStream(`${wsBaseUrl}/ws/tasks/${taskId}?token=${token}`);
    const text = frames.map((f) => f.delta).filter(Boolean).join("");
    expect(text).toBe("fallback worked");
    expect(frames.at(-1)).toMatchObject({ kind: "status", state: "completed" });

    const events = await pool.query("SELECT event_type, severity FROM events WHERE task_id = $1 ORDER BY id", [taskId]);
    expect(events.rows.map((r) => r.event_type)).toContain("model.switched");
  });

  it("marks the task failed and tells the WS client when every provider fails", async () => {
    mockAgent.get("https://api.groq.com").intercept({ path: "/openai/v1/chat/completions", method: "POST" }).reply(500, "server error");

    const token = await pairedToken();
    const conv = await request(app).post("/conversations").set("Authorization", `Bearer ${token}`).send({});
    const conversationId = conv.body.data.id as string;

    const taskRes = await request(app)
      .post(`/conversations/${conversationId}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ parts: [{ type: "text", text: "hi" }], providerKeys: { groq: "gsk-only-1234567890" } });
    const taskId = taskRes.body.data.id as string;

    const frames = await collectTaskStream(`${wsBaseUrl}/ws/tasks/${taskId}?token=${token}`);
    expect(frames.at(-1)).toMatchObject({ kind: "status", state: "failed" });

    const tasksRes = await request(app).get(`/conversations/${conversationId}/tasks`).set("Authorization", `Bearer ${token}`);
    expect(tasksRes.body.data[0].state).toBe("failed");
  });

  it("rejects a WS connection without a valid token", async () => {
    const token = await pairedToken();
    const conv = await request(app).post("/conversations").set("Authorization", `Bearer ${token}`).send({});
    const taskRes = await request(app)
      .post(`/conversations/${conv.body.data.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ parts: [{ type: "text", text: "hi" }], providerKeys: { groq: "gsk-x-1234567890" } });

    mockAgent.get("https://api.groq.com").intercept({ path: "/openai/v1/chat/completions", method: "POST" }).reply(200, sseBody(["ok"]));

    await expect(collectTaskStream(`${wsBaseUrl}/ws/tasks/${taskRes.body.data.id}?token=not-a-real-token`, 2000)).rejects.toThrow();
  });
});
