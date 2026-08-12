# Deployment Architecture

## 1. Target environment

**Oracle Cloud Always Free** — Ampere A1 (ARM64) compute, up to 4 OCPU /
24GB RAM total across instances at no cost. Initial allocation: **one
instance at 2 OCPU / 12GB RAM**, leaving the remaining 2 OCPU / 12GB as
headroom for a second instance later (e.g. isolating the sandbox used by
the Evolution Engine, per `07-security-model.md` §5) without leaving the
free tier.

Every image built by this project targets `linux/arm64`. CI builds and
tests on `arm64` explicitly (not just `amd64` with a hope it also works) —
see §6.

## 2. Resource budget (2 OCPU / 12GB instance)

| Service | RAM (approx.) | Notes |
|---|---|---|
| PostgreSQL 16 + pgvector | 2–3 GB | `shared_buffers` tuned to ~25% of its allotment; HNSW index kept small by memory retention policy (`02-database-schema.md` §4) |
| Redis 7 | 256–512 MB | Queue + rate-limit counters + short-TTL registry cache only, not a general cache store |
| Backend (Node) | 1.5–2.5 GB | Scales with concurrent agent/tool calls; bot runs are short-lived and don't hold long connections |
| Caddy (reverse proxy/TLS) | ~50 MB | |
| OS + Docker overhead | ~1 GB | |
| **Headroom** | **~5 GB** | Reserved — no service is sized to consume it by default; available for the n8n container (M10, optional) or traffic spikes |

### 2.1 M1→M2 conservative start

M1 and M2 run the smallest slice that proves the real chat path (M1) and
model registry/routing (M2) end-to-end, and nothing beyond it:

- **Running**: `backend` (API + WS gateway), `postgres`, `redis`, two
  BullMQ worker processes **inside the backend process** (not separate
  containers — see §3): the M1 events-retention sweep
  (`docs/architecture/02-database-schema.md` §4, every 6h) and the M2
  model-health rollup (`docs/architecture/06-provider-model-interfaces.md`
  §5, every 5min — more frequent because it's what keeps the AUTO
  router's health data fresh, and both jobs are cheap enough at single-user
  call volume that the extra cadence costs nothing measurable).
- **Explicitly not started through M2**: the Bot Engine's bot fleet (no
  bots are registered/scheduled yet — see `09-roadmap.md` M5/M8), the
  Evolution Engine, and any autonomous background agent work. There is
  nothing for a bot to run yet and no server-side key for one to use even
  if there were (`07-security-model.md` §3.4), so this isn't a deferred
  feature so much as a non-goal for these milestones specifically.
- **Worker count**: 2 (both in-process BullMQ workers, as of M2 — was 1 in
  M1). This is itself a telemetry value (§9.1) so growth is visible as
  later milestones add bots.

### 2.2 M5: the Bot Engine's real resource footprint

The Bot Engine adds exactly one more in-process BullMQ worker (worker
count: 3 as of M5), not one process per bot — see `12-bot-engine.md` §3.
Its own resource discipline is structural, not just documentation:

