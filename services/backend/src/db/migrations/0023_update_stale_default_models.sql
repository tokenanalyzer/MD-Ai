-- MD AI — 0023: replace stale M1-era default models for Gemini, Groq, and
-- OpenRouter with their current generation (gemini-1.5-flash,
-- llama-3.3-70b-versatile, and meta-llama/llama-3.1-70b-instruct were the
-- newest models available when M1 shipped and have since been superseded
-- — Groq has announced deprecation of llama-3.3-70b-versatile itself).
--
-- Old rows are left in place (never deleted/renamed) rather than mutated
-- in place: tasks.model_id and model_call_log reference model_registry
-- rows by id via foreign key, so any historical task/telemetry row still
-- pointing at the old id must keep resolving. Only
-- core/providers/registry.ts's PROVIDER_DEFAULT_MODELS (see that file's
-- companion code change) decides which row new requests actually use.
--
-- NVIDIA Nemotron's and SambaNova's defaults are intentionally left
-- unchanged in this migration — their current model catalogs could not be
-- independently verified against the vendors' own docs, so guessing at an
-- exact provider_model_ref risked being wrong rather than merely stale.

INSERT INTO model_registry (
    id, provider_id, provider_model_ref, display_name, discovered_by, user_enabled,
    context_length, supports_tools, supports_vision, supports_reasoning, supports_streaming,
    supports_structured_output, modality, capability_tags
) VALUES
    ('gemini/gemini-2.5-flash', 'gemini', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 'manual', true,
     1000000, true, true, true, true, true, 'multimodal', ARRAY['fast', 'long-context', 'vision', 'reasoning']),
    ('groq/openai/gpt-oss-120b', 'groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B', 'manual', true,
     131072, true, false, true, true, true, 'text', ARRAY['fast', 'reasoning', 'tool-calling']),
    ('openrouter/meta-llama/llama-3.3-70b-instruct', 'openrouter', 'meta-llama/llama-3.3-70b-instruct', 'Llama 3.3 70B Instruct (via OpenRouter)', 'manual', true,
     131072, true, false, false, true, true, 'text', ARRAY['fast'])
ON CONFLICT (id) DO NOTHING;
