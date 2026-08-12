import React, { useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { colors, radius, spacing, typography } from "../theme/tokens";
import type { ChatMessage } from "../state/chatStore";

function shortModelId(modelId: string | null): string {
  if (!modelId) return "model pending";
  const slash = modelId.indexOf("/");
  return slash === -1 ? modelId : modelId.slice(slash + 1);
}

/**
 * M6.4 "expandable task details" — every line here traces to a real field:
 * `progressHistory` is the ordered list of safe `agent_progress` labels the
 * backend already emitted for this task (never chain-of-thought), and
 * `tree` is GET /tasks/:id/tree's real delegation-tree rows. Collapsed by
 * default so the message list stays clean.
 */
function TaskDetails({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const hasHistory = (message.progressHistory?.length ?? 0) > 0;
  const hasTree = (message.tree?.length ?? 0) > 0;
  if (!hasHistory && !hasTree) return null;

  return (
    <View style={styles.detailsWrap}>
      <Pressable onPress={() => setExpanded((v) => !v)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Task details">
        <Text style={styles.detailsToggle}>{expanded ? "Hide details ▲" : "Details ▾"}</Text>
      </Pressable>
      {expanded && (
        <View style={styles.detailsBody}>
          {hasHistory && (
            <View style={styles.detailsSection}>
              {message.progressHistory!.map((label, i) => (
                <Text key={i} style={styles.detailsLine} numberOfLines={1}>
                  · {label}
                </Text>
              ))}
            </View>
          )}
          {hasTree && (
            <View style={styles.detailsSection}>
              {message.tree!.map((node) => (
                <View key={node.id} style={styles.treeRow}>
                  <Text style={styles.treeAgent}>{node.assignedAgentId}</Text>
                  <Text style={styles.treeMeta} numberOfLines={1}>
                    {shortModelId(node.modelId)} · {node.state}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
        <Text style={[styles.text, isUser && styles.textUser]}>
          {message.text || (message.streaming ? "…" : "")}
        </Text>
        {message.streaming && <View style={styles.cursor} />}
        {!isUser && !message.streaming && <TaskDetails message={message} />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { width: "100%", marginVertical: spacing.xs, flexDirection: "row" },
  rowUser: { justifyContent: "flex-end" },
  rowAssistant: { justifyContent: "flex-start" },
  bubble: {
    maxWidth: "84%",
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  bubbleUser: {
    backgroundColor: colors.accentGlow,
    borderWidth: 1,
    borderColor: colors.accentDim,
    borderBottomRightRadius: radius.sm,
  },
  bubbleAssistant: {
    backgroundColor: colors.bgSurfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomLeftRadius: radius.sm,
  },
  text: { color: colors.textPrimary, fontSize: typography.fontSize.md, lineHeight: 21 },
  textUser: { color: colors.textPrimary },
  cursor: {
    width: 6,
    height: 14,
    backgroundColor: colors.accent,
    marginTop: 4,
    opacity: 0.8,
  },
  detailsWrap: { marginTop: spacing.xs, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.xs },
  detailsToggle: { color: colors.secondary, fontSize: typography.fontSize.xs, fontWeight: "600" },
  detailsBody: { marginTop: spacing.xs, gap: spacing.xs },
  detailsSection: { gap: 2 },
  detailsLine: { color: colors.textTertiary, fontSize: typography.fontSize.xs },
  treeRow: { flexDirection: "row", justifyContent: "space-between", gap: spacing.sm },
  treeAgent: { color: colors.textSecondary, fontSize: typography.fontSize.xs, fontWeight: "700", textTransform: "capitalize" },
  treeMeta: { color: colors.textTertiary, fontSize: typography.fontSize.xs, flexShrink: 1, textAlign: "right" },
});
