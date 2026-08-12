import type pg from "pg";
import type { FindingImportance, NotificationSender, NotificationSuppressedReason } from "@mdai/shared-types";
import type { EventBus } from "../events/eventBus.js";
import { getOrCreateNotificationPreferences, type NotificationPreferencesRow } from "../../db/repositories/notificationPreferencesRepo.js";
import { createNotification, markNotificationFailed, markNotificationSent, markNotificationSuppressed } from "../../db/repositories/notificationRepo.js";
import { listActiveSessions } from "../../db/repositories/deviceSessionRepo.js";
import { meetsImportanceThreshold } from "../bots/dedup.js";

export interface NotifyInput {
  findingId?: string;
  botId?: string;
  category?: string;
  topic?: string;
  title: string;
  summary: string;
  importance: FindingImportance;
  deepLink: string;
}

export interface NotificationServiceDeps {
  pool: pg.Pool;
  eventBus: EventBus;
  ownerId: string;
  sender: NotificationSender;
}

/** Minutes since local midnight, in `timeZone` — used for quiet-hours evaluation without a date library dependency. */
function currentMinuteOfDay(timeZone: string, now: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "numeric", hourCycle: "h23" });
  const parts = formatter.formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function isWithinQuietHours(prefs: NotificationPreferencesRow, now: Date): boolean {
  if (prefs.quiet_hours_start_minute === null || prefs.quiet_hours_end_minute === null) return false;
  const current = currentMinuteOfDay(prefs.quiet_hours_timezone, now);
  const { quiet_hours_start_minute: start, quiet_hours_end_minute: end } = prefs;
  // A window that wraps midnight (start > end, e.g. 22:00 -> 07:00) spans
  // two comparisons; a same-day window (start < end) is one.
  if (start <= end) return current >= start && current < end;
  return current >= start || current < end;
}

function evaluateSuppression(
  prefs: NotificationPreferencesRow,
  input: NotifyInput,
  now: Date,
): NotificationSuppressedReason | undefined {
  if (!prefs.enabled) return "disabled";
  if (!meetsImportanceThreshold(input.importance, prefs.minimum_importance)) return "below_threshold";
  if (input.category && prefs.muted_categories.includes(input.category)) return "category_filtered";
  if (input.botId && prefs.muted_bot_ids.includes(input.botId)) return "bot_filtered";
  if (input.topic && prefs.muted_topics.includes(input.topic)) return "topic_filtered";
  if (isWithinQuietHours(prefs, now)) return "quiet_hours";
  return undefined;
}

/**
 * M5.13/M5.14: the terminal step of BOT DETECTS → FINDING → IMPORTANCE
 * FILTER → AGENT ANALYSIS WHEN NEEDED → REVIEW WHEN NEEDED → PUSH
 * NOTIFICATION → USER. Every finding that reaches here gets a
 * `notifications` row regardless of outcome — "never spam" is enforced by
 * marking the row `suppressed` with a specific reason, not by silently
 * skipping it, so the owner-controlled preferences this function applies
 * are auditable in the Bot Fleet UI rather than invisible.
 */
export async function notifyForFinding(deps: NotificationServiceDeps, input: NotifyInput): Promise<void> {
  const prefs = await getOrCreateNotificationPreferences(deps.pool, deps.ownerId);
  const notification = await createNotification(deps.pool, {
    findingId: input.findingId,
    title: input.title,
    summary: input.summary,
    importance: input.importance,
    deepLink: input.deepLink,
  });

  const suppressedReason = evaluateSuppression(prefs, input, new Date());
  if (suppressedReason) {
    await markNotificationSuppressed(deps.pool, notification.id, suppressedReason);
    return;
  }

  const sessions = await listActiveSessions(deps.pool, deps.ownerId);
  const tokens = sessions.map((s) => s.push_token).filter((t): t is string => Boolean(t));
  if (tokens.length === 0) {
    await markNotificationSuppressed(deps.pool, notification.id, "no_device");
    return;
  }

  try {
    const result = await deps.sender.send(tokens, {
      title: input.title,
      summary: input.summary,
      importance: input.importance,
      deepLink: input.deepLink,
    });
    if (result.delivered.length > 0) {
      await markNotificationSent(deps.pool, notification.id);
      await deps.eventBus.publish({
        sourceType: "bot",
        sourceId: input.botId ?? "notification-service",
        payload: { type: "bot.notification.sent", findingId: input.findingId, notificationId: notification.id },
      });
    } else {
      const error = result.failed.map((f) => f.error).join("; ") || "no device accepted the notification";
      await markNotificationFailed(deps.pool, notification.id, error);
      await deps.eventBus.publish({
        sourceType: "bot",
        sourceId: input.botId ?? "notification-service",
        severity: "warn",
        payload: { type: "bot.notification.failed", findingId: input.findingId, notificationId: notification.id, error },
      });
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await markNotificationFailed(deps.pool, notification.id, error);
    await deps.eventBus.publish({
      sourceType: "bot",
      sourceId: input.botId ?? "notification-service",
      severity: "warn",
      payload: { type: "bot.notification.failed", findingId: input.findingId, notificationId: notification.id, error },
    });
  }
}
