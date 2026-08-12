import dns from "node:dns";
import { Agent, setGlobalDispatcher } from "undici";
import { isBlockedHostname, isPrivateOrReservedIp } from "./ssrfGuard.js";

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;
type LookupOptions = dns.LookupOneOptions | dns.LookupAllOptions | number;
type LookupFn = (hostname: string, options: LookupOptions, callback: LookupCallback) => void;

/**
 * M5.0: closes the DNS-rebinding gap `assertSafeUrl` (`ssrfGuard.ts`)
 * honestly left open in M4 — that check validates the resolved address
 * *before* the connection, leaving a window for the DNS record to change
 * before the real TCP connect happens. This wraps the actual resolver
 * Node's connection machinery calls **at connect time** (`net.connect`/
 * `tls.connect`'s own `lookup` option, which undici's `Agent({ connect })`
 * forwards straight through), so the safety check and the address used to
 * open the socket are the same operation — there is no gap left to win a
 * race in. `assertSafeUrl`'s earlier check stays in place as a fast,
 * clear-error first pass; this is what actually closes the hole.
 */
export function createSafeLookup(baseLookup: LookupFn = dns.lookup as unknown as LookupFn): LookupFn {
  return (hostname, options, callback) => {
    if (isBlockedHostname(hostname)) {
      callback(Object.assign(new Error(`SSRF guard: blocked hostname "${hostname}"`), { code: "EBLOCKEDHOST" }), "", 0);
      return;
    }

    const wantsAll = typeof options === "object" && options !== null && "all" in options && options.all === true;
    baseLookup(hostname, { ...(typeof options === "object" ? options : {}), all: true } as dns.LookupAllOptions, (err, addresses) => {
      if (err) {
        callback(err, "", 0);
        return;
      }
      const list = addresses as unknown as dns.LookupAddress[];
      const unsafe = list.find((a) => isPrivateOrReservedIp(a.address));
      if (unsafe) {
        callback(
          Object.assign(new Error(`SSRF guard: refused to connect to private/reserved address ${unsafe.address}`), {
            code: "EUNSAFEADDR",
          }),
          "",
          0,
        );
        return;
      }
      if (list.length === 0) {
        callback(Object.assign(new Error("SSRF guard: DNS resolution returned no addresses"), { code: "ENOTFOUND" }), "", 0);
        return;
      }
      if (wantsAll) {
        callback(null, list);
      } else {
        const first = list[0]!;
        callback(null, first.address, first.family);
      }
    });
  };
}

/**
 * Installs the DNS-rebinding-safe dispatcher as the process-wide default
 * for every outbound `fetch` (provider calls and tool calls alike — both
 * benefit, and legitimate public hostnames pass through unaffected).
 * Called once at boot (`index.ts`); never called from tests, which
 * install their own `MockAgent` dispatcher per test file and never reach
 * a real DNS lookup at all.
 */
export function installSsrfSafeDispatcher(): void {
  setGlobalDispatcher(
    new Agent({
      connect: { lookup: createSafeLookup() as unknown as import("node:net").LookupFunction },
    }),
  );
}
