/**
 * Canonical event bus schema. Every event that crosses the bus is one of
 * these, wrapped in `EventEnvelope`. This union is the single contract
 * shared by: the backend event bus (`core/events`), the `events` DB table,
 * the WS gateway that streams to the mobile app, and the 3D Command Center
 * renderer. Nothing renders in the Command Center that isn't one of these.
 */

export type EventSourceType = "agent" | "bot" | "tool" | "model" | "automation" | "system";
export type EventSeverity = "debug" | "info" | "warn" | "error";

export interface EventEnvelope<T extends EventPayload = EventPayload> {
  id: number;
  type: T["type"];
  sourceType: EventSourceType;
  sourceId: string;
  taskId?: string;
  severity: EventSeverity;
  payload: T;
  createdAt: string;
}

// ---- agent.* -----------------------------------------------------------

export interface AgentStartedEvent {
  type: "agent.started";
  agentId: string;
}
export interface AgentIdleEvent {
  type: "agent.idle";
  agentId: string;
}
export interface AgentTaskCreatedEvent {
  type: "agent.task.created";
  agentId: string;
  taskId: string;
  taskType: string;
  parentTaskId?: string;
}
export interface AgentTaskStartedEvent {
  type: "agent.task.started";
  agentId: string;
  taskId: string;
  modelId?: string;
}
export interface AgentTaskCompletedEvent {
  type: "agent.task.completed";
  agentId: string;
  taskId: string;
  durationMs: number;
}
export interface AgentFailedEvent {
  type: "agent.failed";
  agentId: string;
  taskId?: string;
  errorCode: string;
  message: string;
}
export interface AgentRecoveredEvent {
  type: "agent.recovered";
  agentId: string;
}
/** Generic agent lifecycle completion (M3) — distinct from `agent.task.completed`, which is Master's chat-specific event; every agent (Research, Reviewer, future specialists) emits this around `handleTask`. */
export interface AgentCompletedEvent {
  type: "agent.completed";
  agentId: string;
  taskId: string;
  durationMs: number;
}
export interface AgentMessageSentEvent {
  type: "agent.message.sent";
  fromAgentId: string;
  toAgentId: string;
  taskId: string;
}
export interface AgentMessageReceivedEvent {
  type: "agent.message.received";
  toAgentId: string;
  fromAgentId: string;
  taskId: string;
}

// ---- task.* (M3 — generic A2A task lifecycle, any agent) -------------------

export interface TaskCreatedEvent {
  type: "task.created";
  taskId: string;
  assignedAgentId: string;
  taskType: string;
  parentTaskId?: string;
  correlationId?: string;
}
export interface TaskStartedEvent {
  type: "task.started";
  taskId: string;
  assignedAgentId: string;
}
export interface TaskCompletedEvent {
  type: "task.completed";
  taskId: string;
  assignedAgentId: string;
  durationMs: number;
}
export interface TaskFailedEvent {
  type: "task.failed";
  taskId: string;
  assignedAgentId: string;
  errorCode: string;
  message: string;
  retryable: boolean;
}
export interface TaskCancelledEvent {
  type: "task.cancelled";
  taskId: string;
  reason?: string;
}

// ---- message.* (M3 — generic inter-agent messages) --------------------------

export interface MessageSentEvent {
  type: "message.sent";
  taskId: string;
  fromAgentId: string;
  toAgentId: string;
}
export interface MessageReceivedEvent {
  type: "message.received";
  taskId: string;
  fromAgentId: string;
  toAgentId: string;
}

// ---- review.* (M3 — Reviewer lifecycle) --------------------------------------

export interface ReviewStartedEvent {
  type: "review.started";
  taskId: string;
  targetTaskId: string;
}
export interface ReviewCompletedEvent {
  type: "review.completed";
  taskId: string;
  targetTaskId: string;
  decision: "APPROVE" | "REVISE" | "REJECT";
}

// ---- memory.* (M3) -----------------------------------------------------------

export interface MemoryCreatedEvent {
  type: "memory.created";
  memoryId: string;
  category: string;
  approvalStatus: "approved" | "pending" | "rejected";
}
export interface MemoryRetrievedEvent {
  type: "memory.retrieved";
  taskId: string;
  /** Count and ids only — never retrieved content, per docs/architecture/07-security-model.md. */
  count: number;
  memoryIds: string[];
}

