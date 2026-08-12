import "../setupEnv.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getTestPool, resetTestData, closeTestPool } from "../helpers/testDb.js";
import { evaluateEvolutionProposalPolicy } from "../../src/core/agents/guardian/policy.js";
import {
  applyGuardianVerdict,
  createProposal,
  decideProposal,
  getProposal,
  listProposals,
} from "../../src/db/repositories/evolutionProposalRepo.js";
import { listAuditLog, writeAuditLog } from "../../src/db/repositories/auditLogRepo.js";

const pool = await getTestPool();

beforeEach(async () => {
  await resetTestData(pool);
});

afterAll(async () => {
  await closeTestPool();
});

/**
 * M8.4: the full producer pipeline (discovery, benchmarking, sandbox
 * testing) is explicitly M9 (core/evolution/README.md) — these tests
 * exercise the M8 slice only: a proposal row existing (however it got
 * there), Guardian's deterministic review of it, and a human's decision on
 * whatever Guardian didn't already veto.
 */
describe("Evolution proposal review wiring (M8.4)", () => {
  it("Guardian auto-rejects a proposal it denies, recording decided_by='auto'", async () => {
    const proposal = await createProposal(pool, {
      changeClass: "application_code_update",
      title: "Rewrite the router",
      rationale: "test",
      diff: { file: "src/index.ts" },
      riskLevel: "high",
      requiresApproval: true,
    });
    expect(proposal.status).toBe("proposed");

    const verdict = evaluateEvolutionProposalPolicy({
      changeClass: proposal.change_class,
      riskLevel: proposal.risk_level,
      diff: proposal.diff,
    });
    expect(verdict.decision).toBe("deny");

    const updated = await applyGuardianVerdict(pool, proposal.id, verdict);
    expect(updated).toMatchObject({ status: "rejected", decided_by: "auto" });
    expect(updated.decided_at).not.toBeNull();

    const reread = await getProposal(pool, proposal.id);
    expect(reread?.status).toBe("rejected");
  });

  it("leaves a proposal Guardian doesn't object to as 'proposed', untouched, for a human to decide", async () => {
    const proposal = await createProposal(pool, {
      changeClass: "knowledge_update",
      title: "Add a fact to memory",
      rationale: "test",
      diff: { fact: "MD AI supports five providers" },
      riskLevel: "low",
      requiresApproval: true,
    });

    const verdict = evaluateEvolutionProposalPolicy({
      changeClass: proposal.change_class,
      riskLevel: proposal.risk_level,
      diff: proposal.diff,
    });
    expect(verdict.decision).toBe("pending");

    const afterGuardian = await applyGuardianVerdict(pool, proposal.id, verdict);
    expect(afterGuardian).toMatchObject({ status: "proposed", decided_by: null });

    const decided = await decideProposal(pool, proposal.id, "approved");
    expect(decided).toMatchObject({ status: "approved", decided_by: "user" });
    expect(decided.decided_at).not.toBeNull();
  });

  it("a human can reject a proposal Guardian left pending", async () => {
    const proposal = await createProposal(pool, {
      changeClass: "routing_policy_update",
      title: "Change default model priority",
      rationale: "test",
      diff: { priority: 5 },
      riskLevel: "medium",
      requiresApproval: true,
    });
    const decided = await decideProposal(pool, proposal.id, "rejected");
    expect(decided.status).toBe("rejected");
    expect(decided.decided_by).toBe("user");
  });

  it("listProposals returns every proposal, newest first", async () => {
    const first = await createProposal(pool, {
      changeClass: "skill_update",
      title: "First",
      rationale: "r",
      diff: { a: 1 },
      riskLevel: "low",
      requiresApproval: false,
    });
    const second = await createProposal(pool, {
      changeClass: "skill_update",
      title: "Second",
      rationale: "r",
      diff: { a: 2 },
      riskLevel: "low",
      requiresApproval: false,
    });

    const list = await listProposals(pool);
    const ids = list.map((p) => p.id);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
  });
});

describe("Audit log (M8.3/M8.4)", () => {
  it("writes and lists entries newest first, and never requires secret material", async () => {
    await writeAuditLog(pool, { actor: "guardian", action: "tool_approval.denied", targetType: "tool_invocation", targetId: "x", metadata: { toolId: "t" } });
    await writeAuditLog(pool, { actor: "user", action: "tool_approval.approved", targetType: "tool_invocation", targetId: "x" });

    const entries = await listAuditLog(pool);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0]?.action).toBe("tool_approval.approved");
    expect(entries.some((e) => e.action === "tool_approval.denied")).toBe(true);
  });
});
