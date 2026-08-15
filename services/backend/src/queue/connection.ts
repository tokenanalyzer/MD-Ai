import { Redis } from "ioredis";
import { loadEnv } from "../config/env.js";

let connection: Redis | undefined;

/**
 * Throws rather than falling back to ioredis's own default
 * (127.0.0.1:6379) if REDIS_URL isn't set — callers must check
 * `env.REDIS_URL` themselves first (see index.ts's conditional boot) so a
 * missing config value can never result in a silent, wrong connection
 * attempt instead of the intended "Redis is off" behavior.
 */
export function getRedisConnection(): Redis {
  if (!connection) {
    const env = loadEnv();
    if (!env.REDIS_URL) {
      throw new Error("getRedisConnection() called without REDIS_URL configured");
    }
    connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  }
  return connection;
}

export async function closeRedisConnection(): Promise<void> {
  if (connection) {
    await connection.quit();
    connection = undefined;
  }
}
