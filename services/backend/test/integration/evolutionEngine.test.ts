import "../setupEnv.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getTestPool, resetTestData, closeTestPool } from "../helpers/testDb.js";
import { buildTestAgentRegistry } from "../helpers/appDeps.js";
import { EventBus } from "../../src/core/events/eventBus.js";
import { ModelRegistryService } from "../../src/core/registry/modelRegistryService.js";
import { createProposal, getProposal } from "../../src/db/repositories/evolutionProposalRepo.js";
import { sandboxTestProposal } from "../../src/core/evolution/sandbox.js";
import { applyEvolutionProposal } from "../../src/core/evolution/applyProposal.js";
import { NoEvolutionApplierError } from "../../src/core/evolution/errors.js";
import { reviewAndMaybeApply } from "../../src/core/evolution/reviewAndApply.js";

const pool = await getTestPool();

beforeEach(async () => {
  await resetTestData(pool);
});

afterAll(async () => {
  await closeTestPool();
});

const NEW_MODEL_DIFF = {
  id: "groq/brand-new-model",
  providerId: "groq", // real seeded provider (migration 0013) — model_registry.provider_id has a FK to providers
  providerModelRef: "brand-new-model",
  displayName: "Brand New Model",
  capabilities: {
    contextLength: 8000,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    supportsStructuredOutput: false,
    modality: "text",
    tags: [],
  },
};

const EXISTING_MODEL_ID = "groq/llama-3.3-70b-versatile"; // seeded, see testDb.ts's SEEDED_MODEL_IDS

