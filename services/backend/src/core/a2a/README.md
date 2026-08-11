# core/a2a

A2A-shaped task lifecycle: create/dispatch/cancel tasks, persist
`tasks`/`task_messages`, stream `TaskStreamChunk`s to the API layer. All
agents are `isInternal: true` through M8 (in-process dispatch); this layer
exists so an agent can move to `isInternal: false` with a real network
endpoint later without changing the orchestrator's `delegate()` call site.
See `docs/architecture/04-agent-interfaces.md` §4.