- **Bounded concurrency**: at most 2 bot runs execute at once, process-
  wide, regardless of how many bots are registered or enabled
  (`core/bots/botEngine.ts`'s `MAX_CONCURRENT_BOT_RUNS`) — verified
  against real Redis in `test/integration/botEngine.test.ts`.
- **Bounded rate**: at most 20 runs/minute across all bots
  (`MAX_RUNS_PER_MINUTE`), a second independent cap beyond concurrency.
- **Bounded duration**: every bot has its own `timeout_ms` (15–30s for
  the four M5 bots), enforced via `AbortController`.
- **Schedule cadence, by bot**: AI/Model Release Monitor and News
  Monitor every 30 minutes, User Topic Monitor every 15 minutes, System
  Health Monitor every 5 minutes — none of the four bots run continuously
  or hold an open connection between runs.
- **No new persistent connections**: bots reuse the same `pg.Pool`/Redis
  connection the rest of the backend already holds; `System Health
  Monitor`'s own checks (`SELECT 1`, `PING`, `getJobCounts()`) are the
  only bot work that touches Postgres/Redis directly, and each is a
  single round-trip.
- **Local (non-Oracle) measurement**: not yet captured on real Oracle
  hardware — this sandbox has no way to provision or measure against the
  actual 2 OCPU/12GB target. What's verified here is the *design*
  (fixed, code-enforced bounds — see the constants table in
  `12-bot-engine.md` §4) and correctness under load in this
  environment's local Postgres/Redis, not absolute Oracle-hardware
  numbers. Flagged as a known limitation in the M5 completion report.

## 3. Container topology

```
docker-compose.yml
├── backend        (services/backend, arm64 multi-stage build)
├── postgres        (postgres:16 + pgvector, named volume, pg_dump cron sidecar)
├── redis           (redis:7-alpine, AOF persistence for queue durability)
├── caddy           (reverse proxy, automatic TLS via Let's Encrypt or internal cert for tunnel mode)
└── n8n             (optional, profile: automation — not started by default, see §7)
```

`docker-compose.prod.yml` overlays resource limits (`mem_limit`/`cpus` per
service, matching §2) and disables dev-only bind mounts.

## 4. Networking & exposure

Two supported modes, chosen at deploy time:

- **Cloudflare Tunnel (recommended default).** No inbound port opened on
  the Oracle instance at all; Caddy proxies to `backend` over localhost,
  `cloudflared` establishes the outbound tunnel. Removes "backend reachable
  by internet port scan" from the threat surface entirely.
- **WireGuard VPN.** Phone and backend join a private WireGuard network;
  the API is only reachable over the VPN interface. Slightly more setup on
  the phone, but zero dependency on a third party.

Direct public-port exposure (plain `:443` open to the internet) is
supported but **not the default** — it reintroduces the scanning/DoS
surface both alternatives above avoid, and this is a single-user system
where that convenience isn't worth the exposure.

## 5. Self-healing

- **Health checks**: every subsystem exposes a cheap, no-model-call health
  probe (`Agent.healthCheck()`, provider adapter `testConnection` on a
  schedule, DB/Redis ping) surfaced at `/health` (`03-api-contracts.md` §9).
- **Retries**: transient provider errors (timeouts, 429/5xx) retry with
  jittered backoff at the adapter layer, bounded (default 2 retries) before
  the Model Router's fallback chain takes over.
- **Circuit breaker**: per-provider breaker in `core/router` — N consecutive
  failures within a window flips the provider to `degraded`/`unavailable`
  in the Model Registry (skipping it in routing) without waiting for the
  hourly health rollup; a subsequent successful `testConnection` or probe
  closes the breaker and emits `agent.recovered`-style recovery on the bus.
- **Worker recovery**: Bot Engine runs are idempotent and time-boxed; a bot
  run that doesn't report within its budget is marked `failed` by a
  supervisor sweep and rescheduled on its normal cadence rather than left
  "running" forever.
- **Structured error reporting**: every failure path produces a typed error
  (`TaskError`, `ConnectionTestResult.error`, etc.) rather than an opaque
  500 — the API layer maps these to the common error envelope
  (`03-api-contracts.md`).
- **Safe rollback**: `evolution_proposals.status = 'rolled_back'` plus
  `routing_policy_update` retaining prior weights (see
  `07-security-model.md` §5) means any self-applied change has a defined
  undo path, not just a forward-only apply.

## 6. CI/CD

GitHub Actions pipeline (`.github/workflows/`, added in Phase 7):
1. `typecheck` + `lint` across the pnpm workspace.
2. `unit tests` (core logic: router selection algorithm, event schema
   validation, memory relevance scoring, encryption round-trip).
3. `integration tests` for provider adapters — run against each vendor's
   API using CI-scoped test keys (secrets, never in source), skipped/soft-
   failed gracefully if a given provider's test key isn't configured for a
   contributor's fork.
4. `docker buildx build --platform linux/arm64` for `backend.Dockerfile` —
   build must succeed for `arm64` specifically, not just the CI runner's
   native arch.
5. On merge to main: push image to GHCR, deploy step SSHes to the Oracle
   instance and runs `docker compose pull && docker compose up -d`.

## 7. Integration points (implemented M10, both remain optional)

- **n8n**: `infra/n8n` documents running n8n as an optional compose
  profile (`--profile automation`, not started by a plain `docker compose
  up`); MD AI's automation layer (`core/automations/`) calls out to n8n
  workflows via `automations.action_type = 'n8n_workflow'`, and n8n can
  call back into MD AI via the signed `/webhooks/automations/:slug`
  endpoint (HMAC-SHA256, `core/automations/webhookSignature.ts`). Neither
  side is required for the other to function. Both directions go through
  the same `safeFetch` SSRF policy as every other outbound call in this
  codebase (HTTPS-only) — see `infra/n8n/README.md` for what that means
  for a locally-run n8n instance.
- **OpenClaw**: connects through the `tools.source = 'mcp_server'`
  mechanism — `ToolRegistryService.connectServer(url)`
  (`core/mcp/toolRegistryService.ts`) is a real, working client for the
  standard MCP JSON-RPC `tools/list`/`tools/call` protocol, not an
  OpenClaw-specific integration; OpenClaw is simply the first server this
  connects to once a real endpoint exists. Configured via
  `MDAI_EXTERNAL_MCP_SERVERS` (comma-separated URLs), connected at boot,
  never required. Every tool an external server advertises is persisted
  as a `tools` row with conservative defaults (`riskLevel: "high"`,
  `requiresApproval: true`) and zero `agent_tool_grants` — connecting a
  server makes its tools *discoverable*, never *callable*, until an owner
  explicitly grants a specific agent access, and every call still goes
  through Guardian's M8 approval gate like any other tool.

## 8. Backups

- `pg_dump` scheduled (daily) to Oracle Cloud Object Storage (Always Free
  tier includes 10GB), retained on a short rolling window (e.g. 7 daily +
  4 weekly) given free-tier storage limits.
- Nothing secret is in these backups by default: `provider_configs`
  contains only status metadata (see `07-security-model.md` §3), so a DB
  dump carries no provider key material to protect or lose. If the future
  opt-in server secret mechanism (`07-security-model.md` §3.4) is ever
  built, its encryption-key backup/recovery procedure will be documented
  separately at that time — it does not exist yet.

## 9. Observability posture for this scale

Given the 12GB budget, M1–M8 observability is intentionally lightweight:
structured JSON logs (stdout, captured by Docker's log driver with
rotation), the `/health` endpoints, and the `events`/`audit_log` tables
which already double as a queryable timeline. A Prometheus + Grafana stack
is an explicit *optional* addition for later, not a dependency of the core
architecture — it would consume RAM headroom this budget currently reserves
for the Evolution Engine sandbox and traffic spikes.

### 9.1 M1 resource telemetry (mandatory, minimal)

`GET /health` (`03-api-contracts.md` §9) reports, refreshed on a short
in-process interval (default 10s) rather than computed per-request so the
health check itself stays cheap:

| Metric | Source | Why it matters at this scale |
|---|---|---|
| CPU (process + system) | `process.cpuUsage()` + `os.loadavg()` | First signal the 2-OCPU ceiling is close |
| Memory (process RSS + system free) | `process.memoryUsage()` + `os.freemem()`/`totalmem()` | First signal the 12GB ceiling is close |
| PostgreSQL | pool size, active/idle connections, and a cheap `SELECT 1` latency probe | Connection exhaustion and query slowness show up here before they show up as user-visible errors |
| Redis | `INFO` — `used_memory`, `connected_clients`; `PING` latency | Redis is small by design (§2) — growth here is a signal something is misusing it as a general cache |
| Queue depth | BullMQ `getJobCounts()` for each registered queue | Should be ~0 in M1 outside brief retention-sweep runs; a growing backlog means the worker isn't keeping up |
| Worker count | BullMQ `getWorkers()` / process-local registry | Expected to be 1 in M1 (§2.1) — this is the number that should grow deliberately at M5/M8, not silently |
| Request latency | Rolling p50/p95 per route, computed in the request-logging middleware (in-memory ring buffer, no external APM) | Cheapest possible signal that a provider or the DB has gotten slow |

This is exposed as one aggregate JSON document, not a metrics-scrape
endpoint (no Prometheus exporter in M1 — see the framing above). It is
enough to answer "is this 12GB box under pressure" without adding a
service to the topology.

### 9.2 M3 performance measurement

No Oracle Cloud instance is available in this development sandbox — same
honesty rule as Android device testing (`09-roadmap.md`): what follows is
a **real, repeatable local measurement** (`services/backend/test/integration/perf.test.ts`,
run against a real local Postgres + the actual backend process, provider
HTTP mocked at near-zero latency), not a claim about production hardware.
It isolates what M3's own bookkeeping costs — DB writes and process
memory — from provider network/inference latency, which is mocked here
and outside MD AI's control on real hardware regardless.

**DB write footprint per turn** (measured row-count deltas):

| Turn type | `tasks` | `task_messages` | `events` | `model_call_samples` |
|---|---|---|---|---|
| Direct answer (no delegation) | 1 | 2 | 6 | 2 (classification + synthesis) |
| Full delegation tree (Research + Reviewer, APPROVE, `web_search` unavailable) | 3 | 2 | 27 | 4 (classification + research + review + synthesis) |

The headline change from M1/M2: **every M3 chat turn now makes at least
two model calls instead of one** (intent classification, then synthesis),
and a delegated turn makes four. This is the real cost of M3.2's
capability-based classification and is by design, not an inefficiency to
fix — but it means M3 roughly doubles-to-quadruples per-turn model-call
volume and event-table growth versus M1/M2, which matters for both
provider rate limits and the `events` retention job's (`02-database-schema.md`
§4) sweep volume as usage grows. M4 adds 5 more events per delegation
tree (`tool.discovered`/`.permission.checked`/`.selected`/`.called`/one
terminal event) for Research's `web_search` attempt — see §9.3.

