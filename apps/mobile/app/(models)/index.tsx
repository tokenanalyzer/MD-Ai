import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, RefreshControl } from "react-native";
import { router } from "expo-router";
import { colors, radius, spacing, typography } from "../../src/theme/tokens";
import { useScreenTopPadding } from "../../src/hooks/useScreenTopPadding";
import { Panel } from "../../src/components/Panel";
import { SectionLabel } from "../../src/components/SectionLabel";
import { PulseDot } from "../../src/components/PulseDot";
import { EmptyState } from "../../src/components/EmptyState";
import { useVaultStore, type ProviderVaultEntry } from "../../src/state/vaultStore";
import { useChatStore } from "../../src/state/chatStore";
import type { ModelRegistryEntryDto } from "../../src/api/client";

function availabilityColor(a: ModelRegistryEntryDto["availability"]): string {
  switch (a) {
    case "available":
      return colors.success;
    case "degraded":
      return colors.warning;
    case "unavailable":
      return colors.danger;
    default:
      return colors.textTertiary;
  }
}

function ModelRow({
  entry,
  model,
  isCurrent,
}: {
  entry: ProviderVaultEntry;
  model: ModelRegistryEntryDto;
  isCurrent: boolean;
}) {
  const defaultConfig = entry.configs.find((c) => c.defaultModelId === model.id);
  return (
    <View style={[styles.modelRow, isCurrent && styles.modelRowCurrent]}>
      <PulseDot color={availabilityColor(model.availability)} active={model.availability === "available" && isCurrent} size={7} />
      <View style={{ flex: 1 }}>
        <View style={styles.modelNameRow}>
          <Text style={styles.modelName}>{model.displayName}</Text>
          {defaultConfig && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>default</Text>
            </View>
          )}
          {isCurrent && (
            <View style={[styles.badge, styles.badgeCurrent]}>
              <Text style={[styles.badgeText, styles.badgeTextCurrent]}>current</Text>
            </View>
          )}
          {!model.userEnabled && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>disabled</Text>
            </View>
          )}
        </View>
        <Text style={styles.modelMeta} numberOfLines={1}>
          {model.capabilities.contextLength.toLocaleString()} ctx
          {model.capabilities.supportsVision ? " · vision" : ""}
          {model.capabilities.supportsTools ? " · tools" : ""}
          {model.capabilities.supportsReasoning ? " · reasoning" : ""}
        </Text>
        <Text style={styles.modelMeta} numberOfLines={1}>
          {model.avgLatencyMs !== undefined ? `${model.avgLatencyMs}ms avg` : "no latency data yet"}
          {model.errorRatePct !== undefined ? ` · ${model.errorRatePct.toFixed(1)}% error rate` : ""}
          {` · priority ${model.userPriority}`}
        </Text>
      </View>
    </View>
  );
}

function ProviderCard({ entry }: { entry: ProviderVaultEntry }) {
  const { routingMode, preferredProviderId, preferredModelId } = useChatStore();
  const [expanded, setExpanded] = useState(false);
  const connected = entry.configs.find((c) => c.status === "connected");
  const status = connected ? "Connected" : entry.configs.length > 0 ? "Error" : "Not configured";
  const models = [...entry.models].sort((a, b) => b.userPriority - a.userPriority);
  const currentDefault = models.find((m) => entry.configs.some((c) => c.defaultModelId === m.id));

  return (
    <Panel style={styles.card}>
      <View style={styles.cardHeader}>
        <PulseDot color={connected ? colors.accent : entry.configs.length > 0 ? colors.danger : colors.textTertiary} active={false} size={9} />
        <Text style={styles.providerName}>{entry.provider.displayName}</Text>
        <Text style={styles.providerStatus}>{status}</Text>
      </View>

      {models.length === 0 ? (
        <Text style={styles.empty}>No models discovered for this provider yet.</Text>
      ) : (
        <>
          <Pressable style={styles.modelsToggleRow} onPress={() => setExpanded((v) => !v)}>
            <Text style={styles.modelsToggleLabel}>{models.length} model{models.length === 1 ? "" : "s"}</Text>
            <Text style={styles.modelsToggle}>{expanded ? "Hide ▲" : "Show ▾"}</Text>
          </Pressable>
          {!expanded && currentDefault && <Text style={styles.empty}>Using: {currentDefault.displayName}</Text>}
          {expanded && (
            <View style={styles.modelsList}>
              {models.map((model) => (
                <ModelRow
                  key={model.id}
                  entry={entry}
                  model={model}
                  isCurrent={routingMode === "manual" && preferredProviderId === entry.provider.id && preferredModelId === model.id}
                />
              ))}
            </View>
          )}
        </>
      )}
    </Panel>
  );
}

