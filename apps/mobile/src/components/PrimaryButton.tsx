import React from "react";
import { Pressable, Text, StyleSheet, ActivityIndicator, type StyleProp, type ViewStyle } from "react-native";
import { colors, radius, spacing, typography } from "../theme/tokens";

interface Props {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: "primary" | "danger" | "ghost";
  style?: StyleProp<ViewStyle>;
}

export function PrimaryButton({ label, onPress, loading, disabled, variant = "primary", style }: Props) {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        variant === "primary" && styles.primary,
        variant === "danger" && styles.danger,
        variant === "ghost" && styles.ghost,
        isDisabled && styles.disabled,
        pressed && !isDisabled && styles.pressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === "ghost" ? colors.accent : colors.bgBase} size="small" />
      ) : (
        <Text
          style={[
            styles.label,
            variant === "ghost" && { color: colors.accent },
            variant === "danger" && { color: colors.bgBase },
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  primary: { backgroundColor: colors.accent },
  danger: { backgroundColor: colors.danger },
  ghost: { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.border },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.85 },
  label: { color: colors.bgBase, fontSize: typography.fontSize.md, fontWeight: "600" },
});
