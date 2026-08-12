# MD AI

Private personal AI operating system. Single owner, Android-first client,
always-on backend.

**Start here:** [`docs/architecture/00-overview.md`](docs/architecture/00-overview.md)

## Architecture document set

| Doc | Covers |
|---|---|
| [00-overview.md](docs/architecture/00-overview.md) | Vision, principles, system map |
| [01-repository-structure.md](docs/architecture/01-repository-structure.md) | Repo tree, technology decisions |
| [02-database-schema.md](docs/architecture/02-database-schema.md) | Entities, relationships, migrations |
| [03-api-contracts.md](docs/architecture/03-api-contracts.md) | REST + WebSocket contracts |
| [04-agent-interfaces.md](docs/architecture/04-agent-interfaces.md) | Agent/A2A/MCP interfaces |
| [05-event-schemas.md](docs/architecture/05-event-schemas.md) | Event bus schema |
| [06-provider-model-interfaces.md](docs/architecture/06-provider-model-interfaces.md) | Provider abstraction, Model Router |
| [07-security-model.md](docs/architecture/07-security-model.md) | Key vault, auth, bounded self-modification |
| [08-deployment-architecture.md](docs/architecture/08-deployment-architecture.md) | Oracle Cloud topology, self-healing, CI/CD |
| [09-roadmap.md](docs/architecture/09-roadmap.md) | Milestone sequence M0–M10 |
| [10-android-setup.md](docs/architecture/10-android-setup.md) | Android verification status, how to run on a real device |
| [11-mcp-tools.md](docs/architecture/11-mcp-tools.md) | Tool Registry, MCP execution layer, built-in tools, SSRF/prompt-injection security |

## Status

**M0 (foundation architecture) through M5 (Bot Engine + notifications) are
delivered.** Backend: real Postgres/Redis-backed API + WS server, device
pairing/auth, on-device provider key vault contract, all five provider
adapters, a DB-backed Model Registry with discovery + telemetry-driven
health rollup, a deterministic AUTO scoring router (capability matrix,
retry, circuit-breaker, fallback) plus a MANUAL pin mode, a real
three-agent system (Master orchestrator, Research, Reviewer) with A2A
delegation and a bounded revision loop, a memory subsystem with
approval-gated retrieval, a DB-backed Tool Registry + MCP execution layer
giving Research Agent real (SSRF-protected — including connect-time
DNS-rebinding protection — permission-checked, timeout-bounded) web
search (two independent `SearchProvider`s) and page reading, and a Bot
Engine (`12-bot-engine.md`) — four deterministic background bots (AI/
Model Release, News, User Topic, System Health Monitors) on a shared,
resource-bounded BullMQ worker, deduplication + a deterministic
importance filter, agent escalation through Master's existing
delegation pipeline, an opt-in encrypted background-credential vault so
escalation can work with the app closed, and Android push notifications
(Expo → FCM) with owner-controlled, default-conservative preferences —
**192 backend automated tests + 13 mobile pure-logic tests, all passing**
(real Postgres/Redis, mocked provider/tool HTTP). Mobile: pairing,
Provider Vault (keys, models, default-model picker, AUTO/MANUAL toggle),
chat screens with live delegation/tool status text, and a Bot Fleet
screen (enable/disable/pause/resume/run-now, findings, run history) —
implemented against the same contracts; the whole mobile workspace
typechecks cleanly and is now configured for an Expo Development Build
on a real physical device (see `10-android-setup.md` §4), but has not
yet actually run on one (no Android tooling in the environment this was
built in). See `09-roadmap.md` for exact scope and the next milestone
(M6).

Quickstart (backend):
```sh
pnpm install
cd services/backend && cp ../../.env.example .env  # fill in MDAI_JWT_SECRET
pnpm run db:migrate   # or let `pnpm dev`/`node dist/index.js` auto-migrate on boot
pnpm run dev
```

## Workspace layout

```
apps/mobile        React Native + Expo Android app
services/backend    Node.js backend (Oracle Cloud)
packages/shared-types  Cross-cutting TypeScript contracts (agents, a2a, mcp, providers, events)
infra/               Docker, Oracle Cloud, n8n integration notes
docs/architecture/    This document set
```
