import React, { useEffect, useMemo } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { colors, radius, spacing, typography } from "../../src/theme/tokens";
import { Panel } from "../../src/components/Panel";
import { SectionLabel } from "../../src/components/SectionLabel";
import { PulseDot } from "../../src/components/PulseDot";
import { EventRow } from "../../src/components/EventRow";
import { EmptyState } from "../../src/components/EmptyState";
import { useAgentsStore } from "../../src/state/agentsStore";
import { useEventsStore } from "../../src/state/eventsStore";

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

/**
 * M6.5 AGENT DETAIL — every field sourced from the Agent Registry (GET
 * /agents, GET /agents/:id/delegations) or the real event stream filtered
 * to this agent's own events. No synthesized "recent activity."
 */
export default function AgentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { agents, delegations, loadAgents, loadDelegations, setEnabled } = useAgentsStore();
  const { events, connection, connect } = useEventsStore();

  useEffect(() => {
    if (agents.length === 0) void loadAgents();
    void loadDelegations(id);
    void connect();
  }, [id, agents.length, loadAgents, loadDelegations, connect]);

  const agent = agents.find((a) => a.id === id);
  const allowedDelegations = delegations[id] ?? [];
  const recentActivity = useMemo(
    () =>
      events
        .filter((e) => e.sourceType === "agent" && e.sourceId === id)
        .slice(-15)
        .reverse(),
    [events, id],
  );

  if (!agent) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back">
            <Text style={styles.back}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>Agent</Text>
          <View style={{ width: 50 }} />
        </View>
        <EmptyState kind="loading" message="Loading agent…" />
      </View>
    );
  }

  const disabled = agent.status === "disabled";
  const working = agent.status === "working";

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back">
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {agent.displayName}
        </Text>
        <View style={{ width: 50 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <Panel accent={working ? "cyan" : agent.status === "error" ? "danger" : "none"}>
          <View style={styles.statusRow}>
            <PulseDot color={disabled ? colors.textTertiary : agent.status === "error" ? colors.danger : working ? colors.secondary : colors.accent} active={working} size={10} />
            <Text style={styles.statusText}>{disabled ? "Disabled" : working ? "Working" : agent.status === "error" ? "Error" : "Idle"}</Text>
            <Text style={styles.version}>v{agent.version}</Text>
          </View>
          <Text style={styles.description}>{agent.description}</Text>

          <View style={styles.metaRow}>
            <Text style={styles.metaLabel}>Heartbeat</Text>
            <Text style={styles.metaValue}>{relativeTime(agent.lastHeartbeatAt)}</Text>
          </View>
          <View style={styles.metaRow}>
            <Text style={styles.metaLabel}>Type</Text>
            <Text style={styles.metaValue}>{agent.isInternal ? "Internal" : "External (MCP/A2A)"}</Text>
          </View>
          {!agent.isInternal && agent.externalEndpoint && (
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Endpoint</Text>
              <Text style={styles.metaValue} numberOfLines={1}>
                {agent.externalEndpoint}
              </Text>
            </View>
          )}

          {agent.id !== "master" && (
            <Pressable style={styles.toggleButton} onPress={() => void setEnabled(agent.id, disabled)}>
              <Text style={styles.toggleButtonText}>{disabled ? "Enable agent" : "Disable agent"}</Text>
            </Pressable>
          )}
        </Panel>

        <Panel style={styles.section}>
          <SectionLabel>Capabilities</SectionLabel>
          {agent.capabilities.length === 0 ? (
            <Text style={styles.empty}>No declared capabilities.</Text>
          ) : (
            <View style={styles.chipRow}>
              {agent.capabilities.map((c) => (
                <View key={c} style={styles.chip}>
                  <Text style={styles.chipText}>{c}</Text>
                </View>
              ))}
            </View>
          )}
          <Text style={[styles.subLabel, { marginTop: spacing.md }]}>Supported task types</Text>
          {agent.supportedTaskTypes.length === 0 ? (
            <Text style={styles.empty}>None declared.</Text>
          ) : (
            <View style={styles.chipRow}>
              {agent.supportedTaskTypes.map((t) => (
                <View key={t} style={[styles.chip, styles.chipSecondary]}>
                  <Text style={[styles.chipText, styles.chipTextSecondary]}>{t}</Text>
                </View>
              ))}
            </View>
          )}
        </Panel>

        <Panel style={styles.section}>
          <SectionLabel>Allowed Delegations</SectionLabel>
          {allowedDelegations.length === 0 ? (
            <Text style={styles.empty}>This agent does not delegate to other agents.</Text>
          ) : (
            allowedDelegations.map((target) => (
              <Pressable key={target.id} style={styles.delegationRow} onPress={() => router.push(`/(agents)/${target.id}`)}>
                <PulseDot color={target.status === "working" ? colors.secondary : colors.accent} active={target.status === "working"} size={7} />
                <Text style={styles.delegationName}>{target.displayName}</Text>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
            ))
          )}
        </Panel>

        <Panel style={styles.section}>
          <SectionLabel>Recent Activity</SectionLabel>
          {recentActivity.length === 0 && connection !== "error" && <EmptyState kind="empty" message="No recent activity for this agent yet." />}
          {recentActivity.length === 0 && connection === "error" && <EmptyState kind="error" message="Couldn't reach the event stream" />}
          {recentActivity.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </Panel>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase, paddingTop: spacing.xl },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  back: { color: colors.secondary, fontSize: typography.fontSize.md, width: 50 },
  title: { color: colors.textPrimary, fontSize: typography.fontSize.lg, fontWeight: "700", flex: 1, textAlign: "center" },
  scroll: { padding: spacing.lg, gap: spacing.lg },
  statusRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  statusText: { color: colors.textPrimary, fontSize: typography.fontSize.sm, fontWeight: "700", flex: 1 },
  version: { color: colors.textTertiary, fontSize: typography.fontSize.xs },
  description: { color: colors.textSecondary, fontSize: typography.fontSize.sm, marginTop: spacing.sm },
  metaRow: { flexDirection: "row", justifyContent: "space-between", marginTop: spacing.sm },
  metaLabel: { color: colors.textTertiary, fontSize: typography.fontSize.xs },
  metaValue: { color: colors.textSecondary, fontSize: typography.fontSize.xs, flexShrink: 1, textAlign: "right", marginLeft: spacing.sm },
  toggleButton: {
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    alignItems: "center",
  },
  toggleButtonText: { color: colors.secondary, fontSize: typography.fontSize.sm, fontWeight: "600" },
  section: {},
  subLabel: { color: colors.textTertiary, fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: typography.letterSpacingWide },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.xs },
  chip: { backgroundColor: colors.accentGlow, borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 3 },
  chipText: { color: colors.accent, fontSize: 11, fontWeight: "600" },
  chipSecondary: { backgroundColor: colors.secondaryGlow },
  chipTextSecondary: { color: colors.secondary },
  empty: { color: colors.textTertiary, fontSize: typography.fontSize.xs },
  delegationRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  delegationName: { color: colors.textPrimary, fontSize: typography.fontSize.sm, flex: 1 },
  chevron: { color: colors.textTertiary, fontSize: typography.fontSize.md },
});
