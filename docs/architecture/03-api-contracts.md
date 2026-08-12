# API Contracts

Backend base URL is reached only over TLS (see `08-deployment-architecture.md`).
Every request except `/auth/*` requires a device session bearer token
(`Authorization: Bearer <token>`, see `07-security-model.md` §2). This
document is the source of truth `packages/api-spec/openapi.yaml` gets
generated from in Phase 7 — implementation must not diverge from it without
updating this file first.

Common envelope:

```jsonc
// success
{ "data": { /* ... */ } }
// error
{ "error": { "code": "string", "message": "string", "retryable": false } }
```

## 1. Auth & device pairing

| Method | Path | Body → Response |
|---|---|---|
| `POST` | `/auth/pair` | `{ pairingCode, deviceName, platform, pushToken? }` → `{ accessToken, refreshToken, expiresIn }`. Pairing code is generated out-of-band on first backend boot (printed to server log / shown once), single-use. |
| `POST` | `/auth/refresh` | `{ refreshToken }` → `{ accessToken, expiresIn }` |
| `POST` | `/auth/revoke` | `{ deviceSessionId }` → `204`. Revokes a device (e.g. lost phone). |
| `GET` | `/auth/sessions` | → `DeviceSession[]` |

## 2. Chat / conversations

| Method | Path | Body → Response |
|---|---|---|
| `GET` | `/conversations` | → `Conversation[]` (paginated) |
| `POST` | `/conversations` | `{ title? }` → `Conversation` |
| `GET` | `/conversations/:id/tasks` | → `Task[]` with nested `task_messages` |
| `POST` | `/conversations/:id/messages` | `{ parts: Part[], providerKeys, preferredProviderId?, preferredModelId?, taskCategory?, routingMode? }` → `Task` (creates a `master` task; state starts `submitted`). Text, image, file, and PDF parts all go through this one endpoint — see §6. |
| `POST` | `/tasks/:id/cancel` | `{ reason? }` → `204` |
| `WS` | `/ws/tasks/:id` | Server→client `TaskStreamChunk` frames (see below) |

`providerKeys` is `{ [providerId: string]: string }` — the app includes a
key **only** for providers it currently has unlocked in its local vault
and is willing to let this request use. `taskCategory` (one of `chat`,
`reasoning`, `research`, `long-context`, `vision`, `tool-calling`,
`structured-output`, `fast`) tells the AUTO router's capability matrix
what this message actually needs — omit it and every model qualifies.
`routingMode` is `"auto"` (default) or `"manual"`; `"manual"` requires
`preferredProviderId` and always uses exactly that provider/model with no
scoring or cross-model fallback — see `06-provider-model-interfaces.md`
§4 for the full algorithm both modes run. None of these keys are
ever written to a database row; they exist only in the request handler's
memory for the lifetime of the call (typically a few seconds for a
streamed response) — see `07-security-model.md` §3 for the exact
guarantee and how it's tested.

Chat streaming happens over the same WebSocket gateway used for Command
Center events (§5), scoped to `taskId` — one connection serves both a chat
screen and the Command Center simultaneously, so opening the Command Center
never duplicates a chat's model calls. `TaskStreamChunk.kind` is one of
`token` (answer text delta), `status` (`completed`/`failed`/`canceled`),
`tool_call`, `message`, or — since M3 — `agent_progress`, a short
human-readable label (e.g. "Research Agent working…") Master or a
delegated agent emits while a sub-task is in flight. `agent_progress` is
always a safe status string, never chain-of-thought or raw model output
(`07-security-model.md`).

## 3. Provider / API Key Vault

**The key vault is on the device, not the backend.** Provider API keys are
written and read entirely inside the Android app's Keystore-backed local
storage. The backend never has a "store this key" endpoint at all — see
`07-security-model.md` §3. The endpoints below only ever see a key
**transiently, in a request body, for the duration of that one call**, and
persist only non-secret status metadata as a side effect.

