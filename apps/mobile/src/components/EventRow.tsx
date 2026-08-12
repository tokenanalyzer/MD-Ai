import React, { useEffect, useRef } from "react";
import { Animated, View, Text, StyleSheet } from "react-native";
import { colors, spacing, typography, severityColor } from "../theme/tokens";
import type { EventDto } from "../api/client";

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 5) return "now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

/** Turns a typed event's `type` + safe payload fields into one human-readable line — never chain-of-thought, never a raw payload dump (docs/architecture/05-event-schemas.md). */
export function describeEvent(event: EventDto): string {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case "agent.started":
      return `${p["agentId"]} started`;
    case "agent.completed":
      return `${p["agentId"]} completed in ${p["durationMs"]}ms`;
    case "agent.failed":
      return `${p["agentId"]} failed: ${p["errorCode"]}`;
    case "task.created":
      return `Task created for ${p["assignedAgentId"]}`;
    case "task.completed":
      return `Task completed (${p["durationMs"]}ms)`;
    case "task.failed":
      return `Task failed: ${p["errorCode"]}`;
    case "message.sent":
      return `${p["fromAgentId"]} → ${p["toAgentId"]}`;
    case "review.completed":
      return `Review: ${p["decision"]}`;
    case "memory.created":
      return `Memory created (${p["category"]})`;
    case "memory.retrieved":
      return `${p["count"]} memories retrieved`;
    case "tool.called":
      return `Tool called: ${p["toolId"]}`;
    case "tool.completed":
      return `Tool ${p["toolId"] ?? ""} completed: ${p["status"]}`;
    case "tool.failed":
      return `Tool failed: ${p["errorCode"]}`;
    case "tool.blocked":
      return `Tool blocked: ${p["reason"]}`;
    case "model.selected":
      return `Model selected: ${p["modelId"]}`;
    case "model.switched":
      return `Model switched: ${p["fromModelId"]} → ${p["toModelId"]}`;
    case "bot.run.completed":
      return `${p["botId"]} run ${p["status"]} (${p["findingsCount"]} finding(s))`;
    case "bot.failed":
      return `${p["botId"]} failed: ${p["message"]}`;
    case "bot.finding.created":
      return `${p["botId"]}: new ${p["importance"]} finding`;
    case "bot.finding.escalated":
      return `${p["botId"]}: finding escalated to Master`;
    case "bot.notification.sent":
      return "Notification sent";
    default:
      return event.type;
  }
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