**Backend-side wall time for a full delegation tree** (mocked provider
calls, i.e. this is MD AI's own orchestration overhead only — DB
round-trips, event-bus inserts, WS fan-out — not real model latency):
**~65–80ms** for a 3-task, 27-event delegation tree in this sandbox
(M4's tool-call overhead is a few ms on top of M3's ~51ms baseline). Real
per-turn latency on Oracle hardware will be dominated by the 2–4 actual
provider round-trips (typically 0.5–3s each depending on provider/model)
plus, when a tool actually runs, real network fetch time — not this
backend-side overhead.

**Process memory growth**: 15 additional delegation-tree turns in the
same process grew RSS by ~0.65MB/turn (measured without `--expose-gc`, so
this includes not-yet-collected garbage — an upper bound, not a floor).
Nothing here suggests an obvious per-turn leak (e.g. an uncleaned
`runtimeContext` closure or `chatStreamHub` entry); `chatStreamHub.ts`'s
30-second linger-then-delete window for finished tasks means a burst of
turns will show some transient growth by design, not as a leak signal.

**Budget read-through:** none of this changes §2's resource budget
allocation — the backend's RAM/CPU envelope was already sized for
"scales with concurrent agent/tool calls," and M3 is still a single
in-process Node service with no new container. The real thing to watch
as M3 sees real usage is provider rate limits and event-table growth
from the 2–4x call multiplier above, not CPU/RAM headroom.

