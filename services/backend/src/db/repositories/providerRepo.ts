import type pg from "pg";

export interface ProviderRow {
  id: string;
  display_name: string;
  base_url: string | null;
  docs_url: string | null;
  enabled_builtin: boolean;
  created_at: Date;
}

export interface ProviderConfigRow {
  id: string;
  provider_id: string;
  label: string;
  key_last4: string | null;
  status: "unverified" | "connected" | "error" | "disabled";
  last_test_at: Date | null;
  last_test_error: string | null;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

export async function listProviders(pool: pg.Pool): Promise<ProviderRow[]> {
  const { rows } = await pool.query<ProviderRow>("SELECT * FROM providers ORDER BY display_name");
  return rows;
}

export async function getProvider(pool: pg.Pool, id: string): Promise<ProviderRow | undefined> {
  const { rows } = await pool.query<ProviderRow>("SELECT * FROM providers WHERE id = $1", [id]);
  return rows[0];
}

export async function listProviderConfigs(pool: pg.Pool, providerId?: string): Promise<ProviderConfigRow[]> {
  if (providerId) {
    const { rows } = await pool.query<ProviderConfigRow>(
      "SELECT * FROM provider_configs WHERE provider_id = $1 ORDER BY created_at",
      [providerId],
    );
    return rows;
  }
  const { rows } = await pool.query<ProviderConfigRow>("SELECT * FROM provider_configs ORDER BY created_at");
  return rows;
}

/**
 * Records the outcome of a transient connection test as non-secret
 * metadata. `keyLast4` is derived by the caller from the key that was
 * POSTed for this one call and passed in here — this function never
 * receives, stores, or logs the key itself.
 */
export async function upsertProviderConfigStatus(
  pool: pg.Pool,
  input: {
    providerId: string;
    label: string;
    status: "unverified" | "connected" | "error" | "disabled";
    keyLast4?: string;
    lastTestError?: string;
  },
): Promise<ProviderConfigRow> {
  const { rows } = await pool.query<ProviderConfigRow>(
    `INSERT INTO provider_configs (provider_id, label, status, key_last4, last_test_at, last_test_error)
     VALUES ($1, $2, $3, $4, now(), $5)
     ON CONFLICT (provider_id, label) DO UPDATE SET
       status = EXCLUDED.status,
       key_last4 = COALESCE(EXCLUDED.key_last4, provider_configs.key_last4),
       last_test_at = now(),
       last_test_error = EXCLUDED.last_test_error,
       updated_at = now()
     RETURNING *`,
    [input.providerId, input.label, input.status, input.keyLast4 ?? null, input.lastTestError ?? null],
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to upsert provider config status");
  return row;
}

export async function getProviderConfigById(pool: pg.Pool, id: string): Promise<ProviderConfigRow | undefined> {
  const { rows } = await pool.query<ProviderConfigRow>("SELECT * FROM provider_configs WHERE id = $1", [id]);
  return rows[0];
}

export async function deleteProviderConfig(pool: pg.Pool, id: string): Promise<void> {
  await pool.query("DELETE FROM provider_configs WHERE id = $1", [id]);
}

export async function setDefaultProviderConfig(pool: pg.Pool, id: string): Promise<void> {
  await pool.query(
    `UPDATE provider_configs SET is_default = (id = $1), updated_at = now()
     WHERE provider_id = (SELECT provider_id FROM provider_configs WHERE id = $1)`,
    [id],
  );
}

/** Sets which model a provider config should be used with by default (M2.5 default-model picker). */
export async function setProviderDefaultModel(pool: pg.Pool, providerConfigId: string, modelId: string): Promise<void> {
  await pool.query(
    `INSERT INTO provider_default_models (provider_config_id, model_id) VALUES ($1, $2)
     ON CONFLICT (provider_config_id) DO UPDATE SET model_id = EXCLUDED.model_id`,
    [providerConfigId, modelId],
  );
}

export async function getProviderDefaultModel(pool: pg.Pool, providerConfigId: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ model_id: string }>(
    "SELECT model_id FROM provider_default_models WHERE provider_config_id = $1",
    [providerConfigId],
  );
  return rows[0]?.model_id;
}
