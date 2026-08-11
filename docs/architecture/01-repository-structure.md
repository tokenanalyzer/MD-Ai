# Repository Structure & Technology Decisions

## 1. Repository tree

```
md-ai/
├── apps/
│   └── mobile/                          # React Native + Expo (Android-first)
│       ├── app/                         # expo-router route tree
│       │   ├── (auth)/                  # device pairing / unlock
│       │   ├── (chat)/                  # primary chat interface
│       │   ├── (command-center)/        # 2D→3D live agent visualization
│       │   ├── (vault)/                 # provider / API key vault
│       │   ├── (memory)/                # memory browser
│       │   ├── (agents)/                # agent registry, bot status
│       │   └── (settings)/
│       ├── src/
│       │   ├── components/              # shared dumb UI components
│       │   ├── features/
│       │   │   ├── chat/
│       │   │   ├── command-center/      # scene graph, node renderer (r3f)
│       │   │   ├── provider-vault/
│       │   │   ├── agents/
│       │   │   ├── bots/
│       │   │   └── memory/
│       │   ├── state/                   # zustand stores
│       │   ├── api/                     # generated REST client + hooks
│       │   ├── realtime/                # WebSocket client, event stream hook
│       │   ├── theme/                   # NVIDIA-inspired design tokens
│       │   └── security/                # Keystore-backed local secure storage
│       ├── app.json
│       ├── eas.json
│       └── package.json
│
├── services/
│   └── backend/                          # Node.js core backend (runs on Oracle Cloud)
│       ├── src/
│       │   ├── core/
│       │   │   ├── providers/            # Model Provider abstraction + adapters
│       │   │   │   ├── contracts/        # ModelProvider interface (re-exports shared-types)
│       │   │   │   ├── nvidia-nemotron/
│       │   │   │   ├── gemini/
│       │   │   │   ├── groq/
│       │   │   │   ├── sambanova/
│       │   │   │   └── openrouter/
│       │   │   ├── router/               # Model Registry + Model Router engine
│       │   │   ├── agents/               # Agent Registry + agent implementations
│       │   │   │   ├── master/
│       │   │   │   ├── research/
│       │   │   │   ├── crypto-intel/
│       │   │   │   ├── stock-intel/
│       │   │   │   ├── business-intel/
│       │   │   │   ├── social-media/
│       │   │   │   ├── ai-radar/
│       │   │   │   ├── news-intel/
│       │   │   │   ├── reviewer/
│       │   │   │   ├── guardian/
│       │   │   │   └── memory-agent/
│       │   │   ├── a2a/                  # Agent-to-agent protocol layer
│       │   │   ├── mcp/                  # MCP tool registry + host/client
│       │   │   ├── bots/                 # deterministic worker engine
│       │   │   │   ├── market-scanner/
│       │   │   │   ├── price-monitor/
│       │   │   │   ├── liquidity-monitor/
│       │   │   │   ├── volume-anomaly-monitor/
│       │   │   │   ├── news-monitor/
│       │   │   │   ├── model-release-monitor/
│       │   │   │   ├── social-trend-monitor/
│       │   │   │   ├── business-opportunity-monitor/
│       │   │   │   └── notification-worker/
│       │   │   ├── events/               # event bus implementation + schemas
│       │   │   ├── memory/               # structured memory engine
│       │   │   ├── evolution/            # evolution engine (bounded self-improvement)
│       │   │   ├── security/             # key vault, encryption, guardian policy
│       │   │   └── observability/        # health, metrics, structured logging
│       │   ├── api/
│       │   │   ├── routes/               # REST route handlers
│       │   │   ├── ws/                   # WebSocket gateway (chat stream, events)
│       │   │   └── middleware/           # auth, rate limit, redaction, error mapping
│       │   ├── db/
│       │   │   ├── schema/               # drizzle schema definitions
│       │   │   ├── migrations/           # versioned SQL migrations
│       │   │   └── client.ts
│       │   └── config/                   # env loading + validation (zod)
│       ├── test/
│       │   ├── unit/
│       │   └── integration/              # provider adapter contract tests
│       └── package.json
│
├── packages/
│   ├── shared-types/                     # cross-cutting TypeScript contracts
│   │   └── src/
│   │       ├── agents/                   # Agent, AgentCard, AgentDefinition
│   │       ├── a2a/                      # Task, TaskState, Message, Part
│   │       ├── mcp/                      # ToolDefinition, ToolInvocation
│   │       ├── providers/                # ModelProvider, ModelCapabilities
│   │       ├── events/                   # Event envelope + event union
│   │       ├── memory/                   # MemoryItem, MemoryCategory
│   │       ├── bots/                     # BotDefinition, BotFinding
│   │       └── api/                      # REST/WS DTOs shared with mobile
│   ├── api-spec/                         # OpenAPI spec (source of truth for codegen)
│   └── config/                           # shared eslint/tsconfig/prettier
│
├── infra/
│   ├── docker/
│   │   ├── backend.Dockerfile            # ARM64-compatible multi-stage build
│   │   ├── docker-compose.yml            # backend + postgres(pgvector) + redis
│   │   └── docker-compose.prod.yml
│   ├── oracle-cloud/
│   │   └── README.md                     # Always Free ARM64 provisioning notes
│   └── n8n/
│       └── README.md                     # automation integration point (not required M1)
│
├── docs/
│   └── architecture/                     # this document set (00-09)
│
├── scripts/                              # dev/ops scripts
├── .env.example
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── package.json
```

