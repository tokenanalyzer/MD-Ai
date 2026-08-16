import React, { useEffect, useState } from "react";
import { View, Text, TextInput, StyleSheet, ScrollView, Pressable, RefreshControl } from "react-native";
import { router } from "expo-router";
import { colors, radius, spacing, typography } from "../../src/theme/tokens";
import { Panel } from "../../src/components/Panel";
import { EmptyState } from "../../src/components/EmptyState";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { useMemoryStore } from "../../src/state/memoryStore";
import { useScreenTopPadding } from "../../src/hooks/useScreenTopPadding";
import type { MemoryCategory, MemoryItemDto } from "../../src/api/client";

const CATEGORIES: MemoryCategory[] = [
  "personal_context",
  "projects",
  "goals",
  "preferences",
  "decisions",
  "research",
  "knowledge",
  "conversations",
  "agent_lessons",
];

type Tab = "approved" | "pending" | "rejected";

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function MemoryCard({ item, tab }: { item: MemoryItemDto; tab: Tab }) {
  const { approve, reject, forget } = useMemoryStore();
  return (
    <Panel style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.categoryBadge}>
          <Text style={styles.categoryText}>{item.category.replace(/_/g, " ")}</Text>
        </View>
        {item.pinned && <Text style={styles.pinned}>📌</Text>}
      </View>
      <Text style={styles.content}>{item.summary || item.content}</Text>
      {item.tags.length > 0 && (
        <View style={styles.tagRow}>
          {item.tags.map((t) => (
            <Text key={t} style={styles.tag}>
              #{t}
            </Text>
          ))}
        </View>
      )}
      <View style={styles.metaRow}>
        <Text style={styles.metaText}>source: {item.source}</Text>
        <Text style={styles.metaText}>
          created {relativeTime(item.createdAt)} · updated {relativeTime(item.updatedAt)}
        </Text>
      </View>
      {tab === "pending" && (
        <View style={styles.actionsRow}>
          <PrimaryButton label="Approve" variant="ghost" onPress={() => void approve(item.id)} />
          <PrimaryButton label="Reject" variant="ghost" onPress={() => void reject(item.id)} />
        </View>
      )}
      {tab === "approved" && (
        <View style={styles.actionsRow}>
          <PrimaryButton label="Forget" variant="danger" onPress={() => void forget(item.id)} />
        </View>
      )}
      {tab === "rejected" && (
        <View style={styles.actionsRow}>
          <PrimaryButton label="Delete" variant="ghost" onPress={() => void forget(item.id)} />
        </View>
      )}
    </Panel>
  );
}

/**
 * M6.7 MEMORY CENTER — approved/pending/rejected tabs backed by the real
 * memory subsystem (M3.6/M3.7). "Remember" always creates an
 * already-approved memory (explicit user action); pending items only
 * arrive from Master's own classifier proposing a memoryCandidate during a
 * conversation — nothing here invents automatic memory writes.
 */
