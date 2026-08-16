import type { ModelProvider } from "@mdai/shared-types";
import { createOpenAICompatibleProvider, type OpenAICompatibleConfig } from "./openaiCompatibleClient.js";

/**
 * Static configuration for the five providers named in
 * docs/architecture/06-provider-model-interfaces.md §2. All five expose an
 * OpenAI-compatible chat-completions surface, so each is a thin config
 * object over the shared client rather than bespoke request/response
 * mapping code — this is what "no duplicated provider logic" means in
 * practice for this vendor set.
 *
 * `defaultModel` is used only when a request doesn't specify one; the
 * Model Registry (docs/architecture/02-database-schema.md, `model_registry`
 * table) is the long-term source of per-provider model catalogs — it isn't
 * populated by discovery yet in M1 (that's the Evolution Engine, M9), so
 * these defaults keep M1 usable without it.
 */
const PROVIDER_CONFIGS: OpenAICompatibleConfig[] = [
  {
    id: "nvidia-nemotron",
    displayName: "NVIDIA Nemotron",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    defaultModel: "nvidia/llama-3.1-nemotron-70b-instruct",
  },
  {
    id: "gemini",
    displayName: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    // gemini-1.5-flash is stale (M1-era default); Gemini 2.5 Flash is the
    // current generation. See migration 0023.
    defaultModel: "gemini-2.5-flash",
  },
  {
    id: "groq",
    displayName: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    // llama-3.3-70b-versatile is deprecated on Groq (announced June 2026);
    // openai/gpt-oss-120b is Groq's own recommended replacement. See
    // migration 0023.
    defaultModel: "openai/gpt-oss-120b",
  },
  {
    id: "sambanova",
    displayName: "SambaNova",
    baseUrl: "https://api.sambanova.ai/v1",
    defaultModel: "Meta-Llama-3.1-70B-Instruct",
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    // llama-3.1-70b-instruct is stale (M1-era default); llama-3.3-70b is
    // the current generation on OpenRouter. See migration 0023.
    defaultModel: "meta-llama/llama-3.3-70b-instruct",
  },
];

export const PROVIDER_ADAPTERS: Record<string, ModelProvider> = Object.fromEntries(
  PROVIDER_CONFIGS.map((cfg) => [cfg.id, createOpenAICompatibleProvider(cfg)]),
);

export const PROVIDER_DEFAULT_MODELS: Record<string, string> = Object.fromEntries(
  PROVIDER_CONFIGS.map((cfg) => [cfg.id, cfg.defaultModel]),
);

export function getProviderAdapter(providerId: string): ModelProvider | undefined {
  return PROVIDER_ADAPTERS[providerId];
}

export const KNOWN_PROVIDER_IDS = PROVIDER_CONFIGS.map((cfg) => cfg.id);
