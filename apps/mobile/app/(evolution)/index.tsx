import React, { useEffect, useMemo } from "react";
import { View, Text, StyleSheet, ScrollView, RefreshControl, Pressable } from "react-native";
import { router } from "expo-router";
import { colors, radius, spacing, typography } from "../../src/theme/tokens";
import { Panel } from "../../src/components/Panel";
import { SectionLabel } from "../../src/components/SectionLabel";
import { EmptyState } from "../../src/components/EmptyState";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { useEvolutionStore } from "../../src/state/evolutionStore";
import type { EvolutionProposalDto, ToolApprovalDto } from "../../src/api/client";

function riskColor(risk: EvolutionProposalDto["riskLevel"]): string {
  switch (risk) {
    case "high":
      return colors.danger;
    case "medium":
      return colors.warning;
    default:
      return colors.textTertiary;
  }
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function ProposalCard({ proposal }: { proposal: EvolutionProposalDto }) {
  const { approveProposal, rejectProposal, decidingId } = useEvolutionStore();
  const deciding = decidingId === proposal.id;

  return (
    <Panel style={styles.card}>
      <View style={styles.titleRow}>
        <Text style={styles.name}>{proposal.title}</Text>
        <View style={[styles.riskBadge, { borderColor: riskColor(proposal.riskLevel) }]}>
          <Text style={[styles.riskBadgeText, { color: riskColor(proposal.riskLevel) }]}>{proposal.riskLevel}</Text>
        </View>
      </View>
      <Text style={styles.metaText}>{proposal.changeClass} · {relativeTime(proposal.createdAt)}</Text>
      <Text style={styles.rationale}>{proposal.rationale}</Text>
      {proposal.sandboxResult && (
        <Text style={styles.metaText}>
          Sandbox: {(proposal.sandboxResult["validated"] as boolean) ? "passed" : "flagged"}
          {typeof proposal.sandboxResult["reason"] === "string" ? ` — ${proposal.sandboxResult["reason"]}` : ""}
        </Text>
      )}
      <View style={styles.buttonRow}>
        <PrimaryButton
          label="Approve"
          onPress={() => void approveProposal(proposal.id)}
          loading={deciding}
          disabled={decidingId !== null && !deciding}
          style={styles.button}
        />
        <PrimaryButton
          label="Reject"
          variant="danger"
          onPress={() => void rejectProposal(proposal.id)}
          loading={deciding}
          disabled={decidingId !== null && !deciding}
          style={styles.button}
        />
      </View>
    </Panel>
  );
}

function ToolApprovalCard({ approval }: { approval: ToolApprovalDto }) {
  const { decideTool, decidingId } = useEvolutionStore();
  const deciding = decidingId === approval.id;

  return (
    <Panel style={styles.card}>
      <Text style={styles.name}>{approval.toolId}</Text>
      <Text style={styles.metaText}>
        Requested by {approval.agentId ?? "unknown agent"} · {relativeTime(approval.createdAt)}
      </Text>
      <View style={styles.buttonRow}>
        <PrimaryButton
          label="Approve & Run"
          onPress={() => void decideTool(approval.id, "approved")}
          loading={deciding}
          disabled={decidingId !== null && !deciding}
          style={styles.button}
        />
        <PrimaryButton
          label="Deny"
          variant="danger"
          onPress={() => void decideTool(approval.id, "denied")}
          loading={deciding}
          disabled={decidingId !== null && !deciding}
          style={styles.button}
        />
      </View>
    </Panel>
  );
}

/**
 * M9 APPROVALS — the human approval/denial surface the roadmap calls for:
 * `requires_approval` evolution proposals Guardian left `proposed`/
 * `sandbox_tested` (never itself grants approval — see
 * core/evolution/reviewAndApply.ts) and tool_invocations Guardian left
 * `awaiting_approval` (M8). Approving a tool call actually replays it
 * (M9's task-resumption); approving a proposal applies it immediately if
 * this codebase has a real applier for that change class, otherwise the
 * approval is recorded and applying/deploying it stays a manual step
 * outside the system — never something this screen or the backend does on
 * its own.
 */
export default function EvolutionScreen() {
  const { proposals, toolApprovals, loading, error, sweeping, load, runSweepNow } = useEvolutionStore();

  useEffect(() => {
    void load();
  }, [load]);

  const actionable = useMemo(
    () => proposals.filter((p) => p.requiresApproval && (p.status === "proposed" || p.status === "sandbox_tested")),
    [proposals],
  );
  const resolved = useMemo(
    () => proposals.filter((p) => p.status === "applied" || p.status === "rejected").slice(0, 10),
    [proposals],
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back">
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Approvals</Text>
        <View style={{ width: 50 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} tintColor={colors.accent} />}
      >
        <Panel>
          <SectionLabel>Evolution Engine</SectionLabel>
          <Text style={styles.metaText}>
            Discovery and benchmarking sweeps run on a schedule and propose changes. Low-risk changes with no policy
            objection apply automatically; anything requiring approval waits here.
          </Text>
          <PrimaryButton label="Run Sweep Now" variant="ghost" onPress={() => void runSweepNow()} loading={sweeping} style={{ marginTop: spacing.sm }} />
        </Panel>

        <SectionLabel>Evolution Proposals Awaiting Approval</SectionLabel>
        {actionable.length === 0 && !loading && <EmptyState kind="empty" message="No evolution proposals need your approval right now." />}
        {actionable.map((p) => (
          <ProposalCard key={p.id} proposal={p} />
        ))}

        <SectionLabel>Tool Calls Awaiting Approval</SectionLabel>
        {toolApprovals.length === 0 && !loading && <EmptyState kind="empty" message="No tool calls are waiting on approval." />}
        {toolApprovals.map((a) => (
          <ToolApprovalCard key={a.id} approval={a} />
        ))}

        {resolved.length > 0 && (
          <>
            <SectionLabel>Recently Resolved</SectionLabel>
            {resolved.map((p) => (
              <Panel key={p.id} style={styles.card}>
                <Text style={styles.name}>{p.title}</Text>
                <Text style={styles.metaText}>
                  {p.status} · {p.changeClass} · {relativeTime(p.createdAt)}
                </Text>
              </Panel>
            ))}
          </>
        )}

        {error && <EmptyState kind="error" message="Couldn't load approvals" detail={error} />}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase, paddingTop: spacing.xl },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.lg },
  back: { color: colors.secondary, fontSize: typography.fontSize.md, width: 50 },
  title: { color: colors.textPrimary, fontSize: typography.fontSize.lg, fontWeight: "700" },
  list: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xxl, gap: spacing.md },
  card: { marginBottom: spacing.md },
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
  name: { color: colors.textPrimary, fontSize: typography.fontSize.md, fontWeight: "700", flexShrink: 1 },
  riskBadge: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 1 },
  riskBadgeText: { fontSize: 9, fontWeight: "700", textTransform: "uppercase" },
  metaText: { color: colors.textSecondary, fontSize: typography.fontSize.xs, marginTop: spacing.xs },
  rationale: { color: colors.textTertiary, fontSize: typography.fontSize.xs, marginTop: spacing.sm },
  buttonRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  button: { flex: 1 },
});
