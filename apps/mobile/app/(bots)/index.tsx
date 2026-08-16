import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, RefreshControl } from "react-native";
import { router } from "expo-router";
import { colors, radius, spacing, typography, type StatusColor } from "../../src/theme/tokens";
import { useScreenTopPadding } from "../../src/hooks/useScreenTopPadding";
import { StatusDot } from "../../src/components/StatusDot";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { useBotsStore } from "../../src/state/botsStore";
import type { BotDto, BotHealth, BotStatus, FindingImportance } from "../../src/api/client";

/**
 * M5.16: the Bot Fleet screen — NOT the 3D Command Center (explicitly out
 * of scope for M5). A flat, glanceable list consistent with the Vault
 * screen's card layout: every registered bot, its current status/health,
 * last/last-successful run, failure count, and recent findings, with
 * enable/disable/pause/resume/run-once controls.
 */

function healthToStatus(h: BotHealth): StatusColor {
  return h === "healthy" ? "connected" : h === "degraded" ? "working" : h === "unavailable" ? "error" : "idle";
}

function statusLabel(status: BotStatus, health: BotHealth): string {
  if (status === "running") return "Running";
  if (status === "paused") return "Paused";
  if (status === "disabled") return "Disabled";
  if (status === "error") return "Error";
  return health === "healthy" ? "Idle · healthy" : health === "degraded" ? "Idle · degraded" : "Idle";
}

function importanceColor(importance: FindingImportance): string {
  switch (importance) {
    case "critical":
      return colors.danger;
    case "high":
      return colors.warning;
    case "medium":
      return colors.secondary;
    default:
      return colors.textTertiary;
  }
}

