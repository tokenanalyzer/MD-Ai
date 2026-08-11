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
timeline for the Command Center.

**Provider keys never appear in this schema at all — not even encrypted.**
`provider_configs` deliberately has no ciphertext column. The key lives in
the Android app's Keystore-backed local vault and is sent to the backend
transiently, per request, for in-memory use only; it is never written to
any table. `key_last4` is a display-only fragment reported by the client
after a successful local test, not derived from anything the server holds.
See `07-security-model.md` §3 for the full rationale and the boundary of a
possible future, explicitly opt-in server-side secret mechanism.

## 4. Retention

- `events`: `debug`/`info` rows pruned after `app_config['events.retention_days']`
  (default 30); `warn`/`error` retained default 180 days. Enforced by a
  scheduled job, not a DB trigger, so the policy is adjustable without a
  migration.
- `model_call_samples`: rolled up into `model_registry.avg_latency_ms` /
  `error_rate_pct` hourly, then pruned after 14 days.
- `audit_log`: never auto-pruned.
