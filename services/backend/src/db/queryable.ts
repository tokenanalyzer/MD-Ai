import type pg from "pg";

/**
 * The minimal `pg.Pool`/`pg.PoolClient`-shared surface for repo functions
 * that must be runnable both for real (against the pool) and inside an
 * isolated, always-rolled-back sandbox transaction (against a client from
 * `pool.connect()`) — see `core/evolution/sandbox.ts` (M9). `pg.Pool`
 * satisfies this structurally already, so widening a function's parameter
 * from `pg.Pool` to `Queryable` never changes behavior for existing
 * callers, only allows a transaction client as an additional caller.
 */
export type Queryable = Pick<pg.Pool, "query">;
