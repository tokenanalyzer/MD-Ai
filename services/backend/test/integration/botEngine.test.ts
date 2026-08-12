import "../setupEnv.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { Queue } from "bullmq";
import type { BotDefinition, BotRunContext, BotRunResult, NotificationSender } from "@mdai/shared-types";
import { EventBus } from "../../src/core/events/eventBus.js";
import { AgentRegistryService } from "../../src/core/agents/agentRegistryService.js";
import { ModelRegistryService } from "../../src/core/registry/modelRegistryService.js";
import { ToolRegistryService } from "../../src/core/mcp/toolRegistryService.js";
import { BotRegistryService } from "../../src/core/bots/botRegistryService.js";
import { BotEngine, MAX_CONCURRENT_BOT_RUNS } from "../../src/core/bots/botEngine.js";
import { createBot, getBot } from "../../src/db/repositories/botRepo.js";
import { listRecentBotRuns, listStuckBotRuns, createBotRun } from "../../src/db/repositories/botRunRepo.js";
import { ensureOwner } from "../../src/db/repositories/ownerRepo.js";
import { getTestPool, resetTestData, closeTestPool } from "../helpers/testDb.js";

const pool = await getTestPool();
const redis = new Redis(process.env.REDIS_URL as string);

const noopSender: NotificationSender = {
  async send() {
    return { delivered: [], failed: [] };
  },
};

let ownerId = "";

beforeEach(async () => {
  await resetTestData(pool);
  const owner = await ensureOwner(pool, "Test Owner");
  ownerId = owner.id;
});

afterAll(async () => {
  // Hygiene: this file is the only one that calls engine.start(), which
  // registers real BullMQ repeatable schedules in Redis for every enabled
  // bot (including the seeded production bots) — clean them out so they
  // don't linger in the shared test Redis instance across suite runs.
  const queue = new Queue("bot-engine", { connection: redis.duplicate() });
  const repeatables = await queue.getRepeatableJobs();
  await Promise.all(repeatables.map((r) => queue.removeRepeatableByKey(r.key)));
  await queue.close();

  await pool.query("DELETE FROM bots WHERE id LIKE 'test-%' OR id LIKE 'concurrency-bot-%'");
  await redis.quit();
  await closeTestPool();
});

function makeEngine(botRegistry: BotRegistryService) {
  return new BotEngine({
    pool,
    eventBus: new EventBus(pool),
    botRegistry,
    modelRegistry: new ModelRegistryService(pool),
    agentRegistry: new AgentRegistryService(pool),
    toolRegistry: new ToolRegistryService(pool),
    ownerId,
    notificationSender: noopSender,
  });
}

