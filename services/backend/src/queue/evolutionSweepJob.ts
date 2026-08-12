import { Queue, Worker, type Job } from "bullmq";
import type pg from "pg";
import type { MemoryEngine, ModelRegistry } from "@mdai/shared-types";
import { getRedisConnection } from "./connection.js";
import type { EventBus } from "../core/events/eventBus.js";
import { runEvolutionSweep } from "../core/evolution/producer.js";

/**
 * M9: schedules `runEvolutionSweep` — discovery + benchmarking, both
 * producing (and where eligible, auto-applying) `evolution_proposals`
 * rows. Runs far less often than the M2.2 health rollup: a discovery/
 * benchmarking sweep is a strategic review, not a hot telemetry path, and
 * every provider call it makes is a real outbound request against an
 * opted-in background credential.
 */
export const EVOLUTION_SWEEP_QUEUE_NAME = "evolution-sweep";
const REPEAT_EVERY_MS = 30 * 60 * 1000; // every 30 minutes

export function createEvolutionSweepQueue(): Queue {
  return new Queue(EVOLUTION_SWEEP_QUEUE_NAME, { connection: getRedisConnection() });
}

export function createEvolutionSweepWorker(
  pool: pg.Pool,
  eventBus: EventBus,
  modelRegistry: ModelRegistry,
  memoryEngine: MemoryEngine,
): Worker {
  return new Worker(
    EVOLUTION_SWEEP_QUEUE_NAME,
    async (_job: Job) => runEvolutionSweep({ pool, eventBus, modelRegistry, memoryEngine }),
    { connection: getRedisConnection() },
  );
}

export async function scheduleEvolutionSweepRepeatable(queue: Queue): Promise<void> {
  await queue.add("sweep", {}, { repeat: { every: REPEAT_EVERY_MS }, jobId: "evolution-sweep-repeatable" });
}
