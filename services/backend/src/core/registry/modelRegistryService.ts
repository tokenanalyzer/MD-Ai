import type pg from "pg";
import type { ModelCallSample, ModelRegistry, ModelRegistryEntry } from "@mdai/shared-types";
import {
  getModelRegistryEntry,
  insertModelCallSample,
  listModelRegistry,
  type ModelRegistryRow,
  upsertDiscoveredModel,
  type UpsertModelInput,
} from "../../db/repositories/modelRegistryRepo.js";

function toEntry(row: ModelRegistryRow): ModelRegistryEntry {
  return {
    id: row.id,
    providerId: row.provider_id,
    providerModelRef: row.provider_model_ref,
    displayName: row.display_name,
    capabilities: {
      contextLength: row.context_length ?? 0,
      supportsTools: row.supports_tools,
      supportsVision: row.supports_vision,
      supportsReasoning: row.supports_reasoning,
      supportsStreaming: row.supports_streaming,
      supportsStructuredOutput: row.supports_structured_output,
      modality: row.modality,
      tags: row.capability_tags,
    },
    availability: row.availability,
    avgLatencyMs: row.avg_latency_ms ?? undefined,
    errorRatePct: row.error_rate_pct !== null ? Number(row.error_rate_pct) : undefined,
    lastVerifiedAt: row.last_verified_at?.toISOString(),
    userEnabled: row.user_enabled,
    userPriority: row.user_priority,
    discoveredBy: row.discovered_by,
  };
}

const CACHE_TTL_MS = 5_000;

/**
 * DB-backed `ModelRegistry` (docs/architecture/06-provider-model-interfaces.md
 * §3). Reads are cached briefly since the router calls `list()` on every
 * routed request; `upsert`/`recordCallSample` invalidate the cache so a
 * fresh discovery or health rollup is visible on the next read within
 * `CACHE_TTL_MS`, not just eventually.
 */
export class ModelRegistryService implements ModelRegistry {
  private cache: { key: string; entries: ModelRegistryEntry[]; expiresAt: number } | undefined;

  constructor(private readonly pool: pg.Pool) {}

  async list(filter: { providerId?: string; enabledOnly?: boolean } = {}): Promise<ModelRegistryEntry[]> {
    const key = `${filter.providerId ?? "*"}:${filter.enabledOnly ?? false}`;
    if (this.cache && this.cache.key === key && this.cache.expiresAt > Date.now()) {
      return this.cache.entries;
    }
    const rows = await listModelRegistry(this.pool, filter);
    const entries = rows.map(toEntry);
    this.cache = { key, entries, expiresAt: Date.now() + CACHE_TTL_MS };
    return entries;
  }

  async get(modelId: string): Promise<ModelRegistryEntry | undefined> {
    const row = await getModelRegistryEntry(this.pool, modelId);
    return row ? toEntry(row) : undefined;
  }

  async upsert(entry: ModelRegistryEntry): Promise<void> {
    const input: UpsertModelInput = {
      id: entry.id,
      providerId: entry.providerId,
      providerModelRef: entry.providerModelRef,
      displayName: entry.displayName,
      contextLength: entry.capabilities.contextLength,
      supportsTools: entry.capabilities.supportsTools,
      supportsVision: entry.capabilities.supportsVision,
      supportsReasoning: entry.capabilities.supportsReasoning,
      supportsStreaming: entry.capabilities.supportsStreaming,
      supportsStructuredOutput: entry.capabilities.supportsStructuredOutput,
      modality: entry.capabilities.modality,
      tags: entry.capabilities.tags,
      discoveredBy: entry.discoveredBy,
    };
    await upsertDiscoveredModel(this.pool, input);
    this.cache = undefined;
  }

  async recordCallSample(sample: ModelCallSample): Promise<void> {
    await insertModelCallSample(this.pool, sample);
    // Not invalidating the cache here — call samples feed the health
    // rollup job (core/registry/healthRollup.ts), not a direct registry
    // field, so a single sample shouldn't thrash the cache on every chat
    // token.
  }
}
