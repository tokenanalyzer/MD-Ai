import React, { useEffect, useState } from "react";
import { View, Text, TextInput, StyleSheet, ScrollView, Pressable, RefreshControl, Alert } from "react-native";
import { router } from "expo-router";
import { colors, radius, spacing, typography } from "../../src/theme/tokens";
import { useScreenTopPadding } from "../../src/hooks/useScreenTopPadding";
import { Panel } from "../../src/components/Panel";
import { SectionLabel } from "../../src/components/SectionLabel";
import { EmptyState } from "../../src/components/EmptyState";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { StatusDot } from "../../src/components/StatusDot";
import { useAutomationsStore } from "../../src/state/automationsStore";
import type { AutomationActionType, AutomationDto, AutomationTriggerType } from "../../src/api/client";

const TRIGGER_TYPES: AutomationTriggerType[] = ["schedule", "event", "webhook", "manual"];
const ACTION_TYPES: AutomationActionType[] = ["agent_task", "n8n_workflow", "notification"];

function relativeTime(iso?: string): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

function AutomationCard({ automation }: { automation: AutomationDto }) {
  const [expanded, setExpanded] = useState(false);
  const { runs, runningNow, loadRuns, setEnabled, remove, runNow } = useAutomationsStore();
  const runHistory = runs[automation.id];

  useEffect(() => {
    if (expanded && !runHistory) void loadRuns(automation.id);
  }, [expanded, runHistory, automation.id, loadRuns]);

  return (
    <View style={styles.card}>
      <Pressable onPress={() => setExpanded((e) => !e)} style={styles.cardHeader}>
        <View style={{ flex: 1 }}>
          <View style={styles.titleRow}>
            <Text style={styles.name}>{automation.name}</Text>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{automation.triggerType}</Text>
            </View>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{automation.actionType.replace("_", " ")}</Text>
            </View>
          </View>
          <View style={styles.statusRow}>
            <StatusDot status={automation.enabled ? "connected" : "idle"} />
            <Text style={styles.statusText}>{automation.enabled ? "Enabled" : "Disabled"} · last run {relativeTime(automation.lastRunAt)}</Text>
          </View>
        </View>
        <Text style={styles.chevron}>{expanded ? "▾" : "▸"}</Text>
      </Pressable>

      {automation.description && <Text style={styles.description}>{automation.description}</Text>}

      <View style={styles.actionsRow}>
        <PrimaryButton label={automation.enabled ? "Disable" : "Enable"} variant="ghost" onPress={() => void setEnabled(automation.id, !automation.enabled)} />
        <PrimaryButton label="Run now" variant="ghost" loading={runningNow === automation.id} onPress={() => void runNow(automation.id)} />
        <PrimaryButton
          label="Delete"
          variant="danger"
          onPress={() =>
            Alert.alert("Delete automation?", `"${automation.name}" will stop running.`, [
              { text: "Cancel", style: "cancel" },
              { text: "Delete", style: "destructive", onPress: () => void remove(automation.id) },
            ])
          }
        />
      </View>

      {expanded && (
        <View style={styles.detailSection}>
          <Text style={styles.sectionHeading}>Recent runs</Text>
          {runHistory?.length ? (
            runHistory.slice(0, 8).map((r) => (
              <View key={r.id} style={styles.runRow}>
                <StatusDot status={r.status === "succeeded" ? "connected" : r.status === "running" ? "working" : "error"} size={6} />
                <Text style={styles.runText}>
                  {r.status} · {relativeTime(r.startedAt)}
                  {r.error ? ` · ${r.error}` : ""}
                </Text>
              </View>
            ))
          ) : (
            <Text style={styles.metaText}>No runs recorded yet.</Text>
          )}
          {automation.webhookSlug && (
            <Text style={[styles.metaText, { marginTop: spacing.sm }]}>
              Webhook slug: {automation.webhookSlug} (secret was shown once at creation)
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

/**
 * M10 Automations screen — reads/writes the real `automations` REST surface
 * (`services/backend/src/api/routes/automations.ts`). Every automation an
 * owner creates here funnels into the same Guardian-gated dispatch paths as
 * chat and bot escalation (`core/automations/automationEngine.ts`'s
 * `dispatch()`) — this screen only ever configures what already exists, it
 * never invents a separate execution path.
 */
export default function AutomationsScreen() {
  const topPadding = useScreenTopPadding();
  const { automations, loading, error, lastCreatedWebhookSecret, loadAutomations, create } = useAutomationsStore();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [triggerType, setTriggerType] = useState<AutomationTriggerType>("manual");
  const [actionType, setActionType] = useState<AutomationActionType>("agent_task");
  const [cron, setCron] = useState("");
  const [eventType, setEventType] = useState("");
  const [prompt, setPrompt] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [notifTitle, setNotifTitle] = useState("");
  const [notifSummary, setNotifSummary] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void loadAutomations();
  }, [loadAutomations]);

  function resetForm() {
    setName("");
    setDescription("");
    setTriggerType("manual");
    setActionType("agent_task");
    setCron("");
    setEventType("");
    setPrompt("");
    setWebhookUrl("");
    setNotifTitle("");
    setNotifSummary("");
  }

  function canSubmit(): boolean {
    if (!name.trim()) return false;
    if (triggerType === "schedule" && !cron.trim()) return false;
    if (triggerType === "event" && !eventType.trim()) return false;
    if (actionType === "agent_task" && !prompt.trim()) return false;
    if (actionType === "n8n_workflow" && !webhookUrl.trim()) return false;
    return true;
  }

  async function handleCreate() {
    if (!canSubmit()) return;
    setCreating(true);
    try {
      const triggerConfig: Record<string, unknown> = {};
      if (triggerType === "schedule") triggerConfig["cron"] = cron.trim();
      if (triggerType === "event") triggerConfig["eventType"] = eventType.trim();

      const actionConfig: Record<string, unknown> = {};
      if (actionType === "agent_task") actionConfig["prompt"] = prompt.trim();
      if (actionType === "n8n_workflow") actionConfig["webhookUrl"] = webhookUrl.trim();
      if (actionType === "notification") {
        actionConfig["title"] = notifTitle.trim() || name.trim();
        actionConfig["summary"] = notifSummary.trim();
        actionConfig["importance"] = "medium";
      }

      await create({
        name: name.trim(),
        description: description.trim() || undefined,
        triggerType,
        triggerConfig,
        actionType,
        actionConfig,
      });
      resetForm();
      setShowForm(false);
    } finally {
      setCreating(false);
    }
  }

  return (
    <View style={[styles.container, { paddingTop: topPadding }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back">
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Automations</Text>
        <View style={{ width: 50 }} />
      </View>
      <Text style={styles.subtitle}>
        Scheduled, event-driven, or webhook-triggered actions. Every action still goes through Master's normal
        delegation and Guardian's tool-approval gate — nothing here bypasses either.
      </Text>

      {lastCreatedWebhookSecret && (
        <Panel style={styles.secretPanel} accent="cyan">
          <SectionLabel>Webhook secret — shown once</SectionLabel>
          <Text selectable style={styles.secretText}>{lastCreatedWebhookSecret}</Text>
          <Text style={styles.metaText}>
            Save this now. Sign requests with HMAC-SHA256 over the raw body using this secret in the
            X-MD-AI-Signature header — see infra/n8n/README.md.
          </Text>
        </Panel>
      )}

      {error && <EmptyState kind="error" message="Couldn't load automations" detail={error} />}

      <ScrollView
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadAutomations()} tintColor={colors.accent} />}
      >
        <Panel>
          <SectionLabel action={<Pressable onPress={() => setShowForm((s) => !s)}><Text style={styles.newLink}>{showForm ? "Cancel" : "+ New"}</Text></Pressable>}>
            Create Automation
          </SectionLabel>

          {showForm && (
            <View style={{ gap: spacing.sm }}>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                placeholder="Name"
                placeholderTextColor={colors.textTertiary}
              />
              <TextInput
                style={styles.input}
                value={description}
                onChangeText={setDescription}
                placeholder="Description (optional)"
                placeholderTextColor={colors.textTertiary}
              />

              <Text style={styles.fieldLabel}>Trigger</Text>
              <View style={styles.chipRow}>
                {TRIGGER_TYPES.map((t) => (
                  <Chip key={t} label={t} active={triggerType === t} onPress={() => setTriggerType(t)} />
                ))}
              </View>
              {triggerType === "schedule" && (
                <TextInput
                  style={styles.input}
                  value={cron}
                  onChangeText={setCron}
                  placeholder="Cron expression, e.g. 0 * * * *"
                  placeholderTextColor={colors.textTertiary}
                  autoCapitalize="none"
                />
              )}
              {triggerType === "event" && (
                <TextInput
                  style={styles.input}
                  value={eventType}
                  onChangeText={setEventType}
                  placeholder="Event type, e.g. bot.finding.created"
                  placeholderTextColor={colors.textTertiary}
                  autoCapitalize="none"
                />
              )}
              {triggerType === "webhook" && (
                <Text style={styles.hint}>A signed webhook URL/secret are generated on creation and shown once.</Text>
              )}

              <Text style={styles.fieldLabel}>Action</Text>
              <View style={styles.chipRow}>
                {ACTION_TYPES.map((a) => (
                  <Chip key={a} label={a.replace("_", " ")} active={actionType === a} onPress={() => setActionType(a)} />
                ))}
              </View>
              {actionType === "agent_task" && (
                <TextInput
                  style={[styles.input, styles.multiline]}
                  value={prompt}
                  onChangeText={setPrompt}
                  placeholder="Prompt Master will run, e.g. Summarize today's findings"
                  placeholderTextColor={colors.textTertiary}
                  multiline
                />
              )}
              {actionType === "n8n_workflow" && (
                <TextInput
                  style={styles.input}
                  value={webhookUrl}
                  onChangeText={setWebhookUrl}
                  placeholder="https://your-n8n-host/webhook/..."
                  placeholderTextColor={colors.textTertiary}
                  autoCapitalize="none"
                  keyboardType="url"
                />
              )}
              {actionType === "notification" && (
                <>
                  <TextInput
                    style={styles.input}
                    value={notifTitle}
                    onChangeText={setNotifTitle}
                    placeholder="Notification title (defaults to name)"
                    placeholderTextColor={colors.textTertiary}
                  />
                  <TextInput
                    style={styles.input}
                    value={notifSummary}
                    onChangeText={setNotifSummary}
                    placeholder="Notification summary"
                    placeholderTextColor={colors.textTertiary}
                  />
                </>
              )}

              <PrimaryButton label="Create" onPress={() => void handleCreate()} loading={creating} disabled={!canSubmit()} />
            </View>
          )}
        </Panel>

        <SectionLabel>Configured Automations</SectionLabel>
        {automations.length === 0 && !loading && <EmptyState kind="empty" message="No automations configured yet." />}
        {automations.map((a) => (
          <AutomationCard key={a.id} automation={a} />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.lg },
  back: { color: colors.secondary, fontSize: typography.fontSize.md, width: 50 },
  title: { color: colors.textPrimary, fontSize: typography.fontSize.lg, fontWeight: "700" },
  subtitle: {
    color: colors.textTertiary,
    fontSize: typography.fontSize.xs,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  secretPanel: { marginHorizontal: spacing.lg, marginBottom: spacing.md },
  secretText: {
    color: colors.textPrimary,
    fontSize: typography.fontSize.sm,
    fontFamily: typography.mono,
    marginVertical: spacing.sm,
  },
  list: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xxl, gap: spacing.md },
  newLink: { color: colors.accent, fontSize: typography.fontSize.xs, fontWeight: "700" },
  fieldLabel: { color: colors.textSecondary, fontSize: typography.fontSize.xs, fontWeight: "600", marginTop: spacing.xs },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  chipActive: { borderColor: colors.accent, backgroundColor: colors.accentGlow },
  chipText: { color: colors.textSecondary, fontSize: typography.fontSize.xs },
  chipTextActive: { color: colors.accent, fontWeight: "700" },
  input: {
    color: colors.textPrimary,
    backgroundColor: colors.bgSurfaceRaised,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: typography.fontSize.sm,
  },
  multiline: { minHeight: 72, textAlignVertical: "top" },
  hint: { color: colors.textTertiary, fontSize: typography.fontSize.xs },
  card: {
    backgroundColor: colors.bgSurface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  cardHeader: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
  name: { color: colors.textPrimary, fontSize: typography.fontSize.md, fontWeight: "600" },
  badge: {
    borderWidth: 1,
    borderColor: colors.secondary,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
  },
  badgeText: { color: colors.secondary, fontSize: 10, fontWeight: "700", textTransform: "uppercase" },
  statusRow: { flexDirection: "row", alignItems: "center", marginTop: spacing.xs },
  statusText: { color: colors.textSecondary, fontSize: typography.fontSize.xs },
  chevron: { color: colors.textTertiary, fontSize: typography.fontSize.md },
  description: { color: colors.textTertiary, fontSize: typography.fontSize.xs, marginTop: spacing.sm },
  actionsRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md, flexWrap: "wrap" },
  detailSection: { marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  sectionHeading: { color: colors.textSecondary, fontSize: typography.fontSize.xs, fontWeight: "700" },
  metaText: { color: colors.textSecondary, fontSize: typography.fontSize.xs },
  runRow: { flexDirection: "row", alignItems: "center", marginTop: spacing.xs, gap: spacing.xs },
  runText: { color: colors.textSecondary, fontSize: typography.fontSize.xs },
});
