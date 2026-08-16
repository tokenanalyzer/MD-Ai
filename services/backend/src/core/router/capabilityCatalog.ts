import type { ModelCapabilities } from "@mdai/shared-types";

/**
 * Hand-curated capability data for models MD AI ships defaults for
 * (docs/architecture/06-provider-model-interfaces.md §3). This exists
 * because provider `listModels()` calls return an id and little else —
 * vendors' `/models` endpoints don't reliably self-describe tool/vision/
 * reasoning/structured-output support. Per the M2 instruction "do not
 * assume capabilities merely from model names," this is the one place
 * capability claims are allowed to originate; anything discovered that
 * isn't in this catalog gets conservative `false`/unknown defaults
 * instead of a guess (see `discovery.ts`).
 *
 * Values are best-effort from public vendor documentation as of this
 * writing, not live-verified per request. Correcting or extending this
 * catalog is how "provider adapters update model metadata safely" per
 * the M2 instruction — it is a data change here, never router logic.
 */
export const KNOWN_MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  "nvidia-nemotron/nvidia/llama-3.1-nemotron-70b-instruct": {
    contextLength: 128_000,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    modality: "text",
    tags: ["reasoning", "tool-calling"],
  },
  "nvidia-nemotron/nvidia/nemotron-3-super-120b-a12b": {
    contextLength: 128_000,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    modality: "text",
    tags: ["reasoning", "tool-calling"],
  },
  "gemini/gemini-1.5-flash": {
    contextLength: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: false,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    modality: "multimodal",
    tags: ["fast", "long-context", "vision"],
  },
  "gemini/gemini-2.5-flash": {
    contextLength: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    modality: "multimodal",
    tags: ["fast", "long-context", "vision", "reasoning"],
  },
  "gemini/gemini-3.5-flash": {
    contextLength: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    modality: "multimodal",
    tags: ["fast", "long-context", "vision", "reasoning"],
  },
  "groq/llama-3.3-70b-versatile": {
    contextLength: 128_000,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    modality: "text",
    tags: ["fast"],
  },
  "groq/openai/gpt-oss-120b": {
    contextLength: 131_072,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    modality: "text",
    tags: ["fast", "reasoning", "tool-calling"],
  },
  "sambanova/Meta-Llama-3.1-70B-Instruct": {
    contextLength: 128_000,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    modality: "text",
    tags: [],
  },
  "sambanova/Meta-Llama-3.3-70B-Instruct": {
    contextLength: 131_072,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    modality: "text",
    tags: ["fast"],
  },
  "openrouter/meta-llama/llama-3.1-70b-instruct": {
    contextLength: 128_000,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    modality: "text",
    tags: [],
  },
  "openrouter/meta-llama/llama-3.3-70b-instruct": {
    contextLength: 131_072,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    modality: "text",
    tags: ["fast"],
  },
};

export const UNKNOWN_MODEL_CAPABILITIES: ModelCapabilities = {
  contextLength: 0,
  supportsTools: false,
  supportsVision: false,
  supportsReasoning: false,
  supportsStreaming: true,
  supportsStructuredOutput: false,
  modality: "text",
  tags: ["unverified"],
};

export function lookupCapabilities(registryModelId: string): ModelCapabilities {
  return KNOWN_MODEL_CAPABILITIES[registryModelId] ?? UNKNOWN_MODEL_CAPABILITIES;
}
