import { Router } from "express";
import type pg from "pg";
import { authGuard } from "../middleware/authGuard.js";
import { listEventsSince } from "../../db/repositories/eventRepo.js";

/**
 * M6: read-only REST snapshot of the event bus — the Command Center's
 * Live Event Stream loads its initial page from here, then tails live
 * updates over `/ws/events` (chatGateway.ts) using the same
 * cursor (`id`) this returns, so the two never double-render or drop a
 * gap. Same table, same `EventPayload` union as every other event
 * consumer (docs/architecture/05-event-schemas.md) — nothing here is
 * mobile-specific data.
 */
export function eventsRouter(pool: pg.Pool): Router {
  const router = Router();
  router.use(authGuard(pool));

  router.get("/", async (req, res, next) => {
    try {
      const sinceId = typeof req.query["since"] === "string" ? Number(req.query["since"]) : undefined;
      const limit = typeof req.query["limit"] === "string" ? Number(req.query["limit"]) : undefined;
      const types = typeof req.query["types"] === "string" ? (req.query["types"] as string).split(",") : undefined;
      const rows = await listEventsSince(pool, {
        sinceId: Number.isFinite(sinceId) ? sinceId : undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
        types,
      });
      res.json({
        data: rows.map((r) => ({
          id: r.id,
          type: r.event_type,
          sourceType: r.source_type,
          sourceId: r.source_id,
          taskId: r.task_id ?? undefined,
          severity: r.severity,
          payload: r.payload,
          createdAt: r.created_at.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
