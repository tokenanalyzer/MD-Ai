import React from "react";
import { View, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { colors, elevation, radius, spacing } from "../theme/tokens";

interface Props {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** A subtle accent-colored top border — used to mark a panel as "live"/active without a full color flood. */
  accent?: "none" | "green" | "cyan" | "danger";
  padded?: boolean;
}

const accentColor: Record<NonNullable<Props["accent"]>, string | undefined> = {
  none: undefined,
  green: colors.accent,
  cyan: colors.secondary,
  danger: colors.danger,
};

/**
 * M6: the one "glass/panel surface" primitive every Command Center card
 * builds on (SystemStatus, AICoreCard, AgentNetwork, LiveEventStream,
 * CurrentTask, and the Agent/Model/Memory/Tools Center screens) — a
 * single consistent look (graphite surface, subtle border, soft shadow)
 * instead of each screen re-deriving its own card style, per the
 * "reusable UI components rather than one giant screen" instruction.
 */
export function Panel({ children, style, accent = "none", padded = true }: Props) {
  const accentBorder = accentColor[accent];
  return (
    <View
      style={[
        styles.base,
        elevation.panel,
        padded && styles.padded,
        accentBorder ? { borderTopColor: accentBorder, borderTopWidth: 2 } : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: colors.bgGlass,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  padded: { padding: spacing.lg },
});
