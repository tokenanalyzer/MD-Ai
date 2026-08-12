import "../setupEnv.js";
import { beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../../src/core/events/eventBus.js";
import { ensureOwner } from "../../src/db/repositories/ownerRepo.js";
import { createDeviceSession } from "../../src/db/repositories/deviceSessionRepo.js";
import { getOrCreateNotificationPreferences, updateNotificationPreferences } from "../../src/db/repositories/notificationPreferencesRepo.js";
import { listRecentNotifications } from "../../src/db/repositories/notificationRepo.js";
import { notifyForFinding } from "../../src/core/notifications/notificationService.js";
import { getTestPool, resetTestData, closeTestPool } from "../helpers/testDb.js";
import type { NotificationSender } from "@mdai/shared-types";

const pool = await getTestPool();
const eventBus = new EventBus(pool);

let ownerId = "";
beforeEach(async () => {
  await resetTestData(pool);
  const owner = await ensureOwner(pool, "Test Owner");
  ownerId = owner.id;
});

const baseInput = {
  title: "Test finding",
  summary: "Something worth knowing.",
  deepLink: "mdai://findings/test",
};

describe("M5.14 — notification preferences are default-conservative and enforced before every send", () => {
  it("defaults to minimum_importance='high' — a MEDIUM finding is suppressed out of the box, with no device even registered", async () => {
    const prefs = await getOrCreateNotificationPreferences(pool, ownerId);
    expect(prefs.enabled).toBe(true);
    expect(prefs.minimum_importance).toBe("high");

    const sender: NotificationSender = { async send() { throw new Error("must not be called"); } };
    await notifyForFinding({ pool, eventBus, ownerId, sender }, { ...baseInput, importance: "medium" });

    const [row] = await listRecentNotifications(pool, 1);
    expect(row?.status).toBe("suppressed");
    expect(row?.suppressed_reason).toBe("below_threshold");
  });

  it("suppresses with 'no_device' when importance clears the bar but no device has a push token", async () => {
    const sender: NotificationSender = { async send() { throw new Error("must not be called"); } };
    await notifyForFinding({ pool, eventBus, ownerId, sender }, { ...baseInput, importance: "critical" });

    const [row] = await listRecentNotifications(pool, 1);
    expect(row?.status).toBe("suppressed");
    expect(row?.suppressed_reason).toBe("no_device");
  });

  it("sends successfully and records bot.notification.sent when a device has a token and the sender delivers", async () => {
    await createDeviceSession(pool, { ownerId, deviceName: "phone", platform: "android", refreshTokenHash: "x", pushToken: "ExponentPushToken[abc]" });
    const sender: NotificationSender = {
      async send(tokens) {
        return { delivered: tokens, failed: [] };
      },
    };
    await notifyForFinding({ pool, eventBus, ownerId, sender }, { ...baseInput, importance: "critical" });

    const [row] = await listRecentNotifications(pool, 1);
    expect(row?.status).toBe("sent");
    expect(row?.sent_at).toBeTruthy();

    const events = await pool.query("SELECT event_type FROM events WHERE event_type = 'bot.notification.sent'");
    expect(events.rows.length).toBe(1);
  });

  it("marks the notification failed and records bot.notification.failed when the push provider (FCM/Expo) rejects delivery", async () => {
    await createDeviceSession(pool, { ownerId, deviceName: "phone", platform: "android", refreshTokenHash: "x", pushToken: "ExponentPushToken[bad]" });
    const sender: NotificationSender = {
      async send(tokens) {
        return { delivered: [], failed: tokens.map((t) => ({ token: t, error: "DeviceNotRegistered" })) };
      },
    };
    await notifyForFinding({ pool, eventBus, ownerId, sender }, { ...baseInput, importance: "critical" });

    const [row] = await listRecentNotifications(pool, 1);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("DeviceNotRegistered");

    const events = await pool.query("SELECT event_type FROM events WHERE event_type = 'bot.notification.failed'");
    expect(events.rows.length).toBe(1);
  });

  it("honors muted bot/category/topic filters", async () => {
    await createDeviceSession(pool, { ownerId, deviceName: "phone", platform: "android", refreshTokenHash: "x", pushToken: "tok" });
    await updateNotificationPreferences(pool, ownerId, { minimumImportance: "low", mutedBotIds: ["news-monitor"], mutedCategories: ["system_health"], mutedTopics: ["crypto prices"] });
    const sender: NotificationSender = { async send(tokens) { return { delivered: tokens, failed: [] }; } };

    await notifyForFinding({ pool, eventBus, ownerId, sender }, { ...baseInput, importance: "low", botId: "news-monitor" });
    await notifyForFinding({ pool, eventBus, ownerId, sender }, { ...baseInput, importance: "low", category: "system_health" });
    await notifyForFinding({ pool, eventBus, ownerId, sender }, { ...baseInput, importance: "low", topic: "crypto prices" });
    await notifyForFinding({ pool, eventBus, ownerId, sender }, { ...baseInput, importance: "low", botId: "ai-model-release-monitor" });

    const rows = await listRecentNotifications(pool, 10);
    const byReason = rows.map((r) => r.suppressed_reason ?? r.status);
    expect(byReason).toEqual(expect.arrayContaining(["bot_filtered", "category_filtered", "topic_filtered", "sent"]));
  });

  it("honors quiet hours — a same-day window suppresses when 'now' falls inside it", async () => {
    await createDeviceSession(pool, { ownerId, deviceName: "phone", platform: "android", refreshTokenHash: "x", pushToken: "tok" });
    const nowMinuteUtc = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
    await updateNotificationPreferences(pool, ownerId, {
      minimumImportance: "low",
      quietHoursStartMinute: Math.max(0, nowMinuteUtc - 30),
      quietHoursEndMinute: Math.min(1439, nowMinuteUtc + 30),
      quietHoursTimezone: "UTC",
    });
    const sender: NotificationSender = { async send(tokens) { return { delivered: tokens, failed: [] }; } };
    await notifyForFinding({ pool, eventBus, ownerId, sender }, { ...baseInput, importance: "low" });

    const [row] = await listRecentNotifications(pool, 1);
    expect(row?.status).toBe("suppressed");
    expect(row?.suppressed_reason).toBe("quiet_hours");
  });
});
