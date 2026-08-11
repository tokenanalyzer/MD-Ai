# Agent Interfaces, A2A Layer, and MCP Tool Layer

Full type definitions: `packages/shared-types/src/a2a`, `.../agents`,
`.../mcp`.

## 1. The `Agent` contract

```ts
interface Agent {
  card: AgentCard;
  handleTask(ctx: AgentRuntimeContext): Promise<void>;
  onCancel?(taskId: string): Promise<void>;
  healthCheck(): Promise<{ healthy: boolean; detail?: string }>;
}
```

An agent does not call providers, tools, or other agents directly — it does
everything through `AgentRuntimeContext` (`selectModel`, `callTool`,
`delegate`, `emit`). This is the dependency-inversion seam that keeps
agents unit-testable (mock the context) and keeps the Model Router / MCP
host / A2A layer as the only places that actually reach a provider, a tool,
or another agent.

## 2. Initial Agent Registry

| Agent id | Role | Notes |
|---|---|---|
| `master` | Orchestrator, primary chat surface, classification + delegation | The only agent the user's chat talks to directly by default |
| `research` | Open-ended research, synthesis, citation gathering | Uses `web.search` / `web.fetch` tools |
| `crypto-intel` | Crypto market analysis, on-chain context | Consumes `bot.alert` findings from crypto bots |
| `stock-intel` | Equities/market analysis | Consumes `bot.alert` findings from market-scanner bots |
| `business-intel` | Company/opportunity research | |
| `social-media` | Social trend/sentiment analysis | Consumes social-trend-monitor bot findings |
| `ai-radar` | Tracks AI model/tooling landscape | Feeds the Evolution Engine's model discovery |
| `news-intel` | News synthesis and relevance filtering | Consumes news-monitor bot findings |
| `reviewer` | Validates another agent's output before it reaches the user/Master | Sits between specialist agents and Master in the pipeline |
| `guardian` | Security/policy enforcement, approval-gate checks | Not user-facing; invoked by the orchestrator and the Evolution Engine |
| `memory-agent` | Reads/writes structured memory on behalf of other agents | The only agent with direct memory write access |

Registered as data (`agents` table + `agent_delegation_edges`), not as a
switch statement — adding an agent means writing a new
`core/agents/<name>/index.ts` implementing `Agent` and inserting its row;
nothing in `core/router` or the API layer changes.

## 3. Master Agent decision flow

1. Receive user message (or an escalated `bot_findings` row, or an
   automation trigger).
2. Classify: direct answer vs. task requiring delegation vs. memory command
   vs. automation request.
3. **Direct answer** → call Model Router for a general-purpose model, reply.
4. **Delegation** → read `getDelegationOptions('master')`, pick agent(s) by
   capability match, `delegate()` creates child `Task` row(s).
5. Specialist agent works its task, may itself delegate deeper (e.g.
   `crypto-intel` → `research` for a sub-question) — same interface, no
   special-casing depth.
6. Non-trivial or bot-originated findings route through `reviewer` before
   Master finalizes a response — this is the "Reviewer validates" step in
   `BOT DETECTS → AGENT ANALYZES → REVIEWER VALIDATES → MASTER REPORTS`.
7. Master collects child task outputs, produces one concise final response,
   emits `agent.task.completed` for the top-level task.

## 4. A2A layer

`core/a2a` implements the `Task` state machine
(`submitted → working → input-required|completed|failed|canceled`) and
message passing described in `packages/shared-types/src/a2a`. For M1–M8 all
agents are `isInternal: true` and dispatch happens as direct in-process
function calls; the state machine and persistence (`tasks`,
`task_messages`) are identical to what a real network A2A call would use,
so an agent can be moved to `isInternal: false` with an `externalEndpoint`
later — the orchestrator's `delegate()` call doesn't change, only the A2A
layer's transport implementation for that one agent id.

Cancellation, streaming (`TaskStreamChunk`), and error propagation
(`TaskError.retryable`) are first-class so the Model Router can distinguish
"try a fallback model" from "surface this failure."

## 5. MCP tool layer

Tools live in `core/mcp`, are registered via `ToolHandler`, and are called
only through the `ToolRegistry`/host — never directly by an agent. This
gives three things for free:
- **Agent-agnostic tools.** The same `web.search` implementation serves
  `research`, `news-intel`, and `master`.
- **Central risk gating.** `requiresApproval` tools (e.g. anything that
  spends money or executes code) pause at `awaiting_approval` regardless of
  which agent invoked them, enforced by `agent_tool_grants` +
  `evolution_proposals`-style approval, not by each agent remembering to
  check.
- **External MCP servers as tool sources.** `connectServer(url)` lets a
  third-party MCP server (including ones exposed by n8n or future
  integrations) register tools the same way a built-in tool does.

## 6. Bots are not agents

Bots (`core/bots`) never implement the `Agent` interface and never call a
model. A bot's job ends at writing a `bot_findings` row; if that finding
warrants judgment, the Bot Engine creates a `Task` assigned to the bot's
configured `escalate_to_agent_id` (see `bots.escalate_to_agent_id` in the
schema) — that hand-off is the only point where a bot's output enters the
agent world. See `05-event-schemas.md` for the `bot.*` / `agent.*` event
split that makes this pipeline observable end-to-end.
