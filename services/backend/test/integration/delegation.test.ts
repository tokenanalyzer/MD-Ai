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
import { createReviewerAgent } from "../../src/core/agents/reviewer/reviewerAgent.js";
import type { BackendAgentRuntimeContext } from "../../src/core/agents/runtimeContext.js";

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
  return {
    intercept: { path: "/openai/v1/chat/completions", method: "POST" as const, body: (body: string) => body.includes(marker) },
    body: sseBody(deltas),
  };
}

describe("Master → Research → Reviewer delegation (M3)", () => {
  it("delegates, gets an APPROVE review, and synthesizes a final answer citing the findings", async () => {
    const classification = JSON.stringify({
      delegate: true,
      capability: "research",
      taskObjective: "Summarize what MD AI's Research Agent can do",
      memoryCommand: null,
      memoryCandidate: null,
    });
    const research = JSON.stringify({
      objective: "Summarize what MD AI's Research Agent can do",
      findings: [{ claim: "It structures findings with fact/assumption/uncertain labels.", kind: "fact", source: null }],
      limitations: ["web_search_unavailable — no MCP tool host is connected yet"],
      toolsUsed: [],
    });
    const review = JSON.stringify({ decision: "APPROVE", issues: [], summary: "Findings are well-labeled and honestly limited." });

    for (const r of [
      replyFor("intent classifier", [classification]),
      replyFor("Research Agent inside MD AI", [research]),
      replyFor("Reviewer inside MD AI", [review]),
      replyFor("Master Agent inside MD AI", ["Here is a summary ", "of the findings."]),
    ]) {
      mockAgent.get("https://api.groq.com").intercept(r.intercept).reply(200, r.body);
    }

    const token = await pairedToken();
    const conv = await request(app).post("/conversations").set("Authorization", `Bearer ${token}`).send({});
    const conversationId = conv.body.data.id as string;

    const taskRes = await request(app)
      .post(`/conversations/${conversationId}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        parts: [{ type: "text", text: "Please research what MD AI's Research Agent can do." }],
        providerKeys: { groq: "gsk-test-1234567890" },
      });
    expect(taskRes.status).toBe(201);
    const taskId = taskRes.body.data.id as string;

    const frames = await collectTaskStream(`${wsBaseUrl}/ws/tasks/${taskId}?token=${token}`, 8000);
    const text = frames.map((f) => f.delta).filter(Boolean).join("");
    expect(text).toBe("Here is a summary of the findings.");
    expect(frames.at(-1)).toMatchObject({ kind: "status", state: "completed" });
    expect(frames.some((f) => f.kind === "agent_progress")).toBe(true);

    const tasksRes = await request(app).get(`/conversations/${conversationId}/tasks`).set("Authorization", `Bearer ${token}`);
    const tasks = tasksRes.body.data as { taskType: string; state: string; assignedAgentId: string }[];
    expect(tasks.map((t) => `${t.assignedAgentId}:${t.taskType}:${t.state}`)).toEqual(
      expect.arrayContaining(["master:chat:completed", "research:research:completed", "reviewer:review:completed"]),
    );

    // Every task in this delegation tree shares correlation_id = the root
    // task's own id — join through it to see the whole tree's events, not
    // just the root task's own (events.task_id is per-task, not per-tree).
    const events = await pool.query(
      "SELECT e.event_type FROM events e JOIN tasks t ON t.id = e.task_id WHERE t.correlation_id = $1 ORDER BY e.id",
      [taskId],
    );
    expect(events.rows.map((r) => r.event_type)).toEqual([
      "task.created",
      "task.started",
      "agent.started",
      "task.created",
      "message.sent",
      "task.started",
      "agent.started",
      "task.completed",
      "agent.completed",
      "message.received",
      "task.created",
      "message.sent",
      "task.started",
      "agent.started",
      "review.started",
      "review.completed",
      "task.completed",
      "agent.completed",
      "message.received",
      "model.selected",
      "task.completed",
      "agent.completed",
    ]);
  });

  it("refuses to review another Reviewer task's output without ever calling the model", async () => {
    const reviewer = createReviewerAgent();
    let failure: { code: string; message: string; retryable: boolean } | undefined;
    const fakeCtx: BackendAgentRuntimeContext = {
      task: {
        id: "t-reviewer-self",
        assignedAgentId: "reviewer",
        taskType: "review",
        state: "working",
        input: {
          targetAgentId: "reviewer",
          targetTaskId: "t-earlier-review",
          result: { objective: "x", findings: [], limitations: [], toolsUsed: [] },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      history: [],
      emit: () => {},
      selectModel: async () => {
        throw new Error("must not select a model when refusing self-review");
      },
      completeChat: async () => {
        throw new Error("must not call the model when refusing self-review");
      },
      callTool: async () => {
        throw new Error("not used");
      },
      delegate: async () => {
        throw new Error("not used");
      },
      streamChat: async () => {
        throw new Error("not used");
      },
      addAssistantMessage: async () => {},
      finishCanceled: async () => {},
      start: async () => {},
      finishSuccess: async () => {
        throw new Error("must not report success when refusing self-review");
      },
      finishFailure: async (error) => {
        failure = error;
      },
      publishEvent: async () => {},
    };

    await reviewer.handleTask(fakeCtx);

    expect(failure?.code).toBe("reviewer_cannot_review_self");
  });
});
