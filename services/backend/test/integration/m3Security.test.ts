import "../setupEnv.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import pino from "pino";
import { Redis } from "ioredis";
import { Writable } from "node:stream";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { createApp } from "../../src/api/app.js";
import { attachChatGateway } from "../../src/api/ws/chatGateway.js";
import { EventBus } from "../../src/core/events/eventBus.js";
import { ModelRegistryService } from "../../src/core/registry/modelRegistryService.js";
import { ensureOwner } from "../../src/db/repositories/ownerRepo.js";
import { generatePairingCode } from "../../src/core/security/pairing.js";
import { cancelTaskCascade, createTask } from "../../src/db/repositories/taskRepo.js";
import { getTestPool, resetTestData, closeTestPool } from "../helpers/testDb.js";
import { collectTaskStream } from "../helpers/wsClient.js";
import { buildTestAgentRegistry } from "../helpers/appDeps.js";

const pool = await getTestPool();
const redis = new Redis(process.env.REDIS_URL as string);

const capturedLogLines: string[] = [];
const captureStream = new Writable({
  write(chunk, _enc, callback) {
    capturedLogLines.push(chunk.toString());
    callback();
  },
});
const logger = pino({ level: "debug" }, captureStream);
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

describe("M3 security guarantees (M3.10)", () => {
  it("never persists the provider API key anywhere — tasks, events, memory, or logs — across a full delegation tree", async () => {
    const FAKE_KEY = "gsk-super-secret-should-never-leak-1234567890";

    replyFor(
      "intent classifier",
      [
        JSON.stringify({
          delegate: true,
          capability: "research",
          taskObjective: "Summarize A2A",
          memoryCommand: { action: "remember", content: "User cares about A2A." },
          memoryCandidate: null,
        }),
      ],
    );
    replyFor(
      "Research Agent inside MD AI",
      [JSON.stringify({ objective: "Summarize A2A", findings: [], limitations: ["web_search_unavailable"], toolsUsed: [] })],
    );
    replyFor("Reviewer inside MD AI", [JSON.stringify({ decision: "APPROVE", issues: [], summary: "Fine." })]);
    replyFor("Master Agent inside MD AI", ["All set."]);

    const token = await pairedToken();
    const conv = await request(app).post("/conversations").set("Authorization", `Bearer ${token}`).send({});
    const taskRes = await request(app)
      .post(`/conversations/${conv.body.data.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ parts: [{ type: "text", text: "Summarize A2A and remember I care about it." }], providerKeys: { groq: FAKE_KEY } });
    const taskId = taskRes.body.data.id as string;

    await collectTaskStream(`${wsBaseUrl}/ws/tasks/${taskId}?token=${token}`, 8000);

    const tasksDump = await pool.query("SELECT input, output, error FROM tasks");
    expect(JSON.stringify(tasksDump.rows)).not.toContain(FAKE_KEY);

    const eventsDump = await pool.query("SELECT payload FROM events");
    expect(JSON.stringify(eventsDump.rows)).not.toContain(FAKE_KEY);

    const memoryDump = await pool.query("SELECT content, summary FROM memory_items");
    expect(JSON.stringify(memoryDump.rows)).not.toContain(FAKE_KEY);

    const messagesDump = await pool.query("SELECT parts FROM task_messages");
    expect(JSON.stringify(messagesDump.rows)).not.toContain(FAKE_KEY);

    expect(capturedLogLines.join("\n")).not.toContain(FAKE_KEY);
  });
});

describe("A2A cascade cancellation (M3.4)", () => {
  it("cancels every still-in-flight task in a delegation tree but leaves already-completed ones alone", async () => {
    const root = await createTask(pool, { assignedAgentId: "master", taskType: "chat", inputPayload: {} });
    const inFlightChild = await createTask(pool, {
      assignedAgentId: "research",
      taskType: "research",
      inputPayload: {},
      correlationId: root.correlation_id ?? root.id,
      parentTaskId: root.id,
    });
    const completedChild = await createTask(pool, {
      assignedAgentId: "reviewer",
      taskType: "review",
      inputPayload: {},
      correlationId: root.correlation_id ?? root.id,
      parentTaskId: root.id,
    });
    await pool.query("UPDATE tasks SET state = 'working' WHERE id = $1", [inFlightChild.id]);
    await pool.query("UPDATE tasks SET state = 'completed' WHERE id = $1", [completedChild.id]);

    const canceledIds = await cancelTaskCascade(pool, root.correlation_id ?? root.id);

    expect(canceledIds.sort()).toEqual([root.id, inFlightChild.id].sort());

    const rows = await pool.query("SELECT id, state FROM tasks WHERE id = ANY($1) ORDER BY id", [
      [root.id, inFlightChild.id, completedChild.id],
    ]);
    const byId = new Map(rows.rows.map((r) => [r.id, r.state]));
    expect(byId.get(root.id)).toBe("canceled");
    expect(byId.get(inFlightChild.id)).toBe("canceled");
    expect(byId.get(completedChild.id)).toBe("completed");
  });
});
