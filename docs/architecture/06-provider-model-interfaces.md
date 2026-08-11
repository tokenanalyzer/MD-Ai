# Provider Abstraction, Model Registry, Model Router

Full type definitions: `packages/shared-types/src/providers`.

## 1. The `ModelProvider` contract

```ts
interface ModelProvider {
  id: string;
  displayName: string;
  listModels(apiKey: string): Promise<ModelInfo[]>;
  testConnection(apiKey: string): Promise<ConnectionTestResult>;
  chat(apiKey: string, request: ChatRequest): AsyncIterable<ChatResponseChunk>;
}
```

Three methods, deliberately minimal. Every vendor-specific detail
(auth header shape, SSE vs. chunked-JSON streaming, tool-call encoding,
rate-limit headers) is translated to/from this shape **inside** the
adapter. Nothing above this interface (Model Router, Agent runtime context,
API layer) ever imports a vendor SDK.

`apiKey` is a parameter, not adapter state — the adapter is instantiated
once at boot and reused across every user request; the decrypted key is
fetched from the vault just before the call and never cached in the
adapter instance (see `07-security-model.md`).

## 2. Initial adapters

| `provider_id` | Adapter dir | Notes |
|---|---|---|
| `nvidia-nemotron` | `core/providers/nvidia-nemotron` | NVIDIA NIM-compatible API surface; strong reasoning/tool-use models |
| `gemini` | `core/providers/gemini` | Google Generative Language API; native multimodal/vision |
| `groq` | `core/providers/groq` | OpenAI-compatible chat completions; primary use: very low latency |
| `sambanova` | `core/providers/sambanova` | OpenAI-compatible chat completions |
| `openrouter` | `core/providers/openrouter` | Meta-provider — one credential can reach many upstream models; useful as a broad-coverage fallback and for `listModels` discovery |

All five ship `chat()` as an OpenAI-compatible or documented-native
streaming call normalized to `AsyncIterable<ChatResponseChunk>`. Adding a
sixth provider means: implement `ModelProvider` in a new
`core/providers/<id>` directory, add a `providers` row (id/display
name/base URL), no router or API changes.

## 3. Model Registry

Backed by `model_registry` (see `02-database-schema.md`). Read path is hot
(every routed request reads it), write path is comparatively rare
(discovery, health rollup, user edits) — so `ModelRegistry.list()` is
expected to be cached in-process with a short TTL (invalidated on
`upsert()`), not hit Postgres per chat turn.

`ModelRegistryEntry.discoveredBy` distinguishes rows the user/system added
manually from ones the Evolution Engine discovered — the Vault UI and the
Evolution approval flow both filter on this.

## 4. Model Router algorithm (M2 baseline; refined over time by outcome learning)

`selectModel(criteria: RoutingCriteria) → RoutingDecision`:

1. If `criteria.preferredModelId` is set and that model is `userEnabled`,
   `available`/`degraded`, and its provider has a `connected` credential →
   use it, `reason: "user_override"`.
2. Otherwise filter `model_registry` to rows where: provider has a
   `connected` credential, `userEnabled = true`, `availability != 'unavailable'`,
   and every capability in `requiredCapabilities` is true.
3. Rank remaining candidates by: `userPriority` desc → `errorRatePct` asc →
   `avgLatencyMs` asc (weighted against `maxLatencyMs` if given).
4. Top candidate → `reason: "capability_match"` (or `"user_default"` if it's
   the provider's `provider_default_models` entry and nothing else
   differentiates). Build `fallbackChain` from the next 1–2 ranked
   candidates, preferring a **different provider** for the first fallback so
   a single vendor outage doesn't take out the whole chain.
5. No candidates at all → throw a typed `NoAvailableModelError`; the caller
   (agent runtime) surfaces this as a normal `TaskError` with
   `retryable: false` rather than the process crashing.

On a call failure mid-stream, the caller uses `RoutingDecision.fallbackChain`
directly (no re-query) and emits `model.switched` with the failure reason —
this is what keeps fallback fast and keeps the Command Center's model-switch
visualization accurate.

## 5. Health & discovery feedback loop

Every `chat()` call (success or failure) is recorded via
`ModelRegistry.recordCallSample()` → `model_call_samples`. A scheduled job
(part of `core/observability`, not the Evolution Engine) rolls these up
hourly into `model_registry.avg_latency_ms` / `error_rate_pct` /
`availability`. The Evolution Engine (see `09-roadmap.md` M9) later adds:
periodic `listModels()` sweeps to catch new/retired models, and scheduled
`testConnection()` probes to catch silent credential expiry — both write
through the same `ModelRegistry.upsert()` path, so routing logic doesn't
need to know discovery happened.
