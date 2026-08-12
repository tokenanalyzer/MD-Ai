-- MD AI — 0021: M8 — remaining specialist agents, Guardian, and the
-- remaining bots (docs/architecture/09-roadmap.md M8).

-- ---- M8: six specialist agents (docs/architecture/04-agent-interfaces.md §2) ----
-- Each is a domain-focused variant of the exact same real, tool-using
-- research pipeline Research Agent already runs (core/agents/specialist/
-- specialistAgentFactory.ts reuses researchAgent.ts's structure) — never a
-- distinct fabricated capability. Master's delegation is already fully
-- capability-based (masterAgent.ts / intentClassifier.ts read the live
-- Agent Registry, nothing hardcoded there), so these become selectable
-- purely by existing here plus a master -> X delegation edge below.

INSERT INTO agents (id, display_name, description, agent_card, capabilities, is_internal, status, enabled) VALUES
(
    'crypto-intel',
    'Crypto Intel',
    'Crypto market and on-chain-context research via web search and page reading — the same real tool-use pipeline as Research Agent, focused on crypto. No live price/order-book/on-chain data feed is connected; findings come from searchable public sources only, disclosed honestly like every other specialist here.',
    '{
        "id": "crypto-intel",
        "displayName": "Crypto Intel",
        "description": "Crypto market analysis and on-chain context from searchable public sources.",
        "version": "0.1.0",
        "capabilities": ["crypto-analysis"],
        "supportedTaskTypes": ["research"],
        "isInternal": true,
        "modelPreferences": {"taskCategory": "research"},
        "toolRequirements": ["web_search", "url_reader"],
        "status": "idle"
    }'::jsonb,
    ARRAY['crypto-analysis'],
    true, 'idle', true
),
(
    'stock-intel',
    'Stock Intel',
    'Equities/market research via web search and page reading. No live market-data feed is connected; findings come from searchable public sources only.',
    '{
        "id": "stock-intel",
        "displayName": "Stock Intel",
        "description": "Equities and market research from searchable public sources.",
        "version": "0.1.0",
        "capabilities": ["stock-analysis"],
        "supportedTaskTypes": ["research"],
        "isInternal": true,
        "modelPreferences": {"taskCategory": "research"},
        "toolRequirements": ["web_search", "url_reader"],
        "status": "idle"
    }'::jsonb,
    ARRAY['stock-analysis'],
    true, 'idle', true
),
(
    'business-intel',
    'Business Intel',
    'Company and business-opportunity research via web search and page reading.',
    '{
        "id": "business-intel",
        "displayName": "Business Intel",
        "description": "Company/opportunity research from searchable public sources.",
        "version": "0.1.0",
        "capabilities": ["business-research"],
        "supportedTaskTypes": ["research"],
        "isInternal": true,
        "modelPreferences": {"taskCategory": "research"},
        "toolRequirements": ["web_search", "url_reader"],
        "status": "idle"
    }'::jsonb,
    ARRAY['business-research'],
    true, 'idle', true
),
(
    'social-media',
    'Social Media Intel',
    'Social trend/sentiment research via web search and page reading. No connected social-platform API/firehose; findings come from publicly searchable content only.',
    '{
        "id": "social-media",
        "displayName": "Social Media Intel",
        "description": "Social trend/sentiment analysis from searchable public sources.",
        "version": "0.1.0",
        "capabilities": ["social-analysis"],
        "supportedTaskTypes": ["research"],
        "isInternal": true,
        "modelPreferences": {"taskCategory": "research"},
        "toolRequirements": ["web_search", "url_reader"],
        "status": "idle"
    }'::jsonb,
    ARRAY['social-analysis'],
    true, 'idle', true
),
(
    'ai-radar',
    'AI Radar',
    'Tracks the AI model/tooling landscape via web search and page reading.',
    '{
        "id": "ai-radar",
        "displayName": "AI Radar",
        "description": "AI model/tooling landscape tracking from searchable public sources.",
        "version": "0.1.0",
        "capabilities": ["ai-landscape-tracking"],
        "supportedTaskTypes": ["research"],
        "isInternal": true,
        "modelPreferences": {"taskCategory": "research"},
        "toolRequirements": ["web_search", "url_reader"],
        "status": "idle"
    }'::jsonb,
    ARRAY['ai-landscape-tracking'],
    true, 'idle', true
),
(
    'news-intel',
    'News Intel',
    'News synthesis and relevance filtering via web search and page reading.',
    '{
        "id": "news-intel",
        "displayName": "News Intel",
        "description": "News synthesis and relevance filtering from searchable public sources.",
        "version": "0.1.0",
        "capabilities": ["news-synthesis"],
        "supportedTaskTypes": ["research"],
        "isInternal": true,
        "modelPreferences": {"taskCategory": "research"},
        "toolRequirements": ["web_search", "url_reader"],
        "status": "idle"
    }'::jsonb,
    ARRAY['news-synthesis'],
    true, 'idle', true
),
(
    'guardian',
    'Guardian',
    'Automated first policy check on tool-approval requests and evolution proposals — deterministic rule evaluation, can veto (deny/reject) but can never itself grant a requires_approval item; approval stays a strictly human action (docs/architecture/07-security-model.md §6).',
    '{
        "id": "guardian",
        "displayName": "Guardian",
        "description": "Security/policy enforcement — automated veto-only first check on tool-approval requests and evolution proposals.",
        "version": "0.1.0",
        "capabilities": ["policy-enforcement"],
        "supportedTaskTypes": ["policy-review"],
        "isInternal": true,
        "modelPreferences": {"taskCategory": "reasoning"},
        "toolRequirements": [],
        "status": "idle"
    }'::jsonb,
    ARRAY['policy-enforcement'],
    true, 'idle', true
)
ON CONFLICT (id) DO NOTHING;

