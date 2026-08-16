import "../setupEnv.js";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { Queue } from "bullmq";
import pino from "pino";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { EventBus } from "../../src/core/events/eventBus.js";
import { ModelRegistryService } from "../../src/core/registry/modelRegistryService.js";
import { AutomationEngine, AUTOMATION_ENGINE_QUEUE_NAME } from "../../src/core/automations/automationEngine.js";
import { createAutomation, getAutomation } from "../../src/db/repositories/automationRepo.js";
import { listRecentAutomationRuns, listStuckAutomationRuns, createAutomationRun } from "../../src/db/repositories/automationRunRepo.js";
import { upsertBackgroundCredential } from "../../src/db/repositories/backgroundCredentialRepo.js";
import { encryptCredential, last4 } from "../../src/core/security/backgroundKeyVault.js";
import { ensureOwner } from "../../src/db/repositories/ownerRepo.js";
import { buildTestAgentRegistry } from "../helpers/appDeps.js";
import { getTestPool, resetTestData, closeTestPool } from "../helpers/testDb.js";
import type { NotificationSender } from "@mdai/shared-types";

const pool = await getTestPool();
const redis = new Redis(process.env.REDIS_URL as string);

const noopSender: NotificationSender = {
  async send() {
    return { delivered: [], failed: [] };
  },
};

const logger = pino({ level: "silent" });

let ownerId = "";
let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;

beforeEach(async () => {
  await resetTestData(pool);
  const owner = await ensureOwner(pool, "Test Owner");
  ownerId = owner.id;
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
  // Hygiene: this file is the only one that calls engine.start() with a
  // trigger_type='schedule' automation, which registers a real BullMQ
  // repeatable job in the shared test Redis instance — clean it out (same
  // convention as botEngine.test.ts).
  const queue = new Queue(AUTOMATION_ENGINE_QUEUE_NAME, { connection: redis.duplicate() });
  const repeatables = await queue.getRepeatableJobs();
  await Promise.all(repeatables.map((r) => queue.removeRepeatableByKey(r.key)));
  await queue.close();

  await redis.quit();
  await closeTestPool();
});

function makeEngine(eventBus: EventBus = new EventBus(pool)) {
  const { agentRegistry, toolRegistry } = buildTestAgentRegistry(pool);
  return new AutomationEngine({
    pool,
    eventBus,
    modelRegistry: new ModelRegistryService(pool),
    agentRegistry,
    toolRegistry,
    ownerId,
    notificationSender: noopSender,
    logger,
  });
}

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

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitFor timed out");
}

