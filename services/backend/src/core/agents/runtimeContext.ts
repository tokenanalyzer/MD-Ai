import type pg from "pg";
import type {
  AgentRegistry,
  AgentRuntimeContext,
  ChatMessage,
  EventPayload,
  EventSeverity,
  ModelRegistry,
  RoutingMode,
  Task,
  TaskCategory,
} from "@mdai/shared-types";
import type { EventBus } from "../events/eventBus.js";
import type { ToolRegistryService } from "../mcp/toolRegistryService.js";
import { addTaskMessage, createTask, getTask, listTaskMessages, updateTaskState, type TaskRow } from "../../db/repositories/taskRepo.js";
import { resolveRoutingDecision } from "../router/resolveRoutingDecision.js";
import { completeChatOnce } from "../router/completeChat.js";
import { streamChatWithFallback } from "../router/modelRouter.js";
import { publishChunk } from "../../api/ws/chatStreamHub.js";
import { invokeTool } from "../mcp/mcpHost.js";
import { DelegationNotAuthorizedError, AgentUnavailableError, TaskCanceledError } from "./errors.js";
import { toSharedTask, toSharedTaskMessage } from "./mappers.js";

export interface BackendAgentRuntimeContext extends AgentRuntimeContext {
  /** Marks this context's task completed with a structured result. Every agent must call exactly one of finishSuccess/finishFailure before handleTask returns. */
  finishSuccess(output: Record<string, unknown>, modelId?: string): Promise<void>;
  finishFailure(error: { code: string; message: string; retryable: boolean }): Promise<void>;
  /** Publishes an arbitrary typed event on this task (e.g. review.started) — for events beyond the generic task/agent lifecycle finishSuccess/finishFailure already emit. */
  publishEvent(payload: EventPayload, severity?: EventSeverity): Promise<void>;
  /**
   * Streams a final, user-facing answer token-by-token to the root task's
   * WS subscribers (unlike `completeChat`, which drains silently — this is
   * for Master's synthesis step only). Honors the caller's actual routing
   * preference (AUTO/MANUAL, preferred provider/model); internal agent
   * calls (classification, Research, Reviewer) always go through
   * `completeChat` in plain AUTO mode instead.
   */
  streamChat(input: {
    messages: ChatMessage[];
    taskCategory?: TaskCategory;
    preferredProviderId?: string;
    preferredModelId?: string;
    routingMode?: RoutingMode;
  }): Promise<{ text: string; modelId: string; providerId: string }>;
  /** Appends the agent's reply onto this task's message thread, so later turns' conversation history include it. */
  addAssistantMessage(text: string): Promise<void>;
  /** Marks this context's task canceled (best-effort — see `TaskCanceledError`) and publishes `task.cancelled`. */
  finishCanceled(reason?: string): Promise<void>;
  /**
   * Transitions this context's task `submitted` → `working` and publishes
   * `task.started`/`agent.started` — for a **root** task only (a task
   * dispatched directly, not via `delegate()`, which already does this on
   * a child's behalf before invoking its `handleTask`). Calling this from
   * a delegated agent's `handleTask` would double-publish; only Master's
   * top-level entry point calls it.
   */
  start(): Promise<void>;
}

export interface RuntimeContextDeps {
  pool: pg.Pool;
  eventBus: EventBus;
  modelRegistry: ModelRegistry;
  agentRegistry: AgentRegistry;
  toolRegistry: ToolRegistryService;
  providerKeys: Record<string, string>;
  /** Transient, request-scoped tool credentials (e.g. a search provider key) — travels exactly like `providerKeys`, never persisted. */
  toolKeys: Record<string, string>;
  /** The task id the mobile client's WS is actually subscribed to — every emit()/agent_progress chunk in this delegation tree routes here. */
  rootTaskId: string;
  /** Best-effort cancellation check, consulted between streamed chunks. Defaults to "never canceled" when omitted. */
  isCanceled?: () => boolean;
}

function durationMs(row: TaskRow): number {
  return Date.now() - row.created_at.getTime();
}

