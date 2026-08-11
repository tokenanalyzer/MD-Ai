-- MD AI — 0013: seed the built-in provider catalog
-- Matches services/backend/src/core/providers/registry.ts. Catalog rows
-- only — no secrets, no per-user state (see 0003_provider_vault.sql).

INSERT INTO providers (id, display_name, base_url, docs_url, enabled_builtin) VALUES
    ('nvidia-nemotron', 'NVIDIA Nemotron', 'https://integrate.api.nvidia.com/v1', 'https://docs.nvidia.com/nim/', true),
    ('gemini', 'Google Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', 'https://ai.google.dev/gemini-api/docs/openai', true),
    ('groq', 'Groq', 'https://api.groq.com/openai/v1', 'https://console.groq.com/docs', true),
    ('sambanova', 'SambaNova', 'https://api.sambanova.ai/v1', 'https://docs.sambanova.ai/', true),
    ('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', 'https://openrouter.ai/docs', true)
ON CONFLICT (id) DO NOTHING;