function relativeTime(iso?: string): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function BotCard({ bot }: { bot: BotDto }) {
  const [expanded, setExpanded] = useState(false);
  const { detail, loadDetail, setEnabled, setPaused, runNow } = useBotsStore();
  const d = detail[bot.id];

  useEffect(() => {
    if (expanded && !d) void loadDetail(bot.id);
  }, [expanded, d, bot.id, loadDetail]);

  return (
    <View style={styles.card}>
      <Pressable onPress={() => setExpanded((e) => !e)} style={styles.cardHeader}>
        <View style={{ flex: 1 }}>
          <View style={styles.titleRow}>
            <Text style={styles.botName}>{bot.displayName}</Text>
            <View style={styles.categoryBadge}>
              <Text style={styles.categoryText}>{bot.category.replace("_", " ")}</Text>
            </View>
          </View>
          <View style={styles.statusRow}>
            <StatusDot status={bot.enabled ? healthToStatus(bot.health) : "idle"} />
            <Text style={styles.statusText}>{bot.enabled ? statusLabel(bot.status, bot.health) : "Disabled"}</Text>
          </View>
        </View>
        <Text style={styles.chevron}>{expanded ? "▾" : "▸"}</Text>
      </Pressable>

      <Text style={styles.description}>{bot.description}</Text>

      <View style={styles.metaRow}>
        <Text style={styles.metaText}>Last run: {relativeTime(bot.lastRunAt)}</Text>
        <Text style={styles.metaText}>Last success: {relativeTime(bot.lastSuccessfulRunAt)}</Text>
        {bot.failureCount > 0 && <Text style={[styles.metaText, { color: colors.danger }]}>{bot.failureCount} recent failures</Text>}
      </View>

      <View style={styles.actionsRow}>
        <PrimaryButton
          label={bot.enabled ? "Disable" : "Enable"}
          variant="ghost"
          onPress={() => void setEnabled(bot.id, !bot.enabled)}
        />
        {bot.enabled && (
          <PrimaryButton
            label={bot.status === "paused" ? "Resume" : "Pause"}
            variant="ghost"
            onPress={() => void setPaused(bot.id, bot.status !== "paused")}
          />
        )}
        <PrimaryButton
          label="Run now"
          variant="ghost"
          loading={d?.runningNow ?? false}
          disabled={!bot.enabled}
          onPress={() => void runNow(bot.id)}
        />
      </View>

      {expanded && (
        <View style={styles.detailSection}>
          {d?.loadingDetail ? (
            <Text style={styles.metaText}>Loading…</Text>
          ) : (
            <>
              <Text style={styles.sectionHeading}>Recent findings {d?.findings.length ? `(${d.findings.length})` : ""}</Text>
              {d?.findings.length ? (
                d.findings.slice(0, 8).map((f) => (
                  <View key={f.id} style={styles.findingRow}>
                    <View style={[styles.importanceDot, { backgroundColor: importanceColor(f.importance) }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.findingTitle}>{f.title}</Text>
                      <Text style={styles.findingMeta}>
                        {f.category} · {f.status}
                        {f.occurrenceCount > 1 ? ` · seen ${f.occurrenceCount}×` : ""} · {relativeTime(f.lastSeenAt)}
                      </Text>
                    </View>
                  </View>
                ))
              ) : (
                <Text style={styles.metaText}>No findings yet.</Text>
              )}

              <Text style={[styles.sectionHeading, { marginTop: spacing.md }]}>Recent runs</Text>
              {d?.runs.length ? (
                d.runs.slice(0, 5).map((r) => (
                  <View key={r.id} style={styles.runRow}>
                    <StatusDot
                      status={r.status === "succeeded" ? "connected" : r.status === "running" ? "working" : "error"}
                      size={6}
                    />
                    <Text style={styles.runText}>
                      {r.status} · {relativeTime(r.startedAt)}
                      {r.durationMs ? ` · ${r.durationMs}ms` : ""} · {r.findingsCount} finding(s)
                    </Text>
                  </View>
                ))
              ) : (
                <Text style={styles.metaText}>No runs recorded yet.</Text>
              )}
            </>
          )}
        </View>
      )}
    </View>
  );
}

export default function BotFleetScreen() {
  const topPadding = useScreenTopPadding();
  const { bots, loading, error, loadBots } = useBotsStore();

  useEffect(() => {
    void loadBots();
  }, [loadBots]);

  return (
    <View style={[styles.container, { paddingTop: topPadding }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Bot Fleet</Text>
        <View style={{ width: 50 }} />
      </View>
      <Text style={styles.subtitle}>
        Deterministic background workers — they detect and surface signals, they never answer for you.
      </Text>

      {error && <Text style={styles.errorText}>{error}</Text>}

      <ScrollView
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadBots()} tintColor={colors.accent} />}
      >
        {bots.map((bot) => (
          <BotCard key={bot.id} bot={bot} />
        ))}
        {!loading && bots.length === 0 && <Text style={styles.subtitle}>No bots registered.</Text>}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.lg },
  back: { color: colors.secondary, fontSize: typography.fontSize.md, width: 50 },
  title: { color: colors.textPrimary, fontSize: typography.fontSize.lg, fontWeight: "700" },
  subtitle: {
    color: colors.textTertiary,
    fontSize: typography.fontSize.xs,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
  },
  errorText: { color: colors.danger, fontSize: typography.fontSize.xs, paddingHorizontal: spacing.lg, marginBottom: spacing.sm },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  card: {
    backgroundColor: colors.bgSurface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  cardHeader: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
  botName: { color: colors.textPrimary, fontSize: typography.fontSize.md, fontWeight: "600" },
  categoryBadge: {
    borderWidth: 1,
    borderColor: colors.secondary,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
  },
  categoryText: { color: colors.secondary, fontSize: 10, fontWeight: "700", textTransform: "uppercase" },
  statusRow: { flexDirection: "row", alignItems: "center", marginTop: spacing.xs },
  statusText: { color: colors.textSecondary, fontSize: typography.fontSize.xs },
  chevron: { color: colors.textTertiary, fontSize: typography.fontSize.md },
  description: { color: colors.textTertiary, fontSize: typography.fontSize.xs, marginTop: spacing.sm },
  metaRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md, marginTop: spacing.sm },
  metaText: { color: colors.textSecondary, fontSize: typography.fontSize.xs },
  actionsRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  detailSection: { marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  sectionHeading: { color: colors.textSecondary, fontSize: typography.fontSize.xs, fontWeight: "700" },
  findingRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, marginTop: spacing.sm },
  importanceDot: { width: 7, height: 7, borderRadius: 4, marginTop: 5 },
  findingTitle: { color: colors.textPrimary, fontSize: typography.fontSize.sm },
  findingMeta: { color: colors.textTertiary, fontSize: 11, marginTop: 1 },
  runRow: { flexDirection: "row", alignItems: "center", marginTop: spacing.xs },
  runText: { color: colors.textSecondary, fontSize: typography.fontSize.xs },
});
