import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { colors, radius, spacing, typography, type StatusColor } from "../theme/tokens";
import { StatusDot } from "./StatusDot";

interface Props {
  label: string;
  value: string;
  status?: StatusColor;
  hint?: string;
}

/** M6: one metric card for the System Status grid (backend/DB/Redis/provider/latency/connection) — a fixed, glanceable shape reused for every metric rather than bespoke layout per row. */
export function MetricTile({ label, value, status, hint }: Props) {
  return (
    <View style={styles.tile} accessibilityRole="text" accessibilityLabel={`${label}: ${value}${hint ? `, ${hint}` : ""}`}>
      <View style={styles.labelRow}>
        {status && <StatusDot status={status} size={6} />}
        <Text style={styles.label}>{label.toUpperCase()}</Text>
      </View>
      <Text style={styles.value} numberOfLines={1}>
        {value}
      </Text>
      {hint && (
        <Text style={styles.hint} numberOfLines={1}>
          {hint}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    flexBasis: "48%",
    backgroundColor: colors.bgSurfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  labelRow: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 4 },
  label: { color: colors.textTertiary, fontSize: 10, fontWeight: "700", letterSpacing: typography.letterSpacingWide },
  value: { color: colors.textPrimary, fontSize: typography.fontSize.md, fontWeight: "700" },
  hint: { color: colors.textSecondary, fontSize: typography.fontSize.xs, marginTop: 2 },
});
