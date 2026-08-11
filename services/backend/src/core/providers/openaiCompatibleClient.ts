import type {
  ChatRequest,
  ChatResponseChunk,
  ConnectionTestResult,
  ModelInfo,
  ModelProvider,
} from "@mdai/shared-types";
import { ProviderCallError, isRetryableStatus } from "./errors.js";

export interface OpenAICompatibleConfig {
  id: string;
  displayName: string;
  baseUrl: string;
  chatPath?: string;
  modelsPath?: string;
  /** Most vendors use `Authorization: Bearer <key>`; override if not. */
  buildHeaders?: (apiKey: string) => Record<string, string>;
  /** Used when the caller doesn't specify a model. */
  defaultModel: string;
  /** Fixed timeout for the request-to-first-byte; the router applies its own overall timeout on top. */
  connectTimeoutMs?: number;
}

function defaultHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

async function safeErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    // Truncate defensively — provider error bodies occasionally echo request
    // fragments; never let one balloon into an oversized log line.
    return text.slice(0, 500);
  } catch {
    return "<unreadable response body>";
  }
}

/**
 * Builds a ModelProvider for any OpenAI-chat-completions-compatible vendor.
 * NVIDIA Nemotron (NIM), Groq, SambaNova, OpenRouter, and Gemini's OpenAI
 * compatibility layer all fit this shape — see core/providers/registry.ts
 * for the five configured instances. `apiKey` is a call argument, never
 * adapter state (docs/architecture/07-security-model.md §3.2).
 */
export function createOpenAICompatibleProvider(config: OpenAICompatibleConfig): ModelProvider {
  const chatPath = config.chatPath ?? "/chat/completions";
  const modelsPath = config.modelsPath ?? "/models";
  const buildHeaders = config.buildHeaders ?? defaultHeaders;

  async function listModels(apiKey: string): Promise<ModelInfo[]> {
    const res = await fetch(`${config.baseUrl}${modelsPath}`, {
      method: "GET",
      headers: buildHeaders(apiKey),
    });
    if (!res.ok) {
      throw new ProviderCallError(config.id, `${config.displayName} listModels failed: HTTP ${res.status}`, {
        status: res.status,
        retryable: isRetryableStatus(res.status),
      });
    }
    const body = (await res.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => ({
      id: `${config.id}/${m.id}`,
      providerId: config.id,
      providerModelRef: m.id,
      displayName: m.id,
      capabilities: {
        contextLength: 0,
        supportsTools: false,
        supportsVision: false,
        supportsReasoning: false,
        supportsStreaming: true,
        modality: "text",
        tags: [],
      },
    }));
  }

  async function testConnection(apiKey: string): Promise<ConnectionTestResult> {
    const start = Date.now();
    try {
      const discoveredModels = await listModels(apiKey);
      return { ok: true, latencyMs: Date.now() - start, discoveredModels };
    } catch (err) {
      if (err instanceof ProviderCallError) {
        return { ok: false, error: err.message };
      }
      return { ok: false, error: (err as Error).message };
    }
  }

  async function* chat(apiKey: string, request: ChatRequest): AsyncIterable<ChatResponseChunk> {
    const modelRef = request.modelId || config.defaultModel;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.connectTimeoutMs ?? 30_000);

    let res: Response;
    try {
      res = await fetch(`${config.baseUrl}${chatPath}`, {
        method: "POST",
        headers: { ...buildHeaders(apiKey), "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: modelRef,
          messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
          temperature: request.temperature,
          max_tokens: request.maxOutputTokens,
          stream: true,
        }),
      });
    } catch (err) {
      clearTimeout(timeout);
      const aborted = (err as Error).name === "AbortError";
      throw new ProviderCallError(
        config.id,
        aborted ? `${config.displayName} request timed out` : `${config.displayName} network error: ${(err as Error).message}`,
        { retryable: true },
      );
    }
    clearTimeout(timeout);

    if (!res.ok || !res.body) {
      const errorBody = await safeErrorBody(res);
      throw new ProviderCallError(config.id, `${config.displayName} chat failed: HTTP ${res.status} ${errorBody}`, {
        status: res.status,
        retryable: isRetryableStatus(res.status),
      });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sepIdx: number;
        while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);

          for (const line of rawEvent.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") return;
            let json: {
              choices?: { delta?: { content?: string }; finish_reason?: string }[];
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            try {
              json = JSON.parse(data);
            } catch {
              continue; // tolerate stray keep-alive/comment lines
            }
            const choice = json.choices?.[0];
            const chunk: ChatResponseChunk = {};
            if (choice?.delta?.content) chunk.delta = choice.delta.content;
            if (choice?.finish_reason) {
              chunk.finishReason = choice.finish_reason as ChatResponseChunk["finishReason"];
            }
            if (json.usage) {
              chunk.usage = {
                inputTokens: json.usage.prompt_tokens ?? 0,
                outputTokens: json.usage.completion_tokens ?? 0,
              };
            }
            if (chunk.delta || chunk.finishReason || chunk.usage) yield chunk;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  return {
    id: config.id,
    displayName: config.displayName,
    listModels,
    testConnection,
    chat,
  };
}
