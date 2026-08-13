import { describe, expect, it } from "vitest";
import { looksLikeSecret, redactSecretsFromString, PINO_REDACT_PATHS } from "../../src/core/security/redaction.js";

describe("redaction", () => {
  it("recognizes common provider key shapes as secrets", () => {
    expect(looksLikeSecret("sk-abcdefghijklmnopqrstuvwxyz1234567890")).toBe(true);
    expect(looksLikeSecret("nvapi-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890")).toBe(true);
    expect(looksLikeSecret("Authorization: Bearer abcdefghijklmnop1234567890")).toBe(true);
    expect(looksLikeSecret("a".repeat(40))).toBe(true);
  });

  it("does not flag ordinary short text", () => {
    expect(looksLikeSecret("Hello MD AI, how are you?")).toBe(false);
    expect(looksLikeSecret("task-123")).toBe(false);
  });

  it("redacts secret-shaped substrings from a string, leaving the rest intact", () => {
    const input = "connecting with key sk-abcdefghijklmnop1234567890 to provider";
    const redacted = redactSecretsFromString(input);
    expect(redacted).not.toContain("sk-abcdefghijklmnop1234567890");
    expect(redacted).toContain("connecting with key");
    expect(redacted).toContain("to provider");
  });

  it("declares redact paths for the fields that can carry provider keys", () => {
    expect(PINO_REDACT_PATHS).toContain("req.body.apiKey");
    expect(PINO_REDACT_PATHS).toContain("req.body.providerKeys");
    expect(PINO_REDACT_PATHS).toContain("req.headers.authorization");
  });

  it("declares redact paths for search-provider tool keys and webhook secrets (M4/M10)", () => {
    expect(PINO_REDACT_PATHS).toContain("req.body.toolKeys");
    expect(PINO_REDACT_PATHS).toContain("req.body.webhookSecret");
  });
});