export async function buildRuntimeContext(
  deps: RuntimeContextDeps,
  taskRow: TaskRow,
  agentId: string,
): Promise<BackendAgentRuntimeContext> {
  const history = (await listTaskMessages(deps.pool, taskRow.id)).map(toSharedTaskMessage);

  const ctx: BackendAgentRuntimeContext = {
    task: toSharedTask(taskRow),
    history,

    emit(chunk) {
      publishChunk(deps.rootTaskId, chunk);
    },

    async selectModel(criteria) {
      const decision = await resolveRoutingDecision(deps.pool, deps.modelRegistry, {
        taskType: criteria.taskType,
        taskCategory: criteria.taskCategory as TaskCategory | undefined,
        availableProviderIds: Object.keys(deps.providerKeys),
      });
      return { modelId: decision.modelId, providerId: decision.providerId };
    },

    async completeChat(input) {
      return completeChatOnce(
        deps.pool,
        deps.modelRegistry,
        deps.providerKeys,
        {
          taskType: taskRow.task_type,
          taskCategory: input.taskCategory as TaskCategory | undefined,
          preferredModelId: input.preferredModelId,
          availableProviderIds: Object.keys(deps.providerKeys),
        },
        input.messages,
      );
    },

    async callTool(toolId, input) {
      return invokeTool(
        { pool: deps.pool, eventBus: deps.eventBus, toolRegistry: deps.toolRegistry },
        { toolId, agentId, taskId: taskRow.id, input, toolKeys: deps.toolKeys },
      );
    },

    async streamChat(input) {
      const decision = await resolveRoutingDecision(deps.pool, deps.modelRegistry, {
        taskType: taskRow.task_type,
        taskCategory: input.taskCategory,
        availableProviderIds: Object.keys(deps.providerKeys),
        preferredProviderId: input.preferredProviderId,
        preferredModelId: input.preferredModelId,
        routingMode: input.routingMode ?? "auto",
      });
      await deps.eventBus.publish({
        sourceType: "model",
        sourceId: decision.modelId,
        taskId: taskRow.id,
        payload: { type: "model.selected", modelId: decision.modelId, taskId: taskRow.id, reason: decision.reason },
      });

      let text = "";
      let modelId = decision.modelId;
      let providerId = decision.providerId;
      const stream = streamChatWithFallback({
        decision,
        providerKeys: deps.providerKeys,
        messages: input.messages,
        onModelSwitched: (from, to, reason) => {
          void deps.eventBus.publish({
            sourceType: "model",
            sourceId: to,
            taskId: taskRow.id,
            severity: "warn",
            payload: { type: "model.switched", taskId: taskRow.id, fromModelId: from, toModelId: to, reason },
          });
        },
        onCallSample: (sample) => {
          void deps.modelRegistry.recordCallSample({
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
        modelId = chunk.modelId;
        providerId = chunk.providerId;
        if (chunk.delta) {
          text += chunk.delta;
          ctx.emit({ taskId: deps.rootTaskId, kind: "token", delta: chunk.delta });
        }
        if (deps.isCanceled?.()) throw new TaskCanceledError(deps.rootTaskId);
      }
      return { text, modelId, providerId };
    },

    async addAssistantMessage(text) {
      await addTaskMessage(deps.pool, {
        taskId: taskRow.id,
        role: "agent",
        fromAgentId: agentId,
        parts: [{ type: "text", text }],
      });
    },

    async start() {
      await updateTaskState(deps.pool, taskRow.id, { state: "working", startedAt: true });
      await deps.eventBus.publish({
        sourceType: "agent",
        sourceId: agentId,
        taskId: taskRow.id,
        payload: { type: "task.started", taskId: taskRow.id, assignedAgentId: agentId },
      });
      await deps.eventBus.publish({
        sourceType: "agent",
        sourceId: agentId,
        taskId: taskRow.id,
        payload: { type: "agent.started", agentId },
      });
    },

    async finishCanceled(reason) {
      await updateTaskState(deps.pool, taskRow.id, { state: "canceled", completedAt: true });
      await deps.eventBus.publish({
        sourceType: "agent",
        sourceId: agentId,
        taskId: taskRow.id,
        payload: { type: "task.cancelled", taskId: taskRow.id, reason },
      });
    },

    async delegate(toAgentId, input, taskType): Promise<Task> {
      const authorized = await deps.agentRegistry.isDelegationAuthorized(agentId, toAgentId);
      if (!authorized) throw new DelegationNotAuthorizedError(agentId, toAgentId);

      const targetAgent = await deps.agentRegistry.get(toAgentId);
      if (!targetAgent) throw new AgentUnavailableError(toAgentId);

      const childRow = await createTask(deps.pool, {
        conversationId: taskRow.conversation_id ?? undefined,
        parentTaskId: taskRow.id,
        correlationId: taskRow.correlation_id ?? taskRow.id,
        createdByAgent: agentId,
        assignedAgentId: toAgentId,
        taskType,
        inputPayload: input,
      });

      await deps.eventBus.publish({
        sourceType: "agent",
        sourceId: agentId,
        taskId: childRow.id,
        payload: {
          type: "task.created",
          taskId: childRow.id,
          assignedAgentId: toAgentId,
          taskType,
          parentTaskId: taskRow.id,
          correlationId: childRow.correlation_id ?? undefined,
        },
      });
      await deps.eventBus.publish({
        sourceType: "agent",
        sourceId: agentId,
        taskId: childRow.id,
        payload: { type: "message.sent", taskId: childRow.id, fromAgentId: agentId, toAgentId },
      });
      ctx.emit({
        taskId: deps.rootTaskId,
        kind: "agent_progress",
        label: `${targetAgent.card.displayName} working…`,
      });

      const workingRow = await updateTaskState(deps.pool, childRow.id, { state: "working", startedAt: true });
      await deps.eventBus.publish({
        sourceType: "agent",
        sourceId: toAgentId,
        taskId: childRow.id,
        payload: { type: "task.started", taskId: childRow.id, assignedAgentId: toAgentId },
      });
      await deps.eventBus.publish({
        sourceType: "agent",
        sourceId: toAgentId,
        taskId: childRow.id,
        payload: { type: "agent.started", agentId: toAgentId },
      });

      const childCtx = await buildRuntimeContext(deps, workingRow, toAgentId);
      try {
        await targetAgent.handleTask(childCtx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await updateTaskState(deps.pool, childRow.id, {
          state: "failed",
          error: { code: "agent_threw", message, retryable: false },
          completedAt: true,
        });
      }

      let finalRow = await getTask(deps.pool, childRow.id);
      if (!finalRow) throw new Error(`Child task ${childRow.id} disappeared`);
      if (finalRow.state === "working" || finalRow.state === "submitted") {
        // Safety net: the agent returned without calling finishSuccess/finishFailure.
        finalRow = await updateTaskState(deps.pool, childRow.id, {
          state: "failed",
          error: { code: "agent_did_not_finalize", message: "Agent returned without setting a result", retryable: false },
          completedAt: true,
        });
      }

      await deps.eventBus.publish({
        sourceType: "agent",
        sourceId: toAgentId,
        taskId: childRow.id,
        payload: { type: "message.received", taskId: childRow.id, fromAgentId: toAgentId, toAgentId: agentId },
      });

      return toSharedTask(finalRow);
    },

    async finishSuccess(output, modelId) {
      await updateTaskState(deps.pool, taskRow.id, { state: "completed", output, modelId, completedAt: true });
      const ms = durationMs(taskRow);
      await deps.eventBus.publish({
        sourceType: "agent",
        sourceId: agentId,
        taskId: taskRow.id,
        payload: { type: "task.completed", taskId: taskRow.id, assignedAgentId: agentId, durationMs: ms },
      });
      await deps.eventBus.publish({
        sourceType: "agent",
        sourceId: agentId,
        taskId: taskRow.id,
        payload: { type: "agent.completed", agentId, taskId: taskRow.id, durationMs: ms },
      });
    },

    async publishEvent(payload, severity) {
      await deps.eventBus.publish({ sourceType: "agent", sourceId: agentId, taskId: taskRow.id, severity: severity ?? "info", payload });
    },

    async finishFailure(error) {
      await updateTaskState(deps.pool, taskRow.id, { state: "failed", error, completedAt: true });
      await deps.eventBus.publish({
        sourceType: "agent",
        sourceId: agentId,
        taskId: taskRow.id,
        severity: "error",
        payload: { type: "task.failed", taskId: taskRow.id, assignedAgentId: agentId, errorCode: error.code, message: error.message, retryable: error.retryable },
      });
      await deps.eventBus.publish({
        sourceType: "agent",
        sourceId: agentId,
        taskId: taskRow.id,
        severity: "error",
        payload: { type: "agent.failed", agentId, taskId: taskRow.id, errorCode: error.code, message: error.message },
      });
    },
  };

  return ctx;
}
