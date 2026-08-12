import React, { useEffect } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, RefreshControl } from "react-native";
import { router } from "expo-router";
import { colors, radius, spacing, typography } from "../../src/theme/tokens";
import { Panel } from "../../src/components/Panel";
import { PulseDot } from "../../src/components/PulseDot";
import { EmptyState } from "../../src/components/EmptyState";
import { useAgentsStore } from "../../src/state/agentsStore";
import type { AgentCardDto } from "../../src/api/client";

function statusLabel(status: AgentCardDto["status"]): string {
  switch (status) {
    case "working":
      return "Working";
    case "error":
      return "Error";
    case "disabled":
      return "Disabled";
    default:
      return "Idle";
  }
}

function AgentRow({ agent }: { agent: AgentCardDto }) {
  const disabled = agent.status === "disabled";
  const working = agent.status === "working";
  return (
    <Pressable onPress={() => router.push(`/(agents)/${agent.id}`)} accessibilityRole="button" accessibilityLabel={`${agent.displayName}, ${statusLabel(agent.status)}`}>
      <Panel style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.titleRow}>
            <PulseDot
              color={disabled ? colors.textTertiary : agent.status === "error" ? colors.danger : working ? colors.secondary : colors.accent}
              active={working}
              size={9}
            />
            <Text style={[styles.name, disabled && styles.dimmed]}>{agent.displayName}</Text>
            {agent.isInternal === false && (
              <View style={styles.externalBadge}>
                <Text style={styles.externalBadgeText}>External</Text>
              </View>
            )}
          </View>
          <Text style={styles.chevron}>›</Text>
        </View>
        <Text style={styles.description} numberOfLines={2}>
          {agent.description}
        </Text>
        {agent.capabilities.length > 0 && (
          <View style={styles.capRow}>
            {agent.capabilities.slice(0, 4).map((c) => (
              <View key={c} style={styles.capChip}>
                <Text style={styles.capChipText}>{c}</Text>
              </View>
            ))}
            {agent.capabilities.length > 4 && <Text style={styles.capMore}>+{agent.capabilities.length - 4}</Text>}
          </View>
        )}
      </Panel>
    </Pressable>
  );
}

/**
 * M6.5 AGENT CENTER — every card comes from GET /agents (Agent Registry),
 * never hardcoded, matching AgentNetwork's data source so the Command
 * Center panel and this full list never disagree.
 */
export default function AgentsScreen() {
  const { agents, loading, error, loadAgents } = useAgentsStore();

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Agent Center</Text>
        <View style={{ width: 50 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadAgents()} tintColor={colors.accent} />}
      >
        {agents.length === 0 && loading && <EmptyState kind="loading" message="Discovering agents…" />}
        {agents.length === 0 && error && <EmptyState kind="error" message="Couldn't load agents" detail={error} />}
        {agents.length === 0 && !loading && !error && <EmptyState kind="empty" message="No agents registered" />}
        {agents.map((agent) => (
          <AgentRow key={agent.id} agent={agent} />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase, paddingTop: spacing.xl },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  back: { color: colors.secondary, fontSize: typography.fontSize.md, width: 50 },
  title: { color: colors.textPrimary, fontSize: typography.fontSize.lg, fontWeight: "700" },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  card: { marginBottom: spacing.md },
  cardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexShrink: 1 },
  name: { color: colors.textPrimary, fontSize: typography.fontSize.md, fontWeight: "700" },
  dimmed: { color: colors.textTertiary },
  chevron: { color: colors.textTertiary, fontSize: typography.fontSize.lg },
  externalBadge: { borderWidth: 1, borderColor: colors.secondary, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 1 },
  externalBadgeText: { color: colors.secondary, fontSize: 9, fontWeight: "700", textTransform: "uppercase" },
  description: { color: colors.textTertiary, fontSize: typography.fontSize.xs, marginTop: spacing.sm },
  capRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.sm },
  capChip: { backgroundColor: colors.bgSurfaceRaised, borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  capChipText: { color: colors.textSecondary, fontSize: 10 },
  capMore: { color: colors.textTertiary, fontSize: 10, alignSelf: "center" },
});