describe("Sandbox testing (M9) — real, always-rolled-back transactions", () => {
  it("validates a well-formed model_registry_update diff and rolls back, never leaking into the real registry", async () => {
    const proposal = await createProposal(pool, {
      changeClass: "model_registry_update",
      title: "t",
      rationale: "r",
      diff: NEW_MODEL_DIFF,
      riskLevel: "low",
      requiresApproval: false,
    });
    const result = await sandboxTestProposal(pool, proposal);
    expect(result.validated).toBe(true);

    const modelRegistry = new ModelRegistryService(pool);
    const stillMissing = await modelRegistry.get(NEW_MODEL_DIFF.id);
    expect(stillMissing).toBeUndefined();
  });

  it("rejects a model_registry_update diff missing required fields", async () => {
    const proposal = await createProposal(pool, {
      changeClass: "model_registry_update",
      title: "t",
      rationale: "r",
      diff: { id: "x" },
      riskLevel: "low",
      requiresApproval: false,
    });
    const result = await sandboxTestProposal(pool, proposal);
    expect(result.validated).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("validates a well-formed routing_policy_update diff against an existing model and rolls back", async () => {
    const proposal = await createProposal(pool, {
      changeClass: "routing_policy_update",
      title: "t",
      rationale: "r",
      diff: { modelId: EXISTING_MODEL_ID, previousPriority: 0, newPriority: 1 },
      riskLevel: "low",
      requiresApproval: false,
    });
    const result = await sandboxTestProposal(pool, proposal);
    expect(result.validated).toBe(true);

    const modelRegistry = new ModelRegistryService(pool);
    const entry = await modelRegistry.get(EXISTING_MODEL_ID);
    expect(entry?.userPriority).toBe(0); // rolled back, unchanged
  });

  it("rejects a routing_policy_update diff targeting a model that doesn't exist", async () => {
    const proposal = await createProposal(pool, {
      changeClass: "routing_policy_update",
      title: "t",
      rationale: "r",
      diff: { modelId: "does-not-exist", newPriority: 1 },
      riskLevel: "low",
      requiresApproval: false,
    });
    const result = await sandboxTestProposal(pool, proposal);
    expect(result.validated).toBe(false);
  });

  it("rejects a routing_policy_update diff with an out-of-bounds priority", async () => {
    const proposal = await createProposal(pool, {
      changeClass: "routing_policy_update",
      title: "t",
      rationale: "r",
      diff: { modelId: EXISTING_MODEL_ID, newPriority: 99 },
      riskLevel: "low",
      requiresApproval: false,
    });
    const result = await sandboxTestProposal(pool, proposal);
    expect(result.validated).toBe(false);
  });

  it("validates a well-formed knowledge_update diff and rolls back, never leaking a memory_items row", async () => {
    const proposal = await createProposal(pool, {
      changeClass: "knowledge_update",
      title: "t",
      rationale: "r",
      diff: { category: "knowledge", content: "MD AI supports five providers." },
      riskLevel: "low",
      requiresApproval: false,
    });
    const result = await sandboxTestProposal(pool, proposal);
    expect(result.validated).toBe(true);

    const rows = await pool.query("SELECT * FROM memory_items WHERE content = $1", ["MD AI supports five providers."]);
    expect(rows.rows).toHaveLength(0);
  });

  it("has no validator for skill_update/application_code_update — both always require human review", async () => {
    for (const changeClass of ["skill_update", "application_code_update"] as const) {
      const proposal = await createProposal(pool, {
        changeClass,
        title: "t",
        rationale: "r",
        diff: { anything: true },
        riskLevel: "high",
        requiresApproval: true,
      });
      const result = await sandboxTestProposal(pool, proposal);
      expect(result.validated).toBe(false);
      expect(result.reason).toContain("human review");
    }
  });
});

describe("applyEvolutionProposal (M9) — the only place a diff is actually written", () => {
  it("model_registry_update: upserts the real model_registry row via the Model Registry service", async () => {
    const modelRegistry = new ModelRegistryService(pool);
    const { memoryEngine } = buildTestAgentRegistry(pool);
    const proposal = await createProposal(pool, {
      changeClass: "model_registry_update",
      title: "t",
      rationale: "r",
      diff: NEW_MODEL_DIFF,
      riskLevel: "low",
      requiresApproval: false,
    });
    await pool.query("UPDATE evolution_proposals SET status = 'sandbox_tested' WHERE id = $1", [proposal.id]);
    const reread = (await getProposal(pool, proposal.id))!;

    const applied = await applyEvolutionProposal({ pool, modelRegistry, memoryEngine }, reread);
    expect(applied.status).toBe("applied");
    expect(applied.applied_at).not.toBeNull();

    const entry = await modelRegistry.get(NEW_MODEL_DIFF.id);
    expect(entry).toMatchObject({ displayName: "Brand New Model", discoveredBy: "evolution_engine" });
  });

  it("routing_policy_update: really changes the model's user_priority", async () => {
    const modelRegistry = new ModelRegistryService(pool);
    const { memoryEngine } = buildTestAgentRegistry(pool);
    const proposal = await createProposal(pool, {
      changeClass: "routing_policy_update",
      title: "t",
      rationale: "r",
      diff: { modelId: EXISTING_MODEL_ID, previousPriority: 0, newPriority: 3 },
      riskLevel: "low",
      requiresApproval: false,
    });
    await pool.query("UPDATE evolution_proposals SET status = 'sandbox_tested' WHERE id = $1", [proposal.id]);
    const reread = (await getProposal(pool, proposal.id))!;

    await applyEvolutionProposal({ pool, modelRegistry, memoryEngine }, reread);

    const entry = await modelRegistry.get(EXISTING_MODEL_ID);
    expect(entry?.userPriority).toBe(3);
  });

  it("knowledge_update: really creates an approved memory item via the Memory Engine", async () => {
    const modelRegistry = new ModelRegistryService(pool);
    const { memoryEngine } = buildTestAgentRegistry(pool);
    const proposal = await createProposal(pool, {
      changeClass: "knowledge_update",
      title: "t",
      rationale: "r",
      diff: { category: "knowledge", content: "MD AI's Evolution Engine shipped in M9." },
      riskLevel: "low",
      requiresApproval: false,
    });
    await pool.query("UPDATE evolution_proposals SET status = 'sandbox_tested' WHERE id = $1", [proposal.id]);
    const reread = (await getProposal(pool, proposal.id))!;

    await applyEvolutionProposal({ pool, modelRegistry, memoryEngine }, reread);

    const rows = await pool.query("SELECT approval_status FROM memory_items WHERE content = $1", ["MD AI's Evolution Engine shipped in M9."]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].approval_status).toBe("approved");
  });

  it("skill_update and application_code_update always throw NoEvolutionApplierError — never a fabricated apply", async () => {
    const modelRegistry = new ModelRegistryService(pool);
    const { memoryEngine } = buildTestAgentRegistry(pool);
    for (const changeClass of ["skill_update", "application_code_update"] as const) {
      const proposal = await createProposal(pool, {
        changeClass,
        title: "t",
        rationale: "r",
        diff: { anything: true },
        riskLevel: "high",
        requiresApproval: true,
      });
      await pool.query("UPDATE evolution_proposals SET status = 'approved', decided_by = 'user', decided_at = now() WHERE id = $1", [proposal.id]);
      const reread = (await getProposal(pool, proposal.id))!;

      await expect(applyEvolutionProposal({ pool, modelRegistry, memoryEngine }, reread)).rejects.toThrow(NoEvolutionApplierError);

      const stillApproved = await getProposal(pool, proposal.id);
      expect(stillApproved?.status).toBe("approved"); // never silently marked applied
    }
  });
});

describe("reviewAndMaybeApply (M9) — Guardian + sandbox + conditional auto-apply", () => {
  it("Guardian-denied proposal (empty diff) never reaches sandbox testing or apply", async () => {
    const eventBus = new EventBus(pool);
    const modelRegistry = new ModelRegistryService(pool);
    const { memoryEngine } = buildTestAgentRegistry(pool);
    const proposal = await createProposal(pool, {
      changeClass: "knowledge_update",
      title: "t",
      rationale: "r",
      diff: {},
      riskLevel: "low",
      requiresApproval: false,
    });

    const result = await reviewAndMaybeApply({ pool, eventBus, modelRegistry, memoryEngine }, proposal);
    expect(result.status).toBe("rejected");
    expect(result.decided_by).toBe("auto");
    expect(result.sandbox_result).toBeNull(); // never reached sandbox testing

    const events = await pool.query("SELECT payload FROM events WHERE event_type = 'evolution.proposal.rejected'");
    expect(events.rows).toHaveLength(1);
  });

  it("a not-denied, requires_approval=false proposal with a passing sandbox test auto-applies with no human involved", async () => {
    const eventBus = new EventBus(pool);
    const modelRegistry = new ModelRegistryService(pool);
    const { memoryEngine } = buildTestAgentRegistry(pool);
    const proposal = await createProposal(pool, {
      changeClass: "model_registry_update",
      title: "t",
      rationale: "r",
      diff: NEW_MODEL_DIFF,
      riskLevel: "low",
      requiresApproval: false,
    });

    const result = await reviewAndMaybeApply({ pool, eventBus, modelRegistry, memoryEngine }, proposal);
    expect(result.status).toBe("applied");
    expect(result.decided_by).toBeNull(); // auto-apply is not a "decision" — no human or Guardian veto involved

    const entry = await modelRegistry.get(NEW_MODEL_DIFF.id);
    expect(entry).toBeDefined();

    const events = await pool.query("SELECT payload FROM events WHERE event_type = 'evolution.proposal.applied'");
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].payload.appliedBy).toBe("system");
  });

  it("a requires_approval=true proposal is sandbox-tested but stops there — never auto-applied, even if Guardian has no objection", async () => {
    const eventBus = new EventBus(pool);
    const modelRegistry = new ModelRegistryService(pool);
    const { memoryEngine } = buildTestAgentRegistry(pool);
    const proposal = await createProposal(pool, {
      changeClass: "knowledge_update",
      title: "t",
      rationale: "r",
      diff: { category: "knowledge", content: "this must wait for a human" },
      riskLevel: "low",
      requiresApproval: true, // e.g. a hypothetical future producer flagged this one
    });

    const result = await reviewAndMaybeApply({ pool, eventBus, modelRegistry, memoryEngine }, proposal);
    expect(result.status).toBe("sandbox_tested");
    expect(result.sandbox_result).toMatchObject({ validated: true });

    const rows = await pool.query("SELECT * FROM memory_items WHERE content = $1", ["this must wait for a human"]);
    expect(rows.rows).toHaveLength(0); // never actually applied

    const appliedEvents = await pool.query("SELECT id FROM events WHERE event_type = 'evolution.proposal.applied'");
    expect(appliedEvents.rows).toHaveLength(0);
  });

  it("a proposal whose sandbox test fails is never force-applied, even when requires_approval is false", async () => {
    const eventBus = new EventBus(pool);
    const modelRegistry = new ModelRegistryService(pool);
    const { memoryEngine } = buildTestAgentRegistry(pool);
    const proposal = await createProposal(pool, {
      changeClass: "routing_policy_update",
      title: "t",
      rationale: "r",
      diff: { modelId: "does-not-exist", newPriority: 1 },
      riskLevel: "low",
      requiresApproval: false,
    });

    const result = await reviewAndMaybeApply({ pool, eventBus, modelRegistry, memoryEngine }, proposal);
    expect(result.status).toBe("sandbox_tested");
    expect(result.sandbox_result).toMatchObject({ validated: false });

    const appliedEvents = await pool.query("SELECT id FROM events WHERE event_type = 'evolution.proposal.applied'");
    expect(appliedEvents.rows).toHaveLength(0);
  });
});
