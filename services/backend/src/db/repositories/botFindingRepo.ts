import type pg from "pg";
import type { EscalationStatus, FindingImportance, FindingStatus, NormalizedFinding } from "@mdai/shared-types";

export interface BotFindingRow {
  id: string;
  bot_run_id: string;
  bot_id: string;
  payload: Record<string, unknown>;
  routed_task_id: string | null;
  created_at: Date;
  category: string;
  title: string;
  summary: string;
  importance: FindingImportance;
  confidence: string; // NUMERIC comes back as string from pg
  source_metadata: Record<string, unknown>;
  dedup_key: string;
  detected_at: Date;
  first_seen_at: Date;
  last_seen_at: Date;
  occurrence_count: number;
  cooldown_until: Date | null;
  status: FindingStatus;
  escalation_status: EscalationStatus;
  updated_at: Date;
}

export interface UpsertFindingResult {
  row: BotFindingRow;
  /** True only for the very first time `(botId, dedupKey)` was ever seen — a fresh row, not a repeat occurrence bumping an existing one (M5.5). */
  isNewFinding: boolean;
}

/**
 * Deterministic dedup (M5.5): `(bot_id, dedup_key)` is a stable identity —
 * `ON CONFLICT` bumps `occurrence_count`/`last_seen_at` on a repeat
 * detection instead of inserting a new row, which is what keeps a finding
 * visible across 12 hours of runs from producing 12 separate rows. The
 * `xmax = 0` check is the standard Postgres idiom for "was this an INSERT,
 * not an UPDATE" in an upsert's `RETURNING` clause.
 */
export async function upsertFinding(
  pool: pg.Pool,
  input: { botId: string; botRunId: string; finding: NormalizedFinding },
): Promise<UpsertFindingResult> {
  const f = input.finding;
  const { rows } = await pool.query<BotFindingRow & { inserted: boolean }>(
    `INSERT INTO bot_findings (
       bot_id, bot_run_id, category, title, summary, importance, confidence,
       source_metadata, payload, dedup_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (bot_id, dedup_key) DO UPDATE SET
       bot_run_id = EXCLUDED.bot_run_id,
       last_seen_at = now(),
       occurrence_count = bot_findings.occurrence_count + 1,
       -- The bot re-evaluates deterministically on every run, so the
       -- latest detection's importance/confidence/description simply
       -- replace the previous ones (no ordering comparison needed —
       -- importance is a text enum, not numeric).
       importance = EXCLUDED.importance,
       confidence = EXCLUDED.confidence,
       title = EXCLUDED.title,
       summary = EXCLUDED.summary,
       source_metadata = EXCLUDED.source_metadata,
       payload = EXCLUDED.payload,
       updated_at = now()
     RETURNING *, (xmax = 0) AS inserted`,
    [input.botId, input.botRunId, f.category, f.title, f.summary, f.importance, f.confidence, f.sourceMetadata, f.payload, f.dedupKey],
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to upsert bot finding");
  const { inserted, ...findingRow } = row;
  return { row: findingRow, isNewFinding: inserted };
}

export async function getFinding(pool: pg.Pool, id: string): Promise<BotFindingRow | undefined> {
  const { rows } = await pool.query<BotFindingRow>("SELECT * FROM bot_findings WHERE id = $1", [id]);
  return rows[0];
}

export async function setFindingCooldown(pool: pg.Pool, id: string, cooldownUntil: Date): Promise<void> {
  await pool.query("UPDATE bot_findings SET cooldown_until = $2, updated_at = now() WHERE id = $1", [id, cooldownUntil]);
}

export async function setFindingEscalationStatus(
  pool: pg.Pool,
  id: string,
  escalationStatus: EscalationStatus,
  routedTaskId?: string,
): Promise<void> {
  await pool.query(
    "UPDATE bot_findings SET escalation_status = $2, routed_task_id = COALESCE($3, routed_task_id), updated_at = now() WHERE id = $1",
    [id, escalationStatus, routedTaskId ?? null],
  );
}

export async function setFindingStatus(pool: pg.Pool, id: string, status: FindingStatus): Promise<void> {
  await pool.query("UPDATE bot_findings SET status = $2, updated_at = now() WHERE id = $1", [id, status]);
}

export async function listRecentFindings(pool: pg.Pool, botId?: string, limit = 50): Promise<BotFindingRow[]> {
  if (botId) {
    const { rows } = await pool.query<BotFindingRow>(
      "SELECT * FROM bot_findings WHERE bot_id = $1 ORDER BY last_seen_at DESC LIMIT $2",
      [botId, limit],
    );
    return rows;
  }
  const { rows } = await pool.query<BotFindingRow>(
    "SELECT * FROM bot_findings ORDER BY last_seen_at DESC LIMIT $1",
    [limit],
  );
  return rows;
}