| Method | Path | Body → Response |
|---|---|---|
| `GET` | `/providers` | → `Provider[]` (built-in + user-added catalog, no per-user state) |
| `GET` | `/providers/:id/configs` | → `ProviderConfig[]` — status metadata only: `keyLast4`, `status`, `isDefault`, `label`, `lastTestAt`. **No `apiKey` field exists on this type.** |
| `POST` | `/providers/:id/test-connection` | `{ apiKey, label? }` → `{ result: ConnectionTestResult, config: ProviderConfig, discoveredModelCount }`. The backend calls the provider's adapter with this key **in memory only**, returns the result, and upserts the matching `provider_configs` row's `status`/`last_test_at`/`last_test_error`/`key_last4` (the last-4 fragment is computed from the key `POST`ed for this one call, then the key itself is discarded — never written anywhere). On success, also feeds the Model Registry discovery pipeline (§3.1) using the model list the adapter already fetched to run the test — no extra request. |
| `PATCH` | `/providers/:id/configs/:configId` | `{ label?, isDefault? }` → `ProviderConfig`. Metadata-only edit — there is no way to set/replace a key through this route. |
| `PUT` | `/providers/:id/configs/:configId/default-model` | `{ modelId }` → `ProviderConfig` (now carrying `defaultModelId`). Sets which registry model this provider config should be used with by default — surfaced in the Vault UI's per-provider default-model picker (M2.5) and given a ranking bonus by the AUTO router (§`06-provider-model-interfaces.md` §4). |
| `DELETE` | `/providers/:id/configs/:configId` | → `204`. Clears the backend's status metadata for that provider config. Does **not** touch the device's local vault — the app deletes the actual key from `expo-secure-store` itself and calls this separately so other devices stop seeing it as configured. |

Chat requests (§2) that need a provider call attach the key(s) inline —
see the `providerKeys` field on the WS message contract below — rather
than the backend looking anything up by credential id, because the backend
holds no credential to look up.

### 3.1 Model Registry

| Method | Path | Body → Response |
|---|---|---|
| `GET` | `/models` | `?providerId=&enabledOnly=` → `ModelRegistryEntry[]` — capabilities, availability/health, and user config for every known model. Populated by migration seed data plus whatever `test-connection` has discovered (see `06-provider-model-interfaces.md` §3). |
| `PATCH` | `/models` | `{ modelId, userEnabled?, userPriority? }` → `ModelRegistryEntry`. `modelId` travels in the body rather than the URL because registry ids contain `/` (e.g. `groq/llama-3.3-70b-versatile`), which doesn't survive as an Express route param. Capability/health fields are read-only here — they come from discovery and the telemetry rollup, not user edits. |

## 4. Agents & bots

| Method | Path | Body → Response | Status |
|---|---|---|---|
| `GET` | `/agents` | → `AgentCard[]` with `status` (merges the `agents` table's live `status`/`last_heartbeat_at` with the JSONB `agent_card`'s descriptive fields) | **Implemented (M3)** |
| `PATCH` | `/agents/:id` | `{ enabled }` → `AgentCard` | **Implemented (M3)** |
| `GET` | `/agents/:id/tasks` | `?state=&limit=` → `Task[]` | Not yet implemented — use `GET /conversations/:id/tasks`, which already returns every task in a conversation's delegation tree (root + children), for now |
| `GET` | `/bots` | → `Bot[]` with last run summary | Future milestone — `core/bots` doesn't exist yet |
| `PATCH` | `/bots/:id` | `{ enabled?, config?, scheduleCron? }` → `Bot` | Future milestone |
| `POST` | `/bots/:id/run` | → `BotRun` (manual trigger, e.g. "check now") | Future milestone |
| `GET` | `/bots/:id/findings` | `?since=` → `BotFinding[]` | Future milestone |

## 5. Events / Command Center

| Method | Path | Body → Response |
|---|---|---|
| `GET` | `/events` | `?since=&types=&sourceType=&limit=` → `EventEnvelope[]` (REST catch-up / history scrub) |
| `WS` | `/ws/events?since=<id>&types=a,b,c` | Server→client `EventEnvelope` frames, replays from `since` then live-streams. One socket per device session; `types` filter avoids pushing `debug` noise to a phone on cellular data. |

