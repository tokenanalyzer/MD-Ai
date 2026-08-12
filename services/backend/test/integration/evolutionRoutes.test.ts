import "../setupEnv.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import pino from "pino";
import request from "supertest";
import { getTestPool, resetTestData, closeTestPool } from "../helpers/testDb.js";
import { buildTestAgentRegistry } from "../helpers/appDeps.js";
import { EventBus } from "../../src/core/events/eventBus.js";
import { ModelRegistryService } from "../../src/core/registry/modelRegistryService.js";
import { ensureOwner } from "../../src/db/repositories/ownerRepo.js";
import { generatePairingCode } from "../../src/core/security/pairing.js";
import { createApp } from "../../src/api/app.js";
import { createProposal } from "../../src/db/repositories/evolutionProposalRepo.js";

const pool = await getTestPool();
const redis = new Redis(process.env.REDIS_URL as string);
const logger = pino({ level: "silent" });
const modelRegistry = new ModelRegistryService(pool);
const { agentRegistry, memoryEngine, toolRegistry, botRegistry, botEngine } = buildTestAgentRegistry(pool);
const app = createApp({ pool, redis, queues: [], eventBus: new EventBus(pool), modelRegistry, agentRegistry, memoryEngine, toolRegistry, botRegistry, botEngine, logger });

beforeEach(async () => {
  await resetTestData(pool);
  await ensureOwner(pool, "Test Owner");
});

afterAll(async () => {
  await redis.quit();
  await closeTestPool();
});

async function pairedToken(): Promise<string> {
  const code = await generatePairingCode(pool);
  const res = await request(app).post("/auth/pair").send({ pairingCode: code, deviceName: "phone", platform: "android" });
  return res.body.data.accessToken as string;
}

