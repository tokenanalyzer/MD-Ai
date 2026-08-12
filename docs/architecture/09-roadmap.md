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

## M4 — MCP tool layer — **delivered**
- Tool Registry promoted to a real DB-backed subsystem
  (`core/mcp/toolRegistryService.ts`, migration `0019`): typed
  `ToolDefinition`s (version, MCP metadata, required capabilities, risk
  level, default access, health, timeout, last verified, owner), never a
  hardcoded tool map.
- MCP execution layer (`core/mcp/mcpHost.ts`'s `invokeTool()`) is the only
  path from an agent to a tool: discover → permission-check → execute
  (timeout-bounded) → record → return, with a full `tool_invocations` row
  and 8 metadata-only lifecycle events per call
  (`tool.discovered`/`.selected`/`.permission.checked`/`.called`/
  `.completed`/`.failed`/`.timeout`/`.blocked`) — never a secret or a huge
  payload logged or published.
- Seven built-in tools, exactly the safe set instructed: `web_search`
  (vendor-agnostic `SearchProvider` abstraction, Brave Search
  implemented, honest `ToolNotAvailableError` with no fabricated results
  when unconfigured), `url_reader` and `generic_http_get` (both
  SSRF-protected via `core/security/ssrfGuard.ts` — HTTPS-only, private/
  loopback/link-local/cloud-metadata IP blocking, per-redirect-hop
  re-validation), `file_reader` and `pdf_reader` (HTTPS-URL-scoped, since
  no object-storage subsystem exists in this codebase yet), `calculator`
  (hand-rolled safe expression evaluator, never `eval`), `time_date`
  (deterministic). No browser automation, shell/code execution, trading,
  or social publishing — none of that was built, per instruction.
- Capability-based permissions (`agent_tool_grants`, data not code):
  Research gets the full safe set (`generic_http_get` at `restricted`);
  Reviewer and Master get none in M4.
- Research Agent upgraded from "tool unavailable" to real tool-assisted
  research: search → read up to 3 sources → structured findings that
  cite only URLs actually retrieved this turn — an anti-hallucination
  guard strips and downgrades any source the model merely claims but
  never retrieved.
- Prompt injection defense: explicit trust-boundary markers around every
  piece of retrieved content plus the structural guarantee that a tool's
  output can only ever become inert text, never a trigger for another
  tool call or a permission/routing change.
- Mobile: no new code needed — M3's `agent_progress` status-line
  infrastructure already renders Research's new "Searching the web…" /
  "Reading N sources…" labels; verified over a real WebSocket.
- 35 new M4 tests (SSRF guard, safe fetch redirect/size/timeout handling,
  the calculator's rejection of arbitrary code, prompt injection
  construction + structural containment, MCP host permission-bypass/
  timeout/malformed-response handling, a full tool-assisted research
  end-to-end test, and per-tool latency measurement) on top of the 108
  carried over from M1–M3 — **143 total, zero regressions**. Local
  (non-Oracle) per-tool latency measurement in
  `08-deployment-architecture.md` §9.3.

## M5 — Bot Engine + notifications — **delivered**
- DNS-rebinding SSRF gap closed (M5.0): `core/security/ssrfSafeDispatcher.ts`
  re-validates the resolved address at the exact moment Node opens the
  socket (connect-time, not just pre-check), installed process-wide at
  boot. Second `SearchProvider` (Tavily) added alongside Brave, proving
  Research Agent isn't coupled to one vendor.
- Bot Registry (`core/bots/botRegistryService.ts`, migration `0020`):
  DB-backed, same split as the Agent/Tool Registries — no hardcoded bot
  list anywhere in the scheduler.
- Bot Engine (`core/bots/botEngine.ts`): one shared, bounded BullMQ worker
  (max 2 concurrent runs, 20/min rate limit — Oracle's 2 OCPU/12GB target)
  for every bot's scheduled and run-once execution, never one process per
  bot. Per-bot timeout via `AbortController`, BullMQ attempts/backoff for
  retries, a periodic sweep marks runs stuck past their timeout.
- `BotRun`/`BotFinding` models: a finding is a normalized signal
  (category/title/summary/importance/confidence/dedup key/status/
  escalation status) — explicitly not a final AI answer.
- Deterministic dedup (`UNIQUE(bot_id, dedup_key)` + importance-scaled
  cooldown) and a fixed LOW/MEDIUM/HIGH/CRITICAL importance gate evaluated
  *before* any LLM call.
- Four bots, exactly the set instructed: AI/Model Release Monitor, News
  Monitor (via the existing `SearchProvider` abstraction), User Topic
  Monitor (owner-configured topics), System Health Monitor (deterministic
  Postgres/Redis/memory/CPU/queue-depth/provider-availability checks). No
  trading bots, no exchange execution.
- Agent escalation (`core/bots/escalation.ts`): a finding that clears the
  importance gate dispatches into Master's *existing* capability-discovery
  and delegation pipeline — the same entry point a chat message uses,
  never a bot-specific routing bypass.
- Opt-in background credential vault (M5.12a, `core/security/
  backgroundKeyVault.ts`): the mechanism `07-security-model.md` §3.4
  anticipated, now built — envelope AES-256-GCM encryption, KEK from
  `MDAI_BACKGROUND_KEY_KEK` (never in the DB), covers both LLM provider
  keys and search provider keys, populated only when the owner explicitly
  opts a provider into "background use" from the phone. Absent by
  default; bots keep running deterministically either way.
- Push notifications (Expo push service → FCM on Android) + owner-
  controlled preferences (minimum importance defaulting to HIGH, quiet
  hours, muted topics/bots/categories) — every finding gets a
  `notifications` row regardless of outcome, so suppression is auditable,
  not silent.
- Full `bot.*`/`notification.*` event catalog added to the shared
  `EventPayload` union (`05-event-schemas.md`).
- Mobile Bot Fleet screen (`app/(bots)`) — not the 3D Command Center:
  active/paused bots, health, last/last-successful run, findings, and
  enable/disable/pause/resume/run-now controls.
- 41 new M5 tests (DNS-rebinding connect-time enforcement, second
  SearchProvider resolution, background-vault encryption round-trip and
  REST surface, bot run lifecycle incl. timeout/failure, bounded
  concurrency against real Redis, retry/backoff against real BullMQ,
  row-level and pipeline-level dedup, agent escalation with/without a
  configured background credential, notification preference filtering
  incl. quiet hours and FCM failure handling, System Health Monitor
  against a real forced breach, Bot Registry/Fleet REST surface) — full
  suite **192/192 passing, zero regressions** across M1–M5.
- See `docs/architecture/12-bot-engine.md` for the full design and the
  M5 completion report for the 15-point summary.

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
