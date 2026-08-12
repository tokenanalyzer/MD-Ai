import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { Panel } from "../../components/Panel";
import { SectionLabel } from "../../components/SectionLabel";
import { PulseDot } from "../../components/PulseDot";
import { colors, spacing, typography } from "../../theme/tokens";
import { useChatStore } from "../../state/chatStore";

function formatElapsed(startedAt: number): string {
  const secs = Math.floor((Date.now() - startedAt) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

/**
 * M6 CURRENT TASK panel — mirrors the exact task lifecycle the Chat
 * screen already drives (chatStore: activeTaskId/progressLabel/
 * connection/messages). No separate "task" fetch — the same client-side
 * state the WS task stream already maintains, just summarized here.
 */
export function CurrentTask() {
  const { activeTaskId, activeTaskStartedAt, progressLabel, connection, messages, lastError, preferredModelId, routingMode } = useChatStore();
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!activeTaskStartedAt) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [activeTaskStartedAt]);

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const working = connection === "working";

  const status = working ? "Running" : connection === "error" ? "Error" : lastAssistant ? "Completed" : "Idle";

  return (
    <Panel accent={working ? "cyan" : connection === "error" ? "danger" : "none"}>
      <SectionLabel>Current Task</SectionLabel>

      {!lastUser && (
        <Text style={styles.empty}>No task running yet — start a conversation from Chat or Quick Actions.</Text>
      )}

      {lastUser && (
        <View>
          <View style={styles.row}>
            <PulseDot color={working ? colors.secondary : connection === "error" ? colors.danger : colors.textTertiary} active={working} size={9} />
            <Text style={styles.status}>{status}</Text>
            {activeTaskStartedAt && <Text style={styles.elapsed}>{formatElapsed(activeTaskStartedAt)}</Text>}
          </View>

          <Text style={styles.label}>Request</Text>
          <Text style={styles.request} numberOfLines={2}>
            {lastUser.text}
          </Text>

          {working && progressLabel && (
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Activity</Text>
              <Text style={styles.metaValue} numberOfLines={1}>
                {progressLabel}
              </Text>
            </View>
          )}

          <View style={styles.metaRow}>
            <Text style={styles.metaLabel}>Routing</Text>
            <Text style={styles.metaValue}>{routingMode === "manual" ? `MANUAL · ${preferredModelId ?? "—"}` : "AUTO"}</Text>
          </View>

          {activeTaskId && (
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Task ID</Text>
              <Text style={styles.metaValue} numberOfLines={1}>
                {activeTaskId}
              </Text>
            </View>
          )}

          {!working && connection === "error" && lastError && (
            <Text style={styles.error}>{lastError}</Text>
          )}

          {!working && connection !== "error" && lastAssistant?.text && (
            <View style={styles.resultBox}>
              <Text style={styles.label}>Result</Text>
              <Text style={styles.result} numberOfLines={4}>
                {lastAssistant.text}
              </Text>
            </View>
          )}
        </View>
      )}
    </Panel>
  );
}

const styles = StyleSheet.create({
  empty: { color: colors.textTertiary, fontSize: typography.fontSize.sm },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.sm },
  status: { color: colors.textPrimary, fontSize: typography.fontSize.sm, fontWeight: "700", flex: 1 },
  elapsed: { color: colors.textTertiary, fontSize: typography.fontSize.xs, fontVariant: ["tabular-nums"] },
  label: { color: colors.textTertiary, fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: typography.letterSpacingWide, marginBottom: 2 },
  request: { color: colors.textSecondary, fontSize: typography.fontSize.sm, marginBottom: spacing.sm },
  metaRow: { flexDirection: "row", justifyContent: "space-between", marginTop: spacing.xs },
  metaLabel: { color: colors.textTertiary, fontSize: typography.fontSize.xs },
  metaValue: { color: colors.textSecondary, fontSize: typography.fontSize.xs, flexShrink: 1, textAlign: "right", marginLeft: spacing.sm },
  error: { color: colors.danger, fontSize: typography.fontSize.xs, marginTop: spacing.sm },
  resultBox: { marginTop: spacing.sm },
  result: { color: colors.textSecondary, fontSize: typography.fontSize.xs },
});
