import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, RefreshControl } from "react-native";
import { router } from "expo-router";
import { colors, radius, spacing, typography } from "../../src/theme/tokens";
import { Panel } from "../../src/components/Panel";
import { PulseDot } from "../../src/components/PulseDot";
import { EventRow } from "../../src/components/EventRow";
import { EmptyState } from "../../src/components/EmptyState";
import { useToolsStore } from "../../src/state/toolsStore";
import { useEventsStore } from "../../src/state/eventsStore";
import type { ToolDefinitionDto } from "../../src/api/client";

function healthColor(h: ToolDefinitionDto["health"]): string {
  switch (h) {
    case "healthy":
      return colors.success;
    case "degraded":
      return colors.warning;
    case "unavailable":
      return colors.danger;
    default:
      return colors.textTertiary;
  }
}

function riskColor(risk: ToolDefinitionDto["riskLevel"]): string {
  switch (risk) {
    case "high":
      return colors.danger;
    case "medium":
      return colors.warning;
    default:
      return colors.textTertiary;
  }
}

function accessLabel(access: ToolDefinitionDto["defaultAccess"]): string {
  switch (access) {
    case "allowed":
      return "Allowed";
    case "restricted":
      return "Restricted (approval required)";
    default:
      return "Denied";
  }
}

function relativeTime(iso?: string): string {
  if (!iso) return "never verified";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function ToolCard({ tool }: { tool: ToolDefinitionDto }) {
  const [expanded, setExpanded] = useState(false);
  const events = useEventsStore((s) => s.events);
  const recentInvocations = useMemo(
    () =>
      events
        .filter((e) => e.sourceType === "tool" && e.sourceId === tool.id)
        .slice(-10)
        .reverse(),
    [events, tool.id],
  );

  return (
    <Panel style={styles.card}>
      <Pressable onPress={() => setExpanded((v) => !v)} style={styles.cardHeader}>
        <View style={{ flex: 1 }}>
          <View style={styles.titleRow}>
            <PulseDot color={healthColor(tool.health)} active={false} size={8} />
            <Text style={[styles.name, !tool.enabled && styles.dimmed]}>{tool.displayName}</Text>
            <View style={[styles.riskBadge, { borderColor: riskColor(tool.riskLevel) }]}>
              <Text style={[styles.riskBadgeText, { color: riskColor(tool.riskLevel) }]}>{tool.riskLevel}</Text>
            </View>
          </View>
          <Text style={styles.description} numberOfLines={expanded ? undefined : 2}>
            {tool.description}
          </Text>
        </View>
        <Text style={styles.chevron}>{expanded ? "▾" : "▸"}</Text>
      </Pressable>

      <View style={styles.metaRow}>
        <Text style={styles.metaText}>Access: {accessLabel(tool.defaultAccess)}</Text>
        <Text style={styles.metaText}>{tool.enabled ? "Enabled" : "Disabled"}</Text>
      </View>
      <View style={styles.metaRow}>
        <Text style={styles.metaText}>Health: {tool.health}{tool.healthDetail ? ` · ${tool.healthDetail}` : ""}</Text>
        <Text style={styles.metaText}>Verified {relativeTime(tool.lastVerifiedAt)}</Text>
      </View>

      {expanded && (
        <View style={styles.detailSection}>
          {tool.requiredCapabilities.length > 0 && (
            <View style={styles.chipRow}>
              {tool.requiredCapabilities.map((c) => (
                <View key={c} style={styles.chip}>
                  <Text style={styles.chipText}>{c}</Text>
                </View>
              ))}
            </View>
          )}
          <Text style={styles.metaText}>
            Source: {tool.source === "builtin" ? "Built-in" : "MCP server"} · Owner: {tool.owner} · Timeout: {tool.timeoutMs}ms
            {tool.requiresApproval ? " · requires approval" : ""}
          </Text>

          <Text style={[styles.sectionHeading, { marginTop: spacing.md }]}>Recent invocations</Text>
          {recentInvocations.length === 0 ? (
            <Text style={styles.metaText}>No recent invocations recorded in this session.</Text>
          ) : (
            recentInvocations.map((e) => <EventRow key={e.id} event={e} />)
          )}
        </View>
      )}
    </Panel>
  );
}

/**
 * M6.8 TOOLS CENTER — every field comes from the Tool Registry (M4.1) via
 * GET /tools; "recent invocations" is the live event stream filtered to
 * this tool's own tool.called/completed/failed/blocked events, rendered
 * through the same describeEvent() used everywhere else, which never
 * surfaces raw arguments/results — only safe status metadata.
 */
export default function ToolsScreen() {
  const { tools, loading, error, loadTools } = useToolsStore();
  const connect = useEventsStore((s) => s.connect);

  useEffect(() => {
    void loadTools();
    void connect();
  }, [loadTools, connect]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Tools Center</Text>
        <View style={{ width: 50 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadTools()} tintColor={colors.accent} />}
      >
        {tools.length === 0 && loading && <EmptyState kind="loading" message="Loading tools…" />}
        {tools.length === 0 && error && <EmptyState kind="error" message="Couldn't load tools" detail={error} />}
        {tools.length === 0 && !loading && !error && <EmptyState kind="empty" message="No tools registered." />}
        {tools.map((tool) => (
          <ToolCard key={tool.id} tool={tool} />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase, paddingTop: spacing.xl },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.lg },
  back: { color: colors.secondary, fontSize: typography.fontSize.md, width: 50 },
  title: { color: colors.textPrimary, fontSize: typography.fontSize.lg, fontWeight: "700" },
  list: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xxl, gap: spacing.md },
  card: { marginBottom: spacing.md },
  cardHeader: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
  name: { color: colors.textPrimary, fontSize: typography.fontSize.md, fontWeight: "700" },
  dimmed: { color: colors.textTertiary },
  riskBadge: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 1 },
  riskBadgeText: { fontSize: 9, fontWeight: "700", textTransform: "uppercase" },
  description: { color: colors.textTertiary, fontSize: typography.fontSize.xs, marginTop: spacing.xs },
  chevron: { color: colors.textTertiary, fontSize: typography.fontSize.md },
  metaRow: { flexDirection: "row", justifyContent: "space-between", marginTop: spacing.sm },
  metaText: { color: colors.textSecondary, fontSize: typography.fontSize.xs },
  detailSection: { marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginBottom: spacing.sm },
  chip: { backgroundColor: colors.secondaryGlow, borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  chipText: { color: colors.secondary, fontSize: 10 },
  sectionHeading: { color: colors.textSecondary, fontSize: typography.fontSize.xs, fontWeight: "700" },
});
