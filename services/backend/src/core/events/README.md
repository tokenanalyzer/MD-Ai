# core/events

Event bus: single `EventEmitter`-based dispatcher, synchronous persist to
`events` before fan-out, WS gateway subscription filtering. Implements the
`EventPayload` union in `@mdai/shared-types`. See
`docs/architecture/05-event-schemas.md`.
