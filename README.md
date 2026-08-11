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

## Status

**M0 — Foundation architecture.** Repository structure, database
migrations, and shared type contracts are in place. No application code has
been implemented yet — that begins at M1 once this architecture is
approved. See `09-roadmap.md`.

## Workspace layout

```
apps/mobile        React Native + Expo Android app
services/backend    Node.js backend (Oracle Cloud)
packages/shared-types  Cross-cutting TypeScript contracts (agents, a2a, mcp, providers, events)
infra/               Docker, Oracle Cloud, n8n integration notes
docs/architecture/    This document set
```
