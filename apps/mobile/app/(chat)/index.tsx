import React, { useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Pressable,
} from "react-native";
import { Link } from "expo-router";
import { colors, radius, spacing, typography } from "../../src/theme/tokens";
import { StatusDot } from "../../src/components/StatusDot";
import { MessageBubble } from "../../src/components/MessageBubble";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { useChatStore } from "../../src/state/chatStore";

export default function ChatScreen() {
  const { messages, connection, lastError, send, retryLast, cancelActive, activeTaskId, routingMode, preferredModelId } =
    useChatStore();
  const [draft, setDraft] = useState("");
  const listRef = useRef<FlatList>(null);

  async function handleSend() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    await send(text);
    listRef.current?.scrollToEnd({ animated: true });
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>MD AI</Text>
          <View style={styles.statusRow}>
            <StatusDot status={connection === "error" ? "error" : connection === "working" ? "working" : "idle"} />
            <Text style={styles.statusText}>
              {connection === "working" ? "Master Agent is answering…" : connection === "error" ? "Connection issue" : "Ready"}
            </Text>
          </View>
          <Text style={styles.routingBadge}>
            {routingMode === "manual" ? `MANUAL · ${preferredModelId ?? "pick a model in Vault"}` : "AUTO routing"}
          </Text>
        </View>
        <Link href="/(vault)" asChild>
          <Pressable style={styles.settingsButton}>
            <Text style={styles.settingsButtonText}>Vault</Text>
          </Pressable>
        </Link>
      </View>

      {lastError && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{lastError}</Text>
          <Pressable onPress={retryLast}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      )}

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => <MessageBubble message={item} />}
        contentContainerStyle={styles.list}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>Ask anything. "Explain A2A." "Research this company." "Remember this."</Text>
          </View>
        }
      />

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message MD AI…"
          placeholderTextColor={colors.textTertiary}
          multiline
        />
        {activeTaskId ? (
          <PrimaryButton label="Stop" variant="danger" onPress={cancelActive} />
        ) : (
          <PrimaryButton label="Send" onPress={handleSend} disabled={draft.trim().length === 0} />
        )}
      </View>
    </KeyboardAvoidingView>
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
  headerTitle: { color: colors.textPrimary, fontSize: typography.fontSize.lg, fontWeight: "700" },
  statusRow: { flexDirection: "row", alignItems: "center", marginTop: 4 },
  statusText: { color: colors.textSecondary, fontSize: typography.fontSize.xs },
  routingBadge: { color: colors.secondary, fontSize: typography.fontSize.xs, marginTop: 2 },
  settingsButton: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  settingsButtonText: { color: colors.secondary, fontSize: typography.fontSize.sm },
  errorBanner: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.dangerGlow,
    borderBottomWidth: 1,
    borderBottomColor: colors.danger,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  errorText: { color: colors.textPrimary, fontSize: typography.fontSize.sm, flex: 1 },
  retryText: { color: colors.accent, fontSize: typography.fontSize.sm, fontWeight: "700", marginLeft: spacing.md },
  list: { padding: spacing.lg, flexGrow: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", paddingTop: spacing.xxl },
  emptyText: { color: colors.textTertiary, fontSize: typography.fontSize.sm, textAlign: "center" },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bgSurface,
  },
  input: {
    flex: 1,
    color: colors.textPrimary,
    backgroundColor: colors.bgSurfaceRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    maxHeight: 120,
    fontSize: typography.fontSize.md,
  },
});