## 2. Technology decisions

| Concern | Decision | Rationale |
|---|---|---|
| Mobile framework | React Native + Expo (EAS build), Android target first | Fast iteration, OTA updates, native module access (Keystore) via config plugins, PC client later can reuse `packages/shared-types` and much of `features/` |
| Mobile navigation | `expo-router` | File-based routes map cleanly onto the app tree above; deep-linkable |
| Mobile state | Zustand (local UI/app state) + TanStack Query (server state/cache) | Minimal boilerplate, good fit for a WS-driven realtime app |
| Mobile 3D | `three.js` via `expo-gl` + `@react-three/fiber` for the Command Center, with a mandatory 2D/CSS fallback path when WebGL is unavailable | Real GPU 3D on-device; fallback avoids the WebGL-detection failure mode documented for this account's previous Vite/Replit work |
| Mobile local secure storage | `expo-secure-store` (Android Keystore-backed) | Device-bound secrets only (session token, biometric gate) — **not** the source of truth for provider keys (see §3) |
| Backend runtime | Node.js 24 + TypeScript (strict) | Matches existing account tooling, first-class async I/O for many concurrent provider/agent calls |
| Backend HTTP framework | Express 5 | Simple, well understood, sufficient for a single-user backend; paired with `zod` for request/response validation |
| Realtime transport | WebSocket (native `ws`) | Bidirectional stream for chat token-streaming and Command Center event feed; one connection serves both concerns via typed channels |
| ORM / migrations | Drizzle ORM + drizzle-kit | Typed schema, lightweight, versioned SQL migrations, no heavy codegen step |
| Database | PostgreSQL 16 + `pgvector` | Relational core (agents/tasks/events/registry) and vector search (memory embeddings) in one engine — avoids running a second DB service on a 12GB box |
| Queue / cache | Redis 7 + BullMQ | Bot scheduling, task queues, rate-limit counters, small footprint on ARM64 |
| Containerization | Docker Compose, multi-arch (`linux/arm64`) images | Oracle Always Free compute is Ampere A1 (ARM64); every image must be built/tested for `arm64` |
| Reverse proxy / TLS | Caddy (or Cloudflare Tunnel — see `08-deployment-architecture.md`) | Automatic TLS, minimal config, low resource use |
| Provider abstraction | Custom `ModelProvider` interface (see `06-provider-model-interfaces.md`) | Vendor-neutral; NVIDIA Nemotron, Gemini, Groq, SambaNova, OpenRouter are adapters, not the core |
| Agent protocol | A2A-shaped concepts (Agent Card, Task lifecycle, Message/Part) implemented in-process initially, transport-agnostic so agents can move to real HTTP A2A later | Keeps compatibility with the open A2A ecosystem without paying network overhead for agents that live in the same process today |
| Tool protocol | MCP-shaped tool contracts (JSON-schema input/output), with a host that can also proxy to real external MCP servers | Tools stay swappable and agent-agnostic; opens the door to third-party MCP servers (n8n, browser tools, etc.) |
| Encryption | AES-256-GCM envelope encryption for provider keys at rest; KEK from Oracle Cloud Vault (or sealed env secret) | See `07-security-model.md` |
| Observability | Structured JSON logs + `/health` per subsystem + `events` table doubling as an audit/timeline source | Right-sized for a 2 OCPU/12GB box; Prometheus/Grafana is an optional later addition, not required for M1 |
| CI | GitHub Actions: typecheck, lint, unit tests, provider-adapter contract tests, `arm64` image build | Keeps the ARM64 constraint enforced continuously instead of discovered at deploy time |

## 3. Why provider keys cannot live only in Android Keystore

The product requirement is that **bots and agents keep running when the
phone is closed**. If a provider API key only existed inside the phone's
Keystore, the backend would be unable to make LLM calls while the app is
off — which breaks background monitoring, autonomous agents, and
notifications. Therefore:

- The **authoritative** copy of each provider key is stored **server-side**,
  encrypted at rest (see `07-security-model.md`).
- Android Keystore is used for what it's actually good at on this
  architecture: protecting the **device's own session credential** and
  gating local app unlock (PIN/biometric), not for holding secrets the
  server itself needs to operate autonomously.
- Keys are transmitted from the app to the backend once, over TLS, during
  "Add key" / "Edit key", and are never round-tripped back to the client in
  full afterward (see Vault API contract in `03-api-contracts.md`).

## 4. Extensibility contract

Anything in this list is added by **registering an implementation**, never
by editing router/orchestrator core logic:

- New AI provider → implement `ModelProvider` in `core/providers/<name>`, register in Model Registry.
- New model → discovered by Evolution Engine or added manually; stored as a `model_registry` row.
- New agent → implement the `Agent` interface + `AgentCard` in `core/agents/<name>`, register in Agent Registry.
- New bot → implement `BotDefinition` in `core/bots/<name>`, register in Bot Engine scheduler.
- New MCP tool → implement `ToolDefinition` in `core/mcp/tools/<name>` or connect an external MCP server.
- New A2A agent (external) → register its Agent Card URL; the A2A layer treats it identically to an in-process agent.
- New automation → n8n workflow calling the backend's automation webhook contract.
- New UI module → new `app/(section)` route + `features/<section>` module in the mobile app.
