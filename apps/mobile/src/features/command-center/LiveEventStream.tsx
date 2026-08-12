import React, { useEffect } from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";
import { Panel } from "../../components/Panel";
import { SectionLabel } from "../../components/SectionLabel";
import { EventRow } from "../../components/EventRow";
import { EmptyState } from "../../components/EmptyState";
import { PulseDot } from "../../components/PulseDot";
import { colors, spacing, typography } from "../../theme/tokens";
import { useEventsStore } from "../../state/eventsStore";

const MAX_VISIBLE = 40;

/**
 * M6 LIVE EVENT STREAM — every row comes from the real backend event
 * system (GET /events snapshot + /ws/events live tail with resume-by-
 * cursor), never synthesized client-side. `describeEvent()` (EventRow)
 * only ever renders safe status metadata — no chain-of-thought, no raw
 * payload dump.
 */
export function LiveEventStream() {
  const { events, liveIds, connection, connect, disconnect } = useEventsStore();

  useEffect(() => {
    void connect();
    return () => disconnect();
  }, [connect, disconnect]);

  const visible = events.slice(-MAX_VISIBLE).reverse();

  return (
    <Panel style={styles.panel}>
      <SectionLabel
        action={
          <View style={styles.connRow}>
            <PulseDot
              color={connection === "connected" ? colors.accent : connection === "error" ? colors.danger : colors.textTertiary}
              active={connection === "connected"}
              size={7}
            />
            <Text style={styles.connText}>{connection === "connected" ? "Live" : connection === "error" ? "Disconnected" : "Idle"}</Text>
          </View>
        }
      >
        Live Event Stream
      </SectionLabel>
      {events.length === 0 && connection !== "error" && <EmptyState kind="loading" message="Connecting to event stream…" />}
      {events.length === 0 && connection === "error" && (
        <EmptyState kind="error" message="Couldn't reach the event stream" detail="Check your backend connection in Settings." />
      )}
      {events.length > 0 && (
        <ScrollView style={styles.scroll} nestedScrollEnabled showsVerticalScrollIndicator={false}>
          {visible.map((event) => (
            <EventRow key={event.id} event={event} isNew={liveIds.has(event.id)} />
          ))}
        </ScrollView>
      )}
    </Panel>
  );
}

const styles = StyleSheet.create({
  panel: { maxHeight: 340 },
  scroll: { maxHeight: 280 },
  connRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  connText: { color: colors.textTertiary, fontSize: typography.fontSize.xs },
});
