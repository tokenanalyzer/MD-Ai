import React from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { router } from "expo-router";
import { Panel } from "../../components/Panel";
import { SectionLabel } from "../../components/SectionLabel";
import { colors, radius, spacing, typography } from "../../theme/tokens";
import { useChatStore } from "../../state/chatStore";
import { useSystemStatusStore } from "../../state/systemStatusStore";

interface Action {
  key: string;
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  hint?: string;
}

/**
 * M6 QUICK ACTIONS — every enabled action routes to real, already-existing
 * functionality. Actions with no backing screen yet (Models/Memory/Tools
 * land in M6.6-M6.8) are rendered disabled with a "coming soon" hint
 * rather than pretending to navigate somewhere real — per the explicit
 * "do not create fake functionality" instruction.
 */
export function QuickActions() {
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const refreshStatus = useSystemStatusStore((s) => s.refresh);

  const actions: Action[] = [
    { key: "new-chat", label: "New Chat", onPress: () => { startNewConversation(); router.push("/(chat)"); } },
    { key: "ask-master", label: "Ask Master", onPress: () => router.push("/(chat)") },
    {
      key: "research",
      label: "Research",
      onPress: () => {
        startNewConversation();
        router.push("/(chat)");
      },
      hint: "Opens Chat — describe what to research and Master will route it.",
    },
    { key: "system-status", label: "System Status", onPress: () => void refreshStatus() },
    { key: "agents", label: "Agents", onPress: () => router.push("/(agents)") },
    { key: "models", label: "Models", onPress: () => router.push("/(models)") },
    { key: "memory", label: "Memory", onPress: () => router.push("/(memory)") },
    { key: "tools", label: "Tools", disabled: true, hint: "Coming in M6.8" },
    { key: "automations", label: "Automations", onPress: () => router.push("/(bots)") },
  ];

  return (
    <Panel>
      <SectionLabel>Quick Actions</SectionLabel>
      <View style={styles.grid}>
        {actions.map((action) => (
          <Pressable
            key={action.key}
            disabled={action.disabled}
            onPress={action.onPress}
            style={({ pressed }) => [styles.tile, action.disabled && styles.tileDisabled, pressed && !action.disabled && styles.tilePressed]}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            accessibilityState={{ disabled: action.disabled }}
          >
            <Text style={[styles.label, action.disabled && styles.labelDisabled]}>{action.label}</Text>
            {action.disabled && <Text style={styles.hint}>{action.hint}</Text>}
          </Pressable>
        ))}
      </View>
    </Panel>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  tile: {
    flexBasis: "31%",
    flexGrow: 1,
    backgroundColor: colors.bgSurfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 56,
  },
  tileDisabled: { opacity: 0.4 },
  tilePressed: { borderColor: colors.accent },
  label: { color: colors.textPrimary, fontSize: typography.fontSize.xs, fontWeight: "600", textAlign: "center" },
  labelDisabled: { color: colors.textTertiary },
  hint: { color: colors.textTertiary, fontSize: 9, textAlign: "center", marginTop: 2 },
});