describe("Bot Engine run lifecycle (M5.1/M5.2/M5.3)", () => {
  it("runs a bot end-to-end: succeeds, records a BotRun, updates the bot's own health/last-run fields, and creates a finding", async () => {
    const botId = "test-succeeding-bot";
    await createBot(pool, { id: botId, displayName: "Test Bot", description: "A bot that always succeeds.", scheduleCron: "0 0 1 1 *", timeoutMs: 5000 });

    const registry = new BotRegistryService(pool);
    registry.register({
      id: botId,
      displayName: "Test Bot",
      description: "A bot that always succeeds.",
      version: "0.1.0",
      category: "general",
      scheduleCron: "0 0 1 1 *",
      defaultConfig: {},
      capabilities: [],
      timeoutMs: 5000,
      async run(): Promise<BotRunResult> {
        return {
          status: "succeeded",
          findings: [
            {
              category: "general",
              title: "Something happened",
              summary: "A deterministic detection.",
              importance: "low",
              confidence: 1,
              sourceMetadata: {},
              payload: {},
              dedupKey: "fixed-key",
            },
          ],
        };
      },
    });

    const engine = makeEngine(registry);
    await engine.start();
    try {
      const run = await engine.runNow(botId);
      expect(run.status).toBe("succeeded");
      expect(run.findingsCount).toBe(1);

      const botRow = await getBot(pool, botId);
      expect(botRow?.last_run_at).not.toBeNull();
      expect(botRow?.last_successful_run_at).not.toBeNull();
      expect(botRow?.health).toBe("healthy");
      expect(botRow?.failure_count).toBe(0);
      expect(botRow?.status).toBe("idle"); // returns to idle, never left "running"

      const events = await pool.query("SELECT event_type FROM events WHERE source_id = $1 ORDER BY id", [botId]);
      const types = events.rows.map((r) => r.event_type);
      expect(types).toEqual(
        expect.arrayContaining(["bot.started", "bot.run.started", "bot.run.completed", "bot.finding.created"]),
      );

      const finding = await pool.query("SELECT * FROM bot_findings WHERE bot_id = $1", [botId]);
      expect(finding.rows).toHaveLength(1);
      expect(finding.rows[0].occurrence_count).toBe(1);
    } finally {
      await engine.stop();
    }
  });

  it("records a failed run, increments failure_count, and rejects the run-now caller", async () => {
    const botId = "test-failing-bot";
    await createBot(pool, { id: botId, displayName: "Failing Bot", description: "Always throws.", scheduleCron: "0 0 1 1 *", timeoutMs: 5000 });

    const registry = new BotRegistryService(pool);
    registry.register({
      id: botId,
      displayName: "Failing Bot",
      description: "Always throws.",
      version: "0.1.0",
      category: "general",
      scheduleCron: "0 0 1 1 *",
      defaultConfig: {},
      capabilities: [],
      timeoutMs: 5000,
      async run(): Promise<BotRunResult> {
        throw new Error("simulated bot failure");
      },
    });

    const engine = makeEngine(registry);
    await engine.start();
    try {
      await expect(engine.runNow(botId)).rejects.toThrow();

      const runs = await listRecentBotRuns(pool, botId, 1);
      expect(runs[0]?.status).toBe("failed");
      expect(runs[0]?.error).toContain("simulated bot failure");

      const botRow = await getBot(pool, botId);
      expect(botRow?.failure_count).toBe(1);
      expect(botRow?.health).toBe("degraded");

      const failedEvents = await pool.query("SELECT event_type FROM events WHERE source_id = $1 AND event_type = 'bot.failed'", [botId]);
      expect(failedEvents.rows.length).toBeGreaterThan(0);
    } finally {
      await engine.stop();
    }
  });

  it("times out a bot that respects its AbortSignal but takes longer than timeoutMs", async () => {
    const botId = "test-timeout-bot";
    await createBot(pool, { id: botId, displayName: "Slow Bot", description: "Respects cancellation but is slow.", scheduleCron: "0 0 1 1 *", timeoutMs: 50 });

    const registry = new BotRegistryService(pool);
    registry.register({
      id: botId,
      displayName: "Slow Bot",
      description: "Respects cancellation but is slow.",
      version: "0.1.0",
      category: "general",
      scheduleCron: "0 0 1 1 *",
      defaultConfig: {},
      capabilities: [],
      timeoutMs: 50,
      async run(ctx: BotRunContext): Promise<BotRunResult> {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 5000);
          ctx.signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          });
        });
        return { status: "succeeded", findings: [] };
      },
    });

    const engine = makeEngine(registry);
    await engine.start();
    try {
      await expect(engine.runNow(botId)).rejects.toThrow();
      const runs = await listRecentBotRuns(pool, botId, 1);
      expect(runs[0]?.status).toBe("timeout");
      expect(runs[0]?.error_code).toBe("timeout");
    } finally {
      await engine.stop();
    }
  }, 10000);

  it("bounds global concurrency: at most MAX_CONCURRENT_BOT_RUNS bots run at once even when more are triggered simultaneously", async () => {
    const registry = new BotRegistryService(pool);
    let active = 0;
    let peak = 0;
    const botIds = ["concurrency-bot-1", "concurrency-bot-2", "concurrency-bot-3", "concurrency-bot-4"];

    for (const id of botIds) {
      await createBot(pool, { id, displayName: id, description: "Concurrency probe.", scheduleCron: "0 0 1 1 *", timeoutMs: 5000 });
      registry.register({
        id,
        displayName: id,
        description: "Concurrency probe.",
        version: "0.1.0",
        category: "general",
        scheduleCron: "0 0 1 1 *",
        defaultConfig: {},
        capabilities: [],
        timeoutMs: 5000,
        async run(): Promise<BotRunResult> {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 150));
          active--;
          return { status: "succeeded", findings: [] };
        },
      });
    }

    const engine = makeEngine(registry);
    await engine.start();
    try {
      await Promise.all(botIds.map((id) => engine.runNow(id)));
      expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_BOT_RUNS);
      expect(peak).toBeGreaterThan(0);
    } finally {
      await engine.stop();
    }
  }, 15000);
});

describe("Bot Engine recovery sweep (M5.2/M5.17)", () => {
  it("listStuckBotRuns finds a run that outlived its bot's timeout_ms, and ignores a recent one", async () => {
    const botId = "test-stuck-sweep-bot";
    await createBot(pool, { id: botId, displayName: "Stuck Bot", description: "For sweep testing.", scheduleCron: "0 0 1 1 *", timeoutMs: 1000 });

    const staleRun = await createBotRun(pool, botId);
    await pool.query("UPDATE bot_runs SET started_at = now() - interval '10 seconds' WHERE id = $1", [staleRun.id]);

    const freshRun = await createBotRun(pool, botId);

    const stuck = await listStuckBotRuns(pool);
    const stuckIds = stuck.map((r) => r.id);
    expect(stuckIds).toContain(staleRun.id);
    expect(stuckIds).not.toContain(freshRun.id);
  });
});
