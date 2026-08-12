import type pg from "pg";

export interface AuditLogRow {
  id: string;
  actor: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

/**
 * Append-only audit trail (migration `0012_evolution_audit.sql`, table
 * pre-dates any writer — M8 is the first thing that actually writes to
 * it): key-vault access, approval decisions, Guardian interventions,
 * config changes. `metadata` must never contain secret material.
 */
export async function writeAuditLog(
  pool: pg.Pool,
  entry: { actor: string; action: string; targetType?: string; targetId?: string; metadata?: Record<string, unknown> },
): Promise<AuditLogRow> {
  const { rows } = await pool.query<AuditLogRow>(
    `INSERT INTO audit_log (actor, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [entry.actor, entry.action, entry.targetType ?? null, entry.targetId ?? null, entry.metadata ?? {}],
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to write audit log entry");
  return row;
}

export async function listAuditLog(pool: pg.Pool, limit = 100): Promise<AuditLogRow[]> {
  const { rows } = await pool.query<AuditLogRow>("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1", [limit]);
  return rows;
}
