-- MD AI — 0017: backfill capability data for the M1-seeded default models
-- Mirrors core/router/capabilityCatalog.ts's KNOWN_MODEL_CAPABILITIES —
-- keep these in sync if that catalog changes for these five ids.

UPDATE model_registry SET
    context_length = 128000, supports_tools = true, supports_vision = false,
    supports_reasoning = true, supports_streaming = true, supports_structured_output = true,
    modality = 'text', capability_tags = ARRAY['reasoning', 'tool-calling']
WHERE id = 'nvidia-nemotron/nvidia/llama-3.1-nemotron-70b-instruct';

UPDATE model_registry SET
    context_length = 1000000, supports_tools = true, supports_vision = true,
    supports_reasoning = false, supports_streaming = true, supports_structured_output = true,
    modality = 'multimodal', capability_tags = ARRAY['fast', 'long-context', 'vision']
WHERE id = 'gemini/gemini-1.5-flash';

UPDATE model_registry SET
    context_length = 128000, supports_tools = true, supports_vision = false,
    supports_reasoning = false, supports_streaming = true, supports_structured_output = true,
    modality = 'text', capability_tags = ARRAY['fast']
WHERE id = 'groq/llama-3.3-70b-versatile';

UPDATE model_registry SET
    context_length = 128000, supports_tools = true, supports_vision = false,
    supports_reasoning = false, supports_streaming = true, supports_structured_output = true,
    modality = 'text', capability_tags = ARRAY[]::TEXT[]
WHERE id = 'sambanova/Meta-Llama-3.1-70B-Instruct';

UPDATE model_registry SET
    context_length = 128000, supports_tools = true, supports_vision = false,
    supports_reasoning = false, supports_streaming = true, supports_structured_output = true,
    modality = 'text', capability_tags = ARRAY[]::TEXT[]
WHERE id = 'openrouter/meta-llama/llama-3.1-70b-instruct';