describe("Automation Engine dispatch — every action_type funnels into a pre-existing gated pipeline (M10)", () => {
  it("action_type=notification reuses the exact M5.13 notifyForFinding pipeline and records a notifications row", async () => {
    const automation = await createAutomation(pool, {
      name: "Notify test",
      triggerType: "manual",
      actionType: "notification",
      actionConfig: { title: "Heads up", summary: "Something happened", importance: "high" },
    });

    const engine = makeEngine();
    await engine.start();
    try {
      const run = await engine.runNow(automation.id, "manual");
      expect(run.status).toBe("succeeded");
      expect(run.result).toMatchObject({ notified: true });

      const notif = await pool.query("SELECT title, summary, importance FROM notifications WHERE title = 'Heads up'");
      expect(notif.rows).toHaveLength(1);
      expect(notif.rows[0]).toMatchObject({ title: "Heads up", summary: "Something happened", importance: "high" });

      const completed = await pool.query(
        "SELECT payload FROM events WHERE event_type = 'automation.run.completed' AND source_id = $1",
        [automation.id],
      );
      expect(completed.rows).toHaveLength(1);
      expect(completed.rows[0].payload).toMatchObject({ status: "succeeded" });
    } finally {
      await engine.stop();
    }
  });

  it("action_type=n8n_workflow POSTs to the configured webhookUrl via safeFetch and records the response", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/n8n-hook", method: "POST", body: (b: string) => b.includes('"triggeredAt"') })
      .reply(200, "ok", { headers: { "content-type": "text/plain" } });

    const automation = await createAutomation(pool, {
      name: "n8n test",
      triggerType: "manual",
      actionType: "n8n_workflow",
      actionConfig: { webhookUrl: "https://example.com/n8n-hook" },
    });

    const engine = makeEngine();
    await engine.start();
    try {
      const run = await engine.runNow(automation.id, "manual");
      expect(run.status).toBe("succeeded");
      expect(run.result).toMatchObject({ status: 200 });
    } finally {
      await engine.stop();
    }
  });

  it("action_type=agent_task dispatches through Master's exact handleTask entry point (same one bot escalation and chat use), and the background credential never leaks into events/tasks", async () => {
    const encrypted = encryptCredential("gsk-test-automation-key-1234567890");
    await upsertBackgroundCredential(pool, "llm_provider", "groq", encrypted, last4("gsk-test-automation-key-1234567890"));

    const classification = JSON.stringify({
      delegate: false,
      capability: null,
      taskObjective: null,
      memoryCommand: null,
      memoryCandidate: null,
    });
    replyFor("intent classifier", [classification]);
    replyFor("Master Agent inside MD AI", ["Automation-triggered reply text."]);

    const automation = await createAutomation(pool, {
      name: "Agent task test",
      triggerType: "manual",
      actionType: "agent_task",
      actionConfig: { prompt: "Summarize today's findings" },
    });

    const engine = makeEngine();
    await engine.start();
    try {
      const run = await engine.runNow(automation.id, "manual");
      expect(run.status).toBe("succeeded");
      expect((run.result as { text?: string })?.text).toContain("Automation-triggered reply");
      expect((run.result as { taskId?: string })?.taskId).toBeTruthy();

      const taskId = (run.result as { taskId: string }).taskId;
      const events = await pool.query("SELECT payload FROM events WHERE task_id = $1", [taskId]);
      expect(JSON.stringify(events.rows)).not.toContain("gsk-test-automation-key-1234567890");
      const tasks = await pool.query("SELECT input, output FROM tasks WHERE id = $1", [taskId]);
      expect(JSON.stringify(tasks.rows)).not.toContain("gsk-test-automation-key-1234567890");
    } finally {
      await engine.stop();
    }
  });

  it("action_type=agent_task with no background LLM credential opted in is skipped honestly rather than crashing", async () => {
    const automation = await createAutomation(pool, {
      name: "No credential test",
      triggerType: "manual",
      actionType: "agent_task",
      actionConfig: { prompt: "Do something" },
    });

    const engine = makeEngine();
    await engine.start();
    try {
      const run = await engine.runNow(automation.id, "manual");
      expect(run.status).toBe("succeeded");
      expect(run.result).toMatchObject({ skipped: expect.any(String) });
    } finally {
      await engine.stop();
    }
  });

  it("records a failed run and publishes automation.failed when the n8n endpoint returns a non-2xx status", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/broken-hook", method: "POST" })
      .reply(500, "server error");

    const automation = await createAutomation(pool, {
      name: "Failing n8n test",
      triggerType: "manual",
      actionType: "n8n_workflow",
      actionConfig: { webhookUrl: "https://example.com/broken-hook" },
    });

    const engine = makeEngine();
    await engine.start();
    try {
      // A failed BullMQ job rejects `waitUntilFinished` — runNow() itself
      // throws; the persisted run row (not the resolved value) is where
      // the real status/error live, same convention as botEngine.test.ts's
      // "records a failed run" case.
      await expect(engine.runNow(automation.id, "manual")).rejects.toThrow();

      const runs = await listRecentAutomationRuns(pool, automation.id, 1);
      expect(runs[0]?.status).toBe("failed");
      expect(runs[0]?.error).toContain("500");

      const failed = await pool.query(
        "SELECT payload FROM events WHERE event_type = 'automation.failed' AND source_id = $1",
        [automation.id],
      );
      expect(failed.rows).toHaveLength(1);
      expect(failed.rows[0].payload).toMatchObject({ errorCode: "run_failed" });
    } finally {
      await engine.stop();
    }
  });

  it("aborts a slow n8n call at the automation's own timeout_ms and marks the run 'timeout'", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/slow-hook", method: "POST" })
      .reply(200, "eventually")
      .delay(2000);

    const automation = await createAutomation(pool, {
      name: "Slow n8n test",
      triggerType: "manual",
      actionType: "n8n_workflow",
      actionConfig: { webhookUrl: "https://example.com/slow-hook" },
      timeoutMs: 100,
    });

    const engine = makeEngine();
    await engine.start();
    try {
      await expect(engine.runNow(automation.id, "manual")).rejects.toThrow();

      const runs = await listRecentAutomationRuns(pool, automation.id, 1);
      expect(runs[0]?.status).toBe("timeout");

      const failed = await pool.query(
        "SELECT payload FROM events WHERE event_type = 'automation.failed' AND source_id = $1",
        [automation.id],
      );
      expect(failed.rows[0].payload).toMatchObject({ errorCode: "timeout" });
    } finally {
      await engine.stop();
    }
  }, 10000);
});