export default function MemoryScreen() {
  const topPadding = useScreenTopPadding();
  const { approved, pending, rejected, loading, error, loadAll, remember } = useMemoryStore();
  const [tab, setTab] = useState<Tab>("approved");
  const [composerOpen, setComposerOpen] = useState(false);
  const [draftCategory, setDraftCategory] = useState<MemoryCategory>("personal_context");
  const [draftContent, setDraftContent] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const lists: Record<Tab, MemoryItemDto[]> = { approved, pending, rejected };
  const items = lists[tab];

  async function handleRemember() {
    const content = draftContent.trim();
    if (!content) return;
    setSaving(true);
    try {
      await remember({ category: draftCategory, content });
      setDraftContent("");
      setComposerOpen(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={[styles.container, { paddingTop: topPadding }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back">
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Memory Center</Text>
        <Pressable
          onPress={() => setComposerOpen((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={composerOpen ? "Cancel remembering" : "Remember something new"}
        >
          <Text style={styles.rememberLink}>{composerOpen ? "Cancel" : "+ Remember"}</Text>
        </Pressable>
      </View>

      {composerOpen && (
        <Panel style={styles.composer}>
          <View style={styles.categoryPickerRow}>
            {CATEGORIES.map((c) => (
              <Pressable
                key={c}
                onPress={() => setDraftCategory(c)}
                style={[styles.categoryOption, draftCategory === c && styles.categoryOptionActive]}
              >
                <Text style={[styles.categoryOptionText, draftCategory === c && styles.categoryOptionTextActive]}>
                  {c.replace(/_/g, " ")}
                </Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            style={styles.composerInput}
            value={draftContent}
            onChangeText={setDraftContent}
            placeholder="What should MD AI remember?"
            placeholderTextColor={colors.textTertiary}
            multiline
          />
          <PrimaryButton label="Save" onPress={handleRemember} loading={saving} disabled={draftContent.trim().length === 0} />
        </Panel>
      )}

      <View style={styles.tabRow}>
        {(["approved", "pending", "rejected"] as Tab[]).map((t) => (
          <Pressable
            key={t}
            onPress={() => setTab(t)}
            style={[styles.tab, tab === t && styles.tabActive]}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === t }}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t[0]!.toUpperCase() + t.slice(1)} ({lists[t].length})
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadAll()} tintColor={colors.accent} />}
      >
        {items.length === 0 && loading && <EmptyState kind="loading" message="Loading memory…" />}
        {items.length === 0 && error && <EmptyState kind="error" message="Couldn't load memory" detail={error} />}
        {items.length === 0 && !loading && !error && (
          <EmptyState
            kind="empty"
            message={tab === "approved" ? "No approved memories yet." : tab === "pending" ? "No memories awaiting review." : "No rejected memories."}
          />
        )}
        {items.map((item) => (
          <MemoryCard key={item.id} item={item} tab={tab} />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.lg },
  back: { color: colors.secondary, fontSize: typography.fontSize.md },
  title: { color: colors.textPrimary, fontSize: typography.fontSize.lg, fontWeight: "700" },
  rememberLink: { color: colors.accent, fontSize: typography.fontSize.sm, fontWeight: "700" },
  composer: { marginHorizontal: spacing.lg, marginTop: spacing.md },
  categoryPickerRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginBottom: spacing.sm },
  categoryOption: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 4 },
  categoryOptionActive: { borderColor: colors.accentDim, backgroundColor: colors.accentGlow },
  categoryOptionText: { color: colors.textTertiary, fontSize: 10, textTransform: "capitalize" },
  categoryOptionTextActive: { color: colors.accent, fontWeight: "700" },
  composerInput: {
    color: colors.textPrimary,
    backgroundColor: colors.bgSurfaceRaised,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 60,
    fontSize: typography.fontSize.sm,
    marginBottom: spacing.sm,
  },
  tabRow: { flexDirection: "row", paddingHorizontal: spacing.lg, marginTop: spacing.md, gap: spacing.sm },
  tab: { flex: 1, alignItems: "center", paddingVertical: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  tabActive: { borderColor: colors.accentDim, backgroundColor: colors.accentGlow },
  tabText: { color: colors.textTertiary, fontSize: typography.fontSize.xs, fontWeight: "700" },
  tabTextActive: { color: colors.accent },
  list: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xxl, gap: spacing.md },
  card: { marginBottom: spacing.md },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  categoryBadge: { borderWidth: 1, borderColor: colors.secondary, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 1 },
  categoryText: { color: colors.secondary, fontSize: 10, fontWeight: "700", textTransform: "capitalize" },
  pinned: { fontSize: 14 },
  content: { color: colors.textPrimary, fontSize: typography.fontSize.sm, marginTop: spacing.sm },
  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.sm },
  tag: { color: colors.secondary, fontSize: 11 },
  metaRow: { flexDirection: "row", justifyContent: "space-between", marginTop: spacing.sm },
  metaText: { color: colors.textTertiary, fontSize: 10 },
  actionsRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
});
