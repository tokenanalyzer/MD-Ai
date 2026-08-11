# n8n integration point

Optional, not required for any milestone through M9. See
`docs/architecture/08-deployment-architecture.md` §7 and
`docs/architecture/03-api-contracts.md` §7 (`automations` table,
`/webhooks/automations/:slug`).

When enabled: n8n runs as an additional compose service (its own profile,
not started by default, to respect the resource budget). MD AI automations
with `action_type = 'n8n_workflow'` call an n8n webhook to start a workflow;
n8n workflows can call back into MD AI via the signed automation webhook
endpoint. Neither system depends on the other being present.
