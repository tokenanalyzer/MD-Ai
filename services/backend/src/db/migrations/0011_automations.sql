-- MD AI — 0011: automation definitions (chat-triggered + n8n integration point)

CREATE TABLE automations (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name           TEXT NOT NULL,
    description    TEXT,
    trigger_type   TEXT NOT NULL CHECK (trigger_type IN ('schedule', 'event', 'webhook', 'manual')),
    trigger_config JSONB NOT NULL DEFAULT '{}',    -- cron expr / event_type filter / webhook slug
    action_type    TEXT NOT NULL CHECK (action_type IN ('agent_task', 'n8n_workflow', 'notification')),
    action_config  JSONB NOT NULL DEFAULT '{}',    -- agent id + task template, or n8n workflow id/url
    enabled        BOOLEAN NOT NULL DEFAULT true,
    created_by     TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'master_agent')),
    last_run_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE automation_runs (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    automation_id  UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at    TIMESTAMPTZ,
    status         TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
    result         JSONB,
    error          TEXT
);

CREATE INDEX automation_runs_automation_idx ON automation_runs(automation_id, started_at DESC);
