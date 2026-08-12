import type pg from "pg";
import type { AutomationTriggerType } from "./automationRepo.js";

export type AutomationRunStatus = "running" | "succeeded" | "failed" | "timeout";

export interface AutomationRunRow {
  id: string;
  automation_id: string;
  started_at: Date;
  finished_at: Date | null;
  status: AutomationRunStatus;
  result: Record<string, unknown> | null;
  error: string | null;
  trigger_type: AutomationTriggerType | null;
}

export async function createAutomationRun(pool: pg.Pool, automationId: string, triggerType: AutomationTriggerType): Promise<AutomationRunRow> {
  const { rows } = await pool.query<AutomationRunRow>(
    `INSERT INTO automation_runs (automation_id, status, trigger_type) VALUES ($1, 'running', $2) RETURNING *`,
    [automationId, triggerType],
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to create automation run");
  return row;
}

export async function completeAutomationRun(
  pool: pg.Pool,
  id: string,
  patch: { status: AutomationRunStatus; result?: Record<string, unknown>; error?: string },
): Promise<AutomationRunRow> {
  const { rows } = await pool.query<AutomationRunRow>(
    `UPDATE automation_runs SET status = $2, result = $3, error = $4, finished_at = now() WHERE id = $1 RETURNING *`,
    [id, patch.status, patch.result ?? null, patch.error ?? null],
  );
  const row = rows[0];
  if (!row) throw new Error(`Automation run ${id} not found`);
  return row;
}

export async function listRecentAutomationRuns(pool: pg.Pool, automationId: string, limit = 20): Promise<AutomationRunRow[]> {
  const { rows } = await pool.query<AutomationRunRow>(
    "SELECT * FROM automation_runs WHERE automation_id = $1 ORDER BY started_at DESC LIMIT $2",
    [automationId, limit],
  );
  return rows;
}

/** Mirrors `botRunRepo.listStuckBotRuns` — a run still `running` past its own automation's `timeout_ms` gets swept to `timeout` by the engine's recovery pass, so a crashed worker never leaves a run stuck `running` forever. */
export async function listStuckAutomationRuns(pool: pg.Pool): Promise<(AutomationRunRow & { timeout_ms: number })[]> {
  const { rows } = await pool.query<AutomationRunRow & { timeout_ms: number }>(
    `SELECT r.*, a.timeout_ms FROM automation_runs r
     JOIN automations a ON a.id = r.automation_id
     WHERE r.status = 'running'
       AND r.started_at < now() - (a.timeout_ms || ' milliseconds')::interval`,
  );
  return rows;
}
