import React, { useCallback, useEffect, useState } from "react";
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { configureClientCore } from "@mdai/client-core";
import { colors, radius, spacing, typography } from "../src/theme/tokens";
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
  const autoPair = useSessionStore((s) => s.autoPair);
  const accessToken = useSessionStore((s) => s.accessToken);
  const [ready, setReady] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Owner's choice: no pairing screen at all. First launch (or any launch
  // with no stored session) silently calls the backend's no-code
  // /auth/auto-pair instead of showing a form — this app opens exactly
  // like any other installed app. The one thing that CAN still fail here
  // is genuinely reaching the backend at all (e.g. a Render free-tier
  // instance still spinning up from sleep), which is why this stays
  // retryable rather than a silent infinite spinner.
  const connect = useCallback(async () => {
    setConnectError(null);
    await hydrate();
    if (!useSessionStore.getState().accessToken) {
      try {
        await autoPair();
      } catch (err) {
        setConnectError(err instanceof Error ? err.message : "Could not reach the MD AI backend");
      }
    }
    setReady(true);
    void SplashScreen.hideAsync();
  }, [hydrate, autoPair]);

  useEffect(() => {
    void connect();
  }, [connect]);

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

  if (connectError) {
    return (
      <View style={styles.errorScreen}>
        <Text style={styles.errorTitle}>Couldn't reach MD AI</Text>
        <Text style={styles.errorDetail}>{connectError}</Text>
        <Pressable
          style={styles.retryButton}
          onPress={() => {
            setReady(false);
            void connect();
          }}
        >
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
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

const styles = StyleSheet.create({
  errorScreen: { flex: 1, backgroundColor: colors.bgBase, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  errorTitle: { color: colors.textPrimary, fontSize: typography.fontSize.lg, fontWeight: "700", marginBottom: spacing.sm },
  errorDetail: { color: colors.textSecondary, fontSize: typography.fontSize.sm, textAlign: "center", marginBottom: spacing.lg },
  retryButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
  },
  retryText: { color: colors.bgBase, fontSize: typography.fontSize.md, fontWeight: "700" },
});
