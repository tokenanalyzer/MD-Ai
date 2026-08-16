import React, { useEffect, useState } from "react";
import { View, Text, TextInput, StyleSheet, KeyboardAvoidingView, Platform } from "react-native";
import { router } from "expo-router";
import { colors, radius, spacing, typography } from "../../src/theme/tokens";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { useSessionStore } from "../../src/state/sessionStore";
import { ApiError } from "../../src/api/client";
import { getBackendUrl, setBackendUrl } from "../../src/api/backendUrl";

export default function PairingScreen() {
  const pair = useSessionStore((s) => s.pair);
  const [pairingCode, setPairingCode] = useState("");
  const [deviceName, setDeviceName] = useState("My Phone");
  const [backendUrl, setBackendUrlDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getBackendUrl().then(setBackendUrlDraft);
  }, []);

  async function handlePair() {
    setLoading(true);
    setError(null);
    try {
      const trimmedUrl = backendUrl.trim().replace(/\/$/, "");
      if (!/^https?:\/\//.test(trimmedUrl)) {
        setError("Backend URL must start with http:// or https://");
        return;
      }
      await setBackendUrl(trimmedUrl);
      await pair(pairingCode.trim().toUpperCase(), deviceName.trim() || "My Phone");
      router.replace("/(command-center)");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the MD AI backend");
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.content}>
        <Text style={styles.title}>MD AI</Text>
        <Text style={styles.subtitle}>Private personal intelligence, running on your own backend.</Text>

        <View style={styles.card}>
          <Text style={styles.label}>Backend URL</Text>
          <Text style={styles.hint}>Where your MD AI backend is running.</Text>
          <TextInput
            style={styles.input}
            value={backendUrl}
            onChangeText={setBackendUrlDraft}
            placeholder="https://your-backend.example.com"
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          <Text style={[styles.label, { marginTop: spacing.lg }]}>Pairing code</Text>
          <Text style={styles.hint}>Printed once in your backend's startup log.</Text>
          <TextInput
            style={styles.input}
            value={pairingCode}
            onChangeText={setPairingCode}
            placeholder="XXXXXXXX"
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="characters"
            autoCorrect={false}
          />

          <Text style={[styles.label, { marginTop: spacing.lg }]}>Device name</Text>
          <TextInput
            style={styles.input}
            value={deviceName}
            onChangeText={setDeviceName}
            placeholderTextColor={colors.textTertiary}
          />

          {error && <Text style={styles.error}>{error}</Text>}

          <PrimaryButton
            label="Pair device"
            onPress={handlePair}
            loading={loading}
            disabled={pairingCode.trim().length === 0}
            style={{ marginTop: spacing.xl }}
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase },
  content: { flex: 1, justifyContent: "center", paddingHorizontal: spacing.xl },
  title: {
    color: colors.textPrimary,
    fontSize: 34,
    fontWeight: "700",
    letterSpacing: 1,
    textAlign: "center",
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: typography.fontSize.sm,
    textAlign: "center",
    marginTop: spacing.sm,
    marginBottom: spacing.xxl,
  },
  card: {
    backgroundColor: colors.bgSurface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
  },
  label: { color: colors.textPrimary, fontSize: typography.fontSize.sm, fontWeight: "600" },
  hint: { color: colors.textTertiary, fontSize: typography.fontSize.xs, marginTop: 2, marginBottom: spacing.sm },
  input: {
    backgroundColor: colors.bgSurfaceRaised,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: typography.fontSize.md,
  },
  error: { color: colors.danger, fontSize: typography.fontSize.sm, marginTop: spacing.md },
});
