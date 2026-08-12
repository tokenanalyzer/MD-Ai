import type { ToolAccessLevel, ToolRiskLevel } from "@mdai/shared-types";

/**
 * Guardian's policy checks (docs/architecture/07-security-model.md §6,
 * 09-roadmap.md M8): deterministic rule evaluation, no LLM call, same
 * "deterministic before any model call" precedent as the Bot Engine's
 * importance gate (M5.6). Guardian can only ever `deny` (an automatic
 * veto) or `pending` (forward to a human) — there is no `allow` outcome
 * here, because approval for a `requires_approval` item is a strictly
 * human action Guardian can never grant itself.
 */
export type GuardianDecision = "deny" | "pending";

export interface GuardianVerdict {
  decision: GuardianDecision;
  reason: string;
}

export interface ToolApprovalPolicyInput {
  toolId: string;
  agentId: string;
  riskLevel: ToolRiskLevel;
  /** The agent's own grant level for this tool — already confirmed non-null (some grant exists) by the MCP host's earlier permission check. */
  accessLevel: ToolAccessLevel;
}

/**
 * A high-risk tool is never approvable for an agent that only holds a
 * "restricted" grant — that combination is denied by policy outright,
 * without ever reaching a human. Anything else that requires approval
 * (medium/low risk, or high risk with a full "allowed" grant) has no
 * policy objection and is forwarded to the human approval queue.
 */
export function evaluateToolApprovalPolicy(input: ToolApprovalPolicyInput): GuardianVerdict {
  if (input.riskLevel === "high" && input.accessLevel === "restricted") {
    return {
      decision: "deny",
      reason: `high-risk tool "${input.toolId}" may not be used at "restricted" access by "${input.agentId}" — requires an explicit "allowed" grant before a human can even be asked`,
    };
  }
  return {
    decision: "pending",
    reason: `no policy objection to "${input.toolId}" (risk=${input.riskLevel}, access=${input.accessLevel}) — forwarded for human approval`,
  };
}

export type EvolutionChangeClass =
  | "knowledge_update"
  | "model_registry_update"
  | "routing_policy_update"
  | "skill_update"
  | "application_code_update";

export interface EvolutionProposalPolicyInput {
  changeClass: EvolutionChangeClass;
  riskLevel: "low" | "medium" | "high";
  diff: Record<string, unknown>;
}

/**
 * `application_code_update` is the highest-consequence change class this
 * system can propose (docs/architecture/07-security-model.md §5) — at
 * "high" risk it is denied by policy outright, same shape as the
 * tool-approval rule above. An empty/missing diff is denied regardless of
 * class (nothing concrete to review is itself a policy violation, not a
 * pass-through). Everything else forwards to a human — Guardian never
 * sets a proposal to `approved`.
 */
export function evaluateEvolutionProposalPolicy(input: EvolutionProposalPolicyInput): GuardianVerdict {
  if (!input.diff || Object.keys(input.diff).length === 0) {
    return { decision: "deny", reason: "proposal has an empty diff — nothing concrete to review" };
  }
  if (input.changeClass === "application_code_update" && input.riskLevel === "high") {
    return {
      decision: "deny",
      reason: "high-risk application_code_update proposals are denied by policy outright, never queued for human review",
    };
  }
  return {
    decision: "pending",
    reason: `no policy objection to this ${input.changeClass} proposal (risk=${input.riskLevel}) — forwarded for human decision`,
  };
}