/**
 * M6.6 MODEL/PROVIDER CENTER — reuses vaultStore's already-fetched
 * provider/config/model data (the same source Vault's key-management UI
 * reads) but renders a read-only telemetry view: availability, latency,
 * error rate, routing priority, current/default model. Never renders
 * keyLast4 or any key-management controls — this screen shows no
 * key material at all, unlike Vault.
 */
export default function ModelsScreen() {
  const topPadding = useScreenTopPadding();
  const { entries, loading, loadAll } = useVaultStore();
  const { routingMode } = useChatStore();

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const providerList = Object.values(entries).sort((a, b) => a.provider.displayName.localeCompare(b.provider.displayName));

  return (
    <View style={[styles.container, { paddingTop: topPadding }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back">
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Model / Provider Center</Text>
        <View style={{ width: 50 }} />
      </View>
      <View style={styles.routingBanner}>
        <SectionLabel>Routing Mode</SectionLabel>
        <Text style={styles.routingText}>
          {routingMode === "auto" ? "AUTO — the Model Router scores every connected model." : "MANUAL — pinned to the model marked \"current\" below."}
        </Text>
        <Pressable onPress={() => router.push("/(vault)")}>
          <Text style={styles.vaultLink}>Manage API keys in Provider Vault →</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadAll()} tintColor={colors.accent} />}
      >
        {providerList.length === 0 && loading && <EmptyState kind="loading" message="Loading providers…" />}
        {providerList.length === 0 && !loading && <EmptyState kind="empty" message="No providers configured yet." detail="Add an API key in Provider Vault to get started." />}
        {providerList.map((entry) => (
          <ProviderCard key={entry.provider.id} entry={entry} />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.lg },
  back: { color: colors.secondary, fontSize: typography.fontSize.md, width: 50 },
  title: { color: colors.textPrimary, fontSize: typography.fontSize.lg, fontWeight: "700" },
  routingBanner: { paddingHorizontal: spacing.lg, marginTop: spacing.md, marginBottom: spacing.sm },
  routingText: { color: colors.textSecondary, fontSize: typography.fontSize.xs },
  vaultLink: { color: colors.secondary, fontSize: typography.fontSize.xs, fontWeight: "600", marginTop: spacing.sm },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  card: { marginBottom: spacing.md },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.sm },
  providerName: { color: colors.textPrimary, fontSize: typography.fontSize.md, fontWeight: "700", flex: 1 },
  providerStatus: { color: colors.textTertiary, fontSize: typography.fontSize.xs },
  empty: { color: colors.textTertiary, fontSize: typography.fontSize.xs },
  modelsToggleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  modelsToggleLabel: { color: colors.textSecondary, fontSize: typography.fontSize.xs, fontWeight: "700" },
  modelsToggle: { color: colors.secondary, fontSize: typography.fontSize.xs, fontWeight: "600" },
  modelsList: { gap: spacing.sm, marginTop: spacing.sm },
  modelRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
  },
  modelRowCurrent: { backgroundColor: colors.accentGlow, borderWidth: 1, borderColor: colors.accentDim },
  modelNameRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, flexWrap: "wrap" },
  modelName: { color: colors.textPrimary, fontSize: typography.fontSize.sm, fontWeight: "600" },
  modelMeta: { color: colors.textTertiary, fontSize: typography.fontSize.xs, marginTop: 2 },
  badge: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 1 },
  badgeText: { color: colors.textTertiary, fontSize: 9, fontWeight: "700", textTransform: "uppercase" },
  badgeCurrent: { borderColor: colors.accentDim },
  badgeTextCurrent: { color: colors.accent },
});
