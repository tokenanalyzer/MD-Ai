# core/automations

M10 Automation Engine: BullMQ-backed scheduler (mirrors `core/bots/
botEngine.ts`'s pattern exactly) driving the `automations`/`automation_runs`
tables (migration `0011`, extended by `0022`). Every `action_type` funnels
into a pre-existing, already-gated execution path — `dispatchAgentTask.ts`
reuses Master's own entry point (same as `core/bots/escalation.ts`),
`dispatchN8nWorkflow.ts` is a single outbound `safeFetch` call,
`dispatchNotification.ts` reuses the M5.13 notification pipeline — so
there is no automation-specific way to reach a tool, capability, or state
mutation, and Guardian's M8 tool-approval gate applies identically
regardless of what triggered the task.

`trigger_type = 'webhook'` (the one path an external caller like n8n can
reach) authenticates via a per-automation HMAC-SHA256 signature
(`webhookSignature.ts`) instead of the device bearer token — see
`docs/architecture/07-security-model.md` §2. The signing secret reuses
M5.12a's envelope-encrypted `background_credentials` vault rather than a
new secrets table.

See `docs/architecture/09-roadmap.md` (M10) and `infra/n8n/README.md`.
