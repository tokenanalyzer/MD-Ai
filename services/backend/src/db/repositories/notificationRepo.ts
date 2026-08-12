import type pg from "pg";
import type { FindingImportance, NotificationStatus, NotificationSuppressedReason } from "@mdai/shared-types";

export interface NotificationRow {
  id: string;
  finding_id: string | null;
  title: string;
  summary: string;
  importance: FindingImportance;
  deep_link: string;
  status: NotificationStatus;
  suppressed_reason: NotificationSuppressedReason | null;
  error: string | null;
  sent_at: Date | null;
  created_at: Date;
}

export async function createNotification(
  pool: pg.Pool,
  input: { findingId?: string; title: string; summary: string; importance: FindingImportance; deepLink: string },
): Promise<NotificationRow> {
  const { rows } = await pool.query<NotificationRow>(
    `INSERT INTO notifications (finding_id, title, summary, importance, deep_link)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [input.findingId ?? null, input.title, input.summary, input.importance, input.deepLink],
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to create notification");
  return row;
}

export async function markNotificationSuppressed(pool: pg.Pool, id: string, reason: NotificationSuppressedReason): Promise<void> {
  await pool.query("UPDATE notifications SET status = 'suppressed', suppressed_reason = $2 WHERE id = $1", [id, reason]);
}

export async function markNotificationSent(pool: pg.Pool, id: string): Promise<void> {
  await pool.query("UPDATE notifications SET status = 'sent', sent_at = now() WHERE id = $1", [id]);
}

export async function markNotificationFailed(pool: pg.Pool, id: string, error: string): Promise<void> {
  await pool.query("UPDATE notifications SET status = 'failed', error = $2 WHERE id = $1", [id, error]);
}

export async function listRecentNotifications(pool: pg.Pool, limit = 50): Promise<NotificationRow[]> {
  const { rows } = await pool.query<NotificationRow>("SELECT * FROM notifications ORDER BY created_at DESC LIMIT $1", [limit]);
  return rows;
}
