import { Queue, Worker, type Job } from "bullmq";
import type pg from "pg";
import { getRedisConnection } from "./connection.js";
import { pruneOldEvents } from "../db/repositories/eventRepo.js";

/**
 * The one BullMQ job M1 actually runs (docs/architecture/
 * 08-deployment-architecture.md §2.1) — everything else (bots, evolution
 * sweeps) is deliberately not started yet. Proves the queue/worker
 * infrastructure end-to-end with real, if modest, work: pruning
 * debug/info `events` rows per the retention policy
 * (docs/architecture/02-database-schema.md §4).
 */
export const EVENTS_RETENTION_QUEUE_NAME = "events-retention";
export const DEFAULT_EVENTS_RETENTION_DAYS = 30;
const REPEAT_EVERY_MS = 6 * 60 * 60 * 1000; // every 6h

export function createEventsRetentionQueue(): Queue {
  return new Queue(EVENTS_RETENTION_QUEUE_NAME, { connection: getRedisConnection() });
}

export function createEventsRetentionWorker(pool: pg.Pool, retentionDays = DEFAULT_EVENTS_RETENTION_DAYS): Worker {
  return new Worker(
    EVENTS_RETENTION_QUEUE_NAME,
    async (_job: Job) => {
      const deleted = await pruneOldEvents(pool, retentionDays);
      return { deleted };
    },
    { connection: getRedisConnection() },
  );
}

export async function scheduleEventsRetentionRepeatable(queue: Queue): Promise<void> {
  await queue.add(
    "prune",
    {},
    { repeat: { every: REPEAT_EVERY_MS }, jobId: "events-retention-repeatable" },
  );
}
