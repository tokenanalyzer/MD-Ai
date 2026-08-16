-- MD AI — 0024: replace the remaining stale M1-era default models
-- (Gemini, NVIDIA Nemotron, SambaNova) now that their current-generation
-- model refs could be corroborated. gemini-2.5-flash (migration 0023) was
-- itself already superseded by gemini-3.5-flash within the same day —
-- both are kept, never mutated in place, same reasoning as 0023.

INSERT INTO model_registry (
    id, provider_id, provider_model_ref, display_name, discovered_by, user_enabled,
    context_length, supports_tools, supports_vision, supports_reasoning, supports_streaming,
    supports_structured_output, modality, capability_tags
) VALUES
    ('gemini/gemini-3.5-flash', 'gemini', 'gemini-3.5-flash', 'Gemini 3.5 Flash', 'manual', true,
     1000000, true, true, true, true, true, 'multimodal', ARRAY['fast', 'long-context', 'vision', 'reasoning']),
    ('nvidia-nemotron/nvidia/nemotron-3-super-120b-a12b', 'nvidia-nemotron', 'nvidia/nemotron-3-super-120b-a12b', 'Nemotron 3 Super 120B', 'manual', true,
     128000, true, false, true, true, true, 'text', ARRAY['reasoning', 'tool-calling']),
    ('sambanova/Meta-Llama-3.3-70B-Instruct', 'sambanova', 'Meta-Llama-3.3-70B-Instruct', 'Meta Llama 3.3 70B Instruct', 'manual', true,
     131072, true, false, false, true, true, 'text', ARRAY['fast'])
ON CONFLICT (id) DO NOTHING;
