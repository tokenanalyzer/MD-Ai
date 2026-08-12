import React, { useEffect, useRef } from "react";
import { Animated, View, Text, StyleSheet } from "react-native";
import { colors, spacing, typography, severityColor } from "../theme/tokens";
import type { EventDto } from "../api/client";
import { describeEvent } from "../lib/describeEvent";

export { describeEvent };

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 5) return "now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

/** M6 Live Event Stream row — fades/slides in on first render only (a fresh event arriving live), not on every re-render, so scrolling the backlog stays cheap. */
export function EventRow({ event, isNew }: { event: EventDto; isNew?: boolean }) {
  const opacity = useRef(new Animated.Value(isNew ? 0 : 1)).current;
  const translateY = useRef(new Animated.Value(isNew ? -6 : 0)).current;

  useEffect(() => {
    if (!isNew) return;
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Animated.View style={[styles.row, { opacity, transform: [{ translateY }] }]}>
      <View style={[styles.dot, { backgroundColor: severityColor(event.severity) }]} />
      <View style={{ flex: 1 }}>
        <Text style={styles.text} numberOfLines={1}>
          {describeEvent(event)}
        </Text>
        <Text style={styles.meta}>
          {event.sourceType}/{event.sourceId} · {relativeTime(event.createdAt)}
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, paddingVertical: spacing.xs },
  dot: { width: 6, height: 6, borderRadius: 3, marginTop: 6 },
  text: { color: colors.textPrimary, fontSize: typography.fontSize.sm },
  meta: { color: colors.textTertiary, fontSize: 10, marginTop: 1 },
});
