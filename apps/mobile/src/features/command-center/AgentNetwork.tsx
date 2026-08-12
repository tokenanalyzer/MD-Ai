import React, { useEffect } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { router } from "expo-router";
import { Panel } from "../../components/Panel";
import { SectionLabel } from "../../components/SectionLabel";
import { PulseDot } from "../../components/PulseDot";
import { EmptyState } from "../../components/EmptyState";
import { colors, radius, spacing, typography } from "../../theme/tokens";
import { useAgentsStore } from "../../state/agentsStore";
import type { AgentCardDto } from "../../api/client";

function AgentChip({ agent }: { agent: AgentCardDto }) {
  const working = agent.status === "working";
  const disabled = agent.status === "disabled";
  return (
    <Pressable
      onPress={() => router.push(`/(agents)/${agent.id}`)}
      style={[styles.chip, disabled && styles.chipDisabled]}
      accessibilityRole="button"
      accessibilityLabel={`${agent.displayName}, ${agent.status}`}
    >
      <PulseDot color={disabled ? colors.textTertiary : working ? colors.secondary : colors.accent} active={working} size={8} />
      <Text style={[styles.chipText, disabled && { color: colors.textTertiary }]} numberOfLines={1}>
        {agent.displayName}
      </Text>
    </Pressable>
  );
}

/**
 * M6 AGENT NETWORK — every agent discovered from GET /agents (Agent
 * Registry), never a hardcoded roster. Deliberately a flat chip layout
 * rather than a canvas/SVG node graph for M6 (no new rendering
 * dependency needed); M7's 3D Command Center can replace this component
 * alone without touching the data layer (useAgentsStore), which is the
 * point of keeping the information architecture separate from the
 * renderer from the start.
 */
export function AgentNetwork() {
  const { agents, loading, error, loadAgents } = useAgentsStore();

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  const master = agents.find((a) => a.id === "master");
  const others = agents.filter((a) => a.id !== "master");

  return (
    <Panel>
      <SectionLabel action={<Pressable onPress={() => router.push("/(agents)")}><Text style={styles.viewAll}>View all →</Text></Pressable>}>
        Agent Network
      </SectionLabel>
      {agents.length === 0 && loading && <EmptyState kind="loading" message="Discovering agents…" />}
      {agents.length === 0 && error && <EmptyState kind="error" message="Couldn't load agents" detail={error} />}
      {agents.length === 0 && !loading && !error && <EmptyState kind="empty" message="No agents registered" />}
      {agents.length > 0 && (
        <View>
          {master && (
            <View style={styles.masterRow}>
              <AgentChip agent={master} />
            </View>
          )}
          <View style={styles.othersRow}>
            {others.map((a) => (
              <AgentChip key={a.id} agent={a} />
            ))}
          </View>
        </View>
      )}
    </Panel>
  );
}

const styles = StyleSheet.create({
  viewAll: { color: colors.secondary, fontSize: typography.fontSize.xs, fontWeight: "600" },
  masterRow: { alignItems: "center", marginBottom: spacing.md },
  othersRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, justifyContent: "center" },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: colors.bgSurfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  chipDisabled: { opacity: 0.5 },
  chipText: { color: colors.textPrimary, fontSize: typography.fontSize.xs, fontWeight: "600", maxWidth: 120 },
});
