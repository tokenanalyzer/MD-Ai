import type pg from "pg";
import type { FindingImportance, NotificationSender } from "@mdai/shared-types";
import type { EventBus } from "../events/eventBus.js";
import type { AutomationRow } from "../../db/repositories/automationRepo.js";
import { notifyForFinding } from "../notifications/notificationService.js";

export interface DispatchNotificationDeps {
  pool: pg.Pool;
  eventBus: EventBus;
  ownerId: string;
  sender: NotificationSender;
}

const VALID_IMPORTANCE: FindingImportance[] = ["low", "medium", "high", "critical"];

/**
 * M10 `action_type = 'notification'`: reuses the exact push-notification
 * pipeline M5.13/M5.14 already built (`notifyForFinding` — owner
 * preferences, quiet hours, mute filters, `notifications` table
 * bookkeeping, Expo push) rather than a second notification path. An
 * automation is just another *source* of a notification, same as a bot
 * finding.
 */
export async function dispatchNotification(deps: DispatchNotificationDeps, automation: AutomationRow): Promise<void> {
  const title = typeof automation.action_config["title"] === "string" ? (automation.action_config["title"] as string) : automation.name;
  const summary = typeof automation.action_config["summary"] === "string" ? (automation.action_config["summary"] as string) : "";
  const importanceRaw = automation.action_config["importance"];
  const importance: FindingImportance = VALID_IMPORTANCE.includes(importanceRaw as FindingImportance)
    ? (importanceRaw as FindingImportance)
    : "medium";

  await notifyForFinding(deps, {
    title,
    summary,
    importance,
    deepLink: `mdai://automations/${automation.id}`,
  });
}
