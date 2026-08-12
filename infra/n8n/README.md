# n8n integration point

Implemented M10. Optional — the app is fully usable without it. See
`docs/architecture/08-deployment-architecture.md` §7,
`docs/architecture/03-api-contracts.md` §7 (`automations` table,
`/webhooks/automations/:slug`), and `services/backend/src/core/automations/README.md`.

## Running it

```
docker compose -f infra/docker/docker-compose.yml --profile automation up
```

Not started by a plain `docker compose up` — it's its own profile, to
respect the resource budget (`08-deployment-architecture.md` §4). n8n's
own UI is reachable at `http://localhost:5678` on the host.

## Wiring

- **MD AI → n8n**: create an automation with `actionType: "n8n_workflow"`
  and `actionConfig: { webhookUrl: "<n8n webhook trigger URL>" }`
  (`POST /automations`). Every trigger of that automation POSTs a small
  JSON payload (`automationId`, `automationRunId`, `automationName`,
  `triggeredAt`) to that URL.
- **n8n → MD AI**: create an automation with `triggerType: "webhook"`.
  The response includes a one-time `webhookSecret` — configure your n8n
  workflow's HTTP Request node to POST to
  `https://<your-md-ai-host>/webhooks/automations/<webhookSlug>` with
  header `X-MD-AI-Signature: <hex-encoded HMAC-SHA256 of the exact
  request body, using webhookSecret>`. A missing or invalid signature is
  refused with 401 — the slug alone is never sufficient
  (`docs/architecture/07-security-model.md` §2).

## A real constraint, not a bug

Both directions go through `core/security/ssrfGuard.ts`'s `safeFetch` —
the same HTTPS-only, private-IP-blocking check every other outbound call
in this codebase gets (M4/M5's SSRF protections apply uniformly; an
owner-configured automation target is trusted to be the *right* endpoint,
never exempted from being a *safe* one). That means **MD AI → n8n calls
require n8n to be reachable over HTTPS** — the compose service above
listens on plain HTTP by default, which `dispatchN8nWorkflow` will refuse
to call as configured. Put n8n behind TLS (a reverse proxy, or n8n's own
`N8N_PROTOCOL=https` + certificate config) before wiring an
`n8n_workflow` automation to it. The reverse direction (n8n calling MD
AI's webhook) has the same requirement — MD AI's own backend should be
served over HTTPS in any deployment that accepts external webhook calls,
consistent with `08-deployment-architecture.md`'s "prefer not exposing a
public IP at all" / reverse-proxy guidance.

Neither system depends on the other being present or running.
