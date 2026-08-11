import type pg from "pg";
import type { ChatMessage } from "@mdai/shared-types";
import type { EventBus } from "../core/events/eventBus.js";
import type { TaskRow } from "../db/repositories/taskRepo.js";
import { updateTaskState } from "../db/repositories/taskRepo.js";
import { runMasterAgentChat } from "../core/agents/masterAgent.js";
import { publishChunk, finishTask } from "./ws/chatStreamHub.js";

export interface StartMasterAgentTaskInput {
  pool: pg.Pool;
  eventBus: EventBus;
  task: TaskRow;
  messages: ChatMessage[];
  providerKeys: Record<string, string>;
  preferredProviderId?: string;
  preferredModelId?: string;
}

const canceledTaskIds = new Set<string>();

/**
 * Marks a task canceled. M1 cancellation is best-effort: it stops the
 * chunk stream reaching the client and marks the task row `canceled`
 * (docs/architecture/03-api-contracts.md §2), but does not yet thread an
 * AbortSignal into the in-flight provider fetch — the outbound HTTP
 * request may finish server-side even though nothing further is
 * delivered or persisted. True request-level abort is a documented M2
 * fast-follow, not silently pretended to work today.
 */
export function requestCancel(taskId: string): void {
  canceledTaskIds.add(taskId);
}

/**
 * Fires the Master Agent chat pipeline in the background and bridges its
 * chunks onto the per-task stream hub. `providerKeys` lives only inside
 * this function's closure for the duration of the run — once this
 * async IIFE returns, nothing in the process still references it
 * (docs/architecture/07-security-model.md §3.2).
 */
export function startMasterAgentTask(input: StartMasterAgentTaskInput): void {
  const { task, pool } = input;
  void (async () => {
    try {
      for await (const chunk of runMasterAgentChat({
        pool,
        eventBus: input.eventBus,
        task,
        messages: input.messages,
        providerKeys: input.providerKeys,
        preferredProviderId: input.preferredProviderId,
        preferredModelId: input.preferredModelId,
      })) {
        if (canceledTaskIds.has(task.id)) {
          await updateTaskState(pool, task.id, { state: "canceled", completedAt: true });
          publishChunk(task.id, { taskId: task.id, kind: "status", state: "canceled" });
          break;
        }
        publishChunk(task.id, { taskId: task.id, kind: "token", delta: chunk.delta });
      }
      if (!canceledTaskIds.has(task.id)) {
        publishChunk(task.id, { taskId: task.id, kind: "status", state: "completed" });
      }
    } catch {
      // The error itself is already persisted onto the task row and
      // emitted as an agent.failed event by runMasterAgentChat.
      publishChunk(task.id, { taskId: task.id, kind: "status", state: "failed" });
    } finally {
      canceledTaskIds.delete(task.id);
      finishTask(task.id);
    }
  })();
}
