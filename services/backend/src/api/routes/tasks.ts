import { Router } from "express";
import type pg from "pg";
import { authGuard } from "../middleware/authGuard.js";
import { AppError } from "../errors.js";
import { cancelTaskBodySchema } from "../schemas.js";
import { getTask } from "../../db/repositories/taskRepo.js";
import { requestCancel } from "../chatOrchestrator.js";

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

  return router;
}
