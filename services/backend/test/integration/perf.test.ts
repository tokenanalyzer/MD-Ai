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

const pool = await getTestPool();
const redis = new Redis(process.env.REDIS_URL as string);
const logger = pino({ level: "silent" });
const modelRegistry = new ModelRegistryService(pool);
const { agentRegistry, memoryEngine } = buildTestAgentRegistry(pool);
const app = createApp({ pool, redis, queues: [], eventBus: new EventBus(pool), modelRegistry, agentRegistry, memoryEngine, logger });

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

function replyFor(marker: string, deltas: string[]) {
  mockAgent
    .get("https://api.groq.com")
    .intercept({ path: "/openai/v1/chat/completions", method: "POST", body: (b: string) => b.includes(marker) })
    .reply(200, sseBody(deltas));
}

async function tableCounts(): Promise<Record<string, number>> {
  const tables = ["tasks", "task_messages", "events", "model_call_samples"];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const { rows } = await pool.query<{ count: string }>(`SELECT count(*) FROM ${t}`);
    out[t] = Number(rows[0]?.count ?? 0);
  }
  return out;
}

/**
 * M3.12: not a claim about Oracle hardware (no such box is available in
 * this sandbox — same honesty rule as Android device testing) but a real,
 * repeatable local measurement of what M3's own bookkeeping costs, isolated
 * from provider network/inference latency (which is mocked at ~0ms here and
 * entirely outside MD AI's control anyway): DB write footprint per turn,
 * and this Node process's RSS growth across many turns, which is what
 * actually matters for staying inside the Oracle 2 OCPU/12GB budget.
 */
describe("M3 performance measurement (M3.12)", () => {
  it("measures the DB write footprint of a direct-answer turn vs. a full delegation-tree turn", async () => {
    replyFor(
      "intent classifier",
      [JSON.stringify({ delegate: false, capability: null, taskObjective: null, memoryCommand: null, memoryCandidate: null })],
    );
    replyFor("Master Agent inside MD AI", ["Direct answer."]);

    const token = await pairedToken();
    const conv = await request(app).post("/conversations").set("Authorization", `Bearer ${token}`).send({});

    const before = await tableCounts();
    const taskRes = await request(app)
      .post(`/conversations/${conv.body.data.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ parts: [{ type: "text", text: "hi" }], providerKeys: { groq: "gsk-1" } });
    await collectTaskStream(`${wsBaseUrl}/ws/tasks/${taskRes.body.data.id}?token=${token}`, 8000);
    const after = await tableCounts();

    const directAnswerDelta = {
      tasks: after.tasks! - before.tasks!,
      task_messages: after.task_messages! - before.task_messages!,
      events: after.events! - before.events!,
      model_call_samples: after.model_call_samples! - before.model_call_samples!,
    };
    // eslint-disable-next-line no-console
    console.log("[M3.12] direct-answer turn DB row delta:", directAnswerDelta);

    // A direct-answer turn is one task, two messages (user+agent), and a
    // small fixed event count — this is the floor every chat turn costs
    // regardless of delegation, since M3 always classifies intent first.
    expect(directAnswerDelta.tasks).toBe(1);
    expect(directAnswerDelta.task_messages).toBe(2);
    expect(directAnswerDelta.events).toBeLessThanOrEqual(6);
    expect(directAnswerDelta.model_call_samples).toBe(2); // classification + synthesis
  });

  it("measures the DB write footprint of a full Master->Research->Reviewer turn and process RSS growth over repeated turns", async () => {
    replyFor(
      "intent classifier",
      [
        JSON.stringify({
          delegate: true,
          capability: "research",
          taskObjective: "Summarize A2A",
          memoryCommand: null,
          memoryCandidate: null,
        }),
      ],
    );
    replyFor(
      "Research Agent inside MD AI",
      [JSON.stringify({ objective: "Summarize A2A", findings: [], limitations: ["web_search_unavailable"], toolsUsed: [] })],
    );
    replyFor("Reviewer inside MD AI", [JSON.stringify({ decision: "APPROVE", issues: [], summary: "Fine." })]);
    replyFor("Master Agent inside MD AI", ["Delegated answer."]);

    const token = await pairedToken();
    const conv = await request(app).post("/conversations").set("Authorization", `Bearer ${token}`).send({});

    const before = await tableCounts();
    const taskRes = await request(app)
      .post(`/conversations/${conv.body.data.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ parts: [{ type: "text", text: "Please summarize A2A" }], providerKeys: { groq: "gsk-1" } });
    const start = process.hrtime.bigint();
    await collectTaskStream(`${wsBaseUrl}/ws/tasks/${taskRes.body.data.id}?token=${token}`, 8000);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const after = await tableCounts();

    const delegationDelta = {
      tasks: after.tasks! - before.tasks!,
      task_messages: after.task_messages! - before.task_messages!,
      events: after.events! - before.events!,
      model_call_samples: after.model_call_samples! - before.model_call_samples!,
    };
    // eslint-disable-next-line no-console
    console.log(
      `[M3.12] delegation-tree turn DB row delta: ${JSON.stringify(delegationDelta)}` +
        ` — backend-side wall time (mocked provider calls, so this excludes real inference/network latency): ${elapsedMs.toFixed(1)}ms`,
    );

    // Three tasks (master, research, reviewer), four model calls
    // (classification + research + review + synthesis), a bounded, small
    // event count for the whole tree.
    expect(delegationDelta.tasks).toBe(3);
    expect(delegationDelta.model_call_samples).toBe(4);
    expect(delegationDelta.events).toBeLessThanOrEqual(22);

    if (global.gc) global.gc();
    const rssBefore = process.memoryUsage().rss;
    const ITERATIONS = 15;
    for (let i = 0; i < ITERATIONS; i++) {
      const t = await request(app)
        .post(`/conversations/${conv.body.data.id}/messages`)
        .set("Authorization", `Bearer ${token}`)
        .send({ parts: [{ type: "text", text: `turn ${i}` }], providerKeys: { groq: "gsk-1" } });
      await collectTaskStream(`${wsBaseUrl}/ws/tasks/${t.body.data.id}?token=${token}`, 8000);
    }
    if (global.gc) global.gc();
    const rssAfter = process.memoryUsage().rss;
    const rssDeltaMb = (rssAfter - rssBefore) / (1024 * 1024);
    // eslint-disable-next-line no-console
    console.log(
      `[M3.12] process RSS after ${ITERATIONS} more delegation-tree turns: ${(rssAfter / 1024 / 1024).toFixed(1)}MB` +
        ` (delta ${rssDeltaMb.toFixed(1)}MB, ${(rssDeltaMb / ITERATIONS).toFixed(2)}MB/turn)` +
        (global.gc ? "" : " — run with `node --expose-gc` for a cleaner reading; this number includes uncollected garbage"),
    );

    // Generous bound: this is a smoke check against an obvious per-turn
    // leak (e.g. a runtimeContext closure, a chatStreamHub entry, or a
    // model-registry cache never being released), not a tight budget —
    // the linger-then-delete behavior in chatStreamHub.ts means recently
    // finished tasks' buffers are still held for up to 30s by design.
    expect(rssDeltaMb / ITERATIONS).toBeLessThan(20);
  });
});
