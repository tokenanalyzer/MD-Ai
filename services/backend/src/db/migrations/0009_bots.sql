-- MD AI — 0009: deterministic bot engine

CREATE TABLE bots (
    id             TEXT PRIMARY KEY,              -- e.g. 'price-monitor', 'news-monitor'
    display_name   TEXT NOT NULL,
    description    TEXT NOT NULL,
    schedule_cron  TEXT NOT NULL,                  -- e.g. '*/5 * * * *'
    config         JSONB NOT NULL DEFAULT '{}',    -- bot-specific parameters (symbols, thresholds, feeds)
    enabled        BOOLEAN NOT NULL DEFAULT true,
    escalate_to_agent_id TEXT REFERENCES agents(id), -- who analyzes a bot.alert (per Bot→Agent→Reviewer→Master flow)
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bot_runs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id       TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ,
    status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
    error        TEXT,
    findings_count INT NOT NULL DEFAULT 0
);

CREATE INDEX bot_runs_bot_time_idx ON bot_runs(bot_id, started_at DESC);

-- A "finding" is a deterministic detection (e.g. price crossed threshold).
-- It is NOT an LLM judgment — that happens when an agent picks this up.
CREATE TABLE bot_findings (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_run_id   UUID NOT NULL REFERENCES bot_runs(id) ON DELETE CASCADE,
    bot_id       TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    severity     TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warn', 'critical')),
    payload      JSONB NOT NULL,                    -- raw detection data
    routed_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL, -- the agent task it spawned, if any
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX bot_findings_bot_idx ON bot_findings(bot_id, created_at DESC);
