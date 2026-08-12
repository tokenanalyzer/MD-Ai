# Event Bus & Event Schemas

Full type definitions: `packages/shared-types/src/events`.

## 1. Why one bus, one schema

Every subsystem — agents, bots, tools, the router, automations — emits onto
a single typed bus (`core/events`). Three consumers read from it:

1. **`events` table** (durable log, see `02-database-schema.md`).
2. **WS gateway** (`api/ws`) — fan-out to connected mobile clients.
3. **Evolution Engine / observability** — health rollups, task-outcome
   learning signal.

Because the Command Center renders *only* what arrives on this bus (per the
"no fake animation" principle), the event schema is effectively the
Command Center's API — every visual element (node activity, task path,
model switch, error glow, bot pulse) traces back to one `EventPayload`
variant.

## 2. Envelope

```ts
interface EventEnvelope<T extends EventPayload> {
  id: number;            // events.id (BIGSERIAL) — also the WS resume cursor
  type: T["type"];
  sourceType: "agent" | "bot" | "tool" | "model" | "automation" | "system";
  sourceId: string;
  taskId?: string;
  severity: "debug" | "info" | "warn" | "error";
  payload: T;
  createdAt: string;     // ISO-8601
}
```

`id` doubles as the resume cursor: the mobile WS client reconnects with
`?since=<last_seen_id>` and the gateway replays missed events from the
`events` table before switching to live push — this is what lets the
Command Center show a coherent timeline after the phone was asleep.

## 3. Event catalog

| Event | Emitted by | Command Center meaning |
|---|---|---|
| `agent.started` / `agent.idle` | Agent Registry lifecycle hooks | Node lights up / dims |
| `agent.task.created` / `.started` / `.completed` | A2A layer (M1 chat-specific) | Task path animates from creation → active → resolved |
| `agent.completed` | Any agent's `finishSuccess` (M3, generic) | Distinct from `agent.task.completed` — every agent (Master, Research, Reviewer, future specialists) emits this around `handleTask`, not just the M1 chat path |
| `agent.failed` / `agent.recovered` | A2A layer, health checks | Node shows error glow / clears it |
| `agent.message.sent` / `.received` | A2A layer | Edge pulse between two agent nodes (real A2A message, not decorative) |
| `task.created` / `.started` / `.completed` / `.failed` / `.cancelled` (M3) | `runtimeContext.ts`'s `delegate()`/`start()`/`finishSuccess()`/`finishFailure()`/`finishCanceled()` | Generic A2A task lifecycle for *any* task — root or delegated — carrying `correlationId` so the Command Center can group a whole delegation tree |
| `message.sent` / `.received` (M3) | `delegate()`, on every parent↔child hand-off | Edge pulse for the M3 A2A message layer (distinct from the older `agent.message.*` pair) |
| `review.started` / `.completed` (M3) | Reviewer Agent | Reviewer node pulse; `.completed` carries the `APPROVE`/`REVISE`/`REJECT` decision |
| `memory.created` (M3) | Master, on an explicit "Remember this" or a system-proposed candidate | Memory node pulse; carries `approvalStatus` so pending vs. approved renders differently |
| `memory.retrieved` (M3) | Master, before every response | Memory node → Master edge pulse; carries a **count and ids only, never content** (`07-security-model.md`) |
| `tool.called` / `tool.completed` | MCP host | Node → tool icon flash, latency shown |
| `model.selected` / `model.switched` | Model Router | Provider/model badge on the task path; switch shows the fallback reason |
| `bot.started` / `.stopped` / `.alert` | Bot Engine | Bot node pulse; `.alert` draws the edge into the escalated agent's task |
| `automation.triggered` | Automation runner | Automation node fires, links to the resulting task or notification |

M3 note: the `agent.task.*` events are M1's chat-specific naming, kept for
backward compatibility; every agent's *own* lifecycle (root or delegated)
now also emits the generic `task.*`/`agent.*` pair above via
`runtimeContext.ts`, so a future Command Center has one consistent
vocabulary to render regardless of which agent — or how deep in a
delegation tree — a task belongs to.

Every event is `severity: "error"` capable regardless of type (e.g. a
`tool.completed` with `status: "failed"` still carries `severity: "warn"`
or `"error"` at the envelope level) — the Command Center's error-state
rendering keys off `severity`, not off parsing each payload variant.

## 4. Transport

- Internal: Node `EventEmitter`-based bus in `core/events`, single process
  (fits the Oracle free-tier single-instance topology in M1–M8).
- Persistence: synchronous insert into `events` on emit, before fan-out —
  so a WS disconnect can never lose an event, only delay delivery.
- External: WebSocket, one connection per device session, subscribable by
  `sourceType`/`event type` filters so the phone doesn't have to receive
  `debug`-severity noise it won't render.

## 5. Extensibility

New event types are added by extending the `EventPayload` union in
`packages/shared-types/src/events` — the bus, the `events` table (schema is
already generic `JSONB payload`), and the WS gateway require no change. Only
the mobile Command Center renderer needs a new case to *visualize* a new
event type meaningfully; until then it falls back to a generic
node/edge pulse keyed by `sourceType`/`severity`.
