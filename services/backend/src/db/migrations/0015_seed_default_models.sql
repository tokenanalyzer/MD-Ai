-- MD AI — 0015: seed a model_registry row per provider's M1 default model
--
-- The Model Router (docs/architecture/06-provider-model-interfaces.md §4.1)
-- falls back to a per-provider default model when a request doesn't name
-- one, computed from core/providers/registry.ts's PROVIDER_DEFAULT_MODELS.
-- `tasks.model_id` has a foreign key into model_registry, so every id the
-- router can possibly produce must exist here — this is that seed. Full
-- discovery-driven population is the Evolution Engine's job (M9); this is
-- just enough catalog to make M1's fixed defaults valid FK targets.

INSERT INTO model_registry (id, provider_id, provider_model_ref, display_name, discovered_by, user_enabled) VALUES
    ('nvidia-nemotron/nvidia/llama-3.1-nemotron-70b-instruct', 'nvidia-nemotron', 'nvidia/llama-3.1-nemotron-70b-instruct', 'Llama 3.1 Nemotron 70B Instruct', 'manual', true),
    ('gemini/gemini-1.5-flash', 'gemini', 'gemini-1.5-flash', 'Gemini 1.5 Flash', 'manual', true),
    ('groq/llama-3.3-70b-versatile', 'groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B Versatile', 'manual', true),
    ('sambanova/Meta-Llama-3.1-70B-Instruct', 'sambanova', 'Meta-Llama-3.1-70B-Instruct', 'Meta Llama 3.1 70B Instruct', 'manual', true),
    ('openrouter/meta-llama/llama-3.1-70b-instruct', 'openrouter', 'meta-llama/llama-3.1-70b-instruct', 'Llama 3.1 70B Instruct (via OpenRouter)', 'manual', true)
ON CONFLICT (id) DO NOTHING;
