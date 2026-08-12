import { Router } from "express";
import type pg from "pg";
import { authGuard } from "../middleware/authGuard.js";
import { patchNotificationPreferencesBodySchema } from "../schemas.js";
import { listRecentNotifications } from "../../db/repositories/notificationRepo.js";
import { getOrCreateNotificationPreferences, updateNotificationPreferences } from "../../db/repositories/notificationPreferencesRepo.js";

function toPreferencesDto(row: Awaited<ReturnType<typeof getOrCreateNotificationPreferences>>) {
  return {
    enabled: row.enabled,
    minimumImportance: row.minimum_importance,
    quietHoursStartMinute: row.quiet_hours_start_minute ?? undefined,
    quietHoursEndMinute: row.quiet_hours_end_minute ?? undefined,
    quietHoursTimezone: row.quiet_hours_timezone,
    mutedTopics: row.muted_topics,
    mutedBotIds: row.muted_bot_ids,
    mutedCategories: row.muted_categories,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** M5.13/M5.14: notification history + owner-controlled preferences. */
export function notificationsRouter(pool: pg.Pool): Router {
  const router = Router();
  router.use(authGuard(pool));

  router.get("/", async (_req, res, next) => {
    try {
      const rows = await listRecentNotifications(pool, 50);
      res.json({
        data: rows.map((r) => ({
          id: r.id,
          findingId: r.finding_id ?? undefined,
          title: r.title,
          summary: r.summary,
          importance: r.importance,
          deepLink: r.deep_link,
          status: r.status,
          suppressedReason: r.suppressed_reason ?? undefined,
          sentAt: r.sent_at?.toISOString(),
          createdAt: r.created_at.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/preferences", async (req, res, next) => {
    try {
      const row = await getOrCreateNotificationPreferences(pool, req.deviceSession!.ownerId);
      res.json({ data: toPreferencesDto(row) });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/preferences", async (req, res, next) => {
    try {
      const body = patchNotificationPreferencesBodySchema.parse(req.body);
      const row = await updateNotificationPreferences(pool, req.deviceSession!.ownerId, body);
      res.json({ data: toPreferencesDto(row) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
