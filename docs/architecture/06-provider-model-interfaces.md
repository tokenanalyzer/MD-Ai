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

## 3. Model Registry (first-class subsystem, M2.1)

Backed by `model_registry` (see `02-database-schema.md`), implemented by
`core/registry/modelRegistryService.ts` (`ModelRegistryService`). Read path
is hot (every routed request reads it), write path is comparatively rare
(discovery, health rollup, user edits) — so `list()`/`get()` are cached
in-process with a 5s TTL, invalidated on `upsert()`; `recordCallSample()`
does not invalidate the cache (a single telemetry write shouldn't thrash
reads — the health rollup, §5, is what turns samples into registry state).

`ModelRegistryEntry.discoveredBy` distinguishes rows added by discovery
(`'manual'` — see §3.1; nothing autonomous exists yet) from ones the
Evolution Engine will add starting M9 (`'evolution_engine'`) — the Vault
UI and the future Evolution approval flow both filter on this.

### 3.1 Discovery: "don't hard-code the registry to today's models"

`core/registry/discovery.ts`'s `discoverModels()` is the mechanism that
satisfies this M2 requirement concretely. It runs whenever
`POST /providers/:id/test-connection` succeeds (`api/routes/providers.ts`)
— the adapter already called `listModels()` to run the test, so discovery
reuses that result at no extra request cost. For each returned model:

1. Look up `${providerId}/${providerModelRef}` in
   `core/router/capabilityCatalog.ts`'s `KNOWN_MODEL_CAPABILITIES` — a
   hand-curated map for models MD AI ships defaults for.
2. If found, use that capability data. If not, use
   `UNKNOWN_MODEL_CAPABILITIES` (`contextLength: 0`, every boolean
   capability `false`, `tags: ["unverified"]`) — **never guessed from the
   model's name or id**, per the M2 instruction. An uncurated model is
   still registered (so it shows up, can be selected, and gets fresh
   telemetry) — it just won't pass any hard capability requirement in the
   Capability Matrix (§ below) until someone extends the catalog or the
   Evolution Engine (M9) verifies it.