describe("Evolution proposals REST surface (M9)", () => {
  it("lists proposals and filters by status", async () => {
    const token = await pairedToken();
    await createProposal(pool, {
      changeClass: "knowledge_update",
      title: "A",
      rationale: "r",
      diff: { category: "knowledge", content: "a" },
      riskLevel: "low",
      requiresApproval: false,
    });

    const all = await request(app).get("/evolution/proposals").set("Authorization", `Bearer ${token}`);
    expect(all.status).toBe(200);
    expect(all.body.data).toHaveLength(1);
    expect(all.body.data[0]).toMatchObject({ changeClass: "knowledge_update", status: "proposed" });

    const filtered = await request(app).get("/evolution/proposals?status=applied").set("Authorization", `Bearer ${token}`);
    expect(filtered.body.data).toHaveLength(0);
  });

  it("GET /evolution/proposals/:id returns detail; 404s for an unknown id", async () => {
    const token = await pairedToken();
    const proposal = await createProposal(pool, {
      changeClass: "routing_policy_update",
      title: "B",
      rationale: "r",
      diff: { modelId: "x", newPriority: 1 },
      riskLevel: "low",
      requiresApproval: false,
    });

    const res = await request(app).get(`/evolution/proposals/${proposal.id}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(proposal.id);

    const missing = await request(app)
      .get("/evolution/proposals/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(missing.status).toBe(404);
  });

  it("approves a requires_approval knowledge_update proposal and actually applies it (Memory Engine)", async () => {
    const token = await pairedToken();
    const proposal = await createProposal(pool, {
      changeClass: "knowledge_update",
      title: "C",
      rationale: "r",
      diff: { category: "knowledge", content: "human-approved fact" },
      riskLevel: "low",
      requiresApproval: true,
    });

    const res = await request(app).post(`/evolution/proposals/${proposal.id}/approve`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("applied");
    expect(res.body.data.decidedBy).toBe("user");

    const rows = await pool.query("SELECT * FROM memory_items WHERE content = $1", ["human-approved fact"]);
    expect(rows.rows).toHaveLength(1);

    const audit = await pool.query(
      "SELECT action FROM audit_log WHERE target_id = $1 ORDER BY created_at",
      [proposal.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(["evolution_proposal.approved", "evolution_proposal.applied"]);
  });

  it("rejects a requires_approval proposal without applying it", async () => {
    const token = await pairedToken();
    const proposal = await createProposal(pool, {
      changeClass: "knowledge_update",
      title: "D",
      rationale: "r",
      diff: { category: "knowledge", content: "never applied" },
      riskLevel: "low",
      requiresApproval: true,
    });

    const res = await request(app).post(`/evolution/proposals/${proposal.id}/reject`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("rejected");

    const rows = await pool.query("SELECT * FROM memory_items WHERE content = $1", ["never applied"]);
    expect(rows.rows).toHaveLength(0);
  });

  it("400s approving/rejecting a proposal that doesn't require approval", async () => {
    const token = await pairedToken();
    const proposal = await createProposal(pool, {
      changeClass: "knowledge_update",
      title: "E",
      rationale: "r",
      diff: { category: "knowledge", content: "e" },
      riskLevel: "low",
      requiresApproval: false,
    });

    const approve = await request(app).post(`/evolution/proposals/${proposal.id}/approve`).set("Authorization", `Bearer ${token}`);
    expect(approve.status).toBe(400);
    const reject = await request(app).post(`/evolution/proposals/${proposal.id}/reject`).set("Authorization", `Bearer ${token}`);
    expect(reject.status).toBe(400);
  });

  it("400s deciding a proposal twice", async () => {
    const token = await pairedToken();
    const proposal = await createProposal(pool, {
      changeClass: "knowledge_update",
      title: "F",
      rationale: "r",
      diff: { category: "knowledge", content: "f" },
      riskLevel: "low",
      requiresApproval: true,
    });

    const first = await request(app).post(`/evolution/proposals/${proposal.id}/approve`).set("Authorization", `Bearer ${token}`);
    expect(first.status).toBe(200);
    const second = await request(app).post(`/evolution/proposals/${proposal.id}/approve`).set("Authorization", `Bearer ${token}`);
    expect(second.status).toBe(400);
  });

  it("POST /evolution/sweep runs a real sweep and returns a summary", async () => {
    const token = await pairedToken();
    const res = await request(app).post("/evolution/sweep").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ proposalsCreated: 0, proposalsApplied: 0, proposalsDenied: 0 });
    expect(typeof res.body.data.sweepId).toBe("string");
  });

  it("requires authentication on every evolution route", async () => {
    const list = await request(app).get("/evolution/proposals");
    expect(list.status).toBe(401);
    const sweep = await request(app).post("/evolution/sweep");
    expect(sweep.status).toBe(401);
  });
});

describe("Safety invariant (M9): application_code_update can never auto-apply or self-deploy", () => {
  it("approving an application_code_update records the decision but never applies it — status stays 'approved', never 'applied'", async () => {
    const token = await pairedToken();
    const proposal = await createProposal(pool, {
      changeClass: "application_code_update",
      title: "Change src/index.ts",
      rationale: "r",
      diff: { file: "src/index.ts", patch: "..." },
      riskLevel: "high",
      requiresApproval: true,
    });

    const res = await request(app).post(`/evolution/proposals/${proposal.id}/approve`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("approved");
    expect(res.body.data.status).not.toBe("applied");

    const row = await pool.query("SELECT status, applied_at FROM evolution_proposals WHERE id = $1", [proposal.id]);
    expect(row.rows[0]).toMatchObject({ status: "approved", applied_at: null });

    // No "applied" audit entry exists — only the human's approval.
    const audit = await pool.query("SELECT action FROM audit_log WHERE target_id = $1", [proposal.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(["evolution_proposal.approved"]);
  });

  it("the automated review pipeline (Guardian + sandbox + auto-apply) never produces status='approved' for any change class, valid or invalid diff", async () => {
    const { reviewAndMaybeApply } = await import("../../src/core/evolution/reviewAndApply.js");
    const eventBus = new EventBus(pool);
    const fixtures: { changeClass: Parameters<typeof createProposal>[1]["changeClass"]; diff: Record<string, unknown> }[] = [
      { changeClass: "application_code_update", diff: { file: "x", patch: "y" } },
      { changeClass: "application_code_update", diff: {} }, // empty diff
      { changeClass: "skill_update", diff: { tool: "web_search" } },
      { changeClass: "knowledge_update", diff: { category: "knowledge", content: "z" } },
      { changeClass: "model_registry_update", diff: { id: "no/such-model" } }, // malformed, will fail sandbox
      { changeClass: "routing_policy_update", diff: { modelId: "no-such-model", newPriority: 1 } },
    ];

    for (const fixture of fixtures) {
      const proposal = await createProposal(pool, {
        changeClass: fixture.changeClass,
        title: "invariant probe",
        rationale: "r",
        diff: fixture.diff,
        riskLevel: "high",
        requiresApproval: fixture.changeClass === "application_code_update" || fixture.changeClass === "skill_update",
      });
      const result = await reviewAndMaybeApply({ pool, eventBus, modelRegistry, memoryEngine }, proposal);
      expect(result.status).not.toBe("approved");
      expect(result.decided_by).not.toBe("user"); // only a human REST call ever sets decided_by='user'
    }
  });
});
