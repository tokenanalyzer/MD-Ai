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

## 4. Model Router — every candidate must come from `availableProviderIds`

Because the backend holds no persistent provider credential (see
`07-security-model.md` §3), the router can only ever route to a provider
the *current request* actually supplied a key for —
`criteria.availableProviderIds` (populated from the request's
`providerKeys` map, §`03-api-contracts.md` §2). `provider_configs.status`
metadata (last known "connected"/"error") is used only as a **ranking
signal**, never as a substitute for "is a key present right now."

### 4.1 M1 — explicit, deterministic (no learned ranking yet)

`selectModel(criteria: RoutingCriteria) → RoutingDecision`, M1 version:

1. Reject up front if `criteria.availableProviderIds` is empty →
   `NoAvailableModelError` ("no provider key supplied").
2. If `criteria.preferredModelId` is set and its provider is in
   `availableProviderIds` → use it, `reason: "user_override"`.
3. Else if `criteria.preferredProviderId` is set and present in
   `availableProviderIds` → use that provider's configured default model
   (`provider_default_models`, falling back to a hard-coded sane default
   per provider if none is set) → `reason: "user_default"`.
4. Else → pick the **first** provider in `availableProviderIds` in the
   order the client sent them → `reason: "capability_match"`.
5. `fallbackChain` = the remaining providers in `availableProviderIds`, in
   order, each mapped to that provider's default model. No latency/error-rate
   ranking yet — that requires the telemetry this milestone is busy
   collecting (`model_call_samples`), not guessing at it from zero data.
6. A **provider health check** runs before the first call: a lightweight
   probe (or the most recent `provider_configs.status` if checked within
   the last few minutes) — a provider known `error`/`disabled` is skipped
   in favor of the next one in `availableProviderIds` rather than being
   tried and failed first.
7. Per-call **timeout** (default 30s to first byte), **retry** (bounded,
   jittered, only for transient errors — timeouts/429/5xx), and a
   **circuit breaker** per provider (N consecutive failures within a
   window → skip that provider for the rest of the window) — see
   `08-deployment-architecture.md` §5.

On a call failure mid-stream, the caller uses `RoutingDecision.fallbackChain`
directly (no re-query) and emits `model.switched` with the failure reason —
this is what keeps fallback fast and keeps the Command Center's model-switch
visualization accurate.

### 4.2 M2+ — ranked/adaptive (deferred)

Once `model_call_samples` has real data, step 4 above is replaced by the
ranked algorithm originally scoped (`userPriority` → `errorRatePct` →
`avgLatencyMs`, weighted against `maxLatencyMs`). This is **explicitly
deferred past M1** — adaptive routing on zero telemetry is just guessing
with extra steps, and M1's job is to produce the telemetry, not consume it.

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
