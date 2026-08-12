-- MD AI — 0020: M5 — Bot Registry, Bot Run/Finding models, deduplication +
-- importance fields, push notifications + preferences, user topics, and
-- the opt-in background provider key vault (docs/architecture/
-- 07-security-model.md §3.4).

-- ---- M5.1: Bot Registry --------------------------------------------------

ALTER TABLE bots
    DROP COLUMN escalate_to_agent_id; -- superseded by M5.12: escalation
    -- always goes through Master's existing capability-discovery/delegation
    -- machinery (core/bots/escalation.ts), never a hardcoded per-bot agent
    -- target — a fixed column here would be exactly the "bypass the Agent
    -- Registry" the milestone instruction forbids.

ALTER TABLE bots
    ADD COLUMN version                TEXT NOT NULL DEFAULT '0.1.0',
    ADD COLUMN category               TEXT NOT NULL DEFAULT 'general'
                                        CHECK (category IN ('ai_release', 'news', 'user_topic', 'system_health', 'general')),
    ADD COLUMN status                 TEXT NOT NULL DEFAULT 'idle'
                                        CHECK (status IN ('idle', 'running', 'paused', 'disabled', 'error')),
    ADD COLUMN capabilities           TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN health                 TEXT NOT NULL DEFAULT 'unknown'
                                        CHECK (health IN ('healthy', 'degraded', 'unavailable', 'unknown')),
    ADD COLUMN health_detail          TEXT,
    ADD COLUMN last_run_at            TIMESTAMPTZ,
    ADD COLUMN last_successful_run_at TIMESTAMPTZ,
    ADD COLUMN failure_count          INT NOT NULL DEFAULT 0,
    ADD COLUMN timeout_ms             INT NOT NULL DEFAULT 30000,
    ADD COLUMN owner                  TEXT NOT NULL DEFAULT 'system';

CREATE INDEX bots_status_idx ON bots(status) WHERE enabled = true;

-- ---- M5.3: BotRun ---------------------------------------------------------

ALTER TABLE bot_runs
    ADD COLUMN duration_ms       INT,
    ADD COLUMN error_code        TEXT,
    ADD COLUMN resource_metadata JSONB NOT NULL DEFAULT '{}';

-- M5.2's timeout/cancellation outcomes need distinct terminal states, same
-- pattern as tool_invocations gaining 'timeout'/'blocked' in M4.
ALTER TABLE bot_runs DROP CONSTRAINT bot_runs_status_check;
ALTER TABLE bot_runs ADD CONSTRAINT bot_runs_status_check
    CHECK (status IN ('running', 'succeeded', 'failed', 'timeout', 'cancelled'));

CREATE INDEX bot_runs_status_idx ON bot_runs(status);

-- ---- M5.4/M5.5/M5.6: BotFinding — a signal, never a final AI answer -------

ALTER TABLE bot_findings
    DROP COLUMN severity; -- superseded by `importance` below (LOW/MEDIUM/
    -- HIGH/CRITICAL, M5.6) — two overlapping severity scales would just
    -- invite drift between them.

ALTER TABLE bot_findings
    ADD COLUMN category          TEXT NOT NULL DEFAULT 'general',
    ADD COLUMN title             TEXT NOT NULL DEFAULT '',
    ADD COLUMN summary           TEXT NOT NULL DEFAULT '',
    ADD COLUMN importance        TEXT NOT NULL DEFAULT 'low'
                                    CHECK (importance IN ('low', 'medium', 'high', 'critical')),
    ADD COLUMN confidence        NUMERIC(3,2) NOT NULL DEFAULT 1.0
                                    CHECK (confidence >= 0 AND confidence <= 1),
    ADD COLUMN source_metadata   JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN dedup_key         TEXT NOT NULL DEFAULT '',
    ADD COLUMN detected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN occurrence_count  INT NOT NULL DEFAULT 1,
    ADD COLUMN cooldown_until    TIMESTAMPTZ,
    ADD COLUMN status            TEXT NOT NULL DEFAULT 'new'
                                    CHECK (status IN ('new', 'escalated', 'notified', 'resolved', 'dismissed')),
    ADD COLUMN escalation_status TEXT NOT NULL DEFAULT 'none'
                                    CHECK (escalation_status IN ('none', 'pending', 'escalated', 'analyzed', 'failed')),
    ADD COLUMN updated_at        TIMESTAMPTZ NOT NULL DEFAULT now();