describe("Automation Engine trigger_type wiring (M10)", () => {
  it("trigger_type='schedule' registers a real BullMQ repeatable job at start(), matching the automation's cron", async () => {
    const automation = await createAutomation(pool, {
      name: "Scheduled test",
      triggerType: "schedule",
      triggerConfig: { cron: "0 0 1 1 *" },
      actionType: "notification",
      actionConfig: { title: "Yearly", summary: "x" },
    });

    const engine = makeEngine();
    await engine.start();
    try {
      const repeatables = await engine.getQueue()!.getRepeatableJobs();
      // queue.add()'s first argument (the job name) is the automation id.
      const mine = repeatables.find((r) => r.name === automation.id);
      expect(mine).toBeDefined();
      expect(mine?.pattern).toBe("0 0 1 1 *");
    } finally {
      await engine.stop();
    }
  });

  it("an automation with a syntactically invalid cron string is skipped and logged, not fatal to start() (Cloud Run bootstrap regression)", async () => {
    // trigger_config is an open record (createAutomationBodySchema never
    // validates cron syntax at creation time), so this is a real, reachable
    // state — not a hypothetical. Before the fix, BullMQ's cron-parser
    // throwing inside queue.add() here would reject start() and abort the
    // whole backend's bootstrap for every automation, not just this one.
    const broken = await createAutomation(pool, {
      name: "Broken cron",
      triggerType: "schedule",
      triggerConfig: { cron: "not a valid cron expression" },
      actionType: "notification",
      actionConfig: { title: "x", summary: "x" },
    });
    const healthy = await createAutomation(pool, {
      name: "Healthy cron",
      triggerType: "schedule",
      triggerConfig: { cron: "0 0 1 1 *" },
      actionType: "notification",
      actionConfig: { title: "x", summary: "x" },
    });

    const engine = makeEngine();
    await expect(engine.start()).resolves.toBeUndefined();
    try {
      const repeatables = await engine.getQueue()!.getRepeatableJobs();
      expect(repeatables.find((r) => r.name === broken.id)).toBeUndefined();
      const healthyJob = repeatables.find((r) => r.name === healthy.id);
      expect(healthyJob).toBeDefined();
      expect(healthyJob?.pattern).toBe("0 0 1 1 *");
    } finally {
      await engine.stop();
    }
  });

  it("trigger_type='event' runs when a matching event is published, and never re-triggers from an automation-sourced event (cascade prevention)", async () => {
    const automation = await createAutomation(pool, {
      name: "Event-triggered test",
      triggerType: "event",
      triggerConfig: { eventType: "bot.finding.created" },
      actionType: "notification",
      actionConfig: { title: "Finding seen", summary: "x" },
    });

    // EventBus wraps an in-process EventEmitter, not Redis pub/sub, so the
    // test must publish through the SAME instance the engine subscribed
    // to at start() — a second `new EventBus(pool)` would be a distinct
    // emitter the engine never hears.
    const eventBus = new EventBus(pool);
    const engine = makeEngine(eventBus);
    await engine.start();
    try {
      await eventBus.publish({
        sourceType: "bot",
        sourceId: "some-bot",
        payload: { type: "bot.finding.created", botId: "some-bot", botRunId: "run-1", findingId: "finding-1", category: "general", importance: "high" },
      });

      await waitFor(async () => {
        const runs = await listRecentAutomationRuns(pool, automation.id, 5);
        return runs.some((r) => r.status === "succeeded");
      });

      const runsAfterBotEvent = await listRecentAutomationRuns(pool, automation.id, 10);
      expect(runsAfterBotEvent.length).toBe(1);

      // Structural cascade guard: AutomationEngine.handleEvent's very first
      // check is `if (row.source_type === "automation") return;` —
      // published here with source_type='automation' to exercise that
      // exact branch regardless of payload shape realism.
      await eventBus.publish({
        sourceType: "automation",
        sourceId: "some-other-automation",
        payload: { type: "bot.finding.created", botId: "some-bot", botRunId: "run-2", findingId: "finding-2", category: "general", importance: "high" },
      });

      // Give any (wrongly) enqueued job a moment to have run, then assert
      // the run count did not grow.
      await new Promise((r) => setTimeout(r, 300));
      const runsAfterAutomationEvent = await listRecentAutomationRuns(pool, automation.id, 10);
      expect(runsAfterAutomationEvent.length).toBe(1);
    } finally {
      await engine.stop();
    }
  }, 10000);
});

describe("Automation Engine recovery sweep (M10, mirrors M5.17's Bot Engine sweep)", () => {
  it("listStuckAutomationRuns finds a run that outlived its automation's timeout_ms, and ignores a recent one", async () => {
    const automation = await createAutomation(pool, {
      name: "Stuck sweep test",
      triggerType: "manual",
      actionType: "notification",
      actionConfig: { title: "x", summary: "x" },
      timeoutMs: 1000,
    });

    const staleRun = await createAutomationRun(pool, automation.id, "manual");
    await pool.query("UPDATE automation_runs SET started_at = now() - interval '10 seconds' WHERE id = $1", [staleRun.id]);
    const freshRun = await createAutomationRun(pool, automation.id, "manual");

    const stuck = await listStuckAutomationRuns(pool);
    const stuckIds = stuck.map((r) => r.id);
    expect(stuckIds).toContain(staleRun.id);
    expect(stuckIds).not.toContain(freshRun.id);
  });

  it("markAutomationRan / getAutomation round-trips last_run_at after a run", async () => {
    const automation = await createAutomation(pool, {
      name: "Last-run test",
      triggerType: "manual",
      actionType: "notification",
      actionConfig: { title: "x", summary: "x" },
    });
    expect((await getAutomation(pool, automation.id))?.last_run_at).toBeNull();

    const engine = makeEngine();
    await engine.start();
    try {
      await engine.runNow(automation.id, "manual");
      expect((await getAutomation(pool, automation.id))?.last_run_at).not.toBeNull();
    } finally {
      await engine.stop();
    }
  });
});
