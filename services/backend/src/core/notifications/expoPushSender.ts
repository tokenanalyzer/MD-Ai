import type { NotificationSender } from "@mdai/shared-types";

/**
 * M5.13: "Oracle → notification service → FCM → Android → user". Expo's
 * push service is the implementation of that middle hop in this Expo-
 * managed-workflow codebase: it accepts one first-party HTTPS call and
 * relays to FCM for Android devices (APNs for iOS, unused here) — the
 * mobile app registers via `expo-notifications`, which already handles
 * the underlying FCM device-token plumbing without a separate Firebase
 * Admin SDK/service-account credential on the backend. `exp.host` is a
 * fixed, first-party endpoint, not a caller-supplied URL, so this
 * deliberately does not go through `core/security/ssrfGuard.ts` (that
 * guard exists for URLs derived from external/agent input, which this
 * is not).
 */
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

export const expoPushSender: NotificationSender = {
  async send(tokens, notification) {
    if (tokens.length === 0) return { delivered: [], failed: [] };

    const messages = tokens.map((to) => ({
      to,
      title: notification.title,
      body: notification.summary,
      priority: notification.importance === "critical" || notification.importance === "high" ? "high" : "default",
      data: { deepLink: notification.deepLink, importance: notification.importance },
    }));

    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(messages),
    });

    if (!res.ok) {
      const error = `Expo push service returned HTTP ${res.status}`;
      return { delivered: [], failed: tokens.map((token) => ({ token, error })) };
    }

    const body = (await res.json()) as { data?: ExpoPushTicket[] };
    const tickets = body.data ?? [];
    const delivered: string[] = [];
    const failed: { token: string; error: string }[] = [];
    tokens.forEach((token, i) => {
      const ticket = tickets[i];
      if (ticket?.status === "ok") delivered.push(token);
      else failed.push({ token, error: ticket?.message ?? ticket?.details?.error ?? "unknown Expo push error" });
    });
    return { delivered, failed };
  },
};
