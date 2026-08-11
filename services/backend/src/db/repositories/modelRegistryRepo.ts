import type pg from "pg";
import type { ModelAvailability, ModelCallSample } from "@mdai/shared-types";

export interface ModelRegistryRow {
  id: string;
  provider_id: string;
  provider_model_ref: string;
  display_name: string;
  context_length: number | null;
  supports_tools: boolean;
  supports_vision: boolean;
  supports_reasoning: boolean;
  supports_streaming: boolean;
  supports_structured_output: boolean;
  modality: "text" | "multimodal";
  capability_tags: string[];
  availability: ModelAvailability;
  avg_latency_ms: number | null;
  error_rate_pct: string | null; // NUMERIC comes back as string from pg
  last_verified_at: Date | null;
  user_enabled: boolean;
  user_priority: number;
  discovered_by: "manual" | "evolution_engine";
  created_at: Date;
  updated_at: Date;
}

export async function listModelRegistry(
  pool: pg.Pool,
  filter: { providerId?: string; enabledOnly?: boolean } = {},
): Promise<ModelRegistryRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.providerId) {
    params.push(filter.providerId);
    conditions.push(`provider_id = $${params.length}`);
  }
  if (filter.enabledOnly) {
    conditions.push("user_enabled = true");
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query<ModelRegistryRow>(
    `SELECT * FROM model_registry ${where} ORDER BY provider_id, display_name`,
    params,
  );
  return rows;
}

export async function getModelRegistryEntry(pool: pg.Pool, id: string): Promise<ModelRegistryRow | undefined> {
  const { rows } = await pool.query<ModelRegistryRow>("SELECT * FROM model_registry WHERE id = $1", [id]);
  return rows[0];
}

export interface UpsertModelInput {
  id: string;
  providerId: string;
  providerModelRef: string;
  displayName: string;
  contextLength: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  supportsStreaming: boolean;
  supportsStructuredOutput: boolean;
  modality: "text" | "multimodal";
  tags: string[];
  discoveredBy: "manual" | "evolution_engine";
}

/**
 * Inserts a newly-discovered model, or refreshes capability metadata for
 * an existing one WITHOUT clobbering the user's own configuration
 * (`user_enabled`, `user_priority`) or accumulated health stats
 * (`availability`, `avg_latency_ms`, `error_rate_pct`) — this is the safe
 * update path referenced by the M2.1 requirement that adapters can update
 * model metadata without resetting what the user or the telemetry rollup
 * has already established.
 */
export async function upsertDiscoveredModel(pool: pg.Pool, input: UpsertModelInput): Promise<ModelRegistryRow> {
  const { rows } = await pool.query<ModelRegistryRow>(
    `INSERT INTO model_registry (
        id, provider_id, provider_model_ref, display_name, context_length,
        supports_tools, supports_vision, supports_reasoning, supports_streaming,
        supports_structured_output, modality, capability_tags, discovered_by,
        availability, last_verified_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'available',now())
     ON CONFLICT (id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        context_length = EXCLUDED.context_length,
        supports_tools = EXCLUDED.supports_tools,
        supports_vision = EXCLUDED.supports_vision,
        supports_reasoning = EXCLUDED.supports_reasoning,
        supports_streaming = EXCLUDED.supports_streaming,
        supports_structured_output = EXCLUDED.supports_structured_output,
        modality = EXCLUDED.modality,
        capability_tags = EXCLUDED.capability_tags,
        availability = 'available',
        last_verified_at = now(),
        updated_at = now()
     RETURNING *`,
    [
      input.id,
      input.providerId,
      input.providerModelRef,
      input.displayName,
      input.contextLength,
      input.supportsTools,
      input.supportsVision,
      input.supportsReasoning,
      input.supportsStreaming,
      input.supportsStructuredOutput,
      input.modality,
      input.tags,
      input.discoveredBy,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to upsert model_registry row");
  return row;
}

export async function setModelUserConfig(
  pool: pg.Pool,
  id: string,
  patch: { userEnabled?: boolean; userPriority?: number },
): Promise<ModelRegistryRow | undefined> {
  const { rows } = await pool.query<ModelRegistryRow>(
    `UPDATE model_registry SET
        user_enabled = COALESCE($2, user_enabled),
        user_priority = COALESCE($3, user_priority),
        updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, patch.userEnabled ?? null, patch.userPriority ?? null],
  );
  return rows[0];
}

export async function insertModelCallSample(pool: pg.Pool, sample: ModelCallSample): Promise<void> {
  await pool.query(
    `INSERT INTO model_call_samples
       (model_id, provider_id, latency_ms, success, error_code, task_type, task_category, timed_out, used_as_fallback, input_tokens, output_tokens, response_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      sample.modelId,
      sample.providerId,
      sample.latencyMs,
      sample.success,
      sample.errorCode ?? null,
      sample.taskCategory ?? null,
      sample.taskCategory ?? null,
      sample.timedOut ?? false,
      sample.usedAsFallback ?? false,
      sample.inputTokens ?? null,
      sample.outputTokens ?? null,
      sample.responseStatus ?? null,
    ],
  );
}

export interface ModelHealthRollup {
  modelId: string;
  avgLatencyMs: number;
  errorRatePct: number;
  sampleCount: number;
}

/**
 * Aggregates recent `model_call_samples` into per-model health stats.
 * Read-only — callers decide whether/how to write the result back via
 * `applyHealthRollup`. Windowed to the last N samples per model (not a
 * fixed time window) so a model that's rarely called doesn't get judged
 * on ancient data, and a hot model doesn't dominate its own average.
 */
export async function computeHealthRollup(pool: pg.Pool, sampleWindow = 20): Promise<ModelHealthRollup[]> {
  const { rows } = await pool.query<{ model_id: string; avg_latency_ms: string; error_rate_pct: string; sample_count: string }>(
    `SELECT model_id,
            AVG(latency_ms) AS avg_latency_ms,
            100.0 * SUM(CASE WHEN success THEN 0 ELSE 1 END) / COUNT(*) AS error_rate_pct,
            COUNT(*) AS sample_count
     FROM (
       SELECT model_id, latency_ms, success,
              ROW_NUMBER() OVER (PARTITION BY model_id ORDER BY created_at DESC) AS rn
       FROM model_call_samples
     ) recent
     WHERE rn <= $1
     GROUP BY model_id`,
    [sampleWindow],
  );
  return rows.map((r) => ({
    modelId: r.model_id,
    avgLatencyMs: Math.round(Number(r.avg_latency_ms)),
    errorRatePct: Math.round(Number(r.error_rate_pct) * 100) / 100,
    sampleCount: Number(r.sample_count),
  }));
}

export async function applyHealthRollup(pool: pg.Pool, rollup: ModelHealthRollup[]): Promise<void> {
  for (const r of rollup) {
    const availability: ModelAvailability = r.errorRatePct >= 80 ? "unavailable" : r.errorRatePct >= 30 ? "degraded" : "available";
    await pool.query(
      `UPDATE model_registry SET avg_latency_ms = $2, error_rate_pct = $3, availability = $4, updated_at = now() WHERE id = $1`,
      [r.modelId, r.avgLatencyMs, r.errorRatePct, availability],
    );
  }
}
