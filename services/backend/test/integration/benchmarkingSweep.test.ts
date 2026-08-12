import "../setupEnv.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getTestPool, resetTestData, closeTestPool } from "../helpers/testDb.js";
import { EventBus } from "../../src/core/events/eventBus.js";
import { ModelRegistryService } from "../../src/core/registry/modelRegistryService.js";
import { buildTestAgentRegistry } from "../helpers/appDeps.js";
import { runBenchmarkingSweep } from "../../src/core/evolution/benchmarking.js";
import { insertModelCallSample, setModelUserConfig } from "../../src/db/repositories/modelRegistryRepo.js";
import { listProposals } from "../../src/db/repositories/evolutionProposalRepo.js";

const pool = await getTestPool();
const MODEL_ID = "groq/llama-3.3-70b-versatile"; // seeded, see testDb.ts's SEEDED_MODEL_IDS

beforeEach(async () => {
  await resetTestData(pool);
});

afterAll(async () => {
  await closeTestPool();
});

async function seedSamples(count: number, opts: { success: boolean; latencyMs: number }): Promise<void> {
  for (let i = 0; i < count; i++) {
    await insertModelCallSample(pool, {
      modelId: MODEL_ID,
      providerId: "groq",
      latencyMs: opts.latencyMs,
      success: opts.success,
    });
  }
}

describe("Benchmarking sweep (M9) — reuses M2.2's real model_call_samples telemetry", () => {
  it("proposes and auto-applies a lower priority for a model with an elevated error rate", async () => {
    const modelRegistry = new ModelRegistryService(pool);
    await setModelUserConfig(pool, MODEL_ID, { userPriority: 3 });
    await seedSamples(8, { success: false, latencyMs: 500 });

    const eventBus = new EventBus(pool);
    const { memoryEngine } = buildTestAgentRegistry(pool);
    const result = await runBenchmarkingSweep({ pool, eventBus, modelRegistry, memoryEngine });

    expect(result.proposalsCreated).toBe(1);
    const applied = await listProposals(pool, "applied");
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ change_class: "routing_policy_update" });
    expect(applied[0]?.diff).toMatchObject({ modelId: MODEL_ID, previousPriority: 3, newPriority: 2 });

    const entry = await modelRegistry.get(MODEL_ID);
    expect(entry?.userPriority).toBe(2);
  });

  it("proposes and auto-applies a higher priority for a model with consistently good telemetry", async () => {
    const modelRegistry = new ModelRegistryService(pool);
    await seedSamples(10, { success: true, latencyMs: 200 });

    const eventBus = new EventBus(pool);
    const { memoryEngine } = buildTestAgentRegistry(pool);
    const result = await runBenchmarkingSweep({ pool, eventBus, modelRegistry, memoryEngine });

    expect(result.proposalsCreated).toBe(1);
    const entry = await modelRegistry.get(MODEL_ID);
    expect(entry?.userPriority).toBe(1); // started at the seeded default of 0
  });

  it("proposes nothing for a model with too few samples", async () => {
    const modelRegistry = new ModelRegistryService(pool);
    await seedSamples(2, { success: false, latencyMs: 500 });

    const eventBus = new EventBus(pool);
    const { memoryEngine } = buildTestAgentRegistry(pool);
    const result = await runBenchmarkingSweep({ pool, eventBus, modelRegistry, memoryEngine });
    expect(result.proposalsCreated).toBe(0);
  });

  it("proposes nothing when telemetry doesn't cross either threshold", async () => {
    const modelRegistry = new ModelRegistryService(pool);
    // 10% error rate, 800ms latency — between the "elevated" (>=20%) and
    // "consistently good" (<5% error AND <1500ms) thresholds.
    await seedSamples(9, { success: true, latencyMs: 800 });
    await insertModelCallSample(pool, { modelId: MODEL_ID, providerId: "groq", latencyMs: 800, success: false });

    const eventBus = new EventBus(pool);
    const { memoryEngine } = buildTestAgentRegistry(pool);
    const result = await runBenchmarkingSweep({ pool, eventBus, modelRegistry, memoryEngine });
    expect(result.proposalsCreated).toBe(0);
  });
});
