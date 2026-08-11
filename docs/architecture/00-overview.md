# MD AI — Architecture Overview

## 1. What this is

MD AI is a **private, single-user personal intelligence operating system**. One
person (the owner) interacts with it primarily from an Android phone. A
backend running continuously on Oracle Cloud hosts the actual intelligence:
model routing, agents, background bots, memory, and automation. The Android
app is a **thin control client** — it renders state and sends intent, and
it does not itself execute anything while closed. What "keeps working
while the app is closed" is specifically the **backend**: it stays up and
can run approved background agents, bots, schedulers, and automations that
don't require a provider key the app hasn't supplied (see §2 principle 4
and `07-security-model.md` §3). Results produced while the app was closed
are delivered as a push notification and become visible the next time the
owner opens the app — the phone is not a second execution environment.

It is explicitly **not**:
- a SaaS product
- multi-tenant
- designed for anonymous or public users
- designed around subscription billing, org/team roles, or tenant isolation

Every architectural decision below optimizes for **one owner, one identity,
low operating cost (Oracle Cloud Always Free tier), and long-term
extensibility** — not for scale-out or multi-user isolation.

## 2. Guiding principles

1. **Backend is the source of truth, and the only thing that runs when the
   app is closed.** The phone renders state and sends intent; it does not
   hold authoritative data and executes nothing in the background. The
   backend process itself keeps running independent of the phone, and can
   execute approved bots/schedulers/automations that don't need a
   provider key the app hasn't supplied — see principle 4.
2. **Everything is an interface first.** Providers, agents, tools, and bots
   are implementations of small, stable interfaces registered into
   registries. New ones are added by registering, never by editing core
   routing/orchestration code.
3. **Deterministic work stays deterministic.** Bots do cheap, repeated,
   rule-based monitoring. LLM agents are invoked only when judgment is
   needed. This keeps inference cost and Oracle free-tier CPU usage bounded.
   Pipeline: **Bot detects → Agent analyzes → Reviewer validates → Master
   reports/acts.**
4. **User owns the keys, the system never owns them.** Provider API keys are
   entered by the user and live in the Android app's Keystore-backed local
   vault, not on the backend. They are never hard-coded, never persisted
   server-side by default, never logged, and never required as build-time
   secrets. The backend only ever holds a key transiently, in memory, for
   the single request that needed it. See `07-security-model.md` §3.
5. **Self-improvement is bounded.** The system can update its own knowledge,
   model registry, and routing policy autonomously. It cannot modify its own
   application code, infrastructure, or permissions without an explicit
   human approval step (see `07-security-model.md`).
6. **Real state only.** The 3D Command Center visualizes actual backend
   events. No decorative/fake animation of agent activity.
7. **Small modules, explicit contracts.** No god-files, no duplicated
   provider logic, dependency inversion at every subsystem boundary so
   subsystems are independently testable and replaceable.

## 3. System map

```
                         ┌─────────────────────────────┐
                         │   Android App (Expo/RN)      │
                         │  Chat · Vault · Memory ·      │
                         │  Command Center (2D→3D)       │
                         └───────────────┬───────────────┘
                                 REST + WebSocket (TLS)
                                          │
┌─────────────────────────────────────────────────────────────────────┐
│                     Backend (Oracle Cloud, Docker, ARM64)             │
│                                                                       │
│  API Layer (HTTP + WS) ── AuthN/AuthZ ── Rate limiting ── Redaction   │
│         │                                                             │
│  ┌──────▼───────┐   ┌───────────────┐   ┌─────────────────────────┐  │
│  │ Master Agent  │──▶│ Agent Registry │──▶│ Specialist Agents        │  │
│  │ (Orchestrator)│   │ (A2A cards)    │   │ Research/Crypto/Stock/... │  │
│  └──────┬────────┘   └───────────────┘   └───────────┬─────────────┘  │
│         │                                              │              │
│  ┌──────▼───────┐   ┌───────────────┐   ┌─────────────▼─────────────┐│
│  │ Model Router  │──▶│ Model Registry │   │ MCP Tool Registry          ││
│  │ + fallback    │   │ (capabilities) │   │ (search, fetch, code, …)   ││
│  └──────┬────────┘   └───────────────┘   └────────────────────────────┘│
│         │                                                             │
│  ┌──────▼────────────────────────┐   ┌────────────────────────────┐  │
│  │ Provider Adapters               │   │ Bot Engine (deterministic)  │  │
│  │ Nemotron/Gemini/Groq/Samba/     │   │ scanners, monitors, workers │  │
│  │ OpenRouter                      │   └──────────────┬──────────────┘  │
│  └──────────────────────────────┘                      │              │
│                                                          │              │
│  ┌────────────────────────────────────────────────────▼────────────┐ │
│  │ Event Bus  (agent.*, tool.*, model.*, bot.*, automation.*)        │ │
│  └───────────────┬─────────────────────────────┬─────────────────────┘ │
│                  │                             │                      │
│  ┌───────────────▼──────────┐   ┌──────────────▼─────────────────┐    │
│  │ Memory Engine              │   │ Evolution Engine                 │    │
│  │ (structured, retrievable)  │   │ (registry/routing self-update,   │    │
│  └───────────────────────────┘   │  approval-gated code changes)    │    │
│                                    └──────────────────────────────┘    │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ PostgreSQL (+ pgvector) · Redis (queue/cache) · Secret Vault      │  │
│  └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
          │ optional integration points (not required for M1)
          ▼
  n8n (automation)        OpenClaw (action layer)
```

## 4. Core subsystems (1:1 with the repository)

| Subsystem | Responsibility | Repo location |
|---|---|---|
| Provider Adapters | Talk to each LLM vendor behind one interface | `services/backend/src/core/providers` |
| Model Registry | Catalog of known models + live health/capability data | `services/backend/src/core/router` (registry) + DB |
| Model Router | Pick a model per request given task/capability/health/user pref | `services/backend/src/core/router` |
| Agent Registry + Agents | Discoverable agents, each an A2A-compatible unit | `services/backend/src/core/agents` |
| A2A Layer | Agent identity, task lifecycle, messages, streaming | `services/backend/src/core/a2a` |
| MCP Tool Layer | Tool discovery/invocation, separate from agents | `services/backend/src/core/mcp` |
| Bot Engine | Deterministic background workers | `services/backend/src/core/bots` |
| Event Bus | Canonical event schema + pub/sub | `services/backend/src/core/events` |
| Memory Engine | Structured, retrievable long-term memory | `services/backend/src/core/memory` |
| Evolution Engine | Bounded self-improvement | `services/backend/src/core/evolution` |
| Security/Vault | Key storage, encryption, guardian policy | `services/backend/src/core/security` |
| Observability | Health/status/metrics per component | `services/backend/src/core/observability` |
| API Layer | REST + WebSocket surface for the app | `services/backend/src/api` |
| Mobile App | Chat, Vault, Memory, Command Center UI | `apps/mobile` |
| Shared Types | Cross-cutting contracts (agents/events/providers/api) | `packages/shared-types` |

## 5. Non-goals for the first milestones

- No multi-user auth system (single owner identity only).
- No payment/billing infrastructure.
- No public API surface.
- No mandatory OpenClaw dependency (integration point only).
- No full 3D command center on day one — it is built on the same event
  schema from the start, but ships as a 2D live graph first and upgrades to
  3D without changing the backend contract.

See `09-roadmap.md` for sequencing and `01-repository-structure.md` for the
full repo tree and technology decisions.
