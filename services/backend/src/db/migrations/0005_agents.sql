-- MD AI — 0005: agent registry (A2A-shaped agent cards)

CREATE TABLE agents (
    id                TEXT PRIMARY KEY,             -- e.g. 'master', 'research', 'crypto-intel'
    display_name      TEXT NOT NULL,
    description       TEXT NOT NULL,
    agent_card        JSONB NOT NULL,                -- full A2A-style Agent Card (see packages/shared-types/src/a2a)
    capabilities       TEXT[] NOT NULL DEFAULT '{}',
    is_internal        BOOLEAN NOT NULL DEFAULT true, -- in-process vs. externally-hosted A2A agent
    external_endpoint  TEXT,                          -- set only when is_internal = false
    status              TEXT NOT NULL DEFAULT 'idle'
                            CHECK (status IN ('idle', 'active', 'error', 'disabled')),
    enabled              BOOLEAN NOT NULL DEFAULT true,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which agents a given agent is allowed to delegate to. Absence of a row
-- means "ask the Master Agent" is the only path — this is data, not code,
-- so relationships are never hard-coded (per architecture principle #2).
CREATE TABLE agent_delegation_edges (
    from_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    to_agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    PRIMARY KEY (from_agent_id, to_agent_id)
);