### 9.3 M4 per-tool invocation latency

Same local-sandbox measurement discipline as §9.2 — HTTP mocked, so this
is MD AI's own per-call overhead (SSRF checks, DB writes, event
publishing, and for `pdf_reader` real parsing work), not real network or
search-provider latency (`test/integration/toolPerf.test.ts`):

| Tool | Measured latency | Notes |
|---|---|---|
| `calculator` | ~1ms | Pure local computation, no I/O |
| `time_date` | ~1ms | Pure local computation, no I/O |
| `generic_http_get` | ~5ms | One mocked HTTPS round-trip + SSRF check |
| `file_reader` | ~5ms | One mocked HTTPS round-trip + SSRF check |
| `web_search` | ~9ms | One mocked HTTPS round-trip to the search provider |
| `url_reader` | ~20ms | Mocked fetch + naive HTML-to-text extraction |
| `pdf_reader` | ~280ms | Mocked fetch + real `pdf-parse`/pdfjs initialization and parsing — the one tool whose local processing cost, not I/O, dominates |

`pdf_reader`'s ~280ms is the standout number: it is genuinely doing real
PDF parsing work (not mocked), so this is a realistic floor for that
tool's own cost even before any network fetch time is added on real
hardware. No new BullMQ worker or persistent process was added for
tool execution — every invocation runs synchronously within the
agent's existing task-handling call, consistent with §2's "no
unnecessary permanent workers" discipline.

**No new container, no new queue.** M4's Tool Registry and MCP host are
additional code paths inside the existing single backend process — the
container topology in §3 is unchanged.
