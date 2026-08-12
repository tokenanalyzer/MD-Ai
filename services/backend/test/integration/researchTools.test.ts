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
  mockAgent
    .get("https://api.groq.com")
    .intercept({ path: "/openai/v1/chat/completions", method: "POST", body: (b: string) => b.includes(marker) })
    .reply(200, sseBody(deltas));
}

describe("Research Agent real tool use (M4.10)", () => {
  it("searches, reads a source, cites the real retrieved URL, and strips a fabricated one", async () => {
    mockAgent
      .get("https://api.search.brave.com")
      .intercept({ path: (p: string) => p.startsWith("/res/v1/web/search"), method: "GET" })
      .reply(200, {
        web: {
          results: [
            {
              title: "A2A Protocol Overview",
              url: "https://example.com/a2a-overview",
              description: "An overview of the Agent2Agent protocol.",
            },
          ],
        },
      });
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/a2a-overview", method: "GET" })
      .reply(200, "<html><head><title>A2A Overview</title></head><body><p>A2A defines Task and AgentCard concepts.</p></body></html>", {
        headers: { "content-type": "text/html" },
      });

    const classification = JSON.stringify({
      delegate: true,
      capability: "research",
      taskObjective: "What does the A2A protocol define?",
      memoryCommand: null,
      memoryCandidate: null,
    });
    // The model is instructed to only cite the real retrieved URL; it also
    // tries to sneak in a fabricated one, which the agent must strip.
    const research = JSON.stringify({
      objective: "What does the A2A protocol define?",
      findings: [
        { claim: "A2A defines Task and AgentCard concepts.", kind: "fact", source: "https://example.com/a2a-overview" },
        { claim: "A2A was created in 2019.", kind: "fact", source: "https://fabricated-source.example/a2a-history" },
      ],
      limitations: [],
      toolsUsed: ["web_search", "url_reader"],
    });
    const review = JSON.stringify({ decision: "APPROVE", issues: [], summary: "Grounded in the retrieved source." });

    replyFor("intent classifier", [classification]);
    replyFor("Research Agent inside MD AI", [research]);
    replyFor("Reviewer inside MD AI", [review]);
    replyFor("Master Agent inside MD AI", ["A2A defines Task and AgentCard concepts."]);

    const token = await pairedToken();
    const conv = await request(app).post("/conversations").set("Authorization", `Bearer ${token}`).send({});
    const taskRes = await request(app)
      .post(`/conversations/${conv.body.data.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        parts: [{ type: "text", text: "What does the A2A protocol define?" }],
        providerKeys: { groq: "gsk-test-1234567890" },
        toolKeys: { brave: "test-brave-key" },
      });
    const taskId = taskRes.body.data.id as string;

    const frames = await collectTaskStream(`${wsBaseUrl}/ws/tasks/${taskId}?token=${token}`, 8000);
    expect(frames.at(-1)).toMatchObject({ kind: "status", state: "completed" });
    expect(frames.some((f) => f.kind === "agent_progress" && f.label?.includes("Searching"))).toBe(true);
    expect(frames.some((f) => f.kind === "agent_progress" && f.label?.includes("Reading"))).toBe(true);

    const tasksRes = await request(app).get(`/conversations/${conv.body.data.id}/tasks`).set("Authorization", `Bearer ${token}`);
    const researchTask = (tasksRes.body.data as { assignedAgentId: string; taskType: string }[]).find(
      (t) => t.assignedAgentId === "research" && t.taskType === "research",
    );
    expect(researchTask).toBeDefined();

    const rows = await pool.query("SELECT output FROM tasks WHERE assigned_agent_id = 'research' AND task_type = 'research'");
    const output = rows.rows[0]?.output as { findings: { claim: string; source: string | null; kind: string }[] };
    const grounded = output.findings.find((f) => f.claim.includes("Task and AgentCard"));
    const fabricated = output.findings.find((f) => f.claim.includes("2019"));

    expect(grounded?.source).toBe("https://example.com/a2a-overview");
    // The fabricated source was never actually retrieved — it must be
    // stripped and downgraded, never passed through as a real citation.
    expect(fabricated?.source).toBeNull();
    expect(fabricated?.kind).toBe("uncertain");

    const toolEvents = await pool.query(
      "SELECT e.event_type, e.payload FROM events e JOIN tasks t ON t.id = e.task_id WHERE t.correlation_id = $1 AND e.event_type LIKE 'tool.%' ORDER BY e.id",
      [taskId],
    );
    const types = toolEvents.rows.map((r) => r.event_type);
    expect(types).toEqual(
      expect.arrayContaining([
        "tool.discovered",
        "tool.permission.checked",
        "tool.selected",
        "tool.called",
        "tool.completed",
      ]),
    );
    // Never leak the tool credential onto the event bus.
    expect(JSON.stringify(toolEvents.rows)).not.toContain("test-brave-key");

    const invocations = await pool.query("SELECT tool_id, status, output FROM tool_invocations ORDER BY created_at");
    expect(invocations.rows.map((r) => r.tool_id)).toEqual(expect.arrayContaining(["web_search", "url_reader"]));
    expect(invocations.rows.every((r) => r.status === "succeeded")).toBe(true);
  });

  it("returns ToolNotAvailableError honestly when no search provider key is supplied — never fabricates results", async () => {
    const classification = JSON.stringify({
      delegate: true,
      capability: "research",
      taskObjective: "What is MD AI?",
      memoryCommand: null,
      memoryCandidate: null,
    });
    const research = JSON.stringify({
      objective: "What is MD AI?",
      findings: [{ claim: "MD AI is a personal AI system.", kind: "assumption", source: null }],
      limitations: [],
      toolsUsed: [],
    });
    const review = JSON.stringify({ decision: "APPROVE", issues: [], summary: "Fine." });

    replyFor("intent classifier", [classification]);
    replyFor("Research Agent inside MD AI", [research]);
    replyFor("Reviewer inside MD AI", [review]);
    replyFor("Master Agent inside MD AI", ["MD AI is a personal AI system."]);

    const token = await pairedToken();
    const conv = await request(app).post("/conversations").set("Authorization", `Bearer ${token}`).send({});
    const taskRes = await request(app)
      .post(`/conversations/${conv.body.data.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ parts: [{ type: "text", text: "What is MD AI?" }], providerKeys: { groq: "gsk-1" } });
    const taskId = taskRes.body.data.id as string;

    await collectTaskStream(`${wsBaseUrl}/ws/tasks/${taskId}?token=${token}`, 8000);

    const rows = await pool.query("SELECT output FROM tasks WHERE assigned_agent_id = 'research' AND task_type = 'research'");
    const output = rows.rows[0]?.output as { limitations: string[] };
    expect(output.limitations.some((l) => l.includes("web_search_unavailable"))).toBe(true);

    const failedTool = await pool.query("SELECT status, error_code FROM tool_invocations WHERE tool_id = 'web_search'");
    expect(failedTool.rows[0]).toMatchObject({ status: "failed", error_code: "tool_not_available" });
  });
});
