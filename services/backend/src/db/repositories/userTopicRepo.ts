import type pg from "pg";
import type { FindingImportance } from "@mdai/shared-types";

export interface UserTopicRow {
  id: string;
  owner_id: string;
  topic: string;
  frequency_minutes: number;
  importance_threshold: FindingImportance;
  enabled: boolean;
  last_checked_at: Date | null;
  created_at: Date;
}

export async function listUserTopics(pool: pg.Pool, ownerId: string): Promise<UserTopicRow[]> {
  const { rows } = await pool.query<UserTopicRow>(
    "SELECT * FROM user_topics WHERE owner_id = $1 ORDER BY created_at",
    [ownerId],
  );
  return rows;
}

/** Topics due to be checked right now — `last_checked_at` is null (never run) or older than the topic's own `frequency_minutes`, letting each topic have an independent cadence within one bot. */
export async function listDueUserTopics(pool: pg.Pool): Promise<UserTopicRow[]> {
  const { rows } = await pool.query<UserTopicRow>(
    `SELECT * FROM user_topics
     WHERE enabled = true
       AND (last_checked_at IS NULL OR last_checked_at < now() - (frequency_minutes || ' minutes')::interval)`,
  );
  return rows;
}

export async function createUserTopic(
  pool: pg.Pool,
  input: { ownerId: string; topic: string; frequencyMinutes?: number; importanceThreshold?: FindingImportance },
): Promise<UserTopicRow> {
  const { rows } = await pool.query<UserTopicRow>(
    `INSERT INTO user_topics (owner_id, topic, frequency_minutes, importance_threshold)
     VALUES ($1, $2, COALESCE($3, 60), COALESCE($4, 'medium'))
     ON CONFLICT (owner_id, topic) DO UPDATE SET
       frequency_minutes = COALESCE($3, user_topics.frequency_minutes),
       importance_threshold = COALESCE($4, user_topics.importance_threshold),
       enabled = true
     RETURNING *`,
    [input.ownerId, input.topic, input.frequencyMinutes ?? null, input.importanceThreshold ?? null],
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to create user topic");
  return row;
}

export async function deleteUserTopic(pool: pg.Pool, ownerId: string, id: string): Promise<void> {
  await pool.query("DELETE FROM user_topics WHERE id = $1 AND owner_id = $2", [id, ownerId]);
}

export async function touchUserTopicChecked(pool: pg.Pool, id: string): Promise<void> {
  await pool.query("UPDATE user_topics SET last_checked_at = now() WHERE id = $1", [id]);
}
