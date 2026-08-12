import crypto from "node:crypto";
import { loadEnv } from "../../config/env.js";

/**
 * Envelope encryption for the M5.12a opt-in background credential vault
 * (docs/architecture/07-security-model.md §3.4/§12) — the ONE place in
 * this codebase that persists a provider/tool credential to Postgres, and
 * only for credentials the owner explicitly opted in from the phone.
 *
 * Two-layer AES-256-GCM: a random per-credential Data Encryption Key (DEK)
 * encrypts the actual secret; the DEK itself is encrypted ("wrapped")
 * under a single process-wide Key Encryption Key (KEK) that lives only in
 * `MDAI_BACKGROUND_KEY_KEK` and is never written to the database. Rotating
 * the KEK only requires re-wrapping DEKs (cheap), not re-encrypting every
 * secret; compromising the DB alone (without the KEK env var) yields
 * nothing usable.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export class BackgroundKeyVaultNotConfiguredError extends Error {
  constructor() {
    super(
      "MDAI_BACKGROUND_KEY_KEK is not configured — the opt-in background credential vault is unavailable. " +
        "Set a base64-encoded 32-byte key to enable 'allow background use' for a provider.",
    );
    this.name = "BackgroundKeyVaultNotConfiguredError";
  }
}

function getKek(): Buffer {
  const env = loadEnv();
  if (!env.MDAI_BACKGROUND_KEY_KEK) throw new BackgroundKeyVaultNotConfiguredError();
  const kek = Buffer.from(env.MDAI_BACKGROUND_KEY_KEK, "base64");
  if (kek.length !== KEY_BYTES) {
    throw new Error(`MDAI_BACKGROUND_KEY_KEK must decode to exactly ${KEY_BYTES} bytes (got ${kek.length})`);
  }
  return kek;
}

interface Sealed {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

function seal(plaintext: Buffer, key: Buffer): Sealed {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

function unseal(sealed: Sealed, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, sealed.iv);
  decipher.setAuthTag(sealed.authTag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
}

export interface EncryptedCredential {
  wrappedDek: Buffer;
  dekIv: Buffer;
  dekAuthTag: Buffer;
  credentialCiphertext: Buffer;
  credentialIv: Buffer;
  credentialAuthTag: Buffer;
}

/** Encrypts `plaintextCredential` under a fresh DEK, then wraps that DEK under the process KEK. Throws `BackgroundKeyVaultNotConfiguredError` if no KEK is set — callers must surface that as "background use isn't available," never silently store plaintext. */
export function encryptCredential(plaintextCredential: string): EncryptedCredential {
  const kek = getKek();
  const dek = crypto.randomBytes(KEY_BYTES);

  const wrappedDekSealed = seal(dek, kek);
  const credentialSealed = seal(Buffer.from(plaintextCredential, "utf8"), dek);

  return {
    wrappedDek: wrappedDekSealed.ciphertext,
    dekIv: wrappedDekSealed.iv,
    dekAuthTag: wrappedDekSealed.authTag,
    credentialCiphertext: credentialSealed.ciphertext,
    credentialIv: credentialSealed.iv,
    credentialAuthTag: credentialSealed.authTag,
  };
}

/** Reverses `encryptCredential`. Only ever call this at the moment a decrypted key is actually needed (bot escalation, a background-eligible search call) — never cache the result beyond that one use, same discipline as request-scoped `providerKeys`/`toolKeys`. */
export function decryptCredential(encrypted: EncryptedCredential): string {
  const kek = getKek();
  const dek = unseal({ ciphertext: encrypted.wrappedDek, iv: encrypted.dekIv, authTag: encrypted.dekAuthTag }, kek);
  const plaintext = unseal(
    { ciphertext: encrypted.credentialCiphertext, iv: encrypted.credentialIv, authTag: encrypted.credentialAuthTag },
    dek,
  );
  return plaintext.toString("utf8");
}

export function last4(credential: string): string {
  return credential.length >= 4 ? credential.slice(-4) : credential;
}

/** Generates a fresh, valid KEK for `MDAI_BACKGROUND_KEY_KEK` — an operator convenience, not called at runtime. */
export function generateKek(): string {
  return crypto.randomBytes(KEY_BYTES).toString("base64");
}
