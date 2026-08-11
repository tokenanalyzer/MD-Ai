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

## M3 — Agent Registry + A2A task layer + memory
- `core/a2a` task state machine, delegation, `agent_delegation_edges`.
- Agents: `research`, `reviewer`, `memory-agent` (first three beyond
  Master — enough to prove real delegation + review + memory write).
- Memory Engine: structured storage, embedding + semantic search, chat
  memory commands ("Remember this." / "Forget this.").
- Mobile: memory browser screen, agent list screen (status only, no 3D yet).

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
