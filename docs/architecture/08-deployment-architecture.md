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

## 7. Integration points (not required for first milestone)

- **n8n**: `infra/n8n` documents running n8n as an optional compose
  profile; MD AI's automation layer calls out to n8n workflows via
  `automations.action_type = 'n8n_workflow'`, and n8n can call back into MD
  AI via the signed `/webhooks/automations/:slug` endpoint. Neither side is
  required for the other to function.
- **OpenClaw**: reserved as an `action_type` / tool-source addition in the
  MCP layer once introduced — the `tools.source = 'mcp_server'` mechanism
  already accommodates an external action-execution server without a new
  concept; OpenClaw is simply the first one connected. Not part of M1–M8.

## 8. Backups

- `pg_dump` scheduled (daily) to Oracle Cloud Object Storage (Always Free
  tier includes 10GB), retained on a short rolling window (e.g. 7 daily +
  4 weekly) given free-tier storage limits.
- Provider key ciphertext is included in DB backups (it's useless without
  the KEK, which is **not** backed up alongside the DB — see
  `07-security-model.md` §3); the KEK's own backup/recovery procedure is
  documented separately once the KEK source (Oracle Vault vs. sealed env
  secret) is finalized in Phase 7.

## 9. Observability posture for this scale

Given the 12GB budget, M1–M8 observability is intentionally lightweight:
structured JSON logs (stdout, captured by Docker's log driver with
rotation), the `/health` endpoints, and the `events`/`audit_log` tables
which already double as a queryable timeline. A Prometheus + Grafana stack
is an explicit *optional* addition for later, not a dependency of the core
architecture — it would consume RAM headroom this budget currently reserves
for the Evolution Engine sandbox and traffic spikes.
