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
import { makeFakeCtx } from "../helpers/fakeRuntimeContext.js";

const pool = await getTestPool();
const redis = new Redis(process.env.REDIS_URL as string);
const logger = pino({ level: "silent" });
const modelRegistry = new ModelRegistryService(pool);
const { agentRegistry, memoryEngine, toolRegistry } = buildTestAgentRegistry(pool);
const app = createApp({ pool, redis, queues: [], eventBus: new EventBus(pool), modelRegistry, agentRegistry, memoryEngine, toolRegistry, logger });

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
      // Research's real web_search attempt (M4) — no search provider key
      // is configured in this test, so it fails honestly (tool.failed),
      // exactly the disclosed-limitation path researchAgent.ts handles.
      "tool.discovered",
      "tool.permission.checked",
      "tool.selected",
      "tool.called",
      "tool.failed",
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

  it("bounces one REVISE through a second research attempt with the reviewer's feedback, then APPROVEs", async () => {
    const classification = JSON.stringify({
      delegate: true,
      capability: "research",
      taskObjective: "How many model providers does MD AI support?",
      memoryCommand: null,
      memoryCandidate: null,
    });
    const researchAttempt1 = JSON.stringify({
      objective: "How many model providers does MD AI support?",
      findings: [{ claim: "MD AI supports five providers exactly.", kind: "fact", source: null }],
      limitations: ["web_search_unavailable"],
      toolsUsed: [],
    });
    const reviewRevise = JSON.stringify({
      decision: "REVISE",
      issues: [{ type: "unsupported_claim", description: "Labeled as fact with no live verification available." }],
      summary: "The provider count should be labeled less confidently.",
    });
    const researchAttempt2 = JSON.stringify({
      objective: "How many model providers does MD AI support?",
      findings: [{ claim: "MD AI supports five providers, per model training data with no live verification.", kind: "assumption", source: null }],
      limitations: ["web_search_unavailable"],
      toolsUsed: [],
    });
    const reviewApprove = JSON.stringify({ decision: "APPROVE", issues: [], summary: "Now appropriately hedged." });

    for (const r of [
      replyFor("intent classifier", [classification]),
      // The revision attempt's prompt embeds the reviewer's feedback text
      // (see researchAgent.ts's revisionNote) — match on that rather than
      // request order, since both research calls hit the same endpoint.
      replyFor("previously flagged issues", [researchAttempt2]),
      replyFor("Research Agent inside MD AI", [researchAttempt1]),
      replyFor("MD AI supports five providers exactly", [reviewRevise]),
      replyFor("no live verification", [reviewApprove]),
      replyFor("Master Agent inside MD AI", ["Five providers, ", "per available documentation."]),
    ]) {
      mockAgent.get("https://api.groq.com").intercept(r.intercept).reply(200, r.body);
    }

    const token = await pairedToken();
    const conv = await request(app).post("/conversations").set("Authorization", `Bearer ${token}`).send({});
    const taskRes = await request(app)
      .post(`/conversations/${conv.body.data.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        parts: [{ type: "text", text: "How many model providers does MD AI support?" }],
        providerKeys: { groq: "gsk-test-1234567890" },
      });
    const taskId = taskRes.body.data.id as string;

    const frames = await collectTaskStream(`${wsBaseUrl}/ws/tasks/${taskId}?token=${token}`, 8000);
    const text = frames.map((f) => f.delta).filter(Boolean).join("");
    expect(text).toBe("Five providers, per available documentation.");
    expect(frames.at(-1)).toMatchObject({ kind: "status", state: "completed" });

    const tasksRes = await request(app).get(`/conversations/${conv.body.data.id}/tasks`).set("Authorization", `Bearer ${token}`);
    const tasks = tasksRes.body.data as { taskType: string; assignedAgentId: string; state: string }[];
    expect(tasks.filter((t) => t.assignedAgentId === "research")).toHaveLength(2);
    expect(tasks.filter((t) => t.assignedAgentId === "reviewer")).toHaveLength(2);
    expect(tasks.every((t) => t.state === "completed")).toBe(true);

    const decisions = await pool.query(
      "SELECT e.payload->>'decision' AS decision FROM events e JOIN tasks t ON t.id = e.task_id WHERE t.correlation_id = $1 AND e.event_type = 'review.completed' ORDER BY e.id",
      [taskId],
    );
    expect(decisions.rows.map((r) => r.decision)).toEqual(["REVISE", "APPROVE"]);
  });

  it("stops after one REJECT (no further revision attempts) and still completes the chat honestly", async () => {
    const classification = JSON.stringify({
      delegate: true,
      capability: "research",
      taskObjective: "What was MD AI's revenue last quarter?",
      memoryCommand: null,
      memoryCandidate: null,
    });
    const research = JSON.stringify({
      objective: "What was MD AI's revenue last quarter?",
      findings: [{ claim: "MD AI generated $4.2M in revenue last quarter.", kind: "fact", source: null }],
      limitations: ["web_search_unavailable"],
      toolsUsed: [],
    });
    const reject = JSON.stringify({
      decision: "REJECT",
      issues: [{ type: "hallucination_risk", description: "Specific financial figures invented with no tool access." }],
      summary: "Fabricated a specific number with no basis; unusable.",
    });

    for (const r of [
      replyFor("intent classifier", [classification]),
      replyFor("Research Agent inside MD AI", [research]),
      replyFor("Reviewer inside MD AI", [reject]),
      replyFor("Master Agent inside MD AI", ["I don't have ", "a verified answer for that."]),
    ]) {
      mockAgent.get("https://api.groq.com").intercept(r.intercept).reply(200, r.body);
    }

    const token = await pairedToken();
    const conv = await request(app).post("/conversations").set("Authorization", `Bearer ${token}`).send({});
    const taskRes = await request(app)
      .post(`/conversations/${conv.body.data.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        parts: [{ type: "text", text: "What was MD AI's revenue last quarter?" }],
        providerKeys: { groq: "gsk-test-1234567890" },
      });
    const taskId = taskRes.body.data.id as string;

    const frames = await collectTaskStream(`${wsBaseUrl}/ws/tasks/${taskId}?token=${token}`, 8000);
    expect(frames.at(-1)).toMatchObject({ kind: "status", state: "completed" });

    const tasksRes = await request(app).get(`/conversations/${conv.body.data.id}/tasks`).set("Authorization", `Bearer ${token}`);
    const tasks = tasksRes.body.data as { taskType: string; assignedAgentId: string; state: string }[];
    // Exactly one research attempt — REJECT does not trigger the revision loop.
    expect(tasks.filter((t) => t.assignedAgentId === "research")).toHaveLength(1);
    expect(tasks.filter((t) => t.assignedAgentId === "reviewer")).toHaveLength(1);

    const decisions = await pool.query(
      "SELECT e.payload->>'decision' AS decision FROM events e JOIN tasks t ON t.id = e.task_id WHERE t.correlation_id = $1 AND e.event_type = 'review.completed'",
      [taskId],
    );
    expect(decisions.rows.map((r) => r.decision)).toEqual(["REJECT"]);
  });

  it("refuses to review another Reviewer task's output without ever calling the model", async () => {
    const reviewer = createReviewerAgent();
    let failure: { code: string; message: string; retryable: boolean } | undefined;
    const fakeCtx = makeFakeCtx(
      {
        id: "t-reviewer-self",
        assignedAgentId: "reviewer",
        taskType: "review",
        state: "working",
        input: {
          targetAgentId: "reviewer",
          targetTaskId: "t-earlier-review",
          result: { objective: "x", findings: [], limitations: [], toolsUsed: [] },
        },
      },
      { finishFailure: async (error) => void (failure = error) },
    );

    await reviewer.handleTask(fakeCtx);

    expect(failure?.code).toBe("reviewer_cannot_review_self");
  });
});