-- ---- Delegation authorization (data, not code) ----
-- Master may delegate a research-shaped task to any of the six specialists,
-- exactly like it already can to Research — and may delegate a
-- policy-review task to Guardian. None of the seven may delegate onward
-- (no chained delegation, same as Research/Reviewer).

INSERT INTO agent_delegation_edges (from_agent_id, to_agent_id) VALUES
    ('master', 'crypto-intel'),
    ('master', 'stock-intel'),
    ('master', 'business-intel'),
    ('master', 'social-media'),
    ('master', 'ai-radar'),
    ('master', 'news-intel'),
    ('master', 'guardian')
ON CONFLICT DO NOTHING;

-- ---- Tool grants — identical safe set Research already has (M4.9) ----

INSERT INTO agent_tool_grants (agent_id, tool_id, permission_level)
SELECT specialist, tool_id, permission_level
FROM (VALUES ('crypto-intel'), ('stock-intel'), ('business-intel'), ('social-media'), ('ai-radar'), ('news-intel')) AS s(specialist)
CROSS JOIN (VALUES
    ('web_search', 'allowed'),
    ('url_reader', 'allowed'),
    ('file_reader', 'allowed'),
    ('pdf_reader', 'allowed'),
    ('calculator', 'allowed'),
    ('time_date', 'allowed'),
    ('generic_http_get', 'restricted')
) AS t(tool_id, permission_level)
ON CONFLICT (agent_id, tool_id) DO NOTHING;

-- ---- M8: Guardian tool-approval gate — a human decision, recorded honestly ----
-- 'approved' is a new terminal state distinct from 'succeeded': it records
-- that a human explicitly approved a paused (requires_approval) tool call,
-- without claiming the call was automatically replayed/executed — this
-- codebase has no task-resumption mechanism to do that safely yet (same
-- documented boundary as A2A cancellation being best-effort). No currently
-- shipped tool sets requires_approval=true, so this path is real and
-- tested but dormant until a future higher-risk tool needs it.

ALTER TABLE tool_invocations DROP CONSTRAINT tool_invocations_status_check;
ALTER TABLE tool_invocations ADD CONSTRAINT tool_invocations_status_check
    CHECK (status IN ('running', 'succeeded', 'failed', 'timeout', 'blocked', 'awaiting_approval', 'denied', 'approved'));

-- ---- M8: remaining bots (docs/architecture/09-roadmap.md M8) ----
-- Same deterministic SearchProvider-based pattern as News Monitor (M5.9) —
-- no live price/order-book/on-chain/social-firehose data source exists in
-- this codebase, so "market scanning"/"liquidity"/"volume anomaly"/"social
-- trend" detection here means searchable-news-based signal detection,
-- disclosed honestly in each bot's description, never fabricated live
-- market data.

ALTER TABLE bots DROP CONSTRAINT bots_category_check;
ALTER TABLE bots ADD CONSTRAINT bots_category_check
    CHECK (category IN ('ai_release', 'news', 'user_topic', 'system_health', 'market', 'social', 'business', 'general'));

INSERT INTO bots (id, display_name, description, schedule_cron, config, category, capabilities, timeout_ms, owner) VALUES
(
    'market-scanner', 'Market Scanner',
    'Scans configured crypto/equity market topics via the existing SearchProvider abstraction for notable news-driven signals (listings, delistings, major moves reported in the press). Not a live price feed — searchable news only, disclosed honestly.',
    '*/30 * * * *', '{"topics": ["crypto market", "stock market news", "new token listing", "IPO announcement"]}'::jsonb, 'market', ARRAY['research'], 30000, 'system'
),
(
    'liquidity-monitor', 'Liquidity Monitor',
    'Searches for reported liquidity events (exchange liquidity crises, large withdrawals, depegs) via the existing SearchProvider abstraction. No live order-book/on-chain liquidity data is connected — this is news-based signal detection only.',
    '*/30 * * * *', '{"topics": ["exchange liquidity crisis", "stablecoin depeg", "bank run crypto"]}'::jsonb, 'market', ARRAY['research'], 30000, 'system'
),
(
    'volume-anomaly-monitor', 'Volume Anomaly Monitor',
    'Searches for reported unusual trading volume/activity via the existing SearchProvider abstraction. No live tick/volume data feed is connected — this is news-based signal detection only.',
    '*/30 * * * *', '{"topics": ["unusual trading volume", "trading halt", "circuit breaker triggered"]}'::jsonb, 'market', ARRAY['research'], 30000, 'system'
),
(
    'social-trend-monitor', 'Social Trend Monitor',
    'Tracks configured social/cultural trend topics via the existing SearchProvider abstraction. No connected social-platform API/firehose — searchable public content only.',
    '*/30 * * * *', '{"topics": ["viral trend", "social media backlash", "influencer controversy"]}'::jsonb, 'social', ARRAY['research'], 30000, 'system'
),
(
    'business-opportunity-monitor', 'Business Opportunity Monitor',
    'Tracks configured business-opportunity topics (funding rounds, acquisitions, partnerships, market gaps) via the existing SearchProvider abstraction.',
    '*/30 * * * *', '{"topics": ["startup funding round", "company acquisition", "new market entrant"]}'::jsonb, 'business', ARRAY['research'], 30000, 'system'
)
ON CONFLICT (id) DO NOTHING;
