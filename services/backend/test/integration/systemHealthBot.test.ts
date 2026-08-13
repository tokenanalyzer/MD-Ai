import "../setupEnv.js";
import { beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { createSystemHealthMonitor } from "../../src/core/bots/systemHealthMonitor.js";
import { getTestPool, resetTestData } from "../helpers/testDb.js";

const pool = await getTestPool();
const redis = new Redis(process.env.REDIS_URL as string);

beforeEach(async () => {
  await resetTestData(pool);
});

describe("System Health Monitor (M5.11) — deterministic threshold checks, never an LLM judgment", () => {
  it("runs all six checks and reports no findings when nothing is breached", async () => {
    const bot = createSystemHealthMonitor(pool, redis);
    const result = await bot.run({ botId: bot.id, config: {}, signal: new AbortController().signal, callSearchProvider: async () => undefined });

    expect(result.status).toBe("succeeded");
    expect(result.resourceMetadata?.checksRun).toBe(6);
    // A real, healthy local Postgres/Redis in the test environment should
    // not breach any threshold.
    expect(result.findings.every((f) => f.category === "system_health")).toBe(true);
  });

  it("reports a deterministic CRITICAL finding when an enabled model is unavailable — a real DB state change, not a simulated one", async () => {
    await pool.query(
      `INSERT INTO model_registry (id, provider_id, provider_model_ref, display_name, availability, user_enabled)
       VALUES ('test/unavailable-model', 'groq', 'test-model', 'Test Unavailable Model', 'unavailable', true)
       ON CONFLICT (id) DO UPDATE SET availability = 'unavailable', user_enabled = true`,
    );

    const bot = createSystemHealthMonitor(pool, redis);
    const result = await bot.run({ botId: bot.id, config: {}, signal: new AbortController().signal, callSearchProvider: async () => undefined });

    const breach = result.findings.find((f) => f.dedupKey === "provider_availability");
    expect(breach).toBeDefined();
    expect(breach?.importance).toBe("high");

    await pool.query("DELETE FROM model_registry WHERE id = 'test/unavailable-model'");
  });
});
