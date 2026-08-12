import type pg from "pg";
import type { MemoryEngine, ModelRegistry } from "@mdai/shared-types";
import type { EventBus } from "../events/eventBus.js";
import { runDiscoverySweep } from "./discoverySweep.js";
import { runBenchmarkingSweep } from "./benchmarking.js";
import { listProposals } from "../../db/repositories/evolutionProposalRepo.js";

export interface EvolutionSweepDeps {
  pool: pg.Pool;
  eventBus: EventBus;
  modelRegistry: ModelRegistry;
  memoryEngine: MemoryEngine;
}

export interface EvolutionSweepSummary {
  sweepId: string;
  proposalsCreated: number;
  proposalsApplied: number;
  proposalsDenied: number;
  durationMs: number;
}

/**
 * M9 Evolution Engine entry point: discovery, then benchmarking, both
 * producing `evolution_proposals` rows that are reviewed and (for the two
 * classes with a real applier, when they don't require approval)
 * auto-applied along the way — see `discoverySweep.ts`/`benchmarking.ts`/
 * `reviewAndApply.ts`. Called both from `queue/evolutionSweepJob.ts`'s
 * schedule and from `POST /evolution/sweep` for an on-demand run, same
 * "one real implementation, two triggers" shape as the Bot Engine's
 * `runNow` alongside its own schedule.
 */
export async function runEvolutionSweep(deps: EvolutionSweepDeps): Promise<EvolutionSweepSummary> {
  const sweepId = crypto.randomUUID();
  const start = Date.now();

  await deps.eventBus.publish({
    sourceType: "system",
    sourceId: sweepId,
    payload: { type: "evolution.sweep.started", sweepId },
  });

  const beforeApplied = (await listProposals(deps.pool, "applied")).length;
  const beforeRejected = (await listProposals(deps.pool, "rejected")).length;

  // Sequential, not parallel: both sweeps can propose changes to the same
  // model_registry row (discovery touches capabilities, benchmarking
  // touches user_priority) — running them one after another keeps the
  // sweep's own read-then-write reasoning simple to audit, at no
  // meaningful cost for this single-user system's call volume.
  const discovery = await runDiscoverySweep(deps);
  const benchmarking = await runBenchmarkingSweep(deps);

  const afterApplied = (await listProposals(deps.pool, "applied")).length;
  const afterRejected = (await listProposals(deps.pool, "rejected")).length;

  const summary: EvolutionSweepSummary = {
    sweepId,
    proposalsCreated: discovery.proposalsCreated + benchmarking.proposalsCreated,
    proposalsApplied: Math.max(0, afterApplied - beforeApplied),
    proposalsDenied: Math.max(0, afterRejected - beforeRejected),
    durationMs: Date.now() - start,
  };

  await deps.eventBus.publish({
    sourceType: "system",
    sourceId: sweepId,
    payload: {
      type: "evolution.sweep.completed",
      sweepId,
      proposalsCreated: summary.proposalsCreated,
      proposalsApplied: summary.proposalsApplied,
      proposalsDenied: summary.proposalsDenied,
      durationMs: summary.durationMs,
    },
  });

  return summary;
}