## 6. Memory

| Method | Path | Body → Response |
|---|---|---|
| `GET` | `/memory` | `?category=&q=` → `MemoryItem[]` (lexical/trigram search over approved items) |
| `POST` | `/memory/search` | `{ query, category?, topK? }` → `MemoryItem[]` (same ranking as `GET`, explicit body form — what Master's context-retrieval step calls internally) |
| `GET` | `/memory/pending` | → `MemoryItem[]` (`approval_status = 'pending'` — system-proposed candidates awaiting a human decision) |
| `POST` | `/memory` | `{ category, content, tags?, pinned?, importance? }` → `MemoryItem`, always created `approved` (explicit user "remember this" via the Vault/Memory UI — direct user intent is its own approval) |
| `PATCH` | `/memory/:id` | `{ content?, tags?, pinned?, importance? }` → `MemoryItem` |
| `DELETE` | `/memory/:id` | → `204` (soft delete — "forget this") |
| `POST` | `/memory/:id/approve` | → `MemoryItem` (moves a `pending` candidate to `approved`, making it retrievable) |
| `POST` | `/memory/:id/reject` | → `MemoryItem` (moves a `pending` candidate to `rejected`, permanently excluded from retrieval) |

Chat-native memory commands (`"Remember this."` / `"Forget this."`) and
system-proposed candidates are handled by the Master Agent itself in M3 —
there is no separate `memory-agent` (see `04-agent-interfaces.md` §2/§7).
Master calls `core/memory`'s `MemoryEngine` directly (the same interface
these REST routes sit on top of, not a second code path) rather than going
through its own REST API internally.

## 7. Automations

| Method | Path | Body → Response |
|---|---|---|
| `GET` | `/automations` | → `Automation[]` |
| `POST` | `/automations` | `{ name, triggerType, triggerConfig, actionType, actionConfig }` → `Automation` |
| `PATCH` | `/automations/:id` | `{ enabled?, triggerConfig?, actionConfig? }` → `Automation` |
| `DELETE` | `/automations/:id` | → `204` |
| `POST` | `/automations/:id/run` | → `AutomationRun` (manual trigger) |
| `POST` | `/webhooks/automations/:slug` | provider-defined body → `202`. External trigger point (e.g. from n8n). Authenticated by a per-automation signed slug, not the device bearer token. |

`"Monitor this every morning."` in chat → Master Agent creates a `schedule`-
triggered automation via this same API (agent-created rows carry
`created_by = 'master_agent'`).

## 8. Evolution / approvals

| Method | Path | Body → Response |
|---|---|---|
| `GET` | `/evolution/proposals` | `?status=&changeClass=` → `EvolutionProposal[]` |
| `POST` | `/evolution/proposals/:id/approve` | → `EvolutionProposal` (only path that can move a `requires_approval` proposal to `approved`) |
| `POST` | `/evolution/proposals/:id/reject` | `{ reason? }` → `EvolutionProposal` |
| `GET` | `/evolution/proposals/:id/sandbox-result` | → sandbox test output for review before approving |

See `07-security-model.md` §5 for which `change_class` values reach this
approval gate at all vs. auto-apply.

## 9. Observability

| Method | Path | Response |
|---|---|---|
| `GET` | `/health` | Aggregate: `{ status, components: { db, redis, providers[], agents[], bots[] } }` |
| `GET` | `/health/:component` | Per-component health/latency/error-rate/last-activity |

## 10. Multipart content (images, files, PDFs, screenshots)

Binary content never travels inline in JSON. Flow: `POST /uploads`
(`multipart/form-data`) → `{ uri, mimeType }` → reference that `uri` in a
`FilePart` when posting the chat message. This keeps the WS/REST JSON
payloads small and lets the same upload be referenced from a `Task` and
later from a `MemoryItem` without re-uploading.
