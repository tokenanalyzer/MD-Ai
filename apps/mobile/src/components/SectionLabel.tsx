import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { colors, spacing, typography } from "../theme/tokens";

/** M6: the small uppercase "eyebrow" heading used above every Command Center panel and Center screen section — one consistent typographic voice for section hierarchy. */
export function SectionLabel({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.text}>{children}</Text>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.sm },
  text: {
    color: colors.textTertiary,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: typography.letterSpacingWide,
    textTransform: "uppercase",
  },
});
