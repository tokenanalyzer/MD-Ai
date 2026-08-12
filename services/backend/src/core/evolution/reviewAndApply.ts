import type pg from "pg";
import type { MemoryEngine, ModelRegistry } from "@mdai/shared-types";
import type { EventBus } from "../events/eventBus.js";
import { evaluateEvolutionProposalPolicy } from "../agents/guardian/policy.js";
import { writeAuditLog } from "../../db/repositories/auditLogRepo.js";
import {
  applyGuardianVerdict,
  recordSandboxResult,
  type EvolutionProposalRow,
} from "../../db/repositories/evolutionProposalRepo.js";
import { sandboxTestProposal } from "./sandbox.js";
import { applyEvolutionProposal } from "./applyProposal.js";

export interface ReviewDeps {
  pool: pg.Pool;
  eventBus: EventBus;
  modelRegistry: ModelRegistry;
  memoryEngine: MemoryEngine;
}

/**
 * The one path every evolution proposal goes through after it's created —
 * whether created by the sweep producer or (in a test) directly via
 * `createProposal`. Mirrors M8's tool-approval gate: Guardian reviews
 * first and can only `deny` (auto-reject, logged) or leave `pending`
 * (never itself grants approval); a `pending` proposal is always sandbox
 * tested next (docs/architecture/07-security-model.md §5 — "before a
 * proposal is even shown for approval"); only THEN, if the proposal never
 * required approval in the first place (`requires_approval` was computed
 * `false` at creation — see `changeClassPolicy.ts`) and its sandbox test
 * passed, does it auto-apply. A `requires_approval: true` proposal always
 * stops here, sandbox-tested and waiting, regardless of verdict — only a
 * human calling `POST /evolution/proposals/:id/approve` can move it
 * further.
 */
export async function reviewAndMaybeApply(deps: ReviewDeps, proposal: EvolutionProposalRow): Promise<EvolutionProposalRow> {
  const verdict = evaluateEvolutionProposalPolicy({
    changeClass: proposal.change_class,
    riskLevel: proposal.risk_level,
    diff: proposal.diff,
  });
  const afterVerdict = await applyGuardianVerdict(deps.pool, proposal.id, verdict);

  await writeAuditLog(deps.pool, {
    actor: "guardian",
    action: verdict.decision === "deny" ? "evolution_proposal.denied" : "evolution_proposal.reviewed",
    targetType: "evolution_proposal",
    targetId: proposal.id,
    metadata: { changeClass: proposal.change_class, reason: verdict.reason },
  });

  if (verdict.decision === "deny") {
    await deps.eventBus.publish({
      sourceType: "system",
      sourceId: proposal.id,
      payload: {
        type: "evolution.proposal.rejected",
        proposalId: proposal.id,
        changeClass: proposal.change_class,
        decidedBy: "auto",
      },
    });
    return afterVerdict;
  }

  const sandboxResult = await sandboxTestProposal(deps.pool, afterVerdict);
  const sandboxed = await recordSandboxResult(deps.pool, proposal.id, sandboxResult as unknown as Record<string, unknown>);
  const current = sandboxed ?? afterVerdict;

  // requires_approval was computed once, at creation — never re-evaluated
  // here, so a proposal can't drift into auto-apply eligibility after the
  // fact.
  if (current.requires_approval) return current;

  // Never auto-apply something that failed its own sandbox test — leave it
  // `sandbox_tested` (visible, inspectable via GET /evolution/proposals)
  // instead of silently discarding it or forcing it through anyway.
  if (!sandboxResult.validated) return current;

  const applied = await applyEvolutionProposal({ pool: deps.pool, modelRegistry: deps.modelRegistry, memoryEngine: deps.memoryEngine }, current);

  await writeAuditLog(deps.pool, {
    actor: "system",
    action: "evolution_proposal.applied",
    targetType: "evolution_proposal",
    targetId: proposal.id,
    metadata: { changeClass: proposal.change_class },
  });
  await deps.eventBus.publish({
    sourceType: "system",
    sourceId: proposal.id,
    payload: {
      type: "evolution.proposal.applied",
      proposalId: proposal.id,
      changeClass: proposal.change_class,
      appliedBy: "system",
    },
  });

  return applied;
}
