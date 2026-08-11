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
| `POST` | `/conversations/:id/messages` | `{ parts: Part[] }` → `Task` (creates a `master` task; state starts `submitted`). Text, image, file, and PDF parts all go through this one endpoint — see §6. |
| `POST` | `/tasks/:id/cancel` | `{ reason? }` → `204` |
| `WS` | `/ws/tasks/:id` | Server→client `TaskStreamChunk` frames (see below) |

Chat streaming happens over the same WebSocket gateway used for Command
Center events (§5), scoped to `taskId` — one connection serves both a chat
screen and the Command Center simultaneously, so opening the Command Center
never duplicates a chat's model calls.

## 3. Provider / API Key Vault

| Method | Path | Body → Response |
|---|---|---|
| `GET` | `/providers` | → `Provider[]` (built-in + user-added) |
| `GET` | `/providers/:id/credentials` | → `ProviderCredential[]` — **`key` is never included**, only `keyLast4`, `status`, `isDefault` |
| `POST` | `/providers/:id/credentials` | `{ label?, apiKey, setAsDefault? }` → `ProviderCredential` (key encrypted server-side immediately; response omits it) |
| `PUT` | `/providers/:id/credentials/:credId` | `{ apiKey?, label?, isDefault? }` → `ProviderCredential`. Sending a new `apiKey` fully replaces the stored ciphertext. |
| `DELETE` | `/providers/:id/credentials/:credId` | → `204` |
| `POST` | `/providers/:id/credentials/:credId/test` | → `ConnectionTestResult` (also updates `status`/`last_test_*`) |
| `GET` | `/models` | `?providerId=&enabledOnly=` → `ModelRegistryEntry[]` |
| `PATCH` | `/models/:id` | `{ userEnabled?, userPriority? }` → `ModelRegistryEntry` (user-facing model config only; capability/health fields are read-only here) |

## 4. Agents & bots

| Method | Path | Body → Response |
|---|---|---|
| `GET` | `/agents` | → `AgentCard[]` with `status` |
| `PATCH` | `/agents/:id` | `{ enabled }` → `AgentCard` |
| `GET` | `/agents/:id/tasks` | `?state=&limit=` → `Task[]` |
| `GET` | `/bots` | → `Bot[]` with last run summary |
| `PATCH` | `/bots/:id` | `{ enabled?, config?, scheduleCron? }` → `Bot` |
| `POST` | `/bots/:id/run` | → `BotRun` (manual trigger, e.g. "check now") |
| `GET` | `/bots/:id/findings` | `?since=` → `BotFinding[]` |

## 5. Events / Command Center

| Method | Path | Body → Response |
|---|---|---|
| `GET` | `/events` | `?since=&types=&sourceType=&limit=` → `EventEnvelope[]` (REST catch-up / history scrub) |
| `WS` | `/ws/events?since=<id>&types=a,b,c` | Server→client `EventEnvelope` frames, replays from `since` then live-streams. One socket per device session; `types` filter avoids pushing `debug` noise to a phone on cellular data. |

## 6. Memory

| Method | Path | Body → Response |
|---|---|---|
| `GET` | `/memory` | `?category=&q=&tags=` → `MemoryItem[]` (text/tag search) |
| `POST` | `/memory/search` | `{ query, category?, topK? }` → `MemoryItem[]` (semantic/embedding search) |
| `POST` | `/memory` | `{ category, content, tags?, pinned? }` → `MemoryItem` (explicit "remember this") |
| `PATCH` | `/memory/:id` | `{ content?, tags?, pinned? }` → `MemoryItem` |
| `DELETE` | `/memory/:id` | → `204` (soft delete — "forget this") |

Chat-native memory commands (`"Remember this."` / `"Forget this."`) are
handled by the Master Agent delegating to `memory-agent`, which calls these
same endpoints internally via its `AgentRuntimeContext` — there is no
separate internal API, the agent uses the identical contract.

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
