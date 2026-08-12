-- MD AI — 0019: M4 — real Tool Registry columns, richer tool_invocations,
-- per-agent permission levels, and the first safe built-in tool set.

ALTER TABLE tools
    ADD COLUMN version             TEXT NOT NULL DEFAULT '0.1.0',
    ADD COLUMN mcp_metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN required_capabilities TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN default_access      TEXT NOT NULL DEFAULT 'restricted'
                                        CHECK (default_access IN ('allowed', 'restricted', 'denied')),
    ADD COLUMN health              TEXT NOT NULL DEFAULT 'unknown'
                                        CHECK (health IN ('healthy', 'degraded', 'unavailable', 'unknown')),
    ADD COLUMN health_detail       TEXT,
    ADD COLUMN timeout_ms          INT NOT NULL DEFAULT 10000,
    ADD COLUMN last_verified_at    TIMESTAMPTZ,
    ADD COLUMN owner               TEXT NOT NULL DEFAULT 'system';

-- Per-agent grant level, not just presence/absence — "restricted" lets an
-- agent call a tool while the tool's own handler applies a stricter
-- internal policy (e.g. generic_http_get's domain allowlist), distinct
-- from "allowed" (the tool's normal safe behavior) and from no row at all
-- (denied — the existing agent_delegation_edges pattern: absence is the
-- enforcement mechanism, not a flag to check).
ALTER TABLE agent_tool_grants
    ADD COLUMN permission_level TEXT NOT NULL DEFAULT 'allowed'
        CHECK (permission_level IN ('allowed', 'restricted'));

ALTER TABLE tool_invocations
    ADD COLUMN completed_at    TIMESTAMPTZ,
    ADD COLUMN error_code      TEXT,
    ADD COLUMN result_metadata JSONB;

-- M4 adds two more terminal states: 'timeout' (the host's own timeout
-- fired) and 'blocked' (a security guard — SSRF, permission — refused the
-- call), distinct from a plain handler-thrown 'failed'.
ALTER TABLE tool_invocations DROP CONSTRAINT tool_invocations_status_check;
ALTER TABLE tool_invocations ADD CONSTRAINT tool_invocations_status_check
    CHECK (status IN ('running', 'succeeded', 'failed', 'timeout', 'blocked', 'awaiting_approval', 'denied'));

CREATE INDEX tools_health_idx ON tools(health) WHERE enabled = true;

-- ---- M4.3: first safe tool set (data, not a hardcoded map in Master) ----

INSERT INTO tools (id, display_name, description, input_schema, output_schema, source, risk_level, requires_approval, required_capabilities, default_access, timeout_ms, owner) VALUES
(
    'web_search',
    'Web Search',
    'Searches the web via a configured search provider and returns structured results (title, url, snippet, source). Returns ToolNotAvailableError, never fabricated results, when no provider is configured.',
    '{"type":"object","properties":{"query":{"type":"string"},"maxResults":{"type":"integer"}},"required":["query"]}'::jsonb,
    '{"type":"object","properties":{"results":{"type":"array"},"provider":{"type":"string"}}}'::jsonb,
    'builtin', 'low', false, ARRAY['network'], 'restricted', 15000, 'system'
),
(
    'url_reader',
    'URL Reader',
    'Fetches a single HTTPS URL and extracts readable text, with SSRF protection (private IP / localhost / cloud metadata endpoint blocking), size limits, and redirect limits.',
    '{"type":"object","properties":{"url":{"type":"string"}},"required":["url"]}'::jsonb,
    '{"type":"object","properties":{"url":{"type":"string"},"title":{"type":"string"},"text":{"type":"string"},"truncated":{"type":"boolean"}}}'::jsonb,
    'builtin', 'medium', false, ARRAY['network'], 'restricted', 15000, 'system'
),
(
    'file_reader',
    'Text/File Reader',
    'Fetches a plain-text file over HTTPS and returns its content, bounded by a size limit. Operates on an https:// URL, not an internal object-storage reference — no uploads/object-storage subsystem exists in this codebase yet (see docs/architecture/03-api-contracts.md §10).',
    '{"type":"object","properties":{"url":{"type":"string"}},"required":["url"]}'::jsonb,
    '{"type":"object","properties":{"text":{"type":"string"},"truncated":{"type":"boolean"}}}'::jsonb,
    'builtin', 'low', false, ARRAY['network'], 'allowed', 10000, 'system'
),
(
    'pdf_reader',
    'PDF Text Extraction',
    'Fetches a PDF over HTTPS and extracts its text content, bounded by a size limit and page count. Same HTTPS-URL scoping as file_reader.',
    '{"type":"object","properties":{"url":{"type":"string"}},"required":["url"]}'::jsonb,
    '{"type":"object","properties":{"text":{"type":"string"},"pageCount":{"type":"integer"},"truncated":{"type":"boolean"}}}'::jsonb,
    'builtin', 'low', false, ARRAY['network'], 'allowed', 15000, 'system'
),
(
    'calculator',
    'Calculator',
    'Evaluates a deterministic arithmetic expression locally — never uses an LLM.',
    '{"type":"object","properties":{"expression":{"type":"string"}},"required":["expression"]}'::jsonb,
    '{"type":"object","properties":{"result":{"type":"number"}}}'::jsonb,
    'builtin', 'low', false, ARRAY['compute'], 'allowed', 1000, 'system'
),
(
    'time_date',
    'Time / Date',
    'Returns the current date/time deterministically — never uses an LLM.',
    '{"type":"object","properties":{"timezoneOffsetMinutes":{"type":"integer"}}}'::jsonb,
    '{"type":"object","properties":{"iso":{"type":"string"},"unixMs":{"type":"integer"}}}'::jsonb,
    'builtin', 'low', false, ARRAY['compute'], 'allowed', 1000, 'system'
),
(
    'generic_http_get',
    'Generic HTTP GET Connector',
    'Restricted HTTPS GET to a caller-specified URL. SSRF-protected, size-limited, never forwards or accepts model-supplied credentials/Authorization headers.',
    '{"type":"object","properties":{"url":{"type":"string"}},"required":["url"]}'::jsonb,
    '{"type":"object","properties":{"status":{"type":"integer"},"contentType":{"type":"string"},"body":{"type":"string"},"truncated":{"type":"boolean"}}}'::jsonb,
    'builtin', 'medium', false, ARRAY['network'], 'restricted', 15000, 'system'
)
ON CONFLICT (id) DO NOTHING;

-- ---- M4.9: permissions (data, not a hardcoded map) ----
-- Research: full safe set, generic_http_get at "restricted" (tool already
-- self-restricts regardless — see core/mcp/tools/httpGet.ts).
-- Reviewer/Master: no tool grants in M4 — Reviewer is read-only analysis
-- of what Research already gathered, Master is orchestration-only "unless
-- explicitly authorized," and nothing has authorized it yet.

INSERT INTO agent_tool_grants (agent_id, tool_id, permission_level) VALUES
    ('research', 'web_search', 'allowed'),
    ('research', 'url_reader', 'allowed'),
    ('research', 'file_reader', 'allowed'),
    ('research', 'pdf_reader', 'allowed'),
    ('research', 'calculator', 'allowed'),
    ('research', 'time_date', 'allowed'),
    ('research', 'generic_http_get', 'restricted')
ON CONFLICT (agent_id, tool_id) DO NOTHING;
