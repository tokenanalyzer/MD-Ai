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
| `agent.task.created` / `.started` / `.completed` | A2A layer | Task path animates from creation → active → resolved |
| `agent.failed` / `agent.recovered` | A2A layer, health checks | Node shows error glow / clears it |
| `agent.message.sent` / `.received` | A2A layer | Edge pulse between two agent nodes (real A2A message, not decorative) |
| `tool.called` / `tool.completed` | MCP host | Node → tool icon flash, latency shown |
| `model.selected` / `model.switched` | Model Router | Provider/model badge on the task path; switch shows the fallback reason |
| `bot.started` / `.stopped` / `.alert` | Bot Engine | Bot node pulse; `.alert` draws the edge into the escalated agent's task |
| `automation.triggered` | Automation runner | Automation node fires, links to the resulting task or notification |

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
