import pg from "pg";
import { runMigrations } from "../../src/db/migrate.js";

let pool: pg.Pool | undefined;

/** Real Postgres against `mdai_test` (docs/architecture — same schema as dev/prod, just a separate database). */
export async function getTestPool(): Promise<pg.Pool> {
  if (!pool) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await runMigrations(pool);
  }
  return pool;
}

/**
 * The model_registry rows seeded by migrations 0015/0017/0023/0024 — the
 * only ones every test can rely on existing with known capability data.
 * Anything else is test-induced (discovery, manual edits) and must not
 * survive into the next test file.
 */
const SEEDED_MODEL_IDS = [
  "nvidia-nemotron/nvidia/llama-3.1-nemotron-70b-instruct",
  "nvidia-nemotron/nvidia/nemotron-3-super-120b-a12b",
  "gemini/gemini-1.5-flash",
  "gemini/gemini-2.5-flash",
  "gemini/gemini-3.5-flash",
  "groq/llama-3.3-70b-versatile",
  "groq/openai/gpt-oss-120b",
  "sambanova/Meta-Llama-3.1-70B-Instruct",
  "sambanova/Meta-Llama-3.3-70B-Instruct",
  "openrouter/meta-llama/llama-3.1-70b-instruct",
  "openrouter/meta-llama/llama-3.3-70b-instruct",
];

/**
 * Clears per-run data between tests while leaving the seeded catalog rows
 * (providers, agents — migrations 0013/0014) in place, since integration
 * tests rely on those FK targets existing. `model_registry` is special:
 * tests both read its seeded baseline AND mutate it (discovery, health
 * rollup, user config), so it's reset to that baseline rather than left
 * alone or fully truncated — either extreme breaks a different set of
 * tests.
 */
export async function resetTestData(p: pg.Pool): Promise<void> {
  // agent_tool_grants is seeded catalog data since migration 0019 (M4) —
  // same treatment as agent_delegation_edges/agents/tools, deliberately
  // NOT truncated here. tool_invocations remains per-run state. `bots`
  // (M5) gets the identical treatment: seeded catalog rows (migration
  // 0020), not truncated — bot_runs/bot_findings/notifications are the
  // per-run state. user_topics and background_provider_keys are
  // user-entered config (like provider_configs), truncated fresh per test.
  await p.query(`
    TRUNCATE TABLE
      audit_log, evolution_proposals, automation_runs, automations,
      tool_invocations, notifications, bot_findings, bot_runs,
      user_topics, background_credentials,
      memory_items, events, task_messages, tasks, conversations,
      model_call_samples, provider_default_models, provider_configs,
      device_sessions, owner, app_config
    RESTART IDENTITY CASCADE
  `);

  await p.query("DELETE FROM model_registry WHERE id != ALL($1)", [SEEDED_MODEL_IDS]);
  await p.query(`
    UPDATE model_registry SET
      availability = 'unknown', avg_latency_ms = NULL, error_rate_pct = NULL,
      user_enabled = true, user_priority = 0
    WHERE id = ANY($1)
  `, [SEEDED_MODEL_IDS]);

  // Same leakage risk as model_registry above: a test that disables an
  // agent (PATCH /agents/:id) or records a heartbeat must not affect
  // later tests/files sharing this database.
  await p.query(`UPDATE agents SET enabled = true, status = 'idle', last_heartbeat_at = NULL`);

  // Same leakage risk again: the MCP host records real health transitions
  // (healthy/degraded/unavailable) on every tool invocation.
  await p.query(`UPDATE tools SET enabled = true, health = 'unknown', health_detail = NULL, last_verified_at = NULL`);

  // Same leakage risk again: the Bot Engine records real run outcomes
  // (status/health/last_run_at/failure_count) onto the seeded `bots` rows.
  await p.query(`
    UPDATE bots SET
      enabled = true, status = 'idle', health = 'unknown', health_detail = NULL,
      last_run_at = NULL, last_successful_run_at = NULL, failure_count = 0
  `);
}

export async function closeTestPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
