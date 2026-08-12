import "../setupEnv.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { safeFetch, safeFetchBinary, UnsafeUrlError } from "../../src/core/security/ssrfGuard.js";

let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;

beforeEach(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
});

describe("safeFetch (M4.5/M4.12/M4.15)", () => {
  it("truncates a response larger than maxBytes rather than buffering it all into memory", async () => {
    const big = "x".repeat(10_000);
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/big", method: "GET" })
      .reply(200, big, { headers: { "content-type": "text/plain" } });

    const result = await safeFetch("https://example.com/big", { signal: new AbortController().signal, maxBytes: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBeLessThanOrEqual(1000);
  });

  it("rejects a disallowed content-type", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/binary", method: "GET" })
      .reply(200, "not text", { headers: { "content-type": "application/octet-stream" } });

    await expect(
      safeFetch("https://example.com/binary", {
        signal: new AbortController().signal,
        allowedContentTypePrefixes: ["text/"],
      }),
    ).rejects.toThrow(UnsafeUrlError);
  });

  it("follows a safe redirect chain up to the limit, then refuses one more hop", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/hop0", method: "GET" })
      .reply(302, "", { headers: { location: "https://example.com/hop1" } });
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/hop1", method: "GET" })
      .reply(302, "", { headers: { location: "https://example.com/hop2" } });
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/hop2", method: "GET" })
      .reply(200, "landed", { headers: { "content-type": "text/plain" } });

    const result = await safeFetch("https://example.com/hop0", { signal: new AbortController().signal, maxRedirects: 5 });
    expect(result.body).toBe("landed");
    expect(result.finalUrl).toBe("https://example.com/hop2");
  });

  it("refuses a redirect chain that exceeds the configured limit", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/loop0", method: "GET" })
      .reply(302, "", { headers: { location: "https://example.com/loop1" } });
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/loop1", method: "GET" })
      .reply(302, "", { headers: { location: "https://example.com/loop0" } })
      .persist();

    await expect(
      safeFetch("https://example.com/loop0", { signal: new AbortController().signal, maxRedirects: 1 }),
    ).rejects.toThrow(UnsafeUrlError);
  });

  it("refuses a redirect that points at a private IP — a malicious server can't use a 302 to reach internal infrastructure", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/evil-redirect", method: "GET" })
      .reply(302, "", { headers: { location: "https://169.254.169.254/latest/meta-data/" } });

    await expect(
      safeFetch("https://example.com/evil-redirect", { signal: new AbortController().signal }),
    ).rejects.toThrow(UnsafeUrlError);
  });

  it("aborts via the caller's signal (used by the MCP host's per-tool timeout)", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/slow", method: "GET" })
      .reply(200, "eventually")
      .delay(5000);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(safeFetch("https://example.com/slow", { signal: controller.signal })).rejects.toThrow();
  });

  it("safeFetchBinary streams and truncates binary content against maxBytes", async () => {
    const bytes = new Uint8Array(5000).fill(65);
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/binary-data", method: "GET" })
      .reply(200, Buffer.from(bytes), { headers: { "content-type": "application/pdf" } });

    const result = await safeFetchBinary("https://example.com/binary-data", {
      signal: new AbortController().signal,
      maxBytes: 1000,
    });
    expect(result.truncated).toBe(true);
    expect(result.bytes.byteLength).toBeLessThanOrEqual(1000);
  });
});
