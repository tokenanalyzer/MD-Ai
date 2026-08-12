import { describe, expect, it } from "vitest";
import { createSafeLookup } from "../../src/core/security/ssrfSafeDispatcher.js";

function fakeLookup(addresses: { address: string; family: number }[]) {
  return (
    _hostname: string,
    _options: unknown,
    callback: (err: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void,
  ) => {
    callback(null, addresses);
  };
}

describe("SSRF-safe connect-time DNS lookup (M5.0 — closes the DNS-rebinding gap)", () => {
  it("rejects when every resolved address is private/reserved", () => {
    const lookup = createSafeLookup(fakeLookup([{ address: "127.0.0.1", family: 4 }]) as never);
    lookup("evil.example", { all: true }, (err) => {
      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toContain("private/reserved");
    });
  });

  it("rejects the shared cloud metadata address even if only one of several resolved addresses is unsafe", () => {
    const lookup = createSafeLookup(
      fakeLookup([
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ]) as never,
    );
    let captured: NodeJS.ErrnoException | null = null;
    lookup("mixed.example", { all: true }, (err) => {
      captured = err;
    });
    expect(captured).toBeInstanceOf(Error);
  });

  it("rejects a blocked hostname before ever calling the underlying resolver", () => {
    let baseLookupCalled = false;
    const lookup = createSafeLookup(((..._args: unknown[]) => {
      baseLookupCalled = true;
    }) as never);
    lookup("localhost", { all: true }, (err) => {
      expect(err).toBeInstanceOf(Error);
      expect((err as NodeJS.ErrnoException)?.code).toBe("EBLOCKEDHOST");
    });
    expect(baseLookupCalled).toBe(false);
  });

  it("passes through a genuinely public address unchanged, in both single and all-addresses modes", () => {
    const lookup = createSafeLookup(fakeLookup([{ address: "93.184.216.34", family: 4 }]) as never);

    let singleResult: { address?: string; family?: number } = {};
    lookup("example.com", {}, (err, address, family) => {
      expect(err).toBeNull();
      singleResult = { address: address as string, family };
    });
    expect(singleResult).toEqual({ address: "93.184.216.34", family: 4 });

    let allResult: unknown;
    lookup("example.com", { all: true }, (err, addresses) => {
      expect(err).toBeNull();
      allResult = addresses;
    });
    expect(allResult).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("propagates a real DNS resolution failure without masking it", () => {
    const notFound = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    const lookup = createSafeLookup(((_h: string, _o: unknown, cb: (err: Error) => void) => cb(notFound)) as never);
    lookup("does-not-resolve.invalid", { all: true }, (err) => {
      expect(err).toBe(notFound);
    });
  });
});
