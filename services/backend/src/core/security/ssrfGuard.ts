import dns from "node:dns/promises";
import net from "node:net";

/**
 * Thrown for any URL a tool refused to fetch — malicious, malformed, or
 * pointed at a private/internal address. The message is safe to surface
 * to the caller (no secrets), but never claims a stronger guarantee than
 * what's actually checked — see the DNS-rebinding note below.
 */
export class UnsafeUrlError extends Error {
  constructor(
    readonly reason: string,
    readonly url: string,
  ) {
    super(`Refused to fetch "${url}": ${reason}`);
    this.name = "UnsafeUrlError";
  }
}

// Hostnames blocked outright, before any DNS lookup — covers the common
// "just ask for localhost by name" bypass attempt and known cloud
// metadata hostnames (in addition to IP-based blocking of 169.254.169.254
// below, which covers AWS/GCP/Azure/OCI's shared metadata address).
const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "metadata.google.internal", "metadata"]);

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata (169.254.169.254)
  if (a === 0) return true; // "this network"
  if (a >= 224) return true; // multicast/reserved
  return false;
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // fe80::/10 link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 unique local
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return isPrivateOrReservedIpv4(mapped[1]);
  return false;
}

function isPrivateOrReservedIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateOrReservedIpv4(ip);
  if (version === 6) return isPrivateOrReservedIpv6(ip);
  return true; // unrecognizable — fail closed
}

/**
 * Validates a URL is safe to fetch: HTTPS only, not a blocked hostname,
 * and — after DNS resolution — not pointed at a private, loopback,
 * link-local, or cloud-metadata address. Only the connection-safety
 * decision; callers still need their own size/timeout/content-type
 * handling (see `safeFetch` below).
 *
 * **Known residual risk (documented, not silently ignored):** this
 * validates the hostname's resolved address at check time; a
 * DNS-rebinding attacker who changes the DNS record between this check
 * and the actual outbound connection could still route around it. Fully
 * closing that gap requires pinning the TCP connection to the exact
 * validated IP (a custom low-level dispatcher), which M4 does not
 * implement — see `07-security-model.md` §10 for the honest scope of
 * this guarantee.
 */
export async function assertSafeUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("not a valid URL", rawUrl);
  }
  if (url.protocol !== "https:") {
    throw new UnsafeUrlError("only https:// URLs are allowed", rawUrl);
  }
  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new UnsafeUrlError("blocked hostname", rawUrl);
  }

  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) throw new UnsafeUrlError("private/reserved IP address", rawUrl);
    return url;
  }

  let addresses: string[];
  try {
    const records = await dns.lookup(hostname, { all: true });
    addresses = records.map((r) => r.address);
  } catch {
    throw new UnsafeUrlError("DNS resolution failed", rawUrl);
  }
  if (addresses.length === 0) throw new UnsafeUrlError("DNS resolution returned no addresses", rawUrl);
  if (addresses.some((a) => isPrivateOrReservedIp(a))) {
    throw new UnsafeUrlError("hostname resolves to a private/reserved IP address", rawUrl);
  }
  return url;
}

export interface SafeFetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
}

export interface SafeFetchOptions {
  signal: AbortSignal;
  maxRedirects?: number;
  maxBytes?: number;
  /** Prefix-matched against the response's content-type, e.g. ["text/", "application/json"]. Omit to accept any content-type. */
  allowedContentTypePrefixes?: string[];
  headers?: Record<string, string>;
}

interface SafeFetchStreamResult {
  finalUrl: string;
  status: number;
  contentType: string;
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
}

/**
 * Shared core of `safeFetch`/`safeFetchBinary`: validates every hop
 * (including redirect targets — a redirect to a private IP is refused
 * exactly like a direct request to one), enforces a redirect limit and an
 * optional content-type allowlist, and hands back the response's raw byte
 * stream for the caller to consume (as text or binary) under its own
 * size limit.
 */
async function safeFetchStream(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchStreamResult> {
  const maxRedirects = opts.maxRedirects ?? 5;
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validated = await assertSafeUrl(currentUrl);
    const res = await fetch(validated, {
      redirect: "manual",
      signal: opts.signal,
      headers: { "user-agent": "MD-AI-Agent/1.0 (+tool: safeFetch)", ...opts.headers },
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new UnsafeUrlError("redirect response with no Location header", currentUrl);
      if (hop === maxRedirects) throw new UnsafeUrlError("too many redirects", rawUrl);
      currentUrl = new URL(location, validated).toString();
      continue;
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (opts.allowedContentTypePrefixes && !opts.allowedContentTypePrefixes.some((p) => contentType.startsWith(p))) {
      throw new UnsafeUrlError(`disallowed content-type "${contentType}"`, currentUrl);
    }

    return { finalUrl: currentUrl, status: res.status, contentType, reader: res.body?.getReader() };
  }

  throw new UnsafeUrlError("too many redirects", rawUrl);
}

/** SSRF-safe GET returning decoded text, streamed against `maxBytes` (never buffered-then-checked). */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? 2_000_000;
  const { finalUrl, status, contentType, reader } = await safeFetchStream(rawUrl, opts);
  if (!reader) return { finalUrl, status, contentType, body: "", truncated: false };

  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      const remaining = maxBytes - (total - value.byteLength);
      if (remaining > 0) text += decoder.decode(value.subarray(0, remaining), { stream: true });
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  return { finalUrl, status, contentType, body: text, truncated };
}

export interface SafeFetchBinaryResult {
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: Uint8Array;
  truncated: boolean;
}

/** SSRF-safe GET returning raw bytes (for binary content like PDFs), streamed against `maxBytes`. */
export async function safeFetchBinary(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchBinaryResult> {
  const maxBytes = opts.maxBytes ?? 10_000_000;
  const { finalUrl, status, contentType, reader } = await safeFetchStream(rawUrl, opts);
  if (!reader) return { finalUrl, status, contentType, bytes: new Uint8Array(0), truncated: false };

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      const remaining = maxBytes - (total - value.byteLength);
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(chunks.reduce((sum, c) => sum + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { finalUrl, status, contentType, bytes, truncated };
}
