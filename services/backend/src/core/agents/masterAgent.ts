import type pg from "pg";
import type { ChatMessage, ModelRegistry, RoutingCriteria, RoutingMode, TaskCategory } from "@mdai/shared-types";
import type { EventBus } from "../events/eventBus.js";
import type { TaskRow } from "../../db/repositories/taskRepo.js";
import { addTaskMessage, updateTaskState } from "../../db/repositories/taskRepo.js";
import { resolveRoutingDecision } from "../router/resolveRoutingDecision.js";
import { streamChatWithFallback, type StreamedChunk } from "../router/modelRouter.js";
import { ProviderCallError } from "../providers/errors.js";

export interface RunMasterAgentChatInput {
  pool: pg.Pool;
  eventBus: EventBus;
  modelRegistry: ModelRegistry;
  task: TaskRow;
  /** Full conversation so far, oldest first, including the just-submitted user turn. */
  messages: ChatMessage[];
  providerKeys: Record<string, string>;
  preferredProviderId?: string;
  preferredModelId?: string;
  taskCategory?: TaskCategory;
  routingMode?: RoutingMode;
}

/**
 * M1 Master Agent: direct-answer only, no delegation (docs/architecture/
 * 09-roadmap.md M1; delegation lands at M3 once there's another agent to
 * delegate to). Implements the observable lifecycle every future agent
 * will share — task-state transitions plus agent/model lifecycle events — without
 * the full `Agent`/`AgentRuntimeContext` ceremony (delegate/callTool),
 * which would be dead code until M3/M4 give it something to call.
 *
 * As of M2, model selection goes through the DB-backed scoring router
 * (`resolveRoutingDecision`) instead of a fixed "first available
 * provider" — see docs/architecture/06-provider-model-interfaces.md §4.2.
 */
export async function* runMasterAgentChat(input: RunMasterAgentChatInput): AsyncGenerator<StreamedChunk> {
  const { pool, eventBus, modelRegistry, task } = input;

  await updateTaskState(pool, task.id, { state: "working", startedAt: true });
  await eventBus.publish({
    sourceType: "agent",
    sourceId: "master",
    taskId: task.id,
    payload: { type: "agent.task.started", agentId: "master", taskId: task.id },
  });

  const criteria: RoutingCriteria = {
    taskType: task.task_type,
    taskCategory: input.taskCategory,
    availableProviderIds: Object.keys(input.providerKeys),
    preferredProviderId: input.preferredProviderId,
    preferredModelId: input.preferredModelId,
    routingMode: input.routingMode ?? "auto",
  };

  let assembled = "";
  let finalModelId = "";
  let finalProviderId = "";

  try {
    const decision = await resolveRoutingDecision(pool, modelRegistry, criteria);
    finalModelId = decision.modelId;
    finalProviderId = decision.providerId;
    await eventBus.publish({
      sourceType: "model",
      sourceId: decision.modelId,
      taskId: task.id,
      payload: { type: "model.selected", modelId: decision.modelId, taskId: task.id, reason: decision.reason },
    });

    const stream = streamChatWithFallback({
      decision,
      providerKeys: input.providerKeys,
      messages: input.messages,
      onModelSwitched: (from, to, reason) => {
        void eventBus.publish({
          sourceType: "model",
          sourceId: to,
          taskId: task.id,
          severity: "warn",
          payload: { type: "model.switched", taskId: task.id, fromModelId: from, toModelId: to, reason },
        });
      },
      onCallSample: (sample) => {
        // Fire-and-forget: telemetry must never block or fail the chat
        // stream itself. No secrets/prompt content in this payload — see
        // docs/architecture/07-security-model.md §4.
        void modelRegistry.recordCallSample({
          modelId: sample.modelId,
          providerId: sample.providerId,
          latencyMs: sample.latencyMs,
          success: sample.success,
          errorCode: sample.errorCode,
          taskCategory: input.taskCategory,
          timedOut: sample.timedOut,
          usedAsFallback: sample.usedAsFallback,
          inputTokens: sample.inputTokens,
          outputTokens: sample.outputTokens,
          responseStatus: sample.responseStatus,
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
