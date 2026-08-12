-- MD AI — 0018: M3 — Agent Registry heartbeat, A2A correlation/retry,
-- Memory approval workflow, and the Research/Reviewer agent roster.

ALTER TABLE agents
    ADD COLUMN last_heartbeat_at TIMESTAMPTZ;

ALTER TABLE tasks
    ADD COLUMN correlation_id UUID,
    ADD COLUMN attempt INT NOT NULL DEFAULT 1;

-- A root task (no parent) is its own correlation root.
CREATE INDEX tasks_correlation_idx ON tasks(correlation_id);

ALTER TABLE memory_items
    ADD COLUMN importance NUMERIC(3,2) NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
    ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'
        CHECK (approval_status IN ('approved', 'pending', 'rejected'));

-- Retrieval only ever considers approved, non-deleted memories.
CREATE INDEX memory_items_approval_idx ON memory_items(approval_status) WHERE deleted_at IS NULL;

-- ---- Research + Reviewer agents (M3 roster: Master, Research, Reviewer) ----

INSERT INTO agents (id, display_name, description, agent_card, capabilities, is_internal, status, enabled) VALUES
(
    'research',
    'Research Agent',
    'Gathers and structures findings for a stated research objective, honestly disclosing when no live tool/web access is connected (M3: always — MCP host lands M4).',
    '{
        "id": "research",
        "displayName": "Research Agent",
        "description": "Structured research findings with explicit fact/assumption/uncertainty labeling and honest capability-limitation reporting.",
        "version": "0.1.0",
        "capabilities": ["research"],
        "supportedTaskTypes": ["research"],
        "isInternal": true,
        "modelPreferences": {"taskCategory": "research"},
        "toolRequirements": ["web.search"],
        "status": "idle"
    }'::jsonb,
    ARRAY['research'],
    true,
    'idle',
    true
),
(
    'reviewer',
    'Reviewer',
    'Validates another agent''s structured output before it reaches Master — completeness, schema validity, contradictions, unsupported claims. Never reviews its own output.',
    '{
        "id": "reviewer",
        "displayName": "Reviewer",
        "description": "Validation-only agent: APPROVE / REVISE / REJECT with itemized issues.",
        "version": "0.1.0",
        "capabilities": ["review"],
        "supportedTaskTypes": ["review"],
        "isInternal": true,
        "modelPreferences": {"taskCategory": "reasoning"},
        "toolRequirements": [],
        "status": "idle"
    }'::jsonb,
    ARRAY['review'],
    true,
    'idle',
    true
)
ON CONFLICT (id) DO NOTHING;

-- Update master's agent_card to the richer M3 shape (status/version/etc.
-- were present informally in M1's seed; this brings it in line with the
-- AgentCard fields Research/Reviewer ship with).
UPDATE agents SET agent_card = '{
    "id": "master",
    "displayName": "Master Agent",
    "description": "Primary orchestrator and default chat surface. Classifies intent, delegates to specialist agents by capability, synthesizes final responses.",
    "version": "0.2.0",
    "capabilities": ["chat", "general-qa", "orchestration"],
    "supportedTaskTypes": ["chat"],
    "isInternal": true,
    "modelPreferences": {"taskCategory": "chat"},
    "toolRequirements": [],
    "status": "idle"
}'::jsonb
WHERE id = 'master';

-- ---- Delegation authorization (data, not code) ----
-- Master may delegate to Research and Reviewer. Neither Research nor
-- Reviewer may delegate to anything (no chained/uncontrolled delegation
-- in M3) — enforced by the ABSENCE of rows here, checked by
-- AgentRegistryService.isDelegationAuthorized before every delegate() call.

INSERT INTO agent_delegation_edges (from_agent_id, to_agent_id) VALUES
    ('master', 'research'),
    ('master', 'reviewer')
ON CONFLICT DO NOTHING;
