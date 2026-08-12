import type pg from "pg";

export interface DeviceSessionRow {
  id: string;
  owner_id: string;
  device_name: string;
  platform: "android" | "pc" | "other";
  refresh_token_hash: string;
  push_token: string | null;
  last_seen_at: Date | null;
  created_at: Date;
  revoked_at: Date | null;
}

export async function createDeviceSession(
  pool: pg.Pool,
  input: {
    ownerId: string;
    deviceName: string;
    platform: "android" | "pc" | "other";
    refreshTokenHash: string;
    pushToken?: string;
  },
): Promise<DeviceSessionRow> {
  const { rows } = await pool.query<DeviceSessionRow>(
    `INSERT INTO device_sessions (owner_id, device_name, platform, refresh_token_hash, push_token)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [input.ownerId, input.deviceName, input.platform, input.refreshTokenHash, input.pushToken ?? null],
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to create device session");
  return row;
}

export async function findActiveSessionById(pool: pg.Pool, id: string): Promise<DeviceSessionRow | undefined> {
  const { rows } = await pool.query<DeviceSessionRow>(
    "SELECT * FROM device_sessions WHERE id = $1 AND revoked_at IS NULL",
    [id],
  );
  return rows[0];
}

export async function findActiveSessionByRefreshHash(
  pool: pg.Pool,
  refreshTokenHash: string,
): Promise<DeviceSessionRow | undefined> {
  const { rows } = await pool.query<DeviceSessionRow>(
    "SELECT * FROM device_sessions WHERE refresh_token_hash = $1 AND revoked_at IS NULL",
    [refreshTokenHash],
  );
  return rows[0];
}

export async function touchLastSeen(pool: pg.Pool, id: string): Promise<void> {
  await pool.query("UPDATE device_sessions SET last_seen_at = now() WHERE id = $1", [id]);
}

/** M5.13: push tokens rotate (Expo/FCM tokens are not permanent) — the app re-registers on every cold start, same "re-report on each success" pattern as `provider_configs.key_last4`. */
export async function updatePushToken(pool: pg.Pool, id: string, pushToken: string): Promise<void> {
  await pool.query("UPDATE device_sessions SET push_token = $2 WHERE id = $1", [id, pushToken]);
}

export async function revokeSession(pool: pg.Pool, id: string): Promise<void> {
  await pool.query("UPDATE device_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [id]);
}

export async function listActiveSessions(pool: pg.Pool, ownerId: string): Promise<DeviceSessionRow[]> {
  const { rows } = await pool.query<DeviceSessionRow>(
    "SELECT * FROM device_sessions WHERE owner_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC",
    [ownerId],
  );
  return rows;
}