// ---- tool.* (M4 — MCP execution layer lifecycle) ---------------------------

/** The MCP host found `toolId` in the Tool Registry for this request. */
export interface ToolDiscoveredEvent {
  type: "tool.discovered";
  toolId: string;
  agentId: string;
  taskId?: string;
}
/** The host has decided to actually execute this tool (post-lookup, pre-permission-check). */
export interface ToolSelectedEvent {
  type: "tool.selected";
  toolId: string;
  agentId: string;
  taskId?: string;
  invocationId: string;
}
export interface ToolPermissionCheckedEvent {
  type: "tool.permission.checked";
  toolId: string;
  agentId: string;
  /** Set only once an invocation row exists (i.e. the check passed) — a denial has no invocation to reference. */
  invocationId?: string;
  accessLevel: "allowed" | "restricted" | "denied";
}
export interface ToolCalledEvent {
  type: "tool.called";
  toolId: string;
  agentId: string;
  taskId?: string;
  invocationId: string;
}
export interface ToolCompletedEvent {
  type: "tool.completed";
  toolId: string;
  invocationId: string;
  status: "succeeded" | "failed" | "denied";
  latencyMs: number;
}
export interface ToolFailedEvent {
  type: "tool.failed";
  toolId: string;
  invocationId: string;
  errorCode: string;
  latencyMs: number;
}
export interface ToolTimeoutEvent {
  type: "tool.timeout";
  toolId: string;
  invocationId: string;
  timeoutMs: number;
}
/** Permission denial or a security guard (SSRF, size limit) refused the call before/during execution. */
export interface ToolBlockedEvent {
  type: "tool.blocked";
  toolId: string;
  agentId: string;
  invocationId?: string;
  reason: string;
}
/** M9: a human approved a paused (`awaiting_approval`) tool_invocation and the MCP host is now actually replaying it — distinct from a fresh `tool.called` so the Command Center/audit trail can show "approved & resumed" rather than a brand-new call. */
export interface ToolResumedEvent {
  type: "tool.resumed";
  toolId: string;
  agentId: string;
  invocationId: string;
}

// ---- model.* ---------------------------------------------------------------

export interface ModelSelectedEvent {
  type: "model.selected";
  modelId: string;
  taskId: string;
  reason: string; // e.g. "capability_match", "user_default", "fallback"
}
export interface ModelSwitchedEvent {
  type: "model.switched";
  taskId: string;
  fromModelId: string;
  toModelId: string;
  reason: string; // e.g. "provider_error", "rate_limited", "latency_threshold"
}

// ---- bot.* (M5.15 — Bot Command Center events, metadata-only) --------------

/** Emitted once at boot when a `BotDefinition` implementation is registered (mirrors `AgentStartedEvent`). */
export interface BotRegisteredEvent {
  type: "bot.registered";
  botId: string;
}
/** The bot has become active — engine is about to dispatch a run for it. */
export interface BotStartedEvent {
  type: "bot.started";
  botId: string;
}
export interface BotRunStartedEvent {
  type: "bot.run.started";
  botId: string;
  botRunId: string;
}
export interface BotRunCompletedEvent {
  type: "bot.run.completed";
  botId: string;
  botRunId: string;
  status: "succeeded" | "failed" | "timeout" | "cancelled";
  durationMs: number;
  findingsCount: number;
}
export interface BotFailedEvent {
  type: "bot.failed";
  botId: string;
  botRunId?: string;
  errorCode: string;
  message: string;
}
export interface BotPausedEvent {
  type: "bot.paused";
  botId: string;
}
export interface BotResumedEvent {
  type: "bot.resumed";
  botId: string;
}
export interface BotFindingCreatedEvent {
  type: "bot.finding.created";
  botId: string;
  botRunId: string;
  findingId: string;
  category: string;
  importance: "low" | "medium" | "high" | "critical";
}
/** A repeat detection collapsed into an existing finding (same `(botId, dedupKey)`) instead of creating a new one — M5.5, prevents a 12-hour-visible release from producing 12 notifications. */
export interface BotFindingDeduplicatedEvent {
  type: "bot.finding.deduplicated";
  botId: string;
  findingId: string;
  occurrenceCount: number;
}
export interface BotFindingEscalatedEvent {
  type: "bot.finding.escalated";
  botId: string;
  findingId: string;
  routedTaskId: string;
}
export interface BotNotificationSentEvent {
  type: "bot.notification.sent";
  findingId?: string;
  notificationId: string;
}
export interface BotNotificationFailedEvent {
  type: "bot.notification.failed";
  findingId?: string;
  notificationId: string;
  error: string;
}

