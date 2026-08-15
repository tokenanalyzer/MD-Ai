import { Router } from "express";
import type pg from "pg";
import type { BotRegistry } from "@mdai/shared-types";
import { authGuard } from "../middleware/authGuard.js";
import { AppError } from "../errors.js";
import { patchBotBodySchema } from "../schemas.js";
import type { BotEngine } from "../../core/bots/botEngine.js";
import { listRecentBotRuns } from "../../db/repositories/botRunRepo.js";
import { listRecentFindings } from "../../db/repositories/botFindingRepo.js";

/** M5.16's Bot Fleet screen backend — list/enable/disable/pause/resume/run-once, plus recent runs/findings for the detail view. */
export function botsRouter(pool: pg.Pool, botRegistry: BotRegistry, botEngine: BotEngine | undefined): Router {
  const router = Router();
  router.use(authGuard(pool));

  router.get("/", async (_req, res, next) => {
    try {
      const bots = await botRegistry.list();
      res.json({ data: bots });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id/runs", async (req, res, next) => {
    try {
      const rows = await listRecentBotRuns(pool, req.params.id as string, 20);
      res.json({
        data: rows.map((r) => ({
          id: r.id,
          botId: r.bot_id,
          startedAt: r.started_at.toISOString(),
          completedAt: r.finished_at?.toISOString(),
          durationMs: r.duration_ms ?? undefined,
          status: r.status,
          error: r.error ?? undefined,
          findingsCount: r.findings_count,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id/findings", async (req, res, next) => {
    try {
      const rows = await listRecentFindings(pool, req.params.id as string, 50);
      res.json({
        data: rows.map((r) => ({
          id: r.id,
          botId: r.bot_id,
          category: r.category,
          title: r.title,
          summary: r.summary,
          importance: r.importance,
          status: r.status,
          escalationStatus: r.escalation_status,
          occurrenceCount: r.occurrence_count,
          firstSeenAt: r.first_seen_at.toISOString(),
          lastSeenAt: r.last_seen_at.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:id", async (req, res, next) => {
    try {
      const botId = req.params.id as string;
      const existing = await botRegistry.get(botId);
      if (!existing) throw AppError.notFound(`Bot ${botId} not found`);

      const body = patchBotBodySchema.parse(req.body);
      if (body.enabled !== undefined) await botRegistry.setEnabled(botId, body.enabled);
      if (body.paused !== undefined) await botRegistry.setPaused(botId, body.paused);

      const updated = await botRegistry.get(botId);
      res.json({ data: updated });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/run-now", async (req, res, next) => {
    try {
      const botId = req.params.id as string;
      const existing = await botRegistry.get(botId);
      if (!existing) throw AppError.notFound(`Bot ${botId} not found`);
      if (!botEngine) {
        throw AppError.serviceUnavailable("Bot Engine is unavailable — REDIS_URL is not configured on this backend");
      }
      const run = await botEngine.runNow(botId);
      res.status(202).json({ data: run });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
