# Implementation Roadmap

Each milestone is independently shippable and testable. Nothing here starts
until this whole architecture document set is approved (see PHASE 7 gate in
the top-level task). Ordering front-loads the pieces every later milestone
depends on: DB + provider vault + one working provider before any agent
exists; agents before bots have anywhere to escalate to; events before the
Command Center has anything to render.

## M0 — Foundation architecture — **delivered**
Docs 00–09, repo skeleton, DB migrations, shared TypeScript contracts.
Approved with mandatory changes (device-side key vault instead of
server-side, corrected app-closed semantics, M1 resource discipline) —
those changes are folded into the doc set as of M1.

## M1 — Backend skeleton + first working chat path — **delivered**
- Docker Compose (backend + postgres + redis), migrations 0001–0015
  applied and verified against a real Postgres instance.
- Auth: device pairing (single-use code), JWT access + refresh tokens,
  session revocation — all implemented and integration-tested.
- Provider Vault: metadata-only backend (`provider_configs`, no key
  storage) + Keystore-backed on-device vault in the mobile app, wired to a
  real `test-connection` round trip. All **five** provider adapters
  (NVIDIA Nemotron, Gemini, Groq, SambaNova, OpenRouter) are implemented
  against the shared OpenAI-compatible client and integration-tested with
  mocked HTTP shaped exactly like each vendor's real API; NVIDIA Nemotron
  was verified first per the milestone's priority.
- Master Agent: direct-answer path only (no delegation yet), using the
  Model Router with per-request provider keys, retry, circuit breaker,
  and cross-provider fallback.
- Mobile app: pairing screen, Provider Vault screen (add/test/remove key,
  never displays a full stored key), and the primary chat screen (text
  only) wired to the real WS streaming endpoint and REST contracts.
- Resource telemetry (`/health`): CPU, memory, Postgres pool, Redis,
  BullMQ queue depth/worker count, per-route request latency — verified
  against the running dev backend.
- **Exit criteria met on the backend, live**: paired a device, ran a full
  chat task end-to-end (task creation → event emission → provider call →
  WS streaming → DB persistence) against mocked provider HTTP, and
  separately exercised the real `test-connection` failure path against
  NVIDIA's actual endpoint (blocked only by this dev sandbox's outbound
  network policy, not by the code). **Not exercised**: the mobile app
  on-device (no Android SDK/emulator in this sandbox) — see the M1
  completion report delivered alongside this update for exact scope and
  known limitations.

## M2 — Model Registry, telemetry, capability-aware scoring router — **delivered**
- Model Registry promoted to a first-class DB-backed subsystem
  (`core/registry/modelRegistryService.ts`) with a 5s cache; `GET/PATCH
  /models` implemented. Discovery wired into `test-connection` — a
  successful key test now registers/refreshes every model the provider
  reports, merged with a hand-curated capability catalog (unrecognized
  models get conservative "unverified" defaults, never a name-based guess).
- Model call telemetry (`model_call_samples`: latency, success/timeout/
  used-as-fallback, approximate token counts, response status, task
  category — never prompt content or secrets) recorded on every chat call;
  a BullMQ job rolls the last 20 samples per model into
  `availability`/`avg_latency_ms`/`error_rate_pct` every 5 minutes.
- Capability Matrix (`core/router/capabilityMatrix.ts`): 8 explicit task
  categories, each with hard capability/context-length requirements and
  soft scoring preferences — no inference from model names or prompts.
- Deterministic scoring router (AUTO): pure `scoreCandidate`/
  `rankCandidates` functions combine capability fit, availability, latency,
  error rate, and user priority/default into an inspectable
  `ModelScoreBreakdown` per candidate, unit-tested without a database.
  MANUAL mode pins exactly the requested provider/model with zero scoring
  and zero cross-model fallback, per instruction.
- Mobile Vault screen: per-provider model list (capabilities, health dot,
  avg latency), default-model picker, and a global AUTO/MANUAL toggle
  wired into every chat request.
- 94 automated tests total (83 backend + 11 mobile pure-logic), all
  passing against real Postgres/Redis; mobile workspace typechecks
  cleanly end-to-end. **Not exercised**: the mobile app on a real Android
  device/emulator — see `docs/architecture/10-android-setup.md` for the
  exact verified/unverified split and the M2 completion report for full
  detail.

## M3 — Agent Registry + A2A task layer + memory — **delivered**
- Agent Registry promoted to a real DB-backed subsystem
  (`core/agents/agentRegistryService.ts`): typed `AgentCard`s, capability-
  based discovery (`findByCapability`), delegation authorization backed by
  `agent_delegation_edges` (data, not code), heartbeat/status columns.
