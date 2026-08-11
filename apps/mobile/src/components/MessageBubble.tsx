import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { colors, radius, spacing, typography } from "../theme/tokens";
import type { ChatMessage } from "../state/chatStore";

export function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
        <Text style={[styles.text, isUser && styles.textUser]}>
          {message.text || (message.streaming ? "…" : "")}
        </Text>
        {message.streaming && <View style={styles.cursor} />}
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
});
