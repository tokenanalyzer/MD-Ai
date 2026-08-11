-- MD AI — 0014: seed the Master Agent
-- M1 ships exactly one agent (docs/architecture/09-roadmap.md M1); the
-- other ten in the roster (docs/architecture/04-agent-interfaces.md §2)
-- are registered the same way — an INSERT here, no code change to the
-- router/orchestrator — as they're implemented starting M3.

INSERT INTO agents (id, display_name, description, agent_card, capabilities, is_internal, status, enabled) VALUES (
    'master',
    'Master Agent',
    'Primary orchestrator and default chat surface. Direct-answer only in M1 — delegation to specialist agents lands at M3.',
    '{
        "id": "master",
        "displayName": "Master Agent",
        "description": "Primary orchestrator and default chat surface.",
        "capabilities": ["chat", "general-qa"],
        "supportedTaskTypes": ["chat"],
        "isInternal": true,
        "version": "0.1.0"
    }'::jsonb,
    ARRAY['chat', 'general-qa'],
    true,
    'idle',
    true
)
ON CONFLICT (id) DO NOTHING;
