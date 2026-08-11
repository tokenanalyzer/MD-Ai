import { Router } from "express";
import type pg from "pg";
import type { Redis } from "ioredis";
import type { Queue } from "bullmq";
import { authGuard } from "../middleware/authGuard.js";
import { buildHealthReport } from "../../core/observability/health.js";

export function healthRouter(pool: pg.Pool, redis: Redis, queues: Queue[]): Router {
  const router = Router();

  // Full telemetry (docs/architecture/08-deployment-architecture.md §9.1) is
  // authenticated like everything else — it reveals internal resource
  // state, not appropriate to expose publicly on a single-user system.
  router.get("/", authGuard(pool), async (_req, res, next) => {
    try {
      const report = await buildHealthReport({ pool, redis, queues });
      res.json({ data: report });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** Unauthenticated liveness-only check for container orchestration — no internal detail, just "the process is up." */
export function healthzRouter(): Router {
  const router = Router();
  router.get("/", (_req, res) => res.status(200).json({ status: "ok" }));
  return router;
}
