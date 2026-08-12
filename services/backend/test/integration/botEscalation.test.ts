import "../setupEnv.js";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { EventBus } from "../../src/core/events/eventBus.js";
import { ModelRegistryService } from "../../src/core/registry/modelRegistryService.js";
import { ToolRegistryService } from "../../src/core/mcp/toolRegistryService.js";
import { ensureOwner } from "../../src/db/repositories/ownerRepo.js";
import { createBot } from "../../src/db/repositories/botRepo.js";
import { createBotRun } from "../../src/db/repositories/botRunRepo.js";
import { upsertFinding, type BotFindingRow } from "../../src/db/repositories/botFindingRepo.js";
import { upsertBackgroundCredential } from "../../src/db/repositories/backgroundCredentialRepo.js";
import { encryptCredential, last4 } from "../../src/core/security/backgroundKeyVault.js";
import { escalateFinding } from "../../src/core/bots/escalation.js";
import { buildTestAgentRegistry } from "../helpers/appDeps.js";
import { getTestPool, resetTestData, closeTestPool } from "../helpers/testDb.js";

const pool = await getTestPool();
const { agentRegistry, toolRegistry } = buildTestAgentRegistry(pool);
const modelRegistry = new ModelRegistryService(pool);
const eventBus = new EventBus(pool);

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
  await pool.query("DELETE FROM bots WHERE id = 'escalation-test-bot'");
});

function sseBody(deltas: string[]): string {
  const events = deltas.map((d) => ({ choices: [{ delta: { content: d } }] }));
  events.push({ choices: [{ delta: {} as { content?: string }, finish_reason: "stop" } as never] });
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

function replyFor(marker: string, deltas: string[]) {
  mockAgent
    .get("https://api.groq.com")
    .intercept({ path: "/openai/v1/chat/completions", method: "POST", body: (b: string) => b.includes(marker) })
    .reply(200, sseBody(deltas));
}

async function makeFinding(): Promise<BotFindingRow> {
  await createBot(pool, { id: "escalation-test-bot", displayName: "Escalation Test Bot", description: "x", scheduleCron: "0 0 1 1 *" });
  const run = await createBotRun(pool, "escalation-test-bot");
  const { row } = await upsertFinding(pool, {
    botId: "escalation-test-bot",
    botRunId: run.id,
    finding: {
      category: "ai_release",
      title: "New Widget Model 2.0 released",
      summary: "Widget AI shipped version 2.0 with a larger context window.",
      importance: "high",
      confidence: 1,
      sourceMetadata: { url: "https://example.com/widget-2" },
      payload: {},
      dedupKey: "widget-2.0",
    },
  });
  return row;
}

describe("Bot -> Agent escalation (M5.12)", () => {
  it("returns undefined gracefully when no provider has been opted into the background vault", async () => {
    const finding = await makeFinding();
    const result = await escalateFinding({ pool, eventBus, modelRegistry, agentRegistry, toolRegistry }, finding);
    expect(result).toBeUndefined();
  });

  it("dispatches into Master's existing capability-discovery pipeline and returns an analyzed title/summary when a background credential is configured", async () => {
    const encrypted = encryptCredential("gsk-test-background-key-1234567890");
    await upsertBackgroundCredential(pool, "llm_provider", "groq", encrypted, last4("gsk-test-background-key-1234567890"));

    const classification = JSON.stringify({
      delegate: false,
      capability: null,
      taskObjective: null,
      memoryCommand: null,
      memoryCandidate: null,
    });
    replyFor("intent classifier", [classification]);
    replyFor("Master Agent inside MD AI", ["Widget AI 2.0 ships a larger context window."]);

    const finding = await makeFinding();
    const result = await escalateFinding({ pool, eventBus, modelRegistry, agentRegistry, toolRegistry }, finding);

    expect(result).toBeDefined();
    expect(result?.summary).toContain("Widget AI 2.0");
    expect(result?.taskId).toBeTruthy();

    // The background credential must never leak into the task/event trail.
    const events = await pool.query("SELECT payload FROM events WHERE task_id = $1", [result?.taskId]);
    expect(JSON.stringify(events.rows)).not.toContain("gsk-test-background-key-1234567890");
    const tasks = await pool.query("SELECT input, output FROM tasks WHERE id = $1", [result?.taskId]);
    expect(JSON.stringify(tasks.rows)).not.toContain("gsk-test-background-key-1234567890");
  });
});
