import type { AgentCard, Task, TaskMessage, TaskStreamChunk } from "../a2a/index.js";

export type AgentStatus = "idle" | "active" | "error" | "disabled";

export interface AgentRuntimeContext {
  task: Task;
  history: TaskMessage[];
  /** Emits a streaming chunk to the API layer's WS gateway. */
  emit(chunk: TaskStreamChunk): void;
  /** Requests the Model Router to pick a model for a sub-step of this task. */
  selectModel(criteria: {
    taskType: string;
    requiredCapabilities?: string[];
  }): Promise<{ modelId: string }>;
  /** Invokes an approved tool through the MCP host (never calls a tool directly). */
  callTool(toolId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Delegates a sub-task to another agent via the A2A layer. */
  delegate(toAgentId: string, input: Record<string, unknown>, taskType: string): Promise<Task>;
}

/**
 * Every agent — Master or specialist, built-in or future addition —
 * implements this. The Agent Registry only needs `card` + `handleTask` to
 * make an agent discoverable and dispatchable; everything else in the
 * system (router, delegation, event bus) depends on this interface, never
 * on a specific agent's internals.
 */
export interface Agent {
  card: AgentCard;
  handleTask(ctx: AgentRuntimeContext): Promise<void>;
  /** Optional: called when a CancelTaskRequest targets a task this agent owns. */
  onCancel?(taskId: string): Promise<void>;
  /** Cheap self-check used by observability; must not make paid model calls. */
  healthCheck(): Promise<{ healthy: boolean; detail?: string }>;
}

export interface AgentRegistry {
  list(): Promise<AgentCard[]>;
  get(agentId: string): Promise<Agent | undefined>;
  register(agent: Agent): void;
  setEnabled(agentId: string, enabled: boolean): Promise<void>;
  /** Reads the `agent_delegation_edges` table — never a hard-coded map. */
  getDelegationOptions(agentId: string): Promise<AgentCard[]>;
}

export * from "../a2a/index.js";
export * from "../mcp/index.js";
