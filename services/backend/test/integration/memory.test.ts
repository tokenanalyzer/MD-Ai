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
import { insertMemory } from "../../src/db/repositories/memoryRepo.js";

const pool = await getTestPool();
const redis = new Redis(process.env.REDIS_URL as string);
const logger = pino({ level: "silent" });
const modelRegistry = new ModelRegistryService(pool);
const { agentRegistry, memoryEngine, toolRegistry, botRegistry, botEngine, automationEngine } = buildTestAgentRegistry(pool);
const app = createApp({ pool, redis, queues: [], eventBus: new EventBus(pool), modelRegistry, agentRegistry, memoryEngine, toolRegistry, botRegistry, botEngine, automationEngine, logger });

let server: Server;
let wsBaseUrl: string;

beforeAll(async () => {
  server = createServer(app);
  attachChatGateway(server, pool);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
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

function mockClassification(json: string): void {
  mockAgent
    .get("https://api.groq.com")
    .intercept({ path: "/openai/v1/chat/completions", method: "POST", body: (b: string) => b.includes("intent classifier") })
    .reply(200, sseBody([json]));
}

function mockFinalAnswer(deltas: string[]): void {
  mockAgent
    .get("https://api.groq.com")
    .intercept({ path: "/openai/v1/chat/completions", method: "POST", body: (b: string) => b.includes("Master Agent inside MD AI") })
    .reply(200, sseBody(deltas));
}

describe("Memory subsystem (M3.6/M3.7)", () => {
  it("REST: creates an approved memory that's immediately searchable", async () => {
    const token = await pairedToken();
    const created = await request(app)
      .post("/memory")
      .set("Authorization", `Bearer ${token}`)
      .send({ category: "preferences", content: "Prefers terse, direct answers." });
    expect(created.status).toBe(201);
    expect(created.body.data.approvalStatus).toBe("approved");

    const found = await request(app).post("/memory/search").set("Authorization", `Bearer ${token}`).send({ query: "terse" });
    expect(found.body.data.map((m: { id: string }) => m.id)).toContain(created.body.data.id);
  });

  it("REST: a pending item is invisible to search until approved, then visible", async () => {
    const row = await insertMemory(pool, {
      category: "knowledge",
      content: "System-proposed candidate about deployment region.",
      source: "system_proposed",
      approvalStatus: "pending",
    });

    const token = await pairedToken();
    const beforeApproval = await request(app)
      .post("/memory/search")
      .set("Authorization", `Bearer ${token}`)
      .send({ query: "deployment region" });
    expect(beforeApproval.body.data.map((m: { id: string }) => m.id)).not.toContain(row.id);

    const pending = await request(app).get("/memory/pending").set("Authorization", `Bearer ${token}`);
    expect(pending.body.data.map((m: { id: string }) => m.id)).toContain(row.id);

    const approve = await request(app).post(`/memory/${row.id}/approve`).set("Authorization", `Bearer ${token}`).send();
    expect(approve.body.data.approvalStatus).toBe("approved");

    const afterApproval = await request(app)
      .post("/memory/search")
      .set("Authorization", `Bearer ${token}`)
      .send({ query: "deployment region" });
    expect(afterApproval.body.data.map((m: { id: string }) => m.id)).toContain(row.id);
  });

  it("chat: an explicit 'Remember this' command stores an approved memory sourced from the user's own instruction", async () => {
    mockClassification(
      JSON.stringify({
        delegate: false,
        capability: null,
        taskObjective: null,
        memoryCommand: { action: "remember", content: "I prefer dark-themed UI." },
        memoryCandidate: null,
      }),
    );
    mockFinalAnswer(["Got it, ", "I'll remember that."]);

    const token = await pairedToken();
    const conv = await request(app).post("/conversations").set("Authorization", `Bearer ${token}`).send({});
    const taskRes = await request(app)
      .post(`/conversations/${conv.body.data.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ parts: [{ type: "text", text: "Remember this: I prefer dark-themed UI." }], providerKeys: { groq: "gsk-1" } });

    const frames = await collectTaskStream(`${wsBaseUrl}/ws/tasks/${taskRes.body.data.id}?token=${token}`, 8000);
    expect(frames.at(-1)).toMatchObject({ kind: "status", state: "completed" });

    const rows = await pool.query("SELECT content, source, approval_status FROM memory_items");
    expect(rows.rows).toEqual([
      expect.objectContaining({ content: "I prefer dark-themed UI.", source: "user_command", approval_status: "approved" }),
    ]);
  });

  it("chat: an explicit 'Forget this' command soft-deletes the matching memory", async () => {
    await insertMemory(pool, { category: "preferences", content: "Likes dark-themed UI.", source: "user_command" });

    mockClassification(
      JSON.stringify({
        delegate: false,
        capability: null,
        taskObjective: null,
        memoryCommand: { action: "forget", content: "dark-themed UI" },
        memoryCandidate: null,
      }),
    );
    mockFinalAnswer(["Done, ", "forgotten."]);

    const token = await pairedToken();
    const conv = await request(app).post("/conversations").set("Authorization", `Bearer ${token}`).send({});
    const taskRes = await request(app)
      .post(`/conversations/${conv.body.data.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ parts: [{ type: "text", text: "Forget that I like dark-themed UI." }], providerKeys: { groq: "gsk-1" } });

    const frames = await collectTaskStream(`${wsBaseUrl}/ws/tasks/${taskRes.body.data.id}?token=${token}`, 8000);
    expect(frames.at(-1)).toMatchObject({ kind: "status", state: "completed" });

    const remaining = await pool.query("SELECT id FROM memory_items WHERE deleted_at IS NULL");
    expect(remaining.rows).toEqual([]);
  });

  it("chat: a system-proposed candidate is stored pending, not auto-approved, and never storing every conversation turn by default", async () => {
    mockClassification(
      JSON.stringify({
        delegate: false,
        capability: null,
        taskObjective: null,
        memoryCommand: null,
        memoryCandidate: { category: "projects", content: "User is building MD AI, a personal AI OS.", confidence: 0.8 },
      }),
    );
    mockFinalAnswer(["Sure, ", "here's an answer."]);

    const token = await pairedToken();
    const conv = await request(app).post("/conversations").set("Authorization", `Bearer ${token}`).send({});
    const taskRes = await request(app)
      .post(`/conversations/${conv.body.data.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ parts: [{ type: "text", text: "By the way, I'm building MD AI, a personal AI OS." }], providerKeys: { groq: "gsk-1" } });

    await collectTaskStream(`${wsBaseUrl}/ws/tasks/${taskRes.body.data.id}?token=${token}`, 8000);

    const rows = await pool.query("SELECT approval_status FROM memory_items");
    expect(rows.rows).toEqual([expect.objectContaining({ approval_status: "pending" })]);

    const searchable = await request(app).post("/memory/search").set("Authorization", `Bearer ${token}`).send({ query: "MD AI" });
    expect(searchable.body.data).toEqual([]);
  });

  it("chat: retrieves relevant approved memory before responding and publishes memory.retrieved (ids/count only)", async () => {
    await insertMemory(pool, { category: "preferences", content: "Always answer in a concise, direct style.", source: "user_command" });

    mockClassification(
      JSON.stringify({ delegate: false, capability: null, taskObjective: null, memoryCommand: null, memoryCandidate: null }),
    );
    mockFinalAnswer(["A concise ", "answer."]);

    const token = await pairedToken();
    const conv = await request(app).post("/conversations").set("Authorization", `Bearer ${token}`).send({});
    const taskRes = await request(app)
      .post(`/conversations/${conv.body.data.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ parts: [{ type: "text", text: "What's your answer style?" }], providerKeys: { groq: "gsk-1" } });

    await collectTaskStream(`${wsBaseUrl}/ws/tasks/${taskRes.body.data.id}?token=${token}`, 8000);

    const events = await pool.query("SELECT payload FROM events WHERE task_id = $1 AND event_type = 'memory.retrieved'", [
      taskRes.body.data.id,
    ]);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].payload.count).toBeGreaterThan(0);
    expect(Array.isArray(events.rows[0].payload.memoryIds)).toBe(true);
    // Never the memory content itself on the event bus (docs/architecture/07-security-model.md).
    expect(JSON.stringify(events.rows[0].payload)).not.toContain("concise");
  });
});
