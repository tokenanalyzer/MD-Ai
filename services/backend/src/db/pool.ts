import pg from "pg";
import { loadEnv } from "../config/env.js";

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const env = loadEnv();
    pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
