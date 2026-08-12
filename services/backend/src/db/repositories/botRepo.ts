import type pg from "pg";
import type { BotCategory, BotHealth, BotStatus } from "@mdai/shared-types";

export interface BotRow {
  id: string;
  display_name: string;
  description: string;
  schedule_cron: string;
  config: Record<string, unknown>;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
  version: string;
  category: BotCategory;
  status: BotStatus;
  capabilities: string[];
  health: BotHealth;
  health_detail: string | null;
  last_run_at: Date | null;
  last_successful_run_at: Date | null;
  failure_count: number;
  timeout_ms: number;
  owner: string;
}

export async function createBot(
  pool: pg.Pool,
  input: {
    id: string;
    displayName: string;
    description: string;
    scheduleCron: string;
    category?: BotCategory;
    capabilities?: string[];
    timeoutMs?: number;
    config?: Record<string, unknown>;
  },
): Promise<BotRow> {
  const { rows } = await pool.query<BotRow>(
    `INSERT INTO bots (id, display_name, description, schedule_cron, category, capabilities, timeout_ms, config)
     VALUES ($1, $2, $3, $4, COALESCE($5::text, 'general'), COALESCE($6::text[], '{}'::text[]), COALESCE($7::int, 30000), COALESCE($8::jsonb, '{}'::jsonb))
     ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, description = EXCLUDED.description,
       schedule_cron = EXCLUDED.schedule_cron, category = EXCLUDED.category, capabilities = EXCLUDED.capabilities,
       timeout_ms = EXCLUDED.timeout_ms, config = EXCLUDED.config, updated_at = now()
     RETURNING *`,
    [input.id, input.displayName, input.description, input.scheduleCron, input.category ?? null, input.capabilities ?? null, input.timeoutMs ?? null, input.config ?? null],
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to create bot");
  return row;
}

export async function listBots(pool: pg.Pool): Promise<BotRow[]> {
  const { rows } = await pool.query<BotRow>("SELECT * FROM bots ORDER BY id");
  return rows;
}

export async function getBot(pool: pg.Pool, id: string): Promise<BotRow | undefined> {
  const { rows } = await pool.query<BotRow>("SELECT * FROM bots WHERE id = $1", [id]);
  return rows[0];
}

export async function listEnabledBots(pool: pg.Pool): Promise<BotRow[]> {
  const { rows } = await pool.query<BotRow>(
    "SELECT * FROM bots WHERE enabled = true AND status != 'paused' ORDER BY id",
  );
  return rows;
}

export async function setBotEnabled(pool: pg.Pool, id: string, enabled: boolean): Promise<void> {
  await pool.query("UPDATE bots SET enabled = $2, updated_at = now() WHERE id = $1", [id, enabled]);
}

export async function setBotPaused(pool: pg.Pool, id: string, paused: boolean): Promise<void> {
  await pool.query(
    "UPDATE bots SET status = $2, updated_at = now() WHERE id = $1",
    [id, paused ? "paused" : "idle"],
  );
}

export async function markBotRunning(pool: pg.Pool, id: string): Promise<void> {
  await pool.query("UPDATE bots SET status = 'running', updated_at = now() WHERE id = $1", [id]);
}

export interface BotRunOutcomePatch {
  succeeded: boolean;
  health: BotHealth;
  healthDetail?: string;
}

/** Rolls a run's outcome back onto the bot's own descriptor — `status` returns to `idle` (never left `running`), `failureCount` resets on success and increments on failure, matching the same "health mutates on real transitions" pattern as `tools`/`agents`. */
export async function recordBotRunOutcome(pool: pg.Pool, id: string, patch: BotRunOutcomePatch): Promise<void> {
  await pool.query(
    `UPDATE bots SET
       status = 'idle',
       health = $2,
       health_detail = $3,
       last_run_at = now(),
       last_successful_run_at = CASE WHEN $4 THEN now() ELSE last_successful_run_at END,
       failure_count = CASE WHEN $4 THEN 0 ELSE failure_count + 1 END,
       updated_at = now()
     WHERE id = $1`,
    [id, patch.health, patch.healthDetail ?? null, patch.succeeded],
  );
}
