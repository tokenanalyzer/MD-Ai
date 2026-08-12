import type { Agent, AgentRuntimeContext } from "@mdai/shared-types";
import type { BackendAgentRuntimeContext } from "../runtimeContext.js";
import { evaluateEvolutionProposalPolicy, evaluateToolApprovalPolicy, type GuardianVerdict } from "./policy.js";

interface PolicyReviewInput {
  subject?: "tool_approval" | "evolution_proposal";
  toolApproval?: { toolId: string; agentId: string; riskLevel: "low" | "medium" | "high"; accessLevel: "allowed" | "restricted" };
  evolutionProposal?: {
    changeClass: "knowledge_update" | "model_registry_update" | "routing_policy_update" | "skill_update" | "application_code_update";
    riskLevel: "low" | "medium" | "high";
    diff: Record<string, unknown>;
  };
}

/**
 * M8 Guardian: registered as a real Agent (visible in the Agent Registry
 * and Command Center like every other agent) so a "policy-review" task can
 * be delegated to it through the normal A2A path, exactly like any other
 * specialist. In practice `mcpHost.ts` calls `evaluateToolApprovalPolicy`
 * directly for the tool-approval gate — a full LLM-backed delegate() round
 * trip for a deterministic policy check would be slow and pointless, the
 * same reasoning the Bot Engine's importance gate already applies (M5.6:
 * "evaluated before any LLM call"). This `handleTask` path exists for the
 * cases docs/architecture/07-security-model.md §6 describes generically —
 * anything that explicitly delegates a policy question to Guardian.
 */
export function createGuardianAgent(): Agent {
  return {
    card: {
      id: "guardian",
      displayName: "Guardian",
      description:
        "Automated first policy check on tool-approval requests and evolution proposals — deterministic rule evaluation, can veto but never itself grant approval.",
      version: "0.1.0",
      capabilities: ["policy-enforcement"],
      supportedTaskTypes: ["policy-review"],
      isInternal: true,
      modelPreferences: { taskCategory: "reasoning" },
      toolRequirements: [],
      status: "idle",
    },

    async handleTask(ctx: AgentRuntimeContext): Promise<void> {
      const backendCtx = ctx as BackendAgentRuntimeContext;
      const input = backendCtx.task.input as PolicyReviewInput;

      backendCtx.emit({ taskId: backendCtx.task.id, kind: "agent_progress", label: "Guardian evaluating policy…" });

      let verdict: GuardianVerdict;
      if (input.subject === "tool_approval" && input.toolApproval) {
        verdict = evaluateToolApprovalPolicy(input.toolApproval);
      } else if (input.subject === "evolution_proposal" && input.evolutionProposal) {
        verdict = evaluateEvolutionProposalPolicy(input.evolutionProposal);
      } else {
        await backendCtx.finishFailure({
          code: "missing_policy_subject",
          message: "No tool_approval or evolution_proposal subject was provided to review.",
          retryable: false,
        });
        return;
      }

      await backendCtx.finishSuccess(verdict as unknown as Record<string, unknown>);
    },

    async healthCheck() {
      return { healthy: true };
    },
  };
}
