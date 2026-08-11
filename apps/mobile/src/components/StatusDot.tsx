import React from "react";
import { View, StyleSheet } from "react-native";
import { statusColor, type StatusColor } from "../theme/tokens";

export function StatusDot({ status, size = 8 }: { status: StatusColor; size?: number }) {
  return (
    <View
      style={[
        styles.dot,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: statusColor(status) },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  dot: {
    marginRight: 6,
  },
});
