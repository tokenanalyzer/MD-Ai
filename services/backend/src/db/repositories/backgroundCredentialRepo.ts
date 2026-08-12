import type pg from "pg";
import type { EncryptedCredential } from "../../core/security/backgroundKeyVault.js";

export type BackgroundCredentialKind = "llm_provider" | "search_provider";

export interface BackgroundCredentialRow {
  credential_kind: BackgroundCredentialKind;
  credential_id: string;
  wrapped_dek: Buffer;
  dek_iv: Buffer;
  dek_auth_tag: Buffer;
  credential_ciphertext: Buffer;
  credential_iv: Buffer;
  credential_auth_tag: Buffer;
  key_last4: string | null;
  enabled_by_owner_at: Date;
  created_at: Date;
  updated_at: Date;
}

export function toEncryptedCredential(row: BackgroundCredentialRow): EncryptedCredential {
  return {
    wrappedDek: row.wrapped_dek,
    dekIv: row.dek_iv,
    dekAuthTag: row.dek_auth_tag,
    credentialCiphertext: row.credential_ciphertext,
    credentialIv: row.credential_iv,
    credentialAuthTag: row.credential_auth_tag,
  };
}

export async function upsertBackgroundCredential(
  pool: pg.Pool,
  kind: BackgroundCredentialKind,
  id: string,
  encrypted: EncryptedCredential,
  keyLast4: string,
): Promise<BackgroundCredentialRow> {
  const { rows } = await pool.query<BackgroundCredentialRow>(
    `INSERT INTO background_credentials (
       credential_kind, credential_id, wrapped_dek, dek_iv, dek_auth_tag,
       credential_ciphertext, credential_iv, credential_auth_tag, key_last4
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (credential_kind, credential_id) DO UPDATE SET
       wrapped_dek = EXCLUDED.wrapped_dek, dek_iv = EXCLUDED.dek_iv, dek_auth_tag = EXCLUDED.dek_auth_tag,
       credential_ciphertext = EXCLUDED.credential_ciphertext, credential_iv = EXCLUDED.credential_iv,
       credential_auth_tag = EXCLUDED.credential_auth_tag, key_last4 = EXCLUDED.key_last4,
       enabled_by_owner_at = now(), updated_at = now()
     RETURNING *`,
    [kind, id, encrypted.wrappedDek, encrypted.dekIv, encrypted.dekAuthTag, encrypted.credentialCiphertext, encrypted.credentialIv, encrypted.credentialAuthTag, keyLast4],
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to store background credential");
  return row;
}

export async function getBackgroundCredential(
  pool: pg.Pool,
  kind: BackgroundCredentialKind,
  id: string,
): Promise<BackgroundCredentialRow | undefined> {
  const { rows } = await pool.query<BackgroundCredentialRow>(
    "SELECT * FROM background_credentials WHERE credential_kind = $1 AND credential_id = $2",
    [kind, id],
  );
  return rows[0];
}

export async function listBackgroundCredentials(pool: pg.Pool, kind?: BackgroundCredentialKind): Promise<BackgroundCredentialRow[]> {
  if (kind) {
    const { rows } = await pool.query<BackgroundCredentialRow>(
      "SELECT * FROM background_credentials WHERE credential_kind = $1 ORDER BY credential_id",
      [kind],
    );
    return rows;
  }
  const { rows } = await pool.query<BackgroundCredentialRow>("SELECT * FROM background_credentials ORDER BY credential_kind, credential_id");
  return rows;
}

/** Revokes a credential's ability to be used for background work. Deleting the row is sufficient — the DEK/ciphertext leave with it, so there's nothing left to decrypt even if the KEK were later compromised. */
export async function revokeBackgroundCredential(pool: pg.Pool, kind: BackgroundCredentialKind, id: string): Promise<void> {
  await pool.query("DELETE FROM background_credentials WHERE credential_kind = $1 AND credential_id = $2", [kind, id]);
}

/** Builds the full `providerKeys`-shaped map from every opted-in `llm_provider` credential, decrypting each only for this one call's return value — same non-persistence-beyond-use discipline as request-scoped `providerKeys` (docs/architecture/07-security-model.md §3.2), just sourced from the vault instead of a live request body. */
export async function buildBackgroundProviderKeys(
  pool: pg.Pool,
  decrypt: (encrypted: EncryptedCredential) => string,
): Promise<Record<string, string>> {
  const rows = await listBackgroundCredentials(pool, "llm_provider");
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.credential_id] = decrypt(toEncryptedCredential(row));
  }
  return result;
}

/** Same as `buildBackgroundProviderKeys` but for `search_provider` (`toolKeys`-shaped) credentials. */
export async function buildBackgroundToolKeys(
  pool: pg.Pool,
  decrypt: (encrypted: EncryptedCredential) => string,
): Promise<Record<string, string>> {
  const rows = await listBackgroundCredentials(pool, "search_provider");
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.credential_id] = decrypt(toEncryptedCredential(row));
  }
  return result;
}
