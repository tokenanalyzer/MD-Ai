import pg from "pg";
import { loadEnv } from "../config/env.js";

let pool: pg.Pool | undefined;

/**
 * Managed Postgres providers behind a connection pooler (this repo targets
 * Supabase's Session Pooler, per docs/architecture) commonly present a TLS
 * certificate chain whose root isn't in Node's default trusted CA store —
 * connecting fails with SELF_SIGNED_CERT_IN_CHAIN even with
 * `?sslmode=require` set, because `pg-connection-string` (bundled with
 * `pg` 8.x) treats `require`/`prefer`/`verify-ca` as aliases for
 * `verify-full` — full chain *and* hostname verification — not libpq's
 * classic "encrypt only, don't verify" behavior.
 *
 * Passing an explicit `ssl` option alongside `connectionString` does NOT
 * fix this: `pg`'s ConnectionParameters merges as
 * `Object.assign({}, config, parse(connectionString))`, so an `ssl` value
 * derived from `sslmode` in the URL silently overwrites whatever `ssl` you
 * passed explicitly. `sslmode` has to be stripped from the URL itself
 * before an explicit `ssl` option can take effect — confirmed against the
 * installed `pg-connection-string`: parse() only sets an `ssl` key at all
 * when `sslmode`/`sslcert`/`sslkey`/`sslrootcert` are present.
 *
 * The fix here disables certificate *chain* verification only when the
 * connection string actually requested SSL (`sslmode` present) — local/
 * test DATABASE_URLs never set it, so this is a no-op for them; the
 * connection there is neither requested nor forced to use TLS, unchanged
 * from before. Security tradeoff: the connection stays TLS-encrypted
 * (protects against passive network eavesdropping) but no longer
 * authenticates the server's certificate chain (does not protect against
 * an active MITM on the network path to the database). Closing that gap
 * requires Supabase's actual per-project CA certificate
 * (`sslmode=verify-full` + `sslrootcert`), which is only obtainable by
 * downloading it from the Supabase Dashboard's Connect panel — not
 * something derivable in code.
 */
function resolveConnection(databaseUrl: string): { connectionString: string; ssl?: { rejectUnauthorized: false } } {
  const url = new URL(databaseUrl);
  if (!url.searchParams.has("sslmode")) return { connectionString: databaseUrl };
  url.searchParams.delete("sslmode");
  return { connectionString: url.toString(), ssl: { rejectUnauthorized: false } };
}

export function getPool(): pg.Pool {
  if (!pool) {
    const env = loadEnv();
    const { connectionString, ssl } = resolveConnection(env.DATABASE_URL);
    pool = new pg.Pool({ connectionString, max: 10, ...(ssl ? { ssl } : {}) });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
