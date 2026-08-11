/**
 * A2A-shaped protocol types.
 *
 * These mirror the open Agent2Agent (A2A) protocol's core concepts (Agent
 * Card, Task, Message, Part) closely enough that an in-process agent here
 * could be re-hosted behind a real A2A HTTP endpoint later without changing
 * its logic — only its transport binding in `core/a2a`.
 */

export type TaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled";

export interface AgentCard {
  id: string;
  displayName: string;
  description: string;
  /** Free-form capability tags the Model Router / Master Agent can match against, e.g. "research", "vision", "crypto". */
  capabilities: string[];
  /** Task types this agent declares it can handle (used for classification/delegation). */
  supportedTaskTypes: string[];
  /** True for agents implemented inside this backend process; false for externally-hosted A2A agents. */
  isInternal: boolean;
  /** Required when isInternal is false — the remote agent's A2A endpoint. */
  externalEndpoint?: string;
  version: string;
}

export type PartType = "text" | "file" | "data";

export interface TextPart {
  type: "text";
  text: string;
}

export interface FilePart {
  type: "file";
  mimeType: string;
  /** Opaque storage reference (object storage key), never inline base64 for anything beyond a few KB. */
  uri: string;
  name?: string;
}

export interface DataPart {
  type: "data";
  /** Structured payload, e.g. a tool result or a bot finding being handed to an agent. */
  data: Record<string, unknown>;
}

export type Part = TextPart | FilePart | DataPart;

export type MessageRole = "user" | "agent" | "tool" | "system";

export interface TaskMessage {
  id: string;
  taskId: string;
  role: MessageRole;
  fromAgentId?: string;
  parts: Part[];
  createdAt: string;
}

export interface TaskError {
  code: string;
  message: string;
  /** True if the router/orchestrator should attempt fallback (different model/agent) rather than surface to the user. */
  retryable: boolean;
}

export interface Task {
  id: string;
  conversationId?: string;
  parentTaskId?: string;
  createdByAgentId?: string;
  assignedAgentId: string;
  taskType: string;
  state: TaskState;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: TaskError;
  modelId?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Streaming update emitted while a task is `working`, distinct from the
 * final `Task` record. Consumed by the API layer's WS gateway and re-emitted
 * to the mobile app as chat token deltas / Command Center task-path updates.
 */
export interface TaskStreamChunk {
  taskId: string;
  kind: "token" | "tool_call" | "status" | "message";
  delta?: string;
  toolInvocationId?: string;
  message?: TaskMessage;
  state?: TaskState;
}

/** Request to create and dispatch a new task to an agent. */
export interface CreateTaskRequest {
  conversationId?: string;
  parentTaskId?: string;
  assignedAgentId: string;
  taskType: string;
  input: Record<string, unknown>;
  /** Explicit model override; omitted lets the Model Router decide. */
  modelId?: string;
}

export interface CancelTaskRequest {
  taskId: string;
  reason?: string;
}
