# Database Schema

PostgreSQL 16 + `pgvector` + `pgcrypto` + `pg_trgm`. Migrations are plain
versioned SQL files in `services/backend/src/db/migrations/`, applied in
order by `drizzle-kit` (or `psql` directly in early bring-up). Each file is
additive; destructive/renaming changes get a new numbered migration, never
an edit to an already-applied one.

## 1. Entity groups

| Migration | Tables | Purpose |
|---|---|---|
| `0001_extensions.sql` | — | `pgcrypto`, `vector`, `pg_trgm` |
| `0002_core_config.sql` | `owner`, `device_sessions`, `app_config` | single-user identity, device auth, settings |
| `0003_provider_vault.sql` | `providers`, `provider_configs`, `provider_default_models` | Provider catalog + connection **metadata only** (no secrets — see §3) |
| `0004_model_registry.sql` | `model_registry`, `model_call_samples` | Model Registry + rolling health samples |
| `0005_agents.sql` | `agents`, `agent_delegation_edges` | Agent Registry (A2A agent cards) |
| `0006_a2a_tasks.sql` | `conversations`, `tasks`, `task_messages` | A2A task lifecycle + chat |
| `0007_events.sql` | `events` | Event bus durable log |
| `0008_memory.sql` | `memory_items` | Structured, embeddable long-term memory |
| `0009_bots.sql` | `bots`, `bot_runs`, `bot_findings` | Deterministic background workers |
| `0010_mcp_tools.sql` | `tools`, `agent_tool_grants`, `tool_invocations` | MCP tool registry |
| `0011_automations.sql` | `automations`, `automation_runs` | Scheduled/event-triggered automations, n8n hook |
| `0012_evolution_audit.sql` | `evolution_proposals`, `audit_log` | Bounded self-improvement + security audit trail |
| `0013_seed_providers.sql` | — | Seeds the built-in `providers` catalog (matches `core/providers/registry.ts`) |
| `0014_seed_agents.sql` | — | Seeds the `master` agent row (the only agent implemented in M1) |
| `0015_seed_default_models.sql` | — | Seeds one `model_registry` row per provider's M1 default model (matches `core/providers/registry.ts`'s `PROVIDER_DEFAULT_MODELS`) so `tasks.model_id`'s foreign key always has a valid target |
| `0016_model_registry_telemetry.sql` | — | M2: adds `model_registry.supports_structured_output`; adds `model_call_samples.provider_id`/`task_category`/`timed_out`/`used_as_fallback`/`input_tokens`/`output_tokens`/`response_status` |
| `0017_backfill_default_model_capabilities.sql` | — | M2: backfills accurate capability data (context length, tool/vision/reasoning/structured-output support) for the five M1-seeded default models, mirroring `core/router/capabilityCatalog.ts` |
| `0018_m3_agents_a2a_memory.sql` | — | M3: adds `agents.last_heartbeat_at`; `tasks.correlation_id`/`attempt` + index; `memory_items.importance`/`approval_status` + index; seeds the `research`/`reviewer` agent rows and refreshes `master`'s `agent_card`; seeds `agent_delegation_edges` for `master→research` and `master→reviewer` only |

## 2. Relationship overview

```
owner 1─* device_sessions

providers 1─* provider_configs 1─1 provider_default_models ──▶ model_registry
providers 1─* model_registry 1─* model_call_samples

agents 1─* agent_delegation_edges (self-referencing graph, data not code)
agents 1─* tasks (assigned_agent_id)      agents 1─* tasks (created_by_agent, nullable)
conversations 1─* tasks
tasks 1─* task_messages
tasks 1─1 (0..1) model_registry (model_id used to serve it)

tasks 1─* events (optional link)          agents/bots/tools ──▶ events (source_type/source_id, polymorphic)

bots 1─* bot_runs 1─* bot_findings ──▶ tasks (routed_task_id, the analysis this finding spawned)

agents *─* tools  via agent_tool_grants
tools 1─* tool_invocations ──▶ tasks (optional)

automations 1─* automation_runs

evolution_proposals (standalone; references nothing directly — diff payload
  names the target rows by id, keeping the proposal auditable independent
  of whether the target still exists)
```

## 3. Design notes

**Single-owner, not multi-tenant.** `owner` is a singleton table (enforced
by a unique index on a constant expression) rather than a `users` table with
an `owner_id` foreign key threaded through every other table. This keeps
every other table free of tenant-scoping columns/indexes that would exist
purely for multi-tenant isolation MD AI doesn't need.

**Polymorphic `events.source_type`/`source_id` instead of nullable FKs.**
Events come from agents, bots, tools, models, or automations. A single
`event_type` union with 5 optional foreign keys would mean 4 NULLs on every
row; the `(source_type, source_id)` pair keeps the table narrow and lets new
source kinds be added without a migration.

