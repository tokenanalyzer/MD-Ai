import type pg from "pg";
import type { ChatMessage, RoutingCriteria } from "@mdai/shared-types";
import type { EventBus } from "../events/eventBus.js";
import type { TaskRow } from "../../db/repositories/taskRepo.js";
import { addTaskMessage, updateTaskState } from "../../db/repositories/taskRepo.js";
import { streamChatWithFallback, type StreamedChunk } from "../router/modelRouter.js";
import { ProviderCallError } from "../providers/errors.js";

export interface RunMasterAgentChatInput {
  pool: pg.Pool;
  eventBus: EventBus;
  task: TaskRow;
  /** Full conversation so far, oldest first, including the just-submitted user turn. */
  messages: ChatMessage[];
  providerKeys: Record<string, string>;
  preferredProviderId?: string;
  preferredModelId?: string;
}

/**
 * M1 Master Agent: direct-answer only, no delegation (docs/architecture/
 * 09-roadmap.md M1; delegation lands at M3 once there's another agent to
 * delegate to). Implements the observable lifecycle every future agent
 * will share — task-state transitions plus agent/model lifecycle events — without
 * the full `Agent`/`AgentRuntimeContext` ceremony (delegate/callTool),
 * which would be dead code until M3/M4 give it something to call.
 */
export async function* runMasterAgentChat(input: RunMasterAgentChatInput): AsyncGenerator<StreamedChunk> {
  const { pool, eventBus, task } = input;

  await updateTaskState(pool, task.id, { state: "working", startedAt: true });
  await eventBus.publish({
    sourceType: "agent",
    sourceId: "master",
    taskId: task.id,
    payload: { type: "agent.task.started", agentId: "master", taskId: task.id },
  });

  const criteria: RoutingCriteria = {
    taskType: task.task_type,
    availableProviderIds: Object.keys(input.providerKeys),
    preferredProviderId: input.preferredProviderId,
    preferredModelId: input.preferredModelId,
  };

  let assembled = "";
  let finalModelId = "";
  let finalProviderId = "";

  try {
    const stream = streamChatWithFallback({
      criteria,
      providerKeys: input.providerKeys,
      messages: input.messages,
      onModelSelected: (decision) => {
        finalModelId = decision.modelId;
        finalProviderId = decision.providerId;
        void eventBus.publish({
          sourceType: "model",
          sourceId: decision.modelId,
          taskId: task.id,
          payload: { type: "model.selected", modelId: decision.modelId, taskId: task.id, reason: decision.reason },
        });
      },
      onModelSwitched: (from, to, reason) => {
        void eventBus.publish({
          sourceType: "model",
          sourceId: to,
          taskId: task.id,
          severity: "warn",
          payload: { type: "model.switched", taskId: task.id, fromModelId: from, toModelId: to, reason },
        });
      },
    });

    for await (const chunk of stream) {
      finalModelId = chunk.modelId;
      finalProviderId = chunk.providerId;
      if (chunk.delta) assembled += chunk.delta;
      yield chunk;
    }

    await addTaskMessage(pool, {
      taskId: task.id,
      role: "agent",
      fromAgentId: "master",
      parts: [{ type: "text", text: assembled }],
    });
    await updateTaskState(pool, task.id, {
      state: "completed",
      modelId: finalModelId,
      output: { text: assembled, providerId: finalProviderId },
      completedAt: true,
    });
    await eventBus.publish({
      sourceType: "agent",
      sourceId: "master",
      taskId: task.id,
      payload: {
        type: "agent.task.completed",
        agentId: "master",
        taskId: task.id,
        durationMs: Date.now() - task.created_at.getTime(),
      },
    });
  } catch (err) {
    const error = err as Error;
    const retryable = error instanceof ProviderCallError ? error.retryable : false;
    await updateTaskState(pool, task.id, {
      state: "failed",
      error: { code: error.name, message: error.message, retryable },
      completedAt: true,
    });
    await eventBus.publish({
      sourceType: "agent",
      sourceId: "master",
      taskId: task.id,
      severity: "error",
      payload: { type: "agent.failed", agentId: "master", taskId: task.id, errorCode: error.name, message: error.message },
    });
    throw err;
  }
}
