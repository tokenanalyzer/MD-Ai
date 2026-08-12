import React, { useEffect } from "react";
import { View, Text, StyleSheet } from "react-native";
import { Panel } from "../../components/Panel";
import { SectionLabel } from "../../components/SectionLabel";
import { PulseDot } from "../../components/PulseDot";
import { colors, spacing, typography } from "../../theme/tokens";
import { useAgentsStore } from "../../state/agentsStore";
import { useChatStore } from "../../state/chatStore";

/**
 * M6 AI CORE panel — Master Agent's real state. `working` reflects an
 * actual in-flight chat task (chatStore.connection, the same state the
 * Chat screen's own status line renders), never a decorative "always
 * animating" indicator.
 */
export function AICoreCard() {
  const { agents, loadAgents } = useAgentsStore();
  const { connection, progressLabel, routingMode, preferredModelId, activeTaskId } = useChatStore();

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  const master = agents.find((a) => a.id === "master");
  const working = connection === "working";

  return (
    <Panel accent={working ? "cyan" : "none"}>
      <SectionLabel>AI Core</SectionLabel>
      <View style={styles.row}>
        <PulseDot color={colors.secondary} active={working} size={12} />
        <View style={{ flex: 1, marginLeft: spacing.sm }}>
          <Text style={styles.name}>{master?.displayName ?? "Master Agent"}</Text>
          <Text style={styles.state}>
            {working ? (progressLabel ?? "Orchestrating…") : master?.status === "disabled" ? "Disabled" : "Ready"}
          </Text>
        </View>
      </View>

      <View style={styles.metaRow}>
        <Text style={styles.metaLabel}>Routing</Text>
        <Text style={styles.metaValue}>{routingMode === "manual" ? `MANUAL · ${preferredModelId ?? "—"}` : "AUTO"}</Text>
      </View>
      {master && (
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Capabilities</Text>
          <Text style={styles.metaValue} numberOfLines={1}>
            {master.capabilities.length > 0 ? master.capabilities.join(", ") : "orchestration"}
          </Text>
        </View>
      )}
      {activeTaskId && (
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Active task</Text>
          <Text style={styles.metaValue} numberOfLines={1}>
            {activeTaskId}
          </Text>
        </View>
      )}
    </Panel>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", marginBottom: spacing.sm },
  name: { color: colors.textPrimary, fontSize: typography.fontSize.md, fontWeight: "700" },
  state: { color: colors.textSecondary, fontSize: typography.fontSize.xs, marginTop: 2 },
  metaRow: { flexDirection: "row", justifyContent: "space-between", marginTop: spacing.xs },
  metaLabel: { color: colors.textTertiary, fontSize: typography.fontSize.xs },
  metaValue: { color: colors.textSecondary, fontSize: typography.fontSize.xs, flexShrink: 1, textAlign: "right", marginLeft: spacing.sm },
});
