import crypto from "node:crypto";

/**
 * M10: `POST /webhooks/automations/:slug` authentication
 * (docs/architecture/07-security-model.md §2 — "a per-automation
 * HMAC-signed slug instead of the device bearer token, since the caller
 * (e.g. n8n) isn't the paired device"). `webhook_slug` is a public routing
 * token; the actual proof of authorization is this HMAC over the exact
 * request bytes, computed with a secret only MD AI and the configured
 * caller know.
 */
const SIGNATURE_HEADER = "x-mdai-signature";

export function computeWebhookSignature(secret: string, rawBody: Buffer): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

/** Constant-time comparison — a length mismatch is treated as "invalid", never thrown, since a caller can legitimately send a malformed header. */
export function verifyWebhookSignature(secret: string, rawBody: Buffer, providedSignatureHex: string): boolean {
  const expected = Buffer.from(computeWebhookSignature(secret, rawBody), "hex");
  let provided: Buffer;
  try {
    provided = Buffer.from(providedSignatureHex, "hex");
  } catch {
    return false;
  }
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

export function getSignatureHeader(req: { headers: Record<string, string | string[] | undefined> }): string | undefined {
  const value = req.headers[SIGNATURE_HEADER];
  return typeof value === "string" ? value : undefined;
}

export function generateWebhookSlug(): string {
  return crypto.randomBytes(18).toString("base64url");
}

export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}
