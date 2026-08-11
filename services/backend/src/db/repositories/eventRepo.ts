import type pg from "pg";
import type { EventPayload, EventSeverity, EventSourceType } from "@mdai/shared-types";

export interface EventRow {
  id: number;
  event_type: string;
  source_type: EventSourceType;
  source_id: string;
  task_id: string | null;
  payload: EventPayload;
  severity: EventSeverity;
  created_at: Date;
}

export async function insertEvent(
  pool: pg.Pool,
  input: {
    sourceType: EventSourceType;
    sourceId: string;
    taskId?: string;
    severity: EventSeverity;
    payload: EventPayload;
  },
): Promise<EventRow> {
  const { rows } = await pool.query<EventRow>(
    `INSERT INTO events (event_type, source_type, source_id, task_id, payload, severity)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.payload.type, input.sourceType, input.sourceId, input.taskId ?? null, input.payload, input.severity],
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to insert event");
  return row;
}

export async function listEventsSince(
  pool: pg.Pool,
  input: { sinceId?: number; types?: string[]; limit?: number },
): Promise<EventRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (input.sinceId !== undefined) {
    params.push(input.sinceId);
    conditions.push(`id > $${params.length}`);
  }
  if (input.types && input.types.length > 0) {
    params.push(input.types);
    conditions.push(`event_type = ANY($${params.length})`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(input.limit ?? 200);

  const { rows } = await pool.query<EventRow>(
    `SELECT * FROM events ${where} ORDER BY id ASC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/** Deletes debug/info events older than the given number of days. Used by the events-retention BullMQ job. */
export async function pruneOldEvents(pool: pg.Pool, retentionDays: number): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM events WHERE severity IN ('debug', 'info') AND created_at < now() - ($1 || ' days')::interval`,
    [retentionDays],
  );
  return rowCount ?? 0;
}
