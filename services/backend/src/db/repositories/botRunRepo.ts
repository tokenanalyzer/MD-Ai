import type pg from "pg";
import type { BotRunStatus } from "@mdai/shared-types";

export interface BotRunRow {
  id: string;
  bot_id: string;
  started_at: Date;
  finished_at: Date | null;
  status: BotRunStatus;
  error: string | null;
  error_code: string | null;
  findings_count: number;
  duration_ms: number | null;
  resource_metadata: Record<string, unknown>;
}

export async function createBotRun(pool: pg.Pool, botId: string): Promise<BotRunRow> {
  const { rows } = await pool.query<BotRunRow>(
    `INSERT INTO bot_runs (bot_id, status) VALUES ($1, 'running') RETURNING *`,
    [botId],
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to create bot run");
  return row;
}

export async function completeBotRun(
  pool: pg.Pool,
  id: string,
  patch: {
    status: BotRunStatus;
    error?: string;
    errorCode?: string;
    findingsCount: number;
    resourceMetadata?: Record<string, unknown>;
  },
): Promise<BotRunRow> {
  const { rows } = await pool.query<BotRunRow>(
    `UPDATE bot_runs SET
       status = $2, error = $3, error_code = $4, findings_count = $5,
       resource_metadata = $6, finished_at = now(),
       duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000
     WHERE id = $1 RETURNING *`,
    [id, patch.status, patch.error ?? null, patch.errorCode ?? null, patch.findingsCount, patch.resourceMetadata ?? {}],
  );
  const row = rows[0];
  if (!row) throw new Error(`Bot run ${id} not found`);
  return row;
}

export async function listRecentBotRuns(pool: pg.Pool, botId: string, limit = 20): Promise<BotRunRow[]> {
  const { rows } = await pool.query<BotRunRow>(
    "SELECT * FROM bot_runs WHERE bot_id = $1 ORDER BY started_at DESC LIMIT $2",
    [botId, limit],
  );
  return rows;
}

/** Runs still `running` past their bot's `timeout_ms` — the engine's own recovery sweep marks these `timeout` (M5.2/M5.17), since a crashed worker process can otherwise leave a run stuck forever. */
export async function listStuckBotRuns(pool: pg.Pool): Promise<(BotRunRow & { timeout_ms: number })[]> {
  const { rows } = await pool.query<BotRunRow & { timeout_ms: number }>(
    `SELECT r.*, b.timeout_ms FROM bot_runs r
     JOIN bots b ON b.id = r.bot_id
     WHERE r.status = 'running'
       AND r.started_at < now() - (b.timeout_ms || ' milliseconds')::interval`,
  );
  return rows;
}
