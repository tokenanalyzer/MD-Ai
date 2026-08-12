import React from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { colors, spacing, typography } from "../theme/tokens";

interface Props {
  kind: "loading" | "empty" | "error";
  message: string;
  detail?: string;
}

/**
 * M6: one shared empty/loading/error presentation used by every Command
 * Center panel and every Center screen — "graceful empty/loading/error
 * states" per the milestone's testing checklist, applied consistently
 * rather than each screen inventing its own (or, worse, silently
 * rendering nothing).
 */
export function EmptyState({ kind, message, detail }: Props) {
  return (
    <View style={styles.container} accessibilityRole="text" accessibilityLabel={message}>
      {kind === "loading" && <ActivityIndicator color={colors.accent} style={{ marginBottom: spacing.sm }} />}
      <Text style={[styles.message, kind === "error" && { color: colors.danger }]}>{message}</Text>
      {detail && <Text style={styles.detail}>{detail}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: "center", justifyContent: "center", paddingVertical: spacing.xl },
  message: { color: colors.textSecondary, fontSize: typography.fontSize.sm, textAlign: "center" },
  detail: { color: colors.textTertiary, fontSize: typography.fontSize.xs, textAlign: "center", marginTop: spacing.xs },
});
