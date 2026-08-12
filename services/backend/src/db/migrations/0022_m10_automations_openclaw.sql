-- MD AI — 0022: M10 — automation runner fields (webhook slug, per-run
-- timeout) and the background credential vault's third kind (automation
-- webhook signing secret, reusing M5.12a's encrypted-credential
-- mechanism rather than inventing a second one).

-- A public, non-secret routing token for `POST /webhooks/automations/:slug`
-- — the actual authentication is an HMAC signature over the request body,
-- computed with a secret stored via `background_credentials` (kind
-- 'automation_webhook', id = automations.id). Only ever set for
-- trigger_type = 'webhook' rows; NULL for every other trigger type.
ALTER TABLE automations ADD COLUMN webhook_slug TEXT UNIQUE;

-- Same "fixed, conservative bound" philosophy as bots' own timeout_ms
-- (docs/architecture/12-bot-engine.md — M5.17) rather than unbounded
-- per-config trust in an automation's action.
ALTER TABLE automations ADD COLUMN timeout_ms INT NOT NULL DEFAULT 30000;

-- Honest outcome reporting: a run the recovery sweep marks as having
-- outlived its own automation's timeout_ms must say so, not "failed".
ALTER TABLE automation_runs DROP CONSTRAINT automation_runs_status_check;
ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_status_check
    CHECK (status IN ('running', 'succeeded', 'failed', 'timeout'));

-- Which of the automation's own trigger paths actually fired THIS run —
-- an automation configured trigger_type = 'schedule' can still be run
-- manually (POST /automations/:id/run), so the per-run record, not just
-- the automation's static config, is what's auditable.
ALTER TABLE automation_runs ADD COLUMN trigger_type TEXT
    CHECK (trigger_type IN ('schedule', 'event', 'webhook', 'manual'));

-- M10: the automation webhook signing secret is a credential MD AI itself
-- mints and hands to the external caller (n8n or similar), not a
-- third-party API key — but it reuses the exact same envelope-encrypted
-- storage `background_credentials` already provides (M5.12a), rather
-- than a parallel secrets table.
ALTER TABLE background_credentials DROP CONSTRAINT background_credentials_credential_kind_check;
ALTER TABLE background_credentials ADD CONSTRAINT background_credentials_credential_kind_check
    CHECK (credential_kind IN ('llm_provider', 'search_provider', 'automation_webhook'));
