# Implementation Roadmap

Each milestone is independently shippable and testable. Nothing here starts
until this whole architecture document set is approved (see PHASE 7 gate in
the top-level task). Ordering front-loads the pieces every later milestone
depends on: DB + provider vault + one working provider before any agent
exists; agents before bots have anywhere to escalate to; events before the
Command Center has anything to render.

## M0 — Foundation architecture (this deliverable)
Docs 00–09, repo skeleton, DB migrations, shared TypeScript contracts. No
running code yet. **Gate: user approval before M1.**

## M1 — Backend skeleton + first working chat path
- Docker Compose (backend + postgres + redis), migrations applied.
- Auth: device pairing, session tokens.
- Provider Vault: CRUD + encrypted storage + test-connection, **one**
  adapter live end-to-end (OpenRouter — broadest model coverage for
  earliest usefulness).
- Master Agent: direct-answer path only (no delegation yet), using the
  Model Router with a single provider.
- Mobile app: auth/pairing screen + minimal chat screen (text only) wired
  to the real WS streaming endpoint.
- **Exit criteria**: user can pair their phone, add an OpenRouter key, and
  have a real streamed conversation with Master Agent, backed by Postgres,
  running on the actual Oracle Cloud instance.

## M2 — Full provider abstraction + Model Router
- Remaining four adapters (Nemotron, Gemini, Groq, SambaNova).
- Model Registry populated (manual seed), health sampling, router ranking
  + fallback chain, circuit breaker.
- Vault UI: full multi-provider management, default model selection.

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
