import type pg from "pg";
import type { ModelRegistry, ModelRegistryEntry, RoutingCriteria, RoutingDecision } from "@mdai/shared-types";
import { selectModelFromCandidates } from "./modelRouter.js";
import { PROVIDER_DEFAULT_MODELS } from "../providers/registry.js";
import { UNKNOWN_MODEL_CAPABILITIES } from "./capabilityCatalog.js";

function synthesizeUnknownEntry(providerId: string): ModelRegistryEntry {
  const providerModelRef = PROVIDER_DEFAULT_MODELS[providerId] ?? "default";
  return {
    id: `${providerId}/${providerModelRef}`,
    providerId,
    providerModelRef,
    displayName: providerModelRef,
    capabilities: UNKNOWN_MODEL_CAPABILITIES,
    availability: "unknown",
    userEnabled: true,
    userPriority: 0,
    discoveredBy: "manual",
  };
}

async function loadDefaultModelIds(pool: pg.Pool, providerIds: string[]): Promise<Set<string>> {
  if (providerIds.length === 0) return new Set();
  const { rows } = await pool.query<{ model_id: string }>(
    `SELECT pdm.model_id
     FROM provider_configs pc
     JOIN provider_default_models pdm ON pdm.provider_config_id = pc.id
     WHERE pc.provider_id = ANY($1)`,
    [providerIds],
  );
  return new Set(rows.map((r) => r.model_id));
}

/**
 * The DB-backed half of routing: gathers Model Registry candidates for
 * the request's available providers (synthesizing a conservative
 * "unknown capabilities" placeholder for any provider the registry
 * hasn't discovered models for yet, so a brand-new provider still works
 * — just without capability-aware scoring until discovery runs), then
 * delegates the actual decision to the pure `selectModelFromCandidates`.
 */
export async function resolveRoutingDecision(
  pool: pg.Pool,
  modelRegistry: ModelRegistry,
  criteria: RoutingCriteria,
): Promise<RoutingDecision> {
  if (criteria.routingMode === "manual") {
    return selectModelFromCandidates([], criteria);
  }

  const allEnabled = await modelRegistry.list({ enabledOnly: true });
  const relevant = allEnabled.filter((e) => criteria.availableProviderIds.includes(e.providerId));
  const covered = new Set(relevant.map((e) => e.providerId));
  const synthesized = criteria.availableProviderIds.filter((p) => !covered.has(p)).map(synthesizeUnknownEntry);

  const defaultModelIds = await loadDefaultModelIds(pool, criteria.availableProviderIds);
  return selectModelFromCandidates([...relevant, ...synthesized], criteria, defaultModelIds);
}
