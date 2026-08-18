import React, { useEffect, useState } from "react";
import { View, Text, TextInput, StyleSheet, ScrollView, Pressable, Alert } from "react-native";
import { router } from "expo-router";
import Constants from "expo-constants";
import { colors, radius, spacing, typography } from "../../src/theme/tokens";
import { useScreenTopPadding } from "../../src/hooks/useScreenTopPadding";
import { Panel } from "../../src/components/Panel";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { getBackendUrl, setBackendUrl, wsUrlFrom } from "../../src/api/backendUrl";
import { useSessionStore } from "../../src/state/sessionStore";
import { registerForPushNotificationsAsync } from "../../src/notifications/registerPushToken";

/**
 * Runtime-configurable backend URL (docs/architecture/10-android-setup.md
 * §4/§5) — without this screen, switching between a local dev backend and
 * Oracle required either restarting Metro with a different
 * EXPO_PUBLIC_MDAI_BACKEND_URL or calling setBackendUrl() from code. This
 * makes it a real, in-app, no-rebuild action, which is what "development
 * backend URL configuration without changing source code" actually
 * requires once the app is already running on a device.
 */
export default function SettingsScreen() {
  const topPadding = useScreenTopPadding();
  const [currentUrl, setCurrentUrl] = useState("");
  const [draftUrl, setDraftUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [pushStatus, setPushStatus] = useState<string | null>(null);
  const signOut = useSessionStore((s) => s.signOut);
  const autoPair = useSessionStore((s) => s.autoPair);

  useEffect(() => {
    void getBackendUrl().then((url) => {
      setCurrentUrl(url);
      setDraftUrl(url);
    });
  }, []);

  async function handleSave() {
    const trimmed = draftUrl.trim();
    if (!trimmed) return;
    if (!/^https?:\/\//.test(trimmed)) {
      Alert.alert("Invalid URL", "Backend URL must start with http:// or https://");
      return;
    }
    setSaving(true);
    try {
      await setBackendUrl(trimmed);
      setCurrentUrl(trimmed);
      Alert.alert("Saved", "New chat/WS connections will use this backend from now on.");
    } finally {
      setSaving(false);
    }
  }

  async function handleTestPush() {
    setPushStatus("Registering…");
    const result = await registerForPushNotificationsAsync();
    setPushStatus(result.ok ? "Registered — push token sent to backend." : `Not available: ${result.reason}`);
  }

  return (
    <View style={[styles.container, { paddingTop: topPadding }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back">
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Settings</Text>
        <View style={{ width: 50 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Panel style={styles.section}>
          <Text style={styles.sectionTitle}>Backend connection</Text>
          <Text style={styles.sectionSubtitle}>
            Currently: {currentUrl || "…"}{"\n"}WS gateway: {currentUrl ? wsUrlFrom(currentUrl) : "…"}
          </Text>
          <TextInput
            style={styles.input}
            value={draftUrl}
            onChangeText={setDraftUrl}
            placeholder="http://192.168.1.50:8080"
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <PrimaryButton label="Save & use this backend" onPress={() => void handleSave()} loading={saving} disabled={!draftUrl.trim()} />
          <Text style={styles.hint}>
            On a physical phone, "localhost" means the phone itself — use your dev machine's LAN IP (e.g.
            http://192.168.x.x:8080) or your Oracle backend's public URL. See docs/architecture/10-android-setup.md.
          </Text>
        </Panel>

        <Panel style={styles.section}>
          <Text style={styles.sectionTitle}>Push notifications</Text>
          <PrimaryButton label="Register this device" variant="ghost" onPress={() => void handleTestPush()} />
          {pushStatus && <Text style={styles.hint}>{pushStatus}</Text>}
        </Panel>

        <Panel style={styles.section}>
          <Text style={styles.sectionTitle}>Account</Text>
          <PrimaryButton
            label="Sign out"
            variant="danger"
            onPress={() =>
              Alert.alert("Sign out?", "This device will silently reconnect to the backend the next time you open the app.", [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Sign out",
                  style: "destructive",
                  onPress: () =>
                    void signOut()
                      .then(() => autoPair())
                      .then(() => router.replace("/(command-center)"))
                      .catch(() => router.replace("/")),
                },
              ])
            }
          />
        </Panel>

        <Text style={styles.version}>MD AI · v{Constants.expoConfig?.version ?? "0.0.0"}</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.lg },
  back: { color: colors.secondary, fontSize: typography.fontSize.md, width: 50 },
  title: { color: colors.textPrimary, fontSize: typography.fontSize.lg, fontWeight: "700" },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  section: { gap: spacing.md },
  sectionTitle: { color: colors.textPrimary, fontSize: typography.fontSize.md, fontWeight: "600" },
  sectionSubtitle: { color: colors.textSecondary, fontSize: typography.fontSize.xs },
  input: {
    color: colors.textPrimary,
    backgroundColor: colors.bgSurfaceRaised,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: typography.fontSize.sm,
  },
  hint: { color: colors.textTertiary, fontSize: typography.fontSize.xs, lineHeight: 18 },
  version: { color: colors.textTertiary, fontSize: typography.fontSize.xs, textAlign: "center" },
});
