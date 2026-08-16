import React, { useEffect, useState } from "react";
import { View, Text, TextInput, StyleSheet, ScrollView, Pressable } from "react-native";
import { router } from "expo-router";
import { colors, radius, spacing, typography } from "../../src/theme/tokens";
import { useScreenTopPadding } from "../../src/hooks/useScreenTopPadding";
import { StatusDot } from "../../src/components/StatusDot";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { useVaultStore } from "../../src/state/vaultStore";
import { useChatStore } from "../../src/state/chatStore";
import type { ModelRegistryEntryDto } from "../../src/api/client";

function availabilityToStatus(a: ModelRegistryEntryDto["availability"]) {
  return a === "available" ? "connected" : a === "degraded" ? "working" : a === "unavailable" ? "error" : "idle";
}

export default function VaultScreen() {
  const topPadding = useScreenTopPadding();
  const { entries, loading, loadAll, addAndTestKey, removeKey, setDefault, setDefaultModel } = useVaultStore();
  const { routingMode, setRoutingMode, preferredProviderId, preferredModelId, setManualModel } = useChatStore();
  const [draftKeys, setDraftKeys] = useState<Record<string, string>>({});

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const providerList = Object.values(entries).sort((a, b) => a.provider.displayName.localeCompare(b.provider.displayName));

  return (
    <View style={[styles.container, { paddingTop: topPadding }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Provider Vault</Text>
        <View style={{ width: 50 }} />
      </View>
      <Text style={styles.subtitle}>
        Keys are stored on this device only (Android Keystore) and sent to your backend only when needed to answer a
        message.
      </Text>

      <View style={styles.routingToggleRow}>
        <Text style={styles.routingLabel}>Routing</Text>
        <View style={styles.segmentGroup}>
          {(["auto", "manual"] as const).map((mode) => (
            <Pressable
              key={mode}
              onPress={() => setRoutingMode(mode)}
              style={[styles.segment, routingMode === mode && styles.segmentActive]}
            >
              <Text style={[styles.segmentText, routingMode === mode && styles.segmentTextActive]}>
                {mode.toUpperCase()}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      <Text style={styles.subtitle}>
        {routingMode === "auto"
          ? "AUTO: the Model Router scores every connected model and picks the best fit, with fallback."
          : `MANUAL: always use exactly the model you pick below.${preferredProviderId ? ` Currently: ${preferredModelId ?? preferredProviderId}` : " Tap a model below to pin it."}`}
      </Text>

      <ScrollView contentContainerStyle={styles.list}>
        {providerList.map(({ provider, configs, models, testing, testError }) => {
          const connected = configs.find((c) => c.status === "connected");
          const statusKind = testing ? "working" : connected ? "connected" : configs.length > 0 ? "error" : "idle";

          return (
            <View key={provider.id} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.providerName}>{provider.displayName}</Text>
                <View style={styles.statusRow}>
                  <StatusDot status={statusKind} />
                  <Text style={styles.statusLabel}>
                    {testing ? "Testing…" : connected ? "Connected" : configs.length > 0 ? "Error" : "Not configured"}
                  </Text>
                </View>
              </View>

              {configs.map((config) => (
                <View key={config.id} style={styles.configRow}>
                  <Text style={styles.configLabel}>
                    Key ending in {config.keyLast4 ?? "····"} {config.isDefault ? "· default" : ""}
                  </Text>
                  <View style={styles.configActions}>
                    {!config.isDefault && (
                      <Pressable onPress={() => setDefault(provider.id, config.id)}>
                        <Text style={styles.actionLink}>Make default</Text>
                      </Pressable>
                    )}
                    <Pressable onPress={() => removeKey(provider.id, config.id)}>
                      <Text style={[styles.actionLink, { color: colors.danger }]}>Remove</Text>
                    </Pressable>
                  </View>
                </View>
              ))}

              {testError && <Text style={styles.errorText}>{testError}</Text>}

              <View style={styles.addRow}>
                <TextInput
                  style={styles.input}
                  placeholder={`${provider.displayName} API key`}
                  placeholderTextColor={colors.textTertiary}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={draftKeys[provider.id] ?? ""}
                  onChangeText={(text) => setDraftKeys((s) => ({ ...s, [provider.id]: text }))}
                />
                <PrimaryButton
                  label="Test & Save"
                  variant="ghost"
                  loading={testing}
                  disabled={!draftKeys[provider.id]}
                  onPress={async () => {
                    const key = draftKeys[provider.id];
                    if (!key) return;
                    await addAndTestKey(provider.id, key);
                    setDraftKeys((s) => ({ ...s, [provider.id]: "" }));
                  }}
                />
              </View>

              {models.length > 0 && (
                <View style={styles.modelsSection}>
                  <Text style={styles.modelsHeading}>
                    Available models {models.length > 0 ? `(${models.length})` : ""}
                  </Text>
                  {models.map((model) => {
                    const defaultConfig = configs.find((c) => c.defaultModelId === model.id);
                    const isManualPick = routingMode === "manual" && preferredModelId === model.id;
                    return (
                      <Pressable
                        key={model.id}
                        style={[styles.modelRow, isManualPick && styles.modelRowSelected]}
                        onPress={() => routingMode === "manual" && setManualModel(provider.id, model.id)}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={styles.modelName}>{model.displayName}</Text>
                          <Text style={styles.modelMeta}>
                            {model.capabilities.contextLength.toLocaleString()} ctx
                            {model.capabilities.supportsVision ? " · vision" : ""}
                            {model.capabilities.supportsTools ? " · tools" : ""}
                            {model.capabilities.supportsReasoning ? " · reasoning" : ""}
                            {model.avgLatencyMs ? ` · ${model.avgLatencyMs}ms avg` : ""}
                          </Text>
                        </View>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                          <StatusDot status={availabilityToStatus(model.availability)} />
                          {defaultConfig ? (
                            <Text style={styles.defaultBadge}>default</Text>
                          ) : (
                            connected && (
                              <Pressable onPress={() => setDefaultModel(provider.id, connected.id, model.id)}>
                                <Text style={styles.actionLink}>Set default</Text>
                              </Pressable>
                            )
                          )}
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>
          );
        })}
        {loading && providerList.length === 0 && <Text style={styles.subtitle}>Loading providers…</Text>}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
  },
  back: { color: colors.secondary, fontSize: typography.fontSize.md, width: 50 },
  title: { color: colors.textPrimary, fontSize: typography.fontSize.lg, fontWeight: "700" },
  subtitle: {
    color: colors.textTertiary,
    fontSize: typography.fontSize.xs,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
  },
  routingToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    marginTop: spacing.sm,
  },
  routingLabel: { color: colors.textPrimary, fontSize: typography.fontSize.sm, fontWeight: "600" },
  segmentGroup: {
    flexDirection: "row",
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  segment: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  segmentActive: { backgroundColor: colors.accentGlow },
  segmentText: { color: colors.textTertiary, fontSize: typography.fontSize.xs, fontWeight: "700" },
  segmentTextActive: { color: colors.accent },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  card: {
    backgroundColor: colors.bgSurface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  providerName: { color: colors.textPrimary, fontSize: typography.fontSize.md, fontWeight: "600" },
  statusRow: { flexDirection: "row", alignItems: "center" },
  statusLabel: { color: colors.textSecondary, fontSize: typography.fontSize.xs },
  configRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  configLabel: { color: colors.textSecondary, fontSize: typography.fontSize.sm },
  configActions: { flexDirection: "row", gap: spacing.md },
  actionLink: { color: colors.secondary, fontSize: typography.fontSize.xs, fontWeight: "600" },
  errorText: { color: colors.danger, fontSize: typography.fontSize.xs, marginTop: spacing.sm },
  addRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md, alignItems: "center" },
  input: {
    flex: 1,
    color: colors.textPrimary,
    backgroundColor: colors.bgSurfaceRaised,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: typography.fontSize.sm,
  },
  modelsSection: { marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  modelsHeading: { color: colors.textSecondary, fontSize: typography.fontSize.xs, fontWeight: "700", marginBottom: spacing.xs },
  modelRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
  },
  modelRowSelected: { backgroundColor: colors.accentGlow, borderWidth: 1, borderColor: colors.accentDim },
  modelName: { color: colors.textPrimary, fontSize: typography.fontSize.sm, fontWeight: "600" },
  modelMeta: { color: colors.textTertiary, fontSize: typography.fontSize.xs, marginTop: 2 },
  defaultBadge: {
    color: colors.accent,
    fontSize: typography.fontSize.xs,
    fontWeight: "700",
    borderWidth: 1,
    borderColor: colors.accentDim,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
});
