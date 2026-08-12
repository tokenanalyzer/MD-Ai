import React from "react";
import { View, Text, StyleSheet, ScrollView, Pressable } from "react-native";
import { Link } from "expo-router";
import { colors, radius, spacing, typography } from "../../src/theme/tokens";
import { SystemStatus } from "../../src/features/command-center/SystemStatus";
import { AICoreCard } from "../../src/features/command-center/AICoreCard";
import { AgentNetwork } from "../../src/features/command-center/AgentNetwork";
import { LiveEventStream } from "../../src/features/command-center/LiveEventStream";
import { CurrentTask } from "../../src/features/command-center/CurrentTask";
import { QuickActions } from "../../src/features/command-center/QuickActions";

/**
 * M6 COMMAND CENTER — the app's new home screen. A 2D information
 * architecture deliberately kept flat (ScrollView of panels, not a
 * canvas/3D scene) so M7 can later replace individual panels (starting
 * with AgentNetwork) with a 3D renderer without touching this screen's
 * data layer or the other five panels.
 */
export default function CommandCenterScreen() {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>MD AI</Text>
          <Text style={styles.subtitle}>Command Center</Text>
        </View>
        <View style={styles.headerActions}>
          <Link href="/(chat)" asChild>
            <Pressable style={styles.navButton}>
              <Text style={styles.navButtonText}>Chat</Text>
            </Pressable>
          </Link>
          <Link href="/(settings)" asChild>
            <Pressable style={styles.navButton}>
              <Text style={styles.navButtonText}>⚙</Text>
            </Pressable>
          </Link>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <SystemStatus />
        <AICoreCard />
        <AgentNetwork />
        <LiveEventStream />
        <CurrentTask />
        <QuickActions />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { color: colors.textPrimary, fontSize: typography.fontSize.lg, fontWeight: "700" },
  subtitle: { color: colors.accent, fontSize: typography.fontSize.xs, fontWeight: "600", letterSpacing: typography.letterSpacingWide, textTransform: "uppercase", marginTop: 2 },
  headerActions: { flexDirection: "row", gap: spacing.sm },
  navButton: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  navButtonText: { color: colors.secondary, fontSize: typography.fontSize.sm },
  scroll: { padding: spacing.lg, gap: spacing.lg },
});
