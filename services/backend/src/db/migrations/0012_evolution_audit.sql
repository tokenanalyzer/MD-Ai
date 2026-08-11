-- MD AI — 0012: evolution engine proposals + security audit log
-- Separates the five change classes described in
-- docs/architecture/07-security-model.md so that only the two highest-risk
-- ones ever require a human approval gate.

CREATE TABLE evolution_proposals (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    change_class   TEXT NOT NULL CHECK (change_class IN (
                        'knowledge_update',      -- e.g. new memory/knowledge fact
                        'model_registry_update',  -- new/changed model_registry row
                        'routing_policy_update',  -- router weighting/preference change
                        'skill_update',           -- new/modified tool or agent prompt config
                        'application_code_update' -- source code / infra / permission change
                    )),
    title          TEXT NOT NULL,
    rationale      TEXT NOT NULL,
    diff           JSONB NOT NULL,                -- structured proposed change (never raw shell/code exec)
    risk_level     TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
    requires_approval BOOLEAN NOT NULL,            -- true for skill_update(high-risk) and application_code_update always
    status         TEXT NOT NULL DEFAULT 'proposed'
                        CHECK (status IN ('proposed', 'sandbox_tested', 'approved', 'rejected', 'applied', 'rolled_back')),
    sandbox_result JSONB,
    decided_by     TEXT CHECK (decided_by IN ('user', 'auto')),
    decided_at     TIMESTAMPTZ,
    applied_at     TIMESTAMPTZ,
    rolled_back_at TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX evolution_proposals_status_idx ON evolution_proposals(status);

-- Append-only audit trail for every security-sensitive action: key vault
-- access, approval decisions, guardian interventions, config changes.
CREATE TABLE audit_log (
    id           BIGSERIAL PRIMARY KEY,
    actor        TEXT NOT NULL,                   -- 'user', agent id, or 'system'
    action       TEXT NOT NULL,                    -- e.g. 'provider_key.created', 'evolution.approved'
    target_type  TEXT,
    target_id     TEXT,
    metadata      JSONB NOT NULL DEFAULT '{}',      -- never contains secret material
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_action_time_idx ON audit_log(action, created_at DESC);
