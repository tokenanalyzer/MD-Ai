import type { Task, TaskMessage } from "@mdai/shared-types";
import type { TaskMessageRow, TaskRow } from "../../db/repositories/taskRepo.js";

export function toSharedTask(row: TaskRow): Task {
  return {
    id: row.id,
    conversationId: row.conversation_id ?? undefined,
    parentTaskId: row.parent_task_id ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    createdByAgentId: row.created_by_agent ?? undefined,
    assignedAgentId: row.assigned_agent_id,
    taskType: row.task_type,
    state: row.state,
    input: row.input,
    output: row.output ?? undefined,
    error: row.error as unknown as Task["error"],
    modelId: row.model_id ?? undefined,
    attempt: row.attempt,
    startedAt: row.started_at?.toISOString(),
    completedAt: row.completed_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toSharedTaskMessage(row: TaskMessageRow): TaskMessage {
  return {
    id: row.id,
    taskId: row.task_id,
    role: row.role,
    fromAgentId: row.from_agent_id ?? undefined,
    parts: row.parts,
    createdAt: row.created_at.toISOString(),
  };
}
