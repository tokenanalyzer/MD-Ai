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

// ---- tool.* --------------------------------------------------------------

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

// ---- bot.* -----------------------------------------------------------------

export interface BotStartedEvent {
  type: "bot.started";
  botId: string;
  botRunId: string;
}
export interface BotStoppedEvent {
  type: "bot.stopped";
  botId: string;
  botRunId: string;
  status: "succeeded" | "failed";
}
export interface BotAlertEvent {
  type: "bot.alert";
  botId: string;
  findingId: string;
  severity: EventSeverity;
  routedTaskId?: string;
}

// ---- automation.* ----------------------------------------------------------

export interface AutomationTriggeredEvent {
  type: "automation.triggered";
  automationId: string;
  automationRunId: string;
  triggerType: "schedule" | "event" | "webhook" | "manual";
}

export type EventPayload =
  | AgentStartedEvent
  | AgentIdleEvent
  | AgentTaskCreatedEvent
  | AgentTaskStartedEvent
  | AgentTaskCompletedEvent
  | AgentFailedEvent
  | AgentRecoveredEvent
  | AgentMessageSentEvent
  | AgentMessageReceivedEvent
  | ToolCalledEvent
  | ToolCompletedEvent
  | ModelSelectedEvent
  | ModelSwitchedEvent
  | BotStartedEvent
  | BotStoppedEvent
  | BotAlertEvent
  | AutomationTriggeredEvent;

export type EventType = EventPayload["type"];
