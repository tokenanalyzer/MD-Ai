import "../setupEnv.js";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { getTestPool, resetTestData, closeTestPool } from "../helpers/testDb.js";
import { EventBus } from "../../src/core/events/eventBus.js";
import { ModelRegistryService } from "../../src/core/registry/modelRegistryService.js";
import { buildTestAgentRegistry } from "../helpers/appDeps.js";
import { encryptCredential } from "../../src/core/security/backgroundKeyVault.js";
import { upsertBackgroundCredential } from "../../src/db/repositories/backgroundCredentialRepo.js";
import { runDiscoverySweep } from "../../src/core/evolution/discoverySweep.js";
import { listProposals } from "../../src/db/repositories/evolutionProposalRepo.js";

const pool = await getTestPool();

beforeEach(async () => {
  await resetTestData(pool);
});

afterAll(async () => {
  await closeTestPool();
});

let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;

beforeEach(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
});

async function optInBackgroundGroqKey(): Promise<void> {
  const encrypted = encryptCredential("gsk-background-test-key-1234567890");
  await upsertBackgroundCredential(pool, "llm_provider", "groq", encrypted, "7890");
}

describe("Discovery sweep (M9) — real adapter.listModels() via opted-in background credentials", () => {
  it("creates a model_registry_update proposal for a genuinely new model and auto-applies it", async () => {
    await optInBackgroundGroqKey();
    mockAgent
      .get("https://api.groq.com")
      .intercept({ path: "/openai/v1/models", method: "GET" })
      .reply(200, { data: [{ id: "llama-3.3-70b-versatile" }, { id: "brand-new-groq-model" }] });

    const eventBus = new EventBus(pool);
    const modelRegistry = new ModelRegistryService(pool);
    const { memoryEngine } = buildTestAgentRegistry(pool);

    const result = await runDiscoverySweep({ pool, eventBus, modelRegistry, memoryEngine });

    // "llama-3.3-70b-versatile" is already seeded with matching capabilities
    // (SEEDED_MODEL_IDS) — no proposal for it. Only the genuinely new one.
    expect(result.proposalsCreated).toBe(1);

    const proposals = await listProposals(pool, "applied");
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ change_class: "model_registry_update" });

    const entry = await modelRegistry.get("groq/brand-new-groq-model");
    expect(entry).toBeDefined();
    expect(entry?.discoveredBy).toBe("evolution_engine");
  });

  it("skips a provider quietly (no proposal, no crash) when the live call fails", async () => {
    await optInBackgroundGroqKey();
    mockAgent.get("https://api.groq.com").intercept({ path: "/openai/v1/models", method: "GET" }).reply(500, "server error");

    const eventBus = new EventBus(pool);
    const modelRegistry = new ModelRegistryService(pool);
    const { memoryEngine } = buildTestAgentRegistry(pool);

    const result = await runDiscoverySweep({ pool, eventBus, modelRegistry, memoryEngine });
    expect(result.proposalsCreated).toBe(0);

    const audit = await pool.query("SELECT action FROM audit_log WHERE action = 'evolution.discovery.skipped'");
    expect(audit.rows).toHaveLength(1);
  });

  it("produces no proposal at all when nothing changed since last sweep", async () => {
    await optInBackgroundGroqKey();
    mockAgent
      .get("https://api.groq.com")
      .intercept({ path: "/openai/v1/models", method: "GET" })
      .reply(200, { data: [{ id: "llama-3.3-70b-versatile" }] });

    const eventBus = new EventBus(pool);
    const modelRegistry = new ModelRegistryService(pool);
    const { memoryEngine } = buildTestAgentRegistry(pool);

    const result = await runDiscoverySweep({ pool, eventBus, modelRegistry, memoryEngine });
    expect(result.proposalsCreated).toBe(0);
  });

  it("does nothing when no provider is opted in for background use", async () => {
    const eventBus = new EventBus(pool);
    const modelRegistry = new ModelRegistryService(pool);
    const { memoryEngine } = buildTestAgentRegistry(pool);

    const result = await runDiscoverySweep({ pool, eventBus, modelRegistry, memoryEngine });
    expect(result.proposalsCreated).toBe(0);
  });
});
