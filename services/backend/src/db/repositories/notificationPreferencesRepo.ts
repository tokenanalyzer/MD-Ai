import type pg from "pg";
import type { FindingImportance } from "@mdai/shared-types";

export interface NotificationPreferencesRow {
  owner_id: string;
  enabled: boolean;
  minimum_importance: FindingImportance;
  quiet_hours_start_minute: number | null;
  quiet_hours_end_minute: number | null;
  quiet_hours_timezone: string;
  muted_topics: string[];
  muted_bot_ids: string[];
  muted_categories: string[];
  updated_at: Date;
}

/** Default-conservative row (`minimum_importance = 'high'`, no quiet hours, nothing muted) — created lazily the first time preferences are read or written, same "single owner row" pattern as `owner` itself. */
export async function getOrCreateNotificationPreferences(pool: pg.Pool, ownerId: string): Promise<NotificationPreferencesRow> {
  const { rows } = await pool.query<NotificationPreferencesRow>(
    `INSERT INTO notification_preferences (owner_id) VALUES ($1)
     ON CONFLICT (owner_id) DO UPDATE SET owner_id = EXCLUDED.owner_id
     RETURNING *`,
    [ownerId],
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to load notification preferences");
  return row;
}

export interface NotificationPreferencesPatch {
  enabled?: boolean;
  minimumImportance?: FindingImportance;
  quietHoursStartMinute?: number | null;
  quietHoursEndMinute?: number | null;
  quietHoursTimezone?: string;
  mutedTopics?: string[];
  mutedBotIds?: string[];
  mutedCategories?: string[];
}

export async function updateNotificationPreferences(
  pool: pg.Pool,
  ownerId: string,
  patch: NotificationPreferencesPatch,
): Promise<NotificationPreferencesRow> {
  const current = await getOrCreateNotificationPreferences(pool, ownerId);
  const { rows } = await pool.query<NotificationPreferencesRow>(
    `UPDATE notification_preferences SET
       enabled = $2, minimum_importance = $3,
       quiet_hours_start_minute = $4, quiet_hours_end_minute = $5, quiet_hours_timezone = $6,
       muted_topics = $7, muted_bot_ids = $8, muted_categories = $9,
       updated_at = now()
     WHERE owner_id = $1 RETURNING *`,
    [
      ownerId,
      patch.enabled ?? current.enabled,
      patch.minimumImportance ?? current.minimum_importance,
      patch.quietHoursStartMinute === undefined ? current.quiet_hours_start_minute : patch.quietHoursStartMinute,
      patch.quietHoursEndMinute === undefined ? current.quiet_hours_end_minute : patch.quietHoursEndMinute,
      patch.quietHoursTimezone ?? current.quiet_hours_timezone,
      patch.mutedTopics ?? current.muted_topics,
      patch.mutedBotIds ?? current.muted_bot_ids,
      patch.mutedCategories ?? current.muted_categories,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to update notification preferences");
  return row;
}