-- Deterministic identity for M5.5 dedup: the same (bot, dedup_key) pair is
-- one finding across repeated detections, not N rows — an
-- INSERT ... ON CONFLICT (bot_id, dedup_key) DO UPDATE bumps
-- occurrence_count/last_seen_at instead of creating a duplicate
-- (core/bots/dedup.ts). This is what keeps a release visible for 12 hours
-- from producing 12 notifications.
CREATE UNIQUE INDEX bot_findings_dedup_idx ON bot_findings(bot_id, dedup_key);
CREATE INDEX bot_findings_status_idx ON bot_findings(status, importance);

-- ---- M5.13: Push notifications --------------------------------------------

CREATE TABLE notifications (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    finding_id        UUID REFERENCES bot_findings(id) ON DELETE CASCADE,
    title             TEXT NOT NULL,
    summary           TEXT NOT NULL,
    importance        TEXT NOT NULL CHECK (importance IN ('low', 'medium', 'high', 'critical')),
    deep_link         TEXT NOT NULL,     -- e.g. mdai://findings/<id>, mdai://tasks/<id>
    status            TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sent', 'failed', 'suppressed')),
    suppressed_reason TEXT,              -- 'quiet_hours' | 'below_threshold' | 'topic_filtered' | 'bot_filtered' | 'category_filtered' | 'disabled' | 'no_device'
    error             TEXT,
    sent_at           TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX notifications_finding_idx ON notifications(finding_id);
CREATE INDEX notifications_status_idx ON notifications(status);

-- ---- M5.14: Notification preferences (single-owner) -----------------------

-- Default conservative, per instruction: filter lists are opt-OUT (empty =
-- nothing filtered) but minimum_importance defaults to 'high' and quiet
-- hours are unset — a fresh install sends nothing below HIGH until the
-- owner explicitly loosens it.
CREATE TABLE notification_preferences (
    owner_id                 UUID PRIMARY KEY REFERENCES owner(id) ON DELETE CASCADE,
    enabled                  BOOLEAN NOT NULL DEFAULT true,
    minimum_importance       TEXT NOT NULL DEFAULT 'high'
                                CHECK (minimum_importance IN ('low', 'medium', 'high', 'critical')),
    quiet_hours_start_minute SMALLINT CHECK (quiet_hours_start_minute BETWEEN 0 AND 1439),
    quiet_hours_end_minute   SMALLINT CHECK (quiet_hours_end_minute BETWEEN 0 AND 1439),
    quiet_hours_timezone     TEXT NOT NULL DEFAULT 'UTC',
    muted_topics             TEXT[] NOT NULL DEFAULT '{}',
    muted_bot_ids            TEXT[] NOT NULL DEFAULT '{}',
    muted_categories         TEXT[] NOT NULL DEFAULT '{}',
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- M5.9: User Topic Monitor configuration --------------------------------

CREATE TABLE user_topics (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id              UUID NOT NULL REFERENCES owner(id) ON DELETE CASCADE,
    topic                 TEXT NOT NULL,
    frequency_minutes     INT NOT NULL DEFAULT 60 CHECK (frequency_minutes > 0),
    importance_threshold  TEXT NOT NULL DEFAULT 'medium'
                            CHECK (importance_threshold IN ('low', 'medium', 'high', 'critical')),
    enabled               BOOLEAN NOT NULL DEFAULT true,
    last_checked_at       TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (owner_id, topic)
);

-- ---- M5.12a: opt-in server-side background credential vault ---------------
-- A SEPARATE mechanism from `provider_configs` (docs/architecture/
-- 07-security-model.md §3.4) — the backend is never the DEFAULT holder of a
-- credential; this table holds ciphertext only, and only for credentials
-- the owner has explicitly toggled "allow background use" for from the
-- phone, so a bot finding can still reach Master/Research/Reviewer for
-- analysis (and Research can still search) while the app is closed. Covers
-- both credential families that already travel per-request everywhere else
-- in the system — LLM provider keys (`providerKeys`) and tool credentials
-- like a search provider key (`toolKeys`) — under one mechanism rather than
-- two, since the storage/encryption/opt-in semantics are identical; only
-- which map (`providerKeys` vs `toolKeys`) a given row feeds back into
-- differs, which is exactly what `credential_kind` records. No FK to
-- `providers` — `search_provider` ids (e.g. 'brave', 'tavily') aren't rows
-- in that table at all; the application layer validates `credential_id`
-- against the real provider/SearchProvider id sets before insert.
--
-- Envelope encryption: `wrapped_dek` is a one-time, per-credential
-- data-encryption key, itself encrypted with the process KEK
-- (MDAI_BACKGROUND_KEY_KEK env var — never stored in the DB); the actual
-- credential value is AES-256-GCM ciphertext under that DEK. No plaintext
-- credential material is ever written to Postgres.
CREATE TABLE background_credentials (
    credential_kind      TEXT NOT NULL CHECK (credential_kind IN ('llm_provider', 'search_provider')),
    credential_id        TEXT NOT NULL,   -- e.g. 'groq' (llm_provider) or 'brave'/'tavily' (search_provider)
    wrapped_dek           BYTEA NOT NULL, -- DEK, encrypted under the KEK
    dek_iv                BYTEA NOT NULL,
    dek_auth_tag           BYTEA NOT NULL,
    credential_ciphertext   BYTEA NOT NULL, -- the actual key, encrypted under the DEK
    credential_iv           BYTEA NOT NULL,
    credential_auth_tag      BYTEA NOT NULL,
    key_last4                TEXT,          -- display only, same non-reconstructable guarantee as provider_configs.key_last4
    enabled_by_owner_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (credential_kind, credential_id)
);

-- ---- M5.7-M5.11: seed the four initial bots (data, not a hardcoded map) ---
-- Explicitly NOT crypto/stock trading bots or exchange execution — see
-- docs/architecture/12-bot-engine.md §1 for the scope boundary carried
-- over verbatim from the milestone instruction.

INSERT INTO bots (id, display_name, description, schedule_cron, config, category, capabilities, timeout_ms, owner) VALUES
(
    'ai-model-release-monitor', 'AI / Model Release Monitor',
    'Watches configured/approved sources for new model releases, provider changes, deprecations, and capability changes. Normalizes findings; never fabricates a release — only reports what a source actually published.',
    '*/30 * * * *', '{"sources": []}'::jsonb, 'ai_release', ARRAY['research'], 30000, 'system'
),
(
    'news-monitor', 'News Monitor',
    'Tracks configured topics via the existing SearchProvider abstraction (not a new integration). Deterministic filtering and dedup run before anything reaches an LLM — most articles never trigger a model call.',
    '*/30 * * * *', '{"topics": ["AI agents", "Gemini", "NVIDIA", "Open-source AI"]}'::jsonb, 'news', ARRAY['research'], 30000, 'system'
),
(
    'user-topic-monitor', 'User Topic Monitor',
    'Checks user-defined topics (see user_topics table) at each topic''s own configured frequency and importance threshold.',
    '*/15 * * * *', '{}'::jsonb, 'user_topic', ARRAY['research'], 30000, 'system'
),
(
    'system-health-monitor', 'System Health Monitor',
    'Deterministically checks backend/Postgres/Redis/BullMQ/worker-count/CPU/memory/queue-depth/provider health against fixed thresholds — never an LLM judgment. A threshold breach becomes a Finding.',
    '*/5 * * * *', '{}'::jsonb, 'system_health', ARRAY['system'], 15000, 'system'
)
ON CONFLICT (id) DO NOTHING;
