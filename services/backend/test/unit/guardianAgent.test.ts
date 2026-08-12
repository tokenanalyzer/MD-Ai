import { describe, expect, it } from "vitest";
import { createGuardianAgent } from "../../src/core/agents/guardian/guardianAgent.js";
import { makeFakeCtx } from "../helpers/fakeRuntimeContext.js";

describe("Guardian Agent (M8.3/M8.4)", () => {
  it("is registered with policy-enforcement capability and never calls the model for a policy review", async () => {
    const guardian = createGuardianAgent();
    expect(guardian.card.capabilities).toContain("policy-enforcement");

    let output: Record<string, unknown> | undefined;
    const ctx = makeFakeCtx(
      {
        id: "t1",
        assignedAgentId: "guardian",
        taskType: "policy-review",
        state: "working",
        input: { subject: "tool_approval", toolApproval: { toolId: "t", agentId: "a", riskLevel: "high", accessLevel: "restricted" } },
      },
      {
        completeChat: async () => {
          throw new Error("Guardian must never call the model for a deterministic policy check");
        },
        finishSuccess: async (o) => void (output = o),
      },
    );

    await guardian.handleTask(ctx);
    expect(output?.["decision"]).toBe("deny");
  });

  it("reviews an evolution_proposal subject and returns pending for an unobjectionable one", async () => {
    const guardian = createGuardianAgent();
    let output: Record<string, unknown> | undefined;
    const ctx = makeFakeCtx(
      {
        id: "t2",
        assignedAgentId: "guardian",
        taskType: "policy-review",
        state: "working",
        input: {
          subject: "evolution_proposal",
          evolutionProposal: { changeClass: "knowledge_update", riskLevel: "low", diff: { a: 1 } },
        },
      },
      { finishSuccess: async (o) => void (output = o) },
    );

    await guardian.handleTask(ctx);
    expect(output?.["decision"]).toBe("pending");
  });

  it("fails closed when neither a tool_approval nor evolution_proposal subject is provided", async () => {
    const guardian = createGuardianAgent();
    let failure: { code: string; message: string; retryable: boolean } | undefined;
    const ctx = makeFakeCtx(
      { id: "t3", assignedAgentId: "guardian", taskType: "policy-review", state: "working", input: {} },
      { finishFailure: async (error) => void (failure = error) },
    );

    await guardian.handleTask(ctx);
    expect(failure?.code).toBe("missing_policy_subject");
  });
});
