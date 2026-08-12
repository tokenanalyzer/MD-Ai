import type pg from "pg";
import type { AgentRegistry, ModelRegistry } from "@mdai/shared-types";
import type { EventBus } from "../core/events/eventBus.js";
import { cancelTaskCascade, getTask, type TaskRow } from "../db/repositories/taskRepo.js";
import { buildRuntimeContext } from "../core/agents/runtimeContext.js";
import { publishChunk, finishTask } from "./ws/chatStreamHub.js";

export interface DispatchMasterAgentTaskInput {
  pool: pg.Pool;
  eventBus: EventBus;
  modelRegistry: ModelRegistry;
  agentRegistry: AgentRegistry;
  task: TaskRow;
  providerKeys: Record<string, string>;
}

const canceledTaskIds = new Set<string>();

/**
 * Marks a task canceled. Cancellation is best-effort: it stops the chunk
 * stream reaching the client and, once Master's `streamChat` next checks
 * in, marks the task row (and every in-flight descendant in its
 * delegation tree — M3.4) `canceled`, but does not thread an AbortSignal
 * into the in-flight provider fetch — the outbound HTTP request may
 * finish server-side even though nothing further is delivered or
 * persisted (docs/architecture/03-api-contracts.md §2).
 */
export function requestCancel(taskId: string): void {
  canceledTaskIds.add(taskId);
}

/**
 * Dispatches the Master Agent's `handleTask` in the background and
 * bridges its `emit()` calls (already wired to `publishChunk` inside
 * `buildRuntimeContext`) plus a final terminal `status` chunk onto the
 * per-task stream hub. `providerKeys` lives only inside this function's
 * closure for the duration of the run — once this async IIFE returns,
 * nothing in the process still references it
 * (docs/architecture/07-security-model.md §3.2).
 */
export function dispatchMasterAgentTask(input: DispatchMasterAgentTaskInput): void {
  const { task, pool, eventBus, modelRegistry, agentRegistry, providerKeys } = input;
  void (async () => {
    let finalState: "completed" | "failed" | "canceled" = "completed";
    try {
      const master = await agentRegistry.get("master");
      if (!master) throw new Error("Master agent has no running implementation registered");

      const ctx = await buildRuntimeContext(
        {
          pool,
          eventBus,
          modelRegistry,
          agentRegistry,
          providerKeys,
          rootTaskId: task.id,
          isCanceled: () => canceledTaskIds.has(task.id),
        },
        task,
        "master",
      );
      await master.handleTask(ctx);

      const finalRow = await getTask(pool, task.id);
      finalState = finalRow?.state === "failed" ? "failed" : finalRow?.state === "canceled" ? "canceled" : "completed";
    } catch {
      // The error itself is already persisted onto the task row and
      // emitted as a task.failed/agent.failed event by the runtime context.
      finalState = "failed";
    } finally {
      if (finalState === "canceled") {
        await cancelTaskCascade(pool, task.correlation_id ?? task.id);
      }
      publishChunk(task.id, { taskId: task.id, kind: "status", state: finalState });
      canceledTaskIds.delete(task.id);
      finishTask(task.id);
    }
  })();
}
