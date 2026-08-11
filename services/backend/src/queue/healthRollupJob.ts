import { Queue, Worker, type Job } from "bullmq";
import type pg from "pg";
import { getRedisConnection } from "./connection.js";
import { computeHealthRollup, applyHealthRollup } from "../db/repositories/modelRegistryRepo.js";

/**
 * M2.2: aggregates `model_call_samples` into `model_registry`'s
 * availability/avg_latency_ms/error_rate_pct — the rollup job promised in
 * docs/architecture/06-provider-model-interfaces.md §5 as the source of
 * the health data the M2.4 scoring router reads. Runs on a short interval
 * since M2's call volume is low (single user) — cheap to run often, and
 * fresher health data makes the router's scoring more honest sooner
 * after a provider starts failing.
 */
export const MODEL_HEALTH_ROLLUP_QUEUE_NAME = "model-health-rollup";
const REPEAT_EVERY_MS = 5 * 60 * 1000; // every 5 minutes

export function createHealthRollupQueue(): Queue {
  return new Queue(MODEL_HEALTH_ROLLUP_QUEUE_NAME, { connection: getRedisConnection() });
}

export function createHealthRollupWorker(pool: pg.Pool): Worker {
  return new Worker(
    MODEL_HEALTH_ROLLUP_QUEUE_NAME,
    async (_job: Job) => {
      const rollup = await computeHealthRollup(pool);
      await applyHealthRollup(pool, rollup);
      return { modelsUpdated: rollup.length };
    },
    { connection: getRedisConnection() },
  );
}

export async function scheduleHealthRollupRepeatable(queue: Queue): Promise<void> {
  await queue.add("rollup", {}, { repeat: { every: REPEAT_EVERY_MS }, jobId: "model-health-rollup-repeatable" });
}
