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
 * Clears per-run data between tests while leaving the seeded catalog rows
 * (providers, agents — migrations 0013/0014) in place, since integration
 * tests rely on those FK targets existing.
 */
export async function resetTestData(p: pg.Pool): Promise<void> {
  await p.query(`
    TRUNCATE TABLE
      audit_log, evolution_proposals, automation_runs, automations,
      tool_invocations, agent_tool_grants, bot_findings, bot_runs,
      memory_items, events, task_messages, tasks, conversations,
      model_call_samples, provider_default_models, provider_configs,
      device_sessions, owner, app_config
    RESTART IDENTITY CASCADE
  `);
}

export async function closeTestPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
