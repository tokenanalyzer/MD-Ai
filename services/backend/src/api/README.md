# api

HTTP + WebSocket surface implementing `docs/architecture/03-api-contracts.md`.

- `routes/` — REST handlers, one file per resource group (auth, chat,
  providers, models, agents, bots, events, memory, automations, evolution,
  health).
- `ws/` — WebSocket gateway: `/ws/tasks/:id` (chat streaming) and
  `/ws/events` (Command Center feed), both backed by `core/events`.
- `middleware/` — auth (device session verification), rate limiting, secret
  redaction (see `docs/architecture/07-security-model.md` §4), and error
  mapping to the common `{ data }` / `{ error }` envelope.
