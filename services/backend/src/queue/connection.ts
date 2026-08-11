import { Redis } from "ioredis";
import { loadEnv } from "../config/env.js";

let connection: Redis | undefined;

export function getRedisConnection(): Redis {
  if (!connection) {
    const env = loadEnv();
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