- Three agents — **Master, Research, Reviewer** (not the full future
  ecosystem, and not a `memory-agent`: Master itself owns the single
  memory-write path in M3, see `04-agent-interfaces.md` §7). Master is a
  real orchestrator: capability-based intent classification (dynamic
  capability list, never hardcoded), delegation with a bounded
  one-revision Reviewer loop (`APPROVE`/`REVISE`/`REJECT`), and streamed
  synthesis honoring the user's actual routing preference while every
  internal call stays AUTO. Research is honest about having no live tool
  access yet (`ToolNotAvailableError`, disclosed in `limitations`, never a
  fabricated source). Reviewer structurally refuses to ever review another
  Reviewer task (`reviewer_cannot_review_self`) before making a single
  model call.
- A2A task layer extended: `correlation_id` (root-scoped, propagated to
  every descendant) + `attempt`, `cancelTaskCascade` for whole-tree
  cancellation, a safety net that fails a child task that returns without
  finalizing rather than leaving it stuck `working`.
- Memory Engine (`core/memory/memoryEngine.ts`): real lexical/trigram
  retrieval (`pg_trgm`, not a placeholder — cross-vendor embeddings are a
  documented near-term addition, not faked), an `approval_status` column
  gating retrieval (`approved`/`pending`/`rejected`), explicit "Remember
  this."/"Forget this." commands, and conservative system-proposed
  candidates that are never auto-approved. Context retrieval (top-5
  relevant memories) runs before every Master response, surfaced on the
  event bus as `memory.retrieved` (count + ids only, never content).
- 10 new/extended event types (`task.*`, `message.*`, `review.*`,
  `memory.*`, `agent.completed`) as the future Command Center's source of
  truth, plus mobile chat UI showing safe delegation status text
  (`agent_progress` chunks, e.g. "Research Agent working…") — never
  chain-of-thought.
- 106 automated backend tests total (83 carried over from M1/M2, zero
  regressions, + 23 new M3-specific scenarios covering delegation, the
  bounded revision loop, the Reviewer self-review guard, memory commands/
  candidates/retrieval, agent-registry discovery/authorization, cascade
  cancellation, and a dedicated no-secret-leak test across the whole
  delegation tree). Local (non-Oracle) performance measurement in
  `08-deployment-architecture.md` §9.2. **Not exercised**: the mobile
  delegation-status UI on a real Android device/emulator, same documented
  limitation as M1/M2 — see the M3 completion report for the exact
  verified/unverified split.

## M4 — MCP tool layer
- `core/mcp` host, `agent_tool_grants`, approval gate wiring.
- Initial tools: `web.search`, `web.fetch`, `code.exec` (sandboxed,
  `requires_approval = true`), giving Research Agent real capability.

## M5 — Bot Engine + notifications
- `core/bots` scheduler (BullMQ), first bots: `price-monitor`,
  `news-monitor`, `notification-worker`.
- Bot → Agent escalation path end-to-end (`bot_findings.routed_task_id`).
- Android push notifications (FCM) for bot alerts and long-running task
  completion — this is also the first proof that "backend keeps working
  with the app closed" actually holds.

## M6 — Event streaming + 2D Command Center
- `core/events` bus + `/ws/events` gateway with resume-by-cursor.
- Mobile: 2D live node/edge graph (agents, bots, task paths) — same event
  schema the eventual 3D scene will use, validated against real traffic
  before investing in 3D rendering.

## M7 — 3D Command Center
- `@react-three/fiber` scene replacing the 2D graph, same event stream.
- WebGL-availability fallback path (mandatory, see `01-repository-structure.md`
  §2) so the app degrades to the 2D graph rather than failing silently.
- Zoom/rotate/focus, agent detail panels, live telemetry overlays.

## M8 — Remaining specialist agents + Guardian
- `crypto-intel`, `stock-intel`, `business-intel`, `social-media`,
  `ai-radar`, `news-intel`.
- Remaining bots: `market-scanner`, `liquidity-monitor`,
  `volume-anomaly-monitor`, `social-trend-monitor`,
  `business-opportunity-monitor`.
- `guardian` agent wired into tool-approval and evolution-proposal review
  (policy checks that were manual/absent before this point become
  automatic).

## M9 — Evolution Engine
- Model/tool discovery sweeps, benchmarking of configured models,
  outcome-based routing policy updates.
- `evolution_proposals` pipeline including sandbox testing.
- Approval UI in the app for `application_code_update` /
  approval-required `skill_update` proposals.

## M10 — Automation + action layer integration points
- n8n optional compose profile + `automations` ↔ n8n workflow wiring.
- OpenClaw connected as an MCP tool source (still optional, not required
  for the app to be fully usable).
- PC client foundation: extract `packages/shared-types` + as much of
  `apps/mobile/src/features` as is framework-agnostic into a shape a
  desktop client (Electron/Tauri or a Next.js PWA) can reuse directly.

## Cross-cutting, present from M1 onward (not a separate milestone)
- Unit tests for core logic (router ranking, event schema, encryption
  round-trip, memory relevance).
- Integration tests for each provider adapter as it's added.
- `arm64` CI build gate.
- No milestone ships a "fake" version of a feature it claims to complete —
  a milestone is either fully real for its stated scope or explicitly
  marked partial in its PR description, per the no-placeholder-as-complete
  rule in project development guidelines.
