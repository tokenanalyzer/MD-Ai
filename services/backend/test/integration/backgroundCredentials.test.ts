import "../setupEnv.js";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
const { agentRegistry, memoryEngine, toolRegistry, botRegistry, botEngine, automationEngine } = buildTestAgentRegistry(pool);
const app = createApp({ pool, redis, queues: [], eventBus: new EventBus(pool), modelRegistry, agentRegistry, memoryEngine, toolRegistry, botRegistry, botEngine, automationEngine, logger });

let server: Server;
beforeAll(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await redis.quit();
  await closeTestPool();
});

beforeEach(async () => {
  await resetTestData(pool);
  await ensureOwner(pool, "Test Owner");
});

async function pairedToken(): Promise<string> {
  const code = await generatePairingCode(pool);
  const res = await request(app).post("/auth/pair").send({ pairingCode: code, deviceName: "phone", platform: "android" });
  return res.body.data.accessToken as string;
}

describe("Background credential vault REST surface (M5.12a)", () => {
  it("opts a provider into background use, never echoes the plaintext key back, and lets it be revoked", async () => {
    const token = await pairedToken();
    const secretKey = "gsk-super-secret-background-key-1234567890";

    const putRes = await request(app)
      .put("/background-credentials")
      .set("Authorization", `Bearer ${token}`)
      .send({ credentialKind: "llm_provider", credentialId: "groq", apiKey: secretKey });
    expect(putRes.status).toBe(201);
    expect(JSON.stringify(putRes.body)).not.toContain(secretKey);
    expect(putRes.body.data.keyLast4).toBe(secretKey.slice(-4));

    const listRes = await request(app).get("/background-credentials").set("Authorization", `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    expect(JSON.stringify(listRes.body)).not.toContain(secretKey);
    expect(listRes.body.data).toEqual([
      expect.objectContaining({ credentialKind: "llm_provider", credentialId: "groq", keyLast4: secretKey.slice(-4) }),
    ]);

    // The raw ciphertext columns must never surface through the DB row
    // either — only the application layer's decrypt path should ever see
    // plaintext, and only transiently.
    const raw = await pool.query("SELECT * FROM background_credentials WHERE credential_id = 'groq'");
    expect(JSON.stringify(raw.rows)).not.toContain(secretKey);

    const delRes = await request(app).delete("/background-credentials/llm_provider/groq").set("Authorization", `Bearer ${token}`);
    expect(delRes.status).toBe(204);
    const afterDelete = await request(app).get("/background-credentials").set("Authorization", `Bearer ${token}`);
    expect(afterDelete.body.data).toEqual([]);
  });

  it("rejects an unknown provider/search-provider id", async () => {
    const token = await pairedToken();
    const res = await request(app)
      .put("/background-credentials")
      .set("Authorization", `Bearer ${token}`)
      .send({ credentialKind: "search_provider", credentialId: "not-a-real-provider", apiKey: "x" });
    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/background-credentials");
    expect(res.status).toBe(401);
  });
});
