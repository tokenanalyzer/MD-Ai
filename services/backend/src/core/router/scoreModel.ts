import type { ModelRegistryEntry, ModelScoreBreakdown, RoutingCriteria } from "@mdai/shared-types";
import { isCapable, TASK_CATEGORY_REQUIREMENTS } from "./capabilityMatrix.js";

/**
 * The M2.4 deterministic scoring function. Pure and side-effect free by
 * design — "the routing algorithm must remain deterministic and
 * inspectable" (M2 instructions) means no hidden state, no learned
 * weights, and every factor shows up in the returned breakdown rather
 * than being folded silently into one opaque number.
 *
 * Score buckets (each independently visible in ModelScoreBreakdown):
 * - capabilityScore: category-preference bonus (e.g. reasoning-preferred
 *   categories favor supportsReasoning) — hard requirements are handled
 *   by `isCapable` as an exclusion, not a score.
 * - availabilityScore: available > degraded > unknown; unavailable is
 *   excluded outright, never merely scored low.
 * - latencyScore: lower avg_latency_ms scores higher; unproven models
 *   (no samples yet) get a neutral score rather than being punished or
 *   favored for lack of data.
 * - errorRateScore: lower error_rate_pct scores higher; same neutral
 *   handling for unproven models.
 * - userPriorityScore: the user's own `userPriority` field, plus a bonus
 *   for being the provider's configured default model.
 */
export function scoreCandidate(
  entry: ModelRegistryEntry,
  criteria: RoutingCriteria,
  opts: { isProviderDefaultModel?: boolean } = {},
): ModelScoreBreakdown {
  const base: ModelScoreBreakdown = {
    modelId: entry.id,
    providerId: entry.providerId,
    excluded: false,
    totalScore: 0,
    capabilityScore: 0,
    availabilityScore: 0,
    latencyScore: 0,
    errorRateScore: 0,
    userPriorityScore: 0,
  };

  if (!entry.userEnabled) {
    return { ...base, excluded: true, exclusionReason: "disabled by user" };
  }
  if (entry.availability === "unavailable") {
    return { ...base, excluded: true, exclusionReason: "provider/model marked unavailable" };
  }

  const capabilityCheck = isCapable(entry, criteria.taskCategory);
  if (!capabilityCheck.capable) {
    return { ...base, excluded: true, exclusionReason: capabilityCheck.reason };
  }
  if (criteria.requiredCapabilities) {
    for (const cap of criteria.requiredCapabilities) {
      if (!entry.capabilities[cap]) {
        return { ...base, excluded: true, exclusionReason: `missing explicitly required capability: ${String(cap)}` };
      }
    }
  }
  if (criteria.maxLatencyMs && entry.avgLatencyMs && entry.avgLatencyMs > criteria.maxLatencyMs) {
    return { ...base, excluded: true, exclusionReason: `avg latency ${entry.avgLatencyMs}ms exceeds max ${criteria.maxLatencyMs}ms` };
  }

  const requirement = criteria.taskCategory ? TASK_CATEGORY_REQUIREMENTS[criteria.taskCategory] : undefined;

  let capabilityScore = 0;
  if (requirement?.reasoningPreferred && entry.capabilities.supportsReasoning) capabilityScore += 10;
  if (requirement?.minContextLength && entry.capabilities.contextLength >= requirement.minContextLength * 2) capabilityScore += 5;

  const availabilityScore = entry.availability === "available" ? 40 : entry.availability === "degraded" ? 15 : 5; // "unknown"

  const latencyWeight = requirement?.latencyWeighted ? 2 : 1;
  const latencyScore =
    entry.avgLatencyMs === undefined ? 15 : Math.max(0, Math.min(30, 30 - Math.floor(entry.avgLatencyMs / 200))) * latencyWeight;

  const errorRateScore = entry.errorRatePct === undefined ? 15 : Math.max(0, Math.min(30, Math.round((100 - entry.errorRatePct) * 0.3)));

  let userPriorityScore = entry.userPriority * 5;
  if (opts.isProviderDefaultModel) userPriorityScore += 8;

  const totalScore = capabilityScore + availabilityScore + latencyScore + errorRateScore + userPriorityScore;

  return { ...base, capabilityScore, availabilityScore, latencyScore, errorRateScore, userPriorityScore, totalScore };
}

/** Scores every candidate and returns them ranked best-first; excluded candidates sort last (score irrelevant to them). */
export function rankCandidates(
  entries: ModelRegistryEntry[],
  criteria: RoutingCriteria,
  defaultModelIds: ReadonlySet<string> = new Set(),
): ModelScoreBreakdown[] {
  return entries
    .map((entry) => scoreCandidate(entry, criteria, { isProviderDefaultModel: defaultModelIds.has(entry.id) }))
    .sort((a, b) => {
      if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
      return b.totalScore - a.totalScore;
    });
}
