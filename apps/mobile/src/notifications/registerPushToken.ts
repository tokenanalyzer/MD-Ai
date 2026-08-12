import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { registerPushToken as postPushToken } from "../api/client";

/**
 * M5.13: registers this device for push notifications and reports the
 * resulting Expo push token to the backend, which relays it through
 * Expo's push service to FCM on Android (docs/architecture/
 * 12-bot-engine.md §10.1). Requires a physical device — push tokens are
 * not available on the Android emulator, and Expo Go cannot request the
 * native permission a production/dev-client build can (docs/architecture/
 * 10-android-setup.md §4.12).
 */
export async function registerForPushNotificationsAsync(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (Platform.OS !== "android") return { ok: false, reason: "android-only in this milestone" };
  if (!Device.isDevice) return { ok: false, reason: "push tokens require a physical device, not an emulator" };

  const existing = await Notifications.getPermissionsAsync();
  let granted = existing.granted;
  if (!granted) {
    const requested = await Notifications.requestPermissionsAsync();
    granted = requested.granted;
  }
  if (!granted) return { ok: false, reason: "notification permission denied" };

  await Notifications.setNotificationChannelAsync("default", {
    name: "MD AI",
    importance: Notifications.AndroidImportance.DEFAULT,
  });

  // getExpoPushTokenAsync needs the EAS project id once one exists
  // (`eas init` writes it to app.json's expo.extra.eas.projectId) — omitted
  // is fine for a bare `expo start --dev-client` session without EAS,
  // required once builds go through `eas build`. See
  // docs/architecture/10-android-setup.md §4.12.
  const projectId = Constants.expoConfig?.extra?.["eas"]?.["projectId"] as string | undefined;
  const tokenResponse = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);

  await postPushToken(tokenResponse.data);
  return { ok: true };
}