3. `registry.upsert()` — which refreshes capability/display fields but
   **never touches `user_enabled`/`user_priority`** (the user's own
   config) or the live health fields (`availability`/`avg_latency_ms`/
   `error_rate_pct`, owned by §5's rollup) — see
   `db/repositories/modelRegistryRepo.ts`'s `upsertDiscoveredModel` for
   the exact column-level split. Re-running discovery is safe to do
   repeatedly; it can't silently re-enable a model the user disabled.

Extending the catalog (adding/correcting a model's capability row) is how
"provider adapters update model metadata safely" happens in practice — a
data change in `capabilityCatalog.ts`, never router logic.

### 3.2 Capability Matrix (M2.3)

`core/router/capabilityMatrix.ts`'s `TASK_CATEGORY_REQUIREMENTS` is the
**only** place a task category maps to capability requirements — the
router never infers what a request needs from a prompt's contents or a
model's name, only from `RoutingCriteria.taskCategory`, which the caller
(Master Agent today; any future specialist agent) states explicitly.

| Task category | Hard requirement | Soft preference |
|---|---|---|
| `chat` | — | — |
| `reasoning` | — | `supportsReasoning` (+10 score) |
| `research` | min. context 32K | `supportsReasoning` (+10 score) |
| `long-context` | min. context 100K | — |
| `vision` | `supportsVision` | — |
| `tool-calling` | `supportsTools` | — |
| `structured-output` | `supportsStructuredOutput` | — |
| `fast` | — | latency weighted ×2 in scoring |

"Hard requirement" excludes a candidate outright (§4.1 step 3); "soft
preference" only nudges the score among candidates that already qualify.
An `undefined` `taskCategory` (the common case — most chat turns aren't
tagged) applies no filter at all, matching the M1 behavior of considering
every configured model.

## 4. Model Router — every candidate must come from `availableProviderIds`

Because the backend holds no persistent provider credential (see
`07-security-model.md` §3), the router can only ever route to a provider
the *current request* actually supplied a key for —
`criteria.availableProviderIds` (populated from the request's
`providerKeys` map, §`03-api-contracts.md` §2).

Decision-making (`core/router/resolveRoutingDecision.ts`, DB-backed) and
execution (`core/router/modelRouter.ts`'s `streamChatWithFallback`, pure
given a decision) are deliberately separate — the M2 instruction that
"the routing algorithm must remain deterministic and inspectable" is
easiest to keep true when the scoring function
(`core/router/scoreModel.ts`) is a pure function of its inputs, testable
without a database or a network call (see `services/backend/test/unit/
scoreModel.test.ts`).

### 4.1 AUTO mode — the M2.4 deterministic scoring router

`resolveRoutingDecision(pool, modelRegistry, criteria)`:

1. Reject up front if `criteria.availableProviderIds` is empty →
   `NoAvailableModelError`.
2. Fetch every `userEnabled` Model Registry entry whose `providerId` is in
   `availableProviderIds`. For any available provider the registry has
   **no** row for yet (not discovered), synthesize a conservative
   "unknown capabilities" placeholder from `PROVIDER_DEFAULT_MODELS` so a
   brand-new provider still works, just without capability-aware scoring
   until discovery runs.
3. **Capability Matrix hard filter** (`core/router/capabilityMatrix.ts`):
   a candidate missing a `taskCategory`'s `hardRequirements` (e.g. no
   `supportsVision` for a `vision` task) or below its `minContextLength`
   is excluded outright — not scored low, excluded. Same for
   `criteria.requiredCapabilities` and `criteria.maxLatencyMs` if given.
   `availability: 'unavailable'` and `userEnabled: false` are also hard
   exclusions.
4. **Score every surviving candidate** (`scoreCandidate`), five
   independently-visible buckets, none hidden in one opaque number:
   - `capabilityScore` — a *preference* bonus (e.g. `+10` for
     `supportsReasoning` on a `reasoning`/`research` task) — hard misses
     already got excluded in step 3, this is only for otherwise-tied
     candidates.
   - `availabilityScore` — `available` (40) > `degraded` (15) >
     `unknown` (5, i.e. never verified).
   - `latencyScore` — lower `avgLatencyMs` scores higher (0–30, doubled
     for the `fast` task category); a model with **no samples yet** gets
     a neutral 15, not a penalty for being unproven.
   - `errorRateScore` — lower `errorRatePct` scores higher (0–30); same
     neutral-for-unproven handling.
   - `userPriorityScore` — the user's own `userPriority` (`×5`), plus
     `+8` if this is the provider's configured default model
     (`provider_default_models`, set via the Vault UI's default-model
     picker, M2.5).
5. An explicit `criteria.preferredModelId` present among the candidates
   wins outright over scoring (`reason: "user_override"`) — the caller
   asked for this exact model, scoring doesn't get to override that.
   Otherwise the top-scoring survivor wins, `reason: "user_default"` if
   it's the provider's configured default, else `"capability_match"`.
6. `fallbackChain` = every other non-excluded candidate, in score order —
   which, since M2, can include **another model on the same provider**
   (not just other providers) if that provider has more than one
   registry entry.
7. **Provider health**, per-call **timeout** (30s to first byte),
   **retry** (bounded, jittered, only for transient errors), and a
   **circuit breaker** per provider — unchanged from M1, still enforced
   in `streamChatWithFallback` (`08-deployment-architecture.md` §5).

On a call failure mid-stream, the caller uses `RoutingDecision.fallbackChain`
directly (no re-query) and emits `model.switched` with the failure reason —
this is what keeps fallback fast and keeps the Command Center's model-switch
visualization accurate. Once any content has reached the caller, the router
does **not** retry or fall back (would duplicate output) — it surfaces the
error and leaves recovery to the chat UI's explicit retry action.

### 4.2 MANUAL mode — no scoring, no substitution

`criteria.routingMode === "manual"` bypasses steps 2–6 entirely:

1. Requires `criteria.preferredProviderId` to be one of
   `availableProviderIds` — otherwise `NoAvailableModelError`.
2. Uses `criteria.preferredModelId` if given, else that provider's
   hard-coded default model (`PROVIDER_DEFAULT_MODELS`).
3. `reason: "manual_pin"`, `fallbackChain: []` — retries against that
   *same* model still happen (transient network resilience), but there is
   never a substitution to a different model or provider. This is the
   literal M2 instruction: "MANUAL: Always use the selected provider/model."

### 4.3 What's still deferred to M3+

Nothing here is "adaptive" in the self-learning sense — every weight in
`scoreCandidate` is a fixed constant in source code, not a learned
parameter. Actual weight tuning from observed outcomes (as opposed to
just *collecting* the outcomes, which M2.2 already does) is out of scope
until there's enough real telemetry to tune against responsibly, and even
then stays inside the bounded `routing_policy_update` change class
(`07-security-model.md` §5) — never something the model itself rewrites.

## 5. Telemetry & the health rollup (M2.2)

Every `chat()` call — success or failure, primary or fallback — is
recorded via `ModelRegistry.recordCallSample()` →
`model_registry_repo.ts`'s `insertModelCallSample` → `model_call_samples`
(`docs/architecture/02-database-schema.md` for the exact columns: latency,
success/timed-out/used-as-fallback, approximate token counts when the
provider returned `usage`, response status, task category — **never**
prompt/response content or a secret). The write happens from
`onCallSample` inside `streamChatWithFallback` and is fire-and-forget from
the agent's perspective — telemetry can never block or fail a chat turn.

`core/registry/` doesn't run the rollup itself; a dedicated BullMQ job
does (`queue/healthRollupJob.ts`, scheduled every 5 minutes — see
`08-deployment-architecture.md` §2.1 for why this cadence at this scale):
`computeHealthRollup()` averages latency and error rate over each model's
most recent 20 samples (a sample-count window, not a fixed time window, so
a rarely-called model isn't judged on ancient data and a hot model doesn't
dominate its own average), then `applyHealthRollup()` writes
`avg_latency_ms`/`error_rate_pct`/`availability` back onto `model_registry`
— `unavailable` at ≥80% error rate, `degraded` at ≥30%, else `available`.
This is exactly the health data §4.1's scoring reads; the router itself
never queries `model_call_samples` directly.

The Evolution Engine (`09-roadmap.md` M9) later adds periodic `listModels()`
sweeps to catch new/retired models and scheduled `testConnection()` probes
to catch silent credential expiry — both would write through the same
`upsert()`/rollup paths already built here, so routing logic doesn't need
to know discovery became autonomous.
