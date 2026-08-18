import { getClientCoreConfig } from "../platform.js";
import { useSessionStore } from "../state/sessionStore.js";

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
  const baseUrl = await getClientCoreConfig().getBackendUrl();
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

export function pairDevice(input: { pairingCode: string; deviceName: string; platform: "android" | "pc" | "other" }): Promise<PairResponse> {
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

// ---- search providers --------------------------------------------------------

export interface SearchProviderDto {
  id: string;
  displayName: string;
}

export function listSearchProviders(): Promise<SearchProviderDto[]> {
  return request("/search-providers");
}

/**
 * Search-provider (Brave/Tavily) keys have no persisted config row, unlike
 * `testProviderConnection` — the caller stores the key on-device only once
 * this confirms it works (apps/mobile/src/security/secureVault.ts).
 */
export function testSearchProviderConnection(providerId: string, apiKey: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  return request(`/search-providers/${providerId}/test-connection`, { method: "POST", body: { apiKey } });
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
    /** Request-scoped tool credentials (e.g. Brave/Tavily search keys) — same non-persistence guarantee as providerKeys. */
    toolKeys?: Record<string, string>;
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
      toolKeys: input.toolKeys,
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

/** M6.4 Chat "expandable task details" — one node per task in the real delegation tree (root + descendants), each with its own real assignedAgentId/modelId/state/timestamps. */
export interface TaskTreeNodeDto {
  id: string;
  parentTaskId: string | null;
  assignedAgentId: string;
  taskType: string;
  state: "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled";
  modelId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export function getTaskTree(taskId: string): Promise<TaskTreeNodeDto[]> {
  return request(`/tasks/${taskId}/tree`);
}

// ---- bots (M5.16 — Bot Fleet screen) ------------------------------------------

export type BotStatus = "idle" | "running" | "paused" | "disabled" | "error";
export type BotHealth = "healthy" | "degraded" | "unavailable" | "unknown";
export type FindingImportance = "low" | "medium" | "high" | "critical";

export interface BotDto {
  id: string;
  displayName: string;
  description: string;
  version: string;
  category: string;
  status: BotStatus;
  scheduleCron: string;
  enabled: boolean;
  health: BotHealth;
  healthDetail?: string;
  lastRunAt?: string;
  lastSuccessfulRunAt?: string;
  failureCount: number;
}

export interface BotRunDto {
  id: string;
  botId: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status: "running" | "succeeded" | "failed" | "timeout" | "cancelled";
  error?: string;
  findingsCount: number;
}

export interface BotFindingDto {
  id: string;
  botId: string;
  category: string;
  title: string;
  summary: string;
  importance: FindingImportance;
  status: "new" | "escalated" | "notified" | "resolved" | "dismissed";
  escalationStatus: "none" | "pending" | "escalated" | "analyzed" | "failed";
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export function listBots(): Promise<BotDto[]> {
  return request("/bots");
}

export function listBotRuns(botId: string): Promise<BotRunDto[]> {
  return request(`/bots/${botId}/runs`);
}

export function listBotFindings(botId: string): Promise<BotFindingDto[]> {
  return request(`/bots/${botId}/findings`);
}

export function patchBot(botId: string, patch: { enabled?: boolean; paused?: boolean }): Promise<BotDto> {
  return request(`/bots/${botId}`, { method: "PATCH", body: patch });
}

export function runBotNow(botId: string): Promise<BotRunDto> {
  return request(`/bots/${botId}/run-now`, { method: "POST", body: {} });
}

// ---- notifications (M5.13/M5.14) ------------------------------------------

export interface NotificationDto {
  id: string;
  findingId?: string;
  title: string;
  summary: string;
  importance: FindingImportance;
  deepLink: string;
  status: "pending" | "sent" | "failed" | "suppressed";
  suppressedReason?: string;
  sentAt?: string;
  createdAt: string;
}

export interface NotificationPreferencesDto {
  enabled: boolean;
  minimumImportance: FindingImportance;
  quietHoursStartMinute?: number;
  quietHoursEndMinute?: number;
  quietHoursTimezone: string;
  mutedTopics: string[];
  mutedBotIds: string[];
  mutedCategories: string[];
}

export function listNotifications(): Promise<NotificationDto[]> {
  return request("/notifications");
}

export function getNotificationPreferences(): Promise<NotificationPreferencesDto> {
  return request("/notifications/preferences");
}

export function patchNotificationPreferences(patch: Partial<NotificationPreferencesDto>): Promise<NotificationPreferencesDto> {
  return request("/notifications/preferences", { method: "PATCH", body: patch });
}

export function registerPushToken(pushToken: string): Promise<void> {
  return request("/auth/push-token", { method: "POST", body: { pushToken } });
}

// ---- system health (M6 Command Center — System Status) --------------------

export interface HealthReportDto {
  status: "ok" | "degraded" | "error";
  timestamp: string;
  cpu: { loadavg1: number; loadavg5: number; loadavg15: number; cpuCount: number };
  memory: { processRssMb: number; systemFreeMb: number; systemTotalMb: number };
  postgres: { ok: boolean; latencyMs?: number; poolTotal: number; poolIdle: number; poolWaiting: number; error?: string };
  redis: { ok: boolean; latencyMs?: number; usedMemoryMb?: number; connectedClients?: number; error?: string };
  queues: { name: string; waiting: number; active: number; completed: number; failed: number; workerCount: number }[];
  requestLatency: Record<string, { count: number; avgMs: number; p95Ms: number }>;
}

export function getHealth(): Promise<HealthReportDto> {
  return request("/health");
}

// ---- agents (M6 Agent Center / Agent Detail) -------------------------------

export interface AgentCardDto {
  id: string;
  displayName: string;
  description: string;
  version: string;
  capabilities: string[];
  supportedTaskTypes: string[];
  isInternal: boolean;
  externalEndpoint?: string;
  status: "idle" | "working" | "error" | "disabled";
  lastHeartbeatAt?: string;
}

export function listAgents(): Promise<AgentCardDto[]> {
  return request("/agents");
}

export function setAgentEnabled(agentId: string, enabled: boolean): Promise<AgentCardDto> {
  return request(`/agents/${agentId}`, { method: "PATCH", body: { enabled } });
}

export function getAgentDelegations(agentId: string): Promise<AgentCardDto[]> {
  return request(`/agents/${agentId}/delegations`);
}

// ---- tools (M6 Tools Center) ------------------------------------------------

export interface ToolDefinitionDto {
  id: string;
  displayName: string;
  description: string;
  version: string;
  source: "builtin" | "mcp_server";
  requiredCapabilities: string[];
  riskLevel: "low" | "medium" | "high";
  requiresApproval: boolean;
  defaultAccess: "allowed" | "restricted" | "denied";
  enabled: boolean;
  health: "healthy" | "degraded" | "unavailable" | "unknown";
  healthDetail?: string;
  timeoutMs: number;
  lastVerifiedAt?: string;
  owner: string;
}

export function listTools(): Promise<ToolDefinitionDto[]> {
  return request("/tools");
}

// ---- memory (M6 Memory Center) ---------------------------------------------

export type MemoryCategory =
  | "personal_context"
  | "projects"
  | "goals"
  | "preferences"
  | "decisions"
  | "research"
  | "knowledge"
  | "conversations"
  | "agent_lessons";

export interface MemoryItemDto {
  id: string;
  category: MemoryCategory;
  content: string;
  summary?: string;
  source: string;
  confidence: number;
  importance: number;
  tags: string[];
  pinned: boolean;
  approvalStatus: "approved" | "pending" | "rejected";
  createdAt: string;
  updatedAt: string;
}

/** GET /memory/pending and /memory/rejected return raw DB rows (snake_case), not the mapped camelCase MemoryItem GET /memory returns — a pre-existing inconsistency (M3), normalized here so every Memory Center tab renders from one shape. */
interface MemoryRowWire {
  id: string;
  category: MemoryCategory;
  content: string;
  summary: string | null;
  source: string;
  confidence: string;
  importance: string;
  tags: string[];
  pinned: boolean;
  approval_status: "approved" | "pending" | "rejected";
  created_at: string;
  updated_at: string;
}

function normalizeMemoryRow(row: MemoryRowWire): MemoryItemDto {
  return {
    id: row.id,
    category: row.category,
    content: row.content,
    summary: row.summary ?? undefined,
    source: row.source,
    confidence: Number(row.confidence),
    importance: Number(row.importance),
    tags: row.tags,
    pinned: row.pinned,
    approvalStatus: row.approval_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listApprovedMemory(): Promise<MemoryItemDto[]> {
  return request<MemoryItemDto[]>("/memory");
}

export async function listPendingMemory(): Promise<MemoryItemDto[]> {
  const rows = await request<MemoryRowWire[]>("/memory/pending");
  return rows.map(normalizeMemoryRow);
}

export async function listRejectedMemory(): Promise<MemoryItemDto[]> {
  const rows = await request<MemoryRowWire[]>("/memory/rejected");
  return rows.map(normalizeMemoryRow);
}

export function createMemory(input: { category: MemoryCategory; content: string; tags?: string[]; pinned?: boolean }): Promise<MemoryItemDto> {
  return request("/memory", { method: "POST", body: input });
}

export function approveMemory(id: string): Promise<MemoryItemDto> {
  return request(`/memory/${id}/approve`, { method: "POST", body: {} });
}

export function rejectMemory(id: string): Promise<MemoryItemDto> {
  return request(`/memory/${id}/reject`, { method: "POST", body: {} });
}

export function forgetMemory(id: string): Promise<void> {
  return request(`/memory/${id}`, { method: "DELETE" });
}

// ---- events (M6 Live Event Stream) -----------------------------------------

export interface EventDto {
  id: number;
  type: string;
  sourceType: "agent" | "bot" | "tool" | "model" | "automation" | "system";
  sourceId: string;
  taskId?: string;
  severity: "debug" | "info" | "warn" | "error";
  payload: Record<string, unknown>;
  createdAt: string;
}

export function listRecentEvents(sinceId?: number, limit = 100): Promise<EventDto[]> {
  const params = new URLSearchParams();
  if (sinceId !== undefined) params.set("since", String(sinceId));
  params.set("limit", String(limit));
  return request(`/events?${params.toString()}`);
}

// ---- tool approvals (M8/M9 Guardian tool-approval gate) --------------------

export interface ToolApprovalDto {
  id: string;
  toolId: string;
  agentId: string | null;
  taskId?: string;
  input: Record<string, unknown>;
  createdAt: string;
}

export function listToolApprovals(): Promise<ToolApprovalDto[]> {
  return request("/tools/approvals");
}

/** M9: on "approved" this actually replays the paused tool call — `toolKeys` is only needed if that tool requires a fresh credential the original request's key can no longer supply. Never persisted. */
export function decideToolApproval(
  invocationId: string,
  decision: "approved" | "denied",
  toolKeys?: Record<string, string>,
): Promise<{ id: string; status: string }> {
  return request(`/tools/approvals/${invocationId}/decide`, { method: "POST", body: { decision, toolKeys } });
}

// ---- evolution proposals (M9 Evolution Engine) ------------------------------

export type EvolutionChangeClass =
  | "knowledge_update"
  | "model_registry_update"
  | "routing_policy_update"
  | "skill_update"
  | "application_code_update";

export type EvolutionProposalStatus = "proposed" | "sandbox_tested" | "approved" | "rejected" | "applied" | "rolled_back";

export interface EvolutionProposalDto {
  id: string;
  changeClass: EvolutionChangeClass;
  title: string;
  rationale: string;
  diff: Record<string, unknown>;
  riskLevel: "low" | "medium" | "high";
  requiresApproval: boolean;
  status: EvolutionProposalStatus;
  sandboxResult: Record<string, unknown> | null;
  decidedBy: "user" | "auto" | null;
  decidedAt?: string;
  appliedAt?: string;
  rolledBackAt?: string;
  createdAt: string;
}

export function listEvolutionProposals(status?: EvolutionProposalStatus): Promise<EvolutionProposalDto[]> {
  const params = status ? `?status=${status}` : "";
  return request(`/evolution/proposals${params}`);
}

export function approveEvolutionProposal(id: string): Promise<EvolutionProposalDto> {
  return request(`/evolution/proposals/${id}/approve`, { method: "POST" });
}

export function rejectEvolutionProposal(id: string): Promise<EvolutionProposalDto> {
  return request(`/evolution/proposals/${id}/reject`, { method: "POST" });
}

export interface EvolutionSweepSummaryDto {
  sweepId: string;
  proposalsCreated: number;
  proposalsApplied: number;
  proposalsDenied: number;
  durationMs: number;
}

export function triggerEvolutionSweep(): Promise<EvolutionSweepSummaryDto> {
  return request("/evolution/sweep", { method: "POST" });
}

// ---- automations (M10) -------------------------------------------------------

export type AutomationTriggerType = "schedule" | "event" | "webhook" | "manual";
export type AutomationActionType = "agent_task" | "n8n_workflow" | "notification";

export interface AutomationDto {
  id: string;
  name: string;
  description: string | null;
  triggerType: AutomationTriggerType;
  triggerConfig: Record<string, unknown>;
  actionType: AutomationActionType;
  actionConfig: Record<string, unknown>;
  enabled: boolean;
  createdBy: "user" | "master_agent";
  lastRunAt?: string;
  webhookSlug: string | null;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRunDto {
  id: string;
  automationId: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "succeeded" | "failed" | "timeout";
  result: Record<string, unknown> | null;
  error: string | null;
  triggerType: AutomationTriggerType | null;
}

export function listAutomations(): Promise<AutomationDto[]> {
  return request("/automations");
}

export function getAutomation(id: string): Promise<AutomationDto> {
  return request(`/automations/${id}`);
}

export function createAutomation(input: {
  name: string;
  description?: string;
  triggerType: AutomationTriggerType;
  triggerConfig?: Record<string, unknown>;
  actionType: AutomationActionType;
  actionConfig?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<AutomationDto & { webhookSecret?: string }> {
  return request("/automations", { method: "POST", body: input });
}

export function patchAutomation(
  id: string,
  patch: { name?: string; description?: string; triggerConfig?: Record<string, unknown>; actionConfig?: Record<string, unknown>; enabled?: boolean },
): Promise<AutomationDto> {
  return request(`/automations/${id}`, { method: "PATCH", body: patch });
}

export function deleteAutomation(id: string): Promise<void> {
  return request(`/automations/${id}`, { method: "DELETE" });
}

export function listAutomationRuns(automationId: string): Promise<AutomationRunDto[]> {
  return request(`/automations/${automationId}/runs`);
}

export function runAutomationNow(id: string): Promise<AutomationRunDto> {
  return request(`/automations/${id}/run`, { method: "POST" });
}
