import type pg from "pg";
import type { MemoryEngine, ModelRegistry } from "@mdai/shared-types";
import type { EventBus } from "../events/eventBus.js";
import { computeHealthRollup } from "../../db/repositories/modelRegistryRepo.js";
import { createProposal } from "../../db/repositories/evolutionProposalRepo.js";
import { computeRequiresApproval } from "./changeClassPolicy.js";
import { reviewAndMaybeApply } from "./reviewAndApply.js";

export interface BenchmarkingDeps {
  pool: pg.Pool;
  eventBus: EventBus;
  modelRegistry: ModelRegistry;
  memoryEngine: MemoryEngine;
}

const MIN_SAMPLES = 5;
const HIGH_ERROR_RATE_PCT = 20;
const LOW_ERROR_RATE_PCT = 5;
const GOOD_LATENCY_MS = 1500;
const MIN_PRIORITY = 0;
const MAX_PRIORITY = 10;

/**
 * M9 benchmarking sweep: reuses M2.2's `computeHealthRollup` (real
 * aggregated `model_call_samples` telemetry, read-only here — it does not
 * also call `applyHealthRollup`, which is M2's own scheduled job's job)
 * rather than running fresh live benchmark calls of its own. This is
 * honestly "telemetry-based benchmarking," never a fabricated
 * fresh-measurement claim. A `routing_policy_update` proposal is only
 * created when a simple, deterministic, inspectable rule crosses a
 * threshold — the same "no hidden learned weights, every factor visible"
 * discipline `core/router/scoreModel.ts` documents for the router itself.
 * A model with too few samples, or whose telemetry doesn't cross either
 * threshold, produces no proposal at all.
 */
export async function runBenchmarkingSweep(deps: BenchmarkingDeps): Promise<{ proposalsCreated: number }> {
  const rollup = await computeHealthRollup(deps.pool);
  let proposalsCreated = 0;

  for (const r of rollup) {
    if (r.sampleCount < MIN_SAMPLES) continue;

    const entry = await deps.modelRegistry.get(r.modelId);
    if (!entry) continue; // telemetry for a model no longer in the registry

    let newPriority: number;
    let reason: string;
    if (r.errorRatePct >= HIGH_ERROR_RATE_PCT && entry.userPriority > MIN_PRIORITY) {
      newPriority = entry.userPriority - 1;
      reason = `elevated error rate observed in telemetry (${r.errorRatePct}% over ${r.sampleCount} recent calls)`;
    } else if (r.errorRatePct < LOW_ERROR_RATE_PCT && r.avgLatencyMs < GOOD_LATENCY_MS && entry.userPriority < MAX_PRIORITY) {
      newPriority = entry.userPriority + 1;
      reason = `consistently low error rate and latency observed in telemetry (${r.errorRatePct}% error, ${r.avgLatencyMs}ms avg over ${r.sampleCount} recent calls)`;
    } else {
      continue;
    }

    const diff = {
      modelId: r.modelId,
      previousPriority: entry.userPriority,
      newPriority,
      reason,
      sampleStats: { avgLatencyMs: r.avgLatencyMs, errorRatePct: r.errorRatePct, sampleCount: r.sampleCount },
    };

    const proposal = await createProposal(deps.pool, {
      changeClass: "routing_policy_update",
      title: `Adjust ${entry.displayName}'s routing priority: ${entry.userPriority} -> ${newPriority}`,
      rationale: reason,
      diff,
      riskLevel: "low",
      requiresApproval: computeRequiresApproval("routing_policy_update"),
    });
    proposalsCreated++;

    await deps.eventBus.publish({
      sourceType: "system",
      sourceId: proposal.id,
      payload: {
        type: "evolution.proposal.created",
        proposalId: proposal.id,
        changeClass: "routing_policy_update",
        riskLevel: "low",
        requiresApproval: proposal.requires_approval,
      },
    });

    await reviewAndMaybeApply(deps, proposal);
  }

  return { proposalsCreated };
}
