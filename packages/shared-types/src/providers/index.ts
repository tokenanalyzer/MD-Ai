/**
 * Provider abstraction. Nothing outside `core/providers/<adapter>` and
 * `core/router` is allowed to import a vendor SDK directly — every call
 * into an LLM vendor goes through `ModelProvider`.
 */

export interface ModelCapabilities {
  contextLength: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  supportsStreaming: boolean;
  modality: "text" | "multimodal";
  tags: string[];
}

export interface ModelInfo {
  /** Registry id, e.g. "nvidia-nemotron/nemotron-70b-instruct" — stable, provider-prefixed. */
  id: string;
  providerId: string;
  /** The id the provider's own API expects in requests. */
  providerModelRef: string;
  displayName: string;
  capabilities: ModelCapabilities;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Present when role === "tool": which tool call this message answers. */
  toolCallId?: string;
}

export interface ToolCallRequest {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface ChatRequest {
  modelId: string;
  messages: ChatMessage[];
  tools?: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  temperature?: number;
  maxOutputTokens?: number;
}

export interface ChatResponseChunk {
  delta?: string;
  toolCalls?: ToolCallRequest[];
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter";
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  /** Models this credential can actually see, when the provider supports listing. */
  discoveredModels?: ModelInfo[];
}

/**
 * Implemented once per vendor (NVIDIA Nemotron / Gemini / Groq / SambaNova /
 * OpenRouter today). The Model Router and the Provider Vault API are the
 * only callers. `apiKey` is passed in per-call from the decrypted vault
 * value at request time — a provider adapter never persists or logs it.
 */
export interface ModelProvider {
  id: string;
  displayName: string;

  listModels(apiKey: string): Promise<ModelInfo[]>;

  testConnection(apiKey: string): Promise<ConnectionTestResult>;

  chat(apiKey: string, request: ChatRequest): AsyncIterable<ChatResponseChunk>;
}

// ---- registry & router -----------------------------------------------------

export type ModelAvailability = "available" | "degraded" | "unavailable" | "unknown";

export interface ModelRegistryEntry extends ModelInfo {
  availability: ModelAvailability;
  avgLatencyMs?: number;
  errorRatePct?: number;
  lastVerifiedAt?: string;
  userEnabled: boolean;
  userPriority: number;
  discoveredBy: "manual" | "evolution_engine";
}

export interface ModelRegistry {
  list(filter?: { providerId?: string; enabledOnly?: boolean }): Promise<ModelRegistryEntry[]>;
  get(modelId: string): Promise<ModelRegistryEntry | undefined>;
  upsert(entry: ModelRegistryEntry): Promise<void>;
  recordCallSample(sample: {
    modelId: string;
    latencyMs: number;
    success: boolean;
    errorCode?: string;
    taskType?: string;
  }): Promise<void>;
}

export interface RoutingCriteria {
  taskType: string;
  requiredCapabilities?: (keyof ModelCapabilities)[];
  /** Explicit user override; router still validates the model is enabled/available. */
  preferredModelId?: string;
  maxLatencyMs?: number;
  /**
   * Provider ids the caller actually supplied a key for on this request
   * (see ChatRequestEnvelope.providerKeys in the API layer). The router
   * never stores or looks up a credential — it can only route to a
   * provider present in this list. Required because, per the M1 API-key
   * architecture change, the backend holds no persistent credential of
   * its own to fall back on.
   */
  availableProviderIds: string[];
  preferredProviderId?: string;
}

export interface RoutingDecision {
  modelId: string;
  providerId: string;
  reason: "capability_match" | "user_default" | "user_override" | "fallback";
  /** Ordered list of alternates the router will try if this one fails mid-call. */
  fallbackChain: string[];
}

/**
 * Selects a model given task requirements, current provider/model health,
 * and `criteria.availableProviderIds` — the providers the caller actually
 * handed a key to for this request. Never picks a model whose provider id
 * isn't in that list; the router has no credential store of its own to
 * fall back on (see docs/architecture/07-security-model.md §3).
 */
export interface ModelRouter {
  selectModel(criteria: RoutingCriteria): Promise<RoutingDecision>;
}
