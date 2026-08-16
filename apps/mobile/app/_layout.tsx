import React, { useEffect, useState } from "react";
import { View, ActivityIndicator } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { configureClientCore } from "@mdai/client-core";
import { colors } from "../src/theme/tokens";
import { useSessionStore } from "../src/state/sessionStore";
import { registerForPushNotificationsAsync } from "../src/notifications/registerPushToken";
import { secureStoreCompat } from "../src/platform/secureStoreCompat";
import { getBackendUrl } from "../src/api/backendUrl";

// M10 PC-client foundation: wire the Expo app's real Keystore-backed vault
// and backend-URL resolver into @mdai/client-core before any store/api
// call in that package runs. Must happen before the first render below.
configureClientCore({ keyValueStore: secureStoreCompat, getBackendUrl });

// Keep the native splash (assets/splash.png, configured in app.json) up
// through session hydration below, instead of it auto-hiding the instant
// JS loads and leaving a blank flash before the ActivityIndicator mounts.
void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const hydrate = useSessionStore((s) => s.hydrate);
  const accessToken = useSessionStore((s) => s.accessToken);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    hydrate().finally(() => {
      setReady(true);
      void SplashScreen.hideAsync();
    });
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
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="light" backgroundColor={colors.bgBase} />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.bgBase },
          }}
        />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