**`agent_delegation_edges` is data, not code.** The requirement "do not
hard-code agent relationships" is enforced structurally: the Master Agent's
delegation options are read from this table at request time, so adding a
new agent's delegation path is an `INSERT`, not a code change.

**Memory embeddings use HNSW, filtered by `deleted_at IS NULL`.** Deletes
are soft (`deleted_at`) so "forget this" is reversible/auditable, and the
partial index keeps the ANN index from indexing dead rows.

**Changing the embedding model.** `memory_items.embedding` is `vector(1536)`
to match the default embedding model recorded in
`app_config['memory.embedding_model']`. Swapping to a model with a different
output dimension requires: (1) a new migration that adds a new
`embedding_<dim>` column or a new table version, (2) a backfill job that
re-embeds existing `memory_items.content`, (3) a cutover that drops the old
column once backfill is verified. Never `ALTER COLUMN ... TYPE vector(N)` in
place across dimensions — pgvector will reject mismatched dimensions on
insert, which is the intended guardrail.

**Bot → Agent → Reviewer → Master pipeline is traceable in the schema.**
`bot_findings.routed_task_id` links a deterministic detection to the agent
`task` it spawned; that task's `parent_task_id` chain shows Reviewer
validation as a child task; `events` rows tie the whole chain to a visible
timeline for the Command Center. **M3 implements the agent half of this
today** (`master → research → reviewer`, `tasks.parent_task_id` +
`correlation_id` chaining exactly as described) — the bot-originated half
(`bot_findings.routed_task_id`) is still a future milestone; no bots exist
yet (`core/bots` is unimplemented).

**M3's memory approval workflow is a column, not a separate table.**
`memory_items.approval_status` (`approved` | `pending` | `rejected`,
migration `0018`) gates retrieval directly in `searchMemory`'s `WHERE`
clause — a `pending` row is structurally invisible to search until a
human calls `POST /memory/:id/approve`, rather than relying on
application code to remember to filter it out. `importance` (0–1,
default 0.5) is a second, independent ranking signal from `confidence` —
confidence is "how sure is this true," importance is "how much should
this weigh in retrieval regardless of truth," and M3's `searchMemory`
scoring blends both alongside trigram similarity and `pinned`.

**Cross-vendor memory embeddings are a documented gap, not a faked
feature.** `memory_items.embedding vector(1536)` exists in the schema
(migration `0008`) but nothing in M3 writes to it — `core/memory`'s
`searchMemory` uses `pg_trgm`'s `similarity()` on `content` instead, which
is real, working lexical/trigram ranking, not a placeholder. Populating
`embedding` for real needs a single embedding model usable consistently
across whichever of the five providers/keys happen to be configured on a
given request, which M3 explicitly does not attempt rather than faking
with a fixed or random vector — see `04-agent-interfaces.md` §7.

**Provider keys never appear in this schema at all — not even encrypted.**
`provider_configs` deliberately has no ciphertext column. The key lives in
the Android app's Keystore-backed local vault and is sent to the backend
transiently, per request, for in-memory use only; it is never written to
any table. `key_last4` is a display-only fragment reported by the client
after a successful local test, not derived from anything the server holds.
See `07-security-model.md` §3 for the full rationale and the boundary of a
possible future, explicitly opt-in server-side secret mechanism.

**`model_call_samples` never contains a secret or prompt content — only
call metadata.** `provider_id`, `task_category`, `latency_ms`,
`success`/`timed_out`/`used_as_fallback`, `input_tokens`/`output_tokens`
(counts, not content), and `response_status` (an HTTP status or a
provider `finish_reason` string). This is enforced structurally: the
telemetry write path (`core/router/modelRouter.ts`'s `onCallSample`) only
ever receives values computed from response *metadata* (byte counts,
timing, status codes), never the request/response bodies themselves — see
`07-security-model.md` §4.

**`model_registry` is reset to test-safe defaults between test runs, not
left as global mutable state.** `discoverModels()`/`applyHealthRollup()`
mutate the same five seeded rows other integration tests depend on having
known capability data — `services/backend/test/helpers/testDb.ts` resets
those rows (and deletes anything test-discovered beyond them) between
tests specifically to avoid one test file's discovery/telemetry output
silently changing another's routing decisions.

## 4. Retention

- `events`: `debug`/`info` rows pruned after `app_config['events.retention_days']`
  (default 30); `warn`/`error` retained default 180 days. Enforced by a
  scheduled job, not a DB trigger, so the policy is adjustable without a
  migration.
- `model_call_samples`: rolled up into `model_registry.avg_latency_ms` /
  `error_rate_pct` hourly, then pruned after 14 days.
- `audit_log`: never auto-pruned.