// ---- automation.* ----------------------------------------------------------

export interface AutomationTriggeredEvent {
  type: "automation.triggered";
  automationId: string;
  automationRunId: string;
  triggerType: "schedule" | "event" | "webhook" | "manual";
}

// ---- evolution.* (M9 — Evolution Engine sweeps + proposal lifecycle) ------

/** A discovery+benchmarking sweep began — `sweepId` is a run-scoped correlation id, not a persisted row (sweeps aren't modeled as their own table; their output is `evolution_proposals` rows). */
export interface EvolutionSweepStartedEvent {
  type: "evolution.sweep.started";
  sweepId: string;
}
export interface EvolutionSweepCompletedEvent {
  type: "evolution.sweep.completed";
  sweepId: string;
  proposalsCreated: number;
  proposalsApplied: number;
  proposalsDenied: number;
  durationMs: number;
}
export interface EvolutionProposalCreatedEvent {
  type: "evolution.proposal.created";
  proposalId: string;
  changeClass: string;
  riskLevel: "low" | "medium" | "high";
  requiresApproval: boolean;
}
/** The producer's own proposal auto-applied (never a human action) — see `applyEvolutionProposal`; only reachable for change classes with a real applier and `requiresApproval: false`. */
export interface EvolutionProposalAppliedEvent {
  type: "evolution.proposal.applied";
  proposalId: string;
  changeClass: string;
  appliedBy: "system" | "user";
}
/** A human explicitly approved a `requires_approval` proposal via `POST /evolution/proposals/:id/approve` — Guardian and the sweep producer can never emit this themselves. */
export interface EvolutionProposalApprovedEvent {
  type: "evolution.proposal.approved";
  proposalId: string;
  changeClass: string;
}
export interface EvolutionProposalRejectedEvent {
  type: "evolution.proposal.rejected";
  proposalId: string;
  changeClass: string;
  decidedBy: "user" | "auto";
}

export type EventPayload =
  | AgentStartedEvent
  | AgentIdleEvent
  | AgentTaskCreatedEvent
  | AgentTaskStartedEvent
  | AgentTaskCompletedEvent
  | AgentFailedEvent
  | AgentRecoveredEvent
  | AgentCompletedEvent
  | AgentMessageSentEvent
  | AgentMessageReceivedEvent
  | TaskCreatedEvent
  | TaskStartedEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | TaskCancelledEvent
  | MessageSentEvent
  | MessageReceivedEvent
  | ReviewStartedEvent
  | ReviewCompletedEvent
  | MemoryCreatedEvent
  | MemoryRetrievedEvent
  | ToolDiscoveredEvent
  | ToolSelectedEvent
  | ToolPermissionCheckedEvent
  | ToolCalledEvent
  | ToolCompletedEvent
  | ToolFailedEvent
  | ToolTimeoutEvent
  | ToolBlockedEvent
  | ToolResumedEvent
  | ModelSelectedEvent
  | ModelSwitchedEvent
  | BotRegisteredEvent
  | BotStartedEvent
  | BotRunStartedEvent
  | BotRunCompletedEvent
  | BotFailedEvent
  | BotPausedEvent
  | BotResumedEvent
  | BotFindingCreatedEvent
  | BotFindingDeduplicatedEvent
  | BotFindingEscalatedEvent
  | BotNotificationSentEvent
  | BotNotificationFailedEvent
  | AutomationTriggeredEvent
  | EvolutionSweepStartedEvent
  | EvolutionSweepCompletedEvent
  | EvolutionProposalCreatedEvent
  | EvolutionProposalAppliedEvent
  | EvolutionProposalApprovedEvent
  | EvolutionProposalRejectedEvent;

export type EventType = EventPayload["type"];
