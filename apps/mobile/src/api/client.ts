import { getBackendUrl } from "./backendUrl";
import { useSessionStore } from "../state/sessionStore";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** Skip the Authorization header — only /auth/pair and /auth/refresh. */
  unauthenticated?: boolean;
}

async function rawRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const baseUrl = await getBackendUrl();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!opts.unauthenticated) {
    const token = useSessionStore.getState().accessToken;
    if (token) headers["authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${baseUrl}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 204) return undefined as T;

  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: { code: string; message: string; retryable: boolean } };
  if (!res.ok) {
    const err = json.error ?? { code: "unknown_error", message: `Request failed with ${res.status}`, retryable: false };
    throw new ApiError(res.status, err.code, err.message, err.retryable);
  }
  return json.data as T;
}

/** Wraps every authenticated call with one silent access-token refresh retry on 401. */
async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  try {
    return await rawRequest<T>(path, opts);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && !opts.unauthenticated) {
      const refreshed = await useSessionStore.getState().tryRefresh();
      if (refreshed) return rawRequest<T>(path, opts);
    }
    throw err;
  }
}

// ---- auth ------------------------------------------------------------------

export interface PairResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export function pairDevice(input: { pairingCode: string; deviceName: string; platform: "android" }): Promise<PairResponse> {
  return rawRequest<PairResponse>("/auth/pair", { method: "POST", body: input, unauthenticated: true });
}

export function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  return rawRequest("/auth/refresh", { method: "POST", body: { refreshToken }, unauthenticated: true });
}

// ---- providers / vault -------------------------------------------------------

export interface ProviderDto {
  id: string;
  displayName: string;
  baseUrl: string | null;
  docsUrl: string | null;
  builtin: boolean;
}

export interface ProviderConfigDto {
  id: string;
  providerId: string;
  label: string;
  keyLast4: string | null;
  status: "unverified" | "connected" | "error" | "disabled";
  lastTestAt?: string;
  lastTestError?: string | null;
  isDefault: boolean;
  defaultModelId?: string;
}

export interface ModelCapabilitiesDto {
  contextLength: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  supportsStreaming: boolean;
  supportsStructuredOutput: boolean;
  modality: "text" | "multimodal";
  tags: string[];
}

export interface ModelRegistryEntryDto {
  id: string;
  providerId: string;
  providerModelRef: string;
  displayName: string;
  capabilities: ModelCapabilitiesDto;
  availability: "available" | "degraded" | "unavailable" | "unknown";
  avgLatencyMs?: number;
  errorRatePct?: number;
  lastVerifiedAt?: string;
  userEnabled: boolean;
  userPriority: number;
  discoveredBy: "manual" | "evolution_engine";
}

export function listProviders(): Promise<ProviderDto[]> {
  return request("/providers");
}

export function listProviderConfigs(providerId: string): Promise<ProviderConfigDto[]> {
  return request(`/providers/${providerId}/configs`);
}

export function testProviderConnection(
  providerId: string,
  apiKey: string,
): Promise<{
  result: { ok: boolean; latencyMs?: number; error?: string };
  config: ProviderConfigDto;
  discoveredModelCount: number;
}> {
  return request(`/providers/${providerId}/test-connection`, { method: "POST", body: { apiKey } });
}

export function setDefaultProviderConfig(providerId: string, configId: string): Promise<ProviderConfigDto> {
  return request(`/providers/${providerId}/configs/${configId}`, { method: "PATCH", body: { isDefault: true } });
}

export function setProviderDefaultModel(providerId: string, configId: string, modelId: string): Promise<ProviderConfigDto> {
  return request(`/providers/${providerId}/configs/${configId}/default-model`, { method: "PUT", body: { modelId } });
}

export function deleteProviderConfig(providerId: string, configId: string): Promise<void> {
  return request(`/providers/${providerId}/configs/${configId}`, { method: "DELETE" });
}

// ---- model registry (M2.1/M2.5) -----------------------------------------------

export function listModels(providerId?: string): Promise<ModelRegistryEntryDto[]> {
  const qs = providerId ? `?providerId=${encodeURIComponent(providerId)}` : "";
  return request(`/models${qs}`);
}

export function setModelUserConfig(
  modelId: string,
  patch: { userEnabled?: boolean; userPriority?: number },
): Promise<ModelRegistryEntryDto> {
  return request("/models", { method: "PATCH", body: { modelId, ...patch } });
}

// ---- conversations / chat -----------------------------------------------------

export interface TaskDto {
  id: string;
  conversationId: string;
  assignedAgentId: string;
  taskType: string;
  state: "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled";
  modelId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function createConversation(title?: string): Promise<{ id: string; title: string | null }> {
  return request("/conversations", { method: "POST", body: { title } });
}

export type TaskCategory =
  | "chat"
  | "reasoning"
  | "research"
  | "long-context"
  | "vision"
  | "tool-calling"
  | "structured-output"
  | "fast";

export type RoutingMode = "auto" | "manual";

export function sendMessage(
  conversationId: string,
  input: {
    text: string;
    providerKeys: Record<string, string>;
    preferredProviderId?: string;
    preferredModelId?: string;
    taskCategory?: TaskCategory;
    routingMode?: RoutingMode;
  },
): Promise<TaskDto> {
  return request(`/conversations/${conversationId}/messages`, {
    method: "POST",
    body: {
      parts: [{ type: "text", text: input.text }],
      providerKeys: input.providerKeys,
      preferredProviderId: input.preferredProviderId,
      preferredModelId: input.preferredModelId,
      taskCategory: input.taskCategory,
      routingMode: input.routingMode,
    },
  });
}

export function cancelTask(taskId: string): Promise<void> {
  return request(`/tasks/${taskId}/cancel`, { method: "POST", body: {} });
}
