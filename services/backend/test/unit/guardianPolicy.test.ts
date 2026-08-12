import { describe, expect, it } from "vitest";
import { evaluateEvolutionProposalPolicy, evaluateToolApprovalPolicy } from "../../src/core/agents/guardian/policy.js";

describe("Guardian policy (M8.3) — tool approval", () => {
  it("denies a high-risk tool at only a restricted grant, without ever reaching a human", () => {
    const verdict = evaluateToolApprovalPolicy({
      toolId: "dangerous_tool",
      agentId: "crypto-intel",
      riskLevel: "high",
      accessLevel: "restricted",
    });
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toContain("dangerous_tool");
    expect(verdict.reason).toContain("restricted");
  });

  it("forwards a high-risk tool with a full allowed grant to a human as pending", () => {
    const verdict = evaluateToolApprovalPolicy({
      toolId: "dangerous_tool",
      agentId: "crypto-intel",
      riskLevel: "high",
      accessLevel: "allowed",
    });
    expect(verdict.decision).toBe("pending");
  });

  it("forwards medium/low-risk tools as pending regardless of access level", () => {
    expect(evaluateToolApprovalPolicy({ toolId: "t", agentId: "a", riskLevel: "medium", accessLevel: "restricted" }).decision).toBe(
      "pending",
    );
    expect(evaluateToolApprovalPolicy({ toolId: "t", agentId: "a", riskLevel: "low", accessLevel: "restricted" }).decision).toBe(
      "pending",
    );
  });

  it("never returns an 'approved'/'allow' decision — deny or pending only", () => {
    const decisions = new Set(
      (["low", "medium", "high"] as const).flatMap((riskLevel) =>
        (["allowed", "restricted"] as const).map(
          (accessLevel) => evaluateToolApprovalPolicy({ toolId: "t", agentId: "a", riskLevel, accessLevel }).decision,
        ),
      ),
    );
    expect(decisions).toEqual(new Set(["deny", "pending"]));
  });
});

describe("Guardian policy (M8.4) — evolution proposal review", () => {
  it("denies a proposal with an empty diff, regardless of change class or risk", () => {
    const verdict = evaluateEvolutionProposalPolicy({ changeClass: "knowledge_update", riskLevel: "low", diff: {} });
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toContain("empty diff");
  });

  it("denies a high-risk application_code_update outright", () => {
    const verdict = evaluateEvolutionProposalPolicy({
      changeClass: "application_code_update",
      riskLevel: "high",
      diff: { file: "src/index.ts" },
    });
    expect(verdict.decision).toBe("deny");
  });

  it("forwards a low/medium-risk application_code_update, and any other change class, as pending", () => {
    expect(
      evaluateEvolutionProposalPolicy({ changeClass: "application_code_update", riskLevel: "medium", diff: { a: 1 } }).decision,
    ).toBe("pending");
    expect(
      evaluateEvolutionProposalPolicy({ changeClass: "knowledge_update", riskLevel: "high", diff: { a: 1 } }).decision,
    ).toBe("pending");
    expect(
      evaluateEvolutionProposalPolicy({ changeClass: "routing_policy_update", riskLevel: "low", diff: { a: 1 } }).decision,
    ).toBe("pending");
  });

  it("never returns an 'approved' decision — deny or pending only", () => {
    const verdict = evaluateEvolutionProposalPolicy({ changeClass: "skill_update", riskLevel: "low", diff: { a: 1 } });
    expect(["deny", "pending"]).toContain(verdict.decision);
  });
});
