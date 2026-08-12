import { Router } from "express";
import type pg from "pg";
import { authGuard } from "../middleware/authGuard.js";
import { createUserTopicBodySchema } from "../schemas.js";
import { createUserTopic, deleteUserTopic, listUserTopics } from "../../db/repositories/userTopicRepo.js";

/** M5.10: user-defined topics for the User Topic Monitor bot — configuration only, the bot itself reads this table directly. */
export function userTopicsRouter(pool: pg.Pool): Router {
  const router = Router();
  router.use(authGuard(pool));

  router.get("/", async (req, res, next) => {
    try {
      const rows = await listUserTopics(pool, req.deviceSession!.ownerId);
      res.json({
        data: rows.map((r) => ({
          id: r.id,
          topic: r.topic,
          frequencyMinutes: r.frequency_minutes,
          importanceThreshold: r.importance_threshold,
          enabled: r.enabled,
          lastCheckedAt: r.last_checked_at?.toISOString(),
          createdAt: r.created_at.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const body = createUserTopicBodySchema.parse(req.body);
      const row = await createUserTopic(pool, {
        ownerId: req.deviceSession!.ownerId,
        topic: body.topic,
        frequencyMinutes: body.frequencyMinutes,
        importanceThreshold: body.importanceThreshold,
      });
      res.status(201).json({
        data: {
          id: row.id,
          topic: row.topic,
          frequencyMinutes: row.frequency_minutes,
          importanceThreshold: row.importance_threshold,
          enabled: row.enabled,
          createdAt: row.created_at.toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      await deleteUserTopic(pool, req.deviceSession!.ownerId, req.params.id as string);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
