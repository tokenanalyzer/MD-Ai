import { describe, expect, it } from "vitest";
import { Agent } from "undici";
import { createSafeLookup } from "../../src/core/security/ssrfSafeDispatcher.js";

/**
 * M5.0: proves the connect-time guard actually intercepts Node's real
 * connection machinery — not just our own pre-check — by wiring a fake
 * resolver into a real `undici.Agent` and issuing a real `fetch()`
 * through it. If this test used the global MockAgent dispatcher (like
 * every other integration test in this repo), it would never reach the
 * connection layer at all — this is the one deliberate exception, using
 * its own explicit `dispatcher` instead of the ambient global one,
 * precisely because it needs to exercise real connection-time behavior.
 * Deliberately doesn't depend on real internet reachability (this
 * sandbox's outbound network policy routes through a proxy a hand-built
 * `Agent` doesn't know about) — both cases target `127.0.0.1` on an
 * unused port, which fails fast with `ECONNREFUSED` regardless of
 * network policy; what's under test is *which* error wins the race:
 * our guard's, or a normal connection failure.
 */
describe("SSRF-safe dispatcher — real connection-layer enforcement (M5.0)", () => {
  it("refuses to connect when the resolver returns a private IP at connect time, not just at the earlier pre-check", async () => {
    const alwaysPrivate = (
      _hostname: string,
      options: unknown,
      callback: (err: NodeJS.ErrnoException | null, addresses: unknown, family?: number) => void,
    ) => {
      const wantsAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
      callback(null, wantsAll ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", wantsAll ? undefined : 4);
    };

    const agent = new Agent({
      connect: { lookup: createSafeLookup(alwaysPrivate as never) as unknown as import("node:net").LookupFunction },
    });

    try {
      // The hostname here is irrelevant — the fake resolver always
      // returns 127.0.0.1 regardless of what's asked, simulating a DNS
      // record that changed to point at a private address between an
      // earlier check and this exact connection attempt.
      await fetch("https://looks-completely-legitimate.example:65535/", { dispatcher: agent } as never);
      expect.unreachable("expected the SSRF guard to refuse this connection");
    } catch (err) {
      const cause = (err as Error & { cause?: Error & { code?: string } }).cause;
      expect(cause?.code ?? cause?.message ?? (err as Error).message).toMatch(/EUNSAFEADDR|private\/reserved/i);
    } finally {
      await agent.close();
    }
  });

  it("lets a genuinely public/safe address reach the connection attempt — the guard doesn't false-positive", async () => {
    // A real public IP (documentation range TEST-NET-1, RFC 5737 —
    // guaranteed non-routable but *not* one of the private/reserved
    // ranges our guard blocks) on a port nothing listens on: if the
    // guard let it through, the failure is an ordinary connection
    // failure, never our SSRF error.
    const publicLooking = (
      _hostname: string,
      options: unknown,
      callback: (err: NodeJS.ErrnoException | null, addresses: unknown, family?: number) => void,
    ) => {
      const wantsAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
      callback(null, wantsAll ? [{ address: "192.0.2.1", family: 4 }] : "192.0.2.1", wantsAll ? undefined : 4);
    };

    const agent = new Agent({
      connectTimeout: 1000,
      connect: {
        lookup: createSafeLookup(publicLooking as never) as unknown as import("node:net").LookupFunction,
      },
    });

    try {
      await fetch("https://looks-completely-legitimate.example/", { dispatcher: agent } as never);
      expect.unreachable("nothing listens on this test address — a response would be surprising");
    } catch (err) {
      const cause = (err as Error & { cause?: Error & { code?: string } }).cause;
      // Any normal network failure is fine here — the only thing that
      // must NOT happen is our own SSRF rejection.
      expect(cause?.code).not.toBe("EUNSAFEADDR");
    } finally {
      await agent.close();
    }
  });
});
