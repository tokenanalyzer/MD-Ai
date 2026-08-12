/**
 * Push notification delivery (M5.13) and owner-controlled preferences
 * (M5.14). A notification always originates from a `BotFinding` that
 * survived dedup + importance filtering (and, when significant, Agent
 * analysis) — see docs/architecture/12-bot-engine.md §6.
 */

import type { FindingImportance } from "../bots/index.js";

export type NotificationStatus = "pending" | "sent" | "failed" | "suppressed";
export type NotificationSuppressedReason =
  | "quiet_hours"
  | "below_threshold"
  | "topic_filtered"
  | "bot_filtered"
  | "category_filtered"
  | "disabled"
  | "no_device";

export interface PushNotification {
  id: string;
  findingId?: string;
  title: string;
  summary: string;
  importance: FindingImportance;
  /** Where opening the notification takes the user, e.g. `mdai://findings/<id>` or `mdai://tasks/<id>` — never a raw external URL (M5.13). */
  deepLink: string;
  status: NotificationStatus;
  suppressedReason?: NotificationSuppressedReason;
  error?: string;
  sentAt?: string;
  createdAt: string;
}

export interface NotificationPreferences {
  enabled: boolean;
  minimumImportance: FindingImportance;
  /** Minutes since local midnight, in `quietHoursTimezone`. Both set or both unset. A window that wraps midnight (start > end) is valid and spans overnight. */
  quietHoursStartMinute?: number;
  quietHoursEndMinute?: number;
  quietHoursTimezone: string;
  /** Opt-OUT lists — empty means nothing is filtered (M5.14's "default conservative" is carried by `minimumImportance`, not these). */
  mutedTopics: string[];
  mutedBotIds: string[];
  mutedCategories: string[];
  updatedAt: string;
}

/** Sends one push notification to every registered device — implemented via Expo's push service, which relays to FCM on Android (docs/architecture/12-bot-engine.md §6.1). */
export interface NotificationSender {
  send(tokens: string[], notification: Pick<PushNotification, "title" | "summary" | "importance" | "deepLink">): Promise<{ delivered: string[]; failed: { token: string; error: string }[] }>;
}
