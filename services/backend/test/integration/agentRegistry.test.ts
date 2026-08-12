import "../setupEnv.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import pino from "pino";
import { Redis } from "ioredis";
import { createApp } from "../../src/api/app.js";
import { EventBus } from "../../src/core/events/eventBus.js";
import { ModelRegistryService } from "../../src/core/registry/modelRegistryService.js";
import { ensureOwner } from "../../src/db/repositories/ownerRepo.js";
import { generatePairingCode } from "../../src/core/security/pairing.js";
import { getTestPool, resetTestData, closeTestPool } from "../helpers/testDb.js";
import { buildTestAgentRegistry } from "../helpers/appDeps.js";

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

describe("Agent Registry (M3.1)", () => {
  it("lists exactly the M3 three-agent roster with real, non-hardcoded capabilities", async () => {
    const token = await pairedToken();
    const res = await request(app).get("/agents").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const agents = res.body.data as { id: string; capabilities: string[]; status: string }[];
    const byId = new Map(agents.map((a) => [a.id, a]));
    expect([...byId.keys()].sort()).toEqual(["master", "research", "reviewer"]);
    expect(byId.get("master")?.capabilities).toEqual(expect.arrayContaining(["chat", "orchestration"]));
    expect(byId.get("research")?.capabilities).toContain("research");
    expect(byId.get("reviewer")?.capabilities).toContain("review");
    expect(byId.get("master")?.status).not.toBe("disabled");
  });

  it("reflects a disabled agent's status immediately via PATCH /agents/:id", async () => {
    const token = await pairedToken();
    const patch = await request(app).patch("/agents/research").set("Authorization", `Bearer ${token}`).send({ enabled: false });
    expect(patch.status).toBe(200);
    expect(patch.body.data.status).toBe("disabled");

    const list = await request(app).get("/agents").set("Authorization", `Bearer ${token}`);
    const research = (list.body.data as { id: string; status: string }[]).find((a) => a.id === "research");
    expect(research?.status).toBe("disabled");
  });

  it("authorizes exactly the seeded master→research and master→reviewer delegation edges — nothing else", async () => {
    expect(await agentRegistry.isDelegationAuthorized("master", "research")).toBe(true);
    expect(await agentRegistry.isDelegationAuthorized("master", "reviewer")).toBe(true);
    expect(await agentRegistry.isDelegationAuthorized("research", "reviewer")).toBe(false);
    expect(await agentRegistry.isDelegationAuthorized("reviewer", "research")).toBe(false);
    expect(await agentRegistry.isDelegationAuthorized("research", "master")).toBe(false);
  });

  it("discovers agents by capability rather than a hardcoded id map", async () => {
    const researchCards = await agentRegistry.findByCapability("research");
    expect(researchCards.map((c) => c.id)).toEqual(["research"]);

    const nonsenseCards = await agentRegistry.findByCapability("time-travel");
    expect(nonsenseCards).toEqual([]);
  });
});
