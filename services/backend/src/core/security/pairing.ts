import { randomInt, createHash } from "node:crypto";
import type pg from "pg";
import { loadEnv } from "../../config/env.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars (0/O, 1/I/L)
const CODE_LENGTH = 8;

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function generateCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}

/**
 * Generates a single-use pairing code and stores only its hash + expiry in
 * app_config. The raw code is returned so the caller can print it to the
 * backend's own boot log (docs/architecture/07-security-model.md §2) — it
 * is never transmitted anywhere else.
 */
export async function generatePairingCode(pool: pg.Pool): Promise<string> {
  const env = loadEnv();
  const code = generateCode();
  const expiresAt = new Date(Date.now() + env.MDAI_PAIRING_CODE_TTL_MINUTES * 60_000);
  await pool.query(
    `INSERT INTO app_config (key, value) VALUES ('pairing.code', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify({ hash: hashCode(code), expiresAt: expiresAt.toISOString(), consumed: false })],
  );
  return code;
}

export type PairingConsumeResult = { ok: true } | { ok: false; reason: "invalid" | "expired" | "already_used" };

/** Validates and, on success, invalidates the pairing code (single-use). */
export async function consumePairingCode(pool: pg.Pool, submittedCode: string): Promise<PairingConsumeResult> {
  const { rows } = await pool.query<{ value: { hash: string; expiresAt: string; consumed: boolean } }>(
    "SELECT value FROM app_config WHERE key = 'pairing.code'",
  );
  const record = rows[0]?.value;
  if (!record) return { ok: false, reason: "invalid" };
  if (record.consumed) return { ok: false, reason: "already_used" };
  if (new Date(record.expiresAt).getTime() < Date.now()) return { ok: false, reason: "expired" };
  if (hashCode(submittedCode) !== record.hash) return { ok: false, reason: "invalid" };

  await pool.query(
    `UPDATE app_config SET value = jsonb_set(value, '{consumed}', 'true'), updated_at = now() WHERE key = 'pairing.code'`,
  );
  return { ok: true };
}
