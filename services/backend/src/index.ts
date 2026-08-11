import { createServer } from "node:http";
import pino from "pino";
import { loadEnv } from "./config/env.js";
import { getPool, closePool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { ensureOwner } from "./db/repositories/ownerRepo.js";
import { listActiveSessions } from "./db/repositories/deviceSessionRepo.js";
import { generatePairingCode } from "./core/security/pairing.js";
import { EventBus } from "./core/events/eventBus.js";
import { getRedisConnection, closeRedisConnection } from "./queue/connection.js";
import {
  createEventsRetentionQueue,
  createEventsRetentionWorker,
  scheduleEventsRetentionRepeatable,
} from "./queue/eventsRetentionJob.js";
import { createApp } from "./api/app.js";
import { attachChatGateway } from "./api/ws/chatGateway.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = getPool();

  const { applied } = await runMigrations(pool);
  logger.info({ appliedCount: applied.length }, "database migrations up to date");

  const owner = await ensureOwner(pool, "Owner");
  const activeSessions = await listActiveSessions(pool, owner.id);
  if (activeSessions.length === 0) {
    const code = await generatePairingCode(pool);
    logger.info(`\n\n  MD AI pairing code (single use, expires in ${env.MDAI_PAIRING_CODE_TTL_MINUTES}m): ${code}\n`);
  }

  const redis = getRedisConnection();
  const eventBus = new EventBus(pool);

  const eventsRetentionQueue = createEventsRetentionQueue();
  const eventsRetentionWorker = createEventsRetentionWorker(pool);
  await scheduleEventsRetentionRepeatable(eventsRetentionQueue);

  const app = createApp({ pool, redis, queues: [eventsRetentionQueue], eventBus, logger });
  const server = createServer(app);
  attachChatGateway(server, pool);

  server.listen(env.PORT, () => {
    logger.info(`MD AI backend listening on :${env.PORT}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received, shutting down`);
    server.close();
    await eventsRetentionWorker.close();
    await eventsRetentionQueue.close();
    await closeRedisConnection();
    await closePool();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
