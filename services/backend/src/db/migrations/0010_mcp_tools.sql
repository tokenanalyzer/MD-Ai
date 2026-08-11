-- MD AI — 0010: MCP-compatible tool registry (tools are separate from agents)

CREATE TABLE tools (
    id              TEXT PRIMARY KEY,             -- e.g. 'web.search', 'web.fetch', 'code.exec'
    display_name    TEXT NOT NULL,
    description     TEXT NOT NULL,
    input_schema    JSONB NOT NULL,                -- JSON Schema
    output_schema   JSONB NOT NULL,                -- JSON Schema
    source          TEXT NOT NULL DEFAULT 'builtin'
                        CHECK (source IN ('builtin', 'mcp_server')),
    mcp_server_url  TEXT,                          -- set when source = 'mcp_server'
    risk_level      TEXT NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high')),
    requires_approval BOOLEAN NOT NULL DEFAULT false, -- high-risk tools (e.g. code exec, purchases)
    enabled          BOOLEAN NOT NULL DEFAULT true,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which agents may call which tools — explicit allow-list, not implicit.
CREATE TABLE agent_tool_grants (
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    tool_id  TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
    PRIMARY KEY (agent_id, tool_id)
);

CREATE TABLE tool_invocations (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tool_id      TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
    task_id      UUID REFERENCES tasks(id) ON DELETE SET NULL,
    agent_id     TEXT REFERENCES agents(id),
    input        JSONB NOT NULL,
    output       JSONB,
    status       TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'succeeded', 'failed', 'awaiting_approval', 'denied')),
    error        TEXT,
    latency_ms   INT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tool_invocations_tool_time_idx ON tool_invocations(tool_id, created_at DESC);
CREATE INDEX tool_invocations_task_idx ON tool_invocations(task_id);
