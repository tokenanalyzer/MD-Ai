import React, { useEffect, useState } from "react";
import { View, ActivityIndicator } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { colors } from "../src/theme/tokens";
import { useSessionStore } from "../src/state/sessionStore";
import { registerForPushNotificationsAsync } from "../src/notifications/registerPushToken";

export default function RootLayout() {
  const hydrate = useSessionStore((s) => s.hydrate);
  const accessToken = useSessionStore((s) => s.accessToken);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    hydrate().finally(() => setReady(true));
  }, [hydrate]);

  useEffect(() => {
    // Best-effort, never blocks startup or the chat flow (M5.13) — a
    // denied permission or an emulator/Expo-Go environment just means no
    // push notifications, not a crash. Re-registers on every cold start
    // since push tokens rotate.
    if (accessToken) {
      void registerForPushNotificationsAsync().catch(() => {});
    }
  }, [accessToken]);

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bgBase, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" backgroundColor={colors.bgBase} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bgBase },
        }}
      />
    </SafeAreaProvider>
  );
}
