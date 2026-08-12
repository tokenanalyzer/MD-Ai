import { Router } from "express";
import type pg from "pg";
import { authGuard } from "../middleware/authGuard.js";
import { AppError } from "../errors.js";
import { cancelTaskBodySchema } from "../schemas.js";
import { getTask, listTasksByCorrelation, type TaskRow } from "../../db/repositories/taskRepo.js";
import { requestCancel } from "../chatOrchestrator.js";

function toTaskTreeNodeDto(task: TaskRow) {
  return {
    id: task.id,
    parentTaskId: task.parent_task_id,
    assignedAgentId: task.assigned_agent_id,
    taskType: task.task_type,
    state: task.state,
    modelId: task.model_id,
    startedAt: task.started_at?.toISOString() ?? null,
    completedAt: task.completed_at?.toISOString() ?? null,
    createdAt: task.created_at.toISOString(),
  };
}

export function tasksRouter(pool: pg.Pool): Router {
  const router = Router();
  router.use(authGuard(pool));

  router.post("/:id/cancel", async (req, res, next) => {
    try {
      cancelTaskBodySchema.parse(req.body ?? {});
      const task = await getTask(pool, req.params.id as string);
      if (!task) throw AppError.notFound("Task not found");
      if (task.state === "completed" || task.state === "failed" || task.state === "canceled") {
        res.status(204).send();
        return;
      }
      requestCancel(task.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  /**
   * M6.4 Chat "expandable task details" — the full delegation tree (root +
   * every descendant sub-task) for the task's root correlation id, so the
   * mobile client can show which agents actually ran and which model each
   * sub-task used, from real DB rows rather than only the latest progress
   * label.
   */
  router.get("/:id/tree", async (req, res, next) => {
    try {
      const task = await getTask(pool, req.params.id as string);
      if (!task) throw AppError.notFound("Task not found");
      const correlationId = task.correlation_id ?? task.id;
      const tree = await listTasksByCorrelation(pool, correlationId);
      res.json({ data: tree.map(toTaskTreeNodeDto) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
