import "../setupEnv.js";
import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCacheForTests } from "../../src/config/env.js";
import {
  BackgroundKeyVaultNotConfiguredError,
  decryptCredential,
  encryptCredential,
  generateKek,
} from "../../src/core/security/backgroundKeyVault.js";

const originalKek = process.env.MDAI_BACKGROUND_KEY_KEK;

afterEach(() => {
  if (originalKek === undefined) delete process.env.MDAI_BACKGROUND_KEY_KEK;
  else process.env.MDAI_BACKGROUND_KEY_KEK = originalKek;
  resetEnvCacheForTests();
});

describe("background credential vault (M5.12a)", () => {
  it("throws BackgroundKeyVaultNotConfiguredError when no KEK is set — never falls back to storing plaintext", () => {
    delete process.env.MDAI_BACKGROUND_KEY_KEK;
    resetEnvCacheForTests();
    expect(() => encryptCredential("sk-real-secret-key")).toThrow(BackgroundKeyVaultNotConfiguredError);
  });

  it("round-trips a credential through encrypt -> decrypt", () => {
    process.env.MDAI_BACKGROUND_KEY_KEK = generateKek();
    resetEnvCacheForTests();

    const plaintext = "sk-real-secret-key-1234567890";
    const encrypted = encryptCredential(plaintext);

    expect(Buffer.isBuffer(encrypted.credentialCiphertext)).toBe(true);
    expect(encrypted.credentialCiphertext.toString("utf8")).not.toContain(plaintext);
    expect(encrypted.wrappedDek.toString("utf8")).not.toContain(plaintext);

    expect(decryptCredential(encrypted)).toBe(plaintext);
  });

  it("fails to decrypt under a different KEK — proves the ciphertext alone (e.g. a stolen DB dump) is useless without the env-only KEK", () => {
    process.env.MDAI_BACKGROUND_KEY_KEK = generateKek();
    resetEnvCacheForTests();
    const encrypted = encryptCredential("sk-real-secret-key");

    process.env.MDAI_BACKGROUND_KEY_KEK = generateKek();
    resetEnvCacheForTests();
    expect(() => decryptCredential(encrypted)).toThrow();
  });

  it("rejects a KEK that isn't exactly 32 bytes decoded", () => {
    process.env.MDAI_BACKGROUND_KEY_KEK = Buffer.from("too-short").toString("base64");
    resetEnvCacheForTests();
    expect(() => encryptCredential("sk-real-secret-key")).toThrow(/32 bytes/);
  });

  it("produces different ciphertext for the same plaintext on repeated calls (random IV/DEK per encryption)", () => {
    process.env.MDAI_BACKGROUND_KEY_KEK = generateKek();
    resetEnvCacheForTests();
    const a = encryptCredential("sk-real-secret-key");
    const b = encryptCredential("sk-real-secret-key");
    expect(a.credentialCiphertext.equals(b.credentialCiphertext)).toBe(false);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
  });
});
