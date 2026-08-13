/**
 * Structural log redaction (docs/architecture/07-security-model.md §4).
 *
 * `PINO_REDACT_PATHS` is consumed by pino's built-in `redact` option so
 * matching fields are stripped BEFORE serialization — not a best-effort
 * string scrub applied after the fact. `looksLikeSecret` is the
 * defense-in-depth backstop for anything that didn't go through the
 * structured logger (e.g. an uncaught exception's raw message).
 */
export const PINO_REDACT_PATHS = [
  "req.body.apiKey",
  "req.body.providerKeys",
  "req.body.providerKeys.*",
  "req.body.toolKeys",
  "req.body.toolKeys.*",
  "req.body.webhookSecret",
  "req.headers.authorization",
  "*.apiKey",
  "*.providerKeys",
  "*.toolKeys",
  "*.webhookSecret",
  '*.parts[*].data.apiKey',
];

// Common provider key shapes: OpenAI/NVIDIA/Groq-style "sk-..."/"nvapi-...",
// bearer tokens, and long hex/base64-ish opaque strings (32+ chars).
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{10,}\b/g,
  /\bnvapi-[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi,
  /\b[A-Za-z0-9_-]{32,}\b/g,
];

export function looksLikeSecret(value: string): boolean {
  return SECRET_PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(value);
  });
}

export function redactSecretsFromString(value: string): string {
  let result = value;
  for (const re of SECRET_PATTERNS) {
    result = result.replace(re, "[redacted]");
  }
  return result;
}
