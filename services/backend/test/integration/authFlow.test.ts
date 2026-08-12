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
const { agentRegistry, memoryEngine, toolRegistry } = buildTestAgentRegistry(pool);
const app = createApp({ pool, redis, queues: [], eventBus: new EventBus(pool), modelRegistry, agentRegistry, memoryEngine, toolRegistry, logger });

beforeEach(async () => {
  await resetTestData(pool);
  await ensureOwner(pool, "Test Owner");
});

afterAll(async () => {
  await redis.quit();
  await closeTestPool();
});

describe("auth flow", () => {
  it("rejects a bogus pairing code", async () => {
    const res = await request(app)
      .post("/auth/pair")
      .send({ pairingCode: "NOPE0000", deviceName: "phone", platform: "android" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("pairing_invalid");
  });

  it("pairs successfully with a valid single-use code, and rejects reuse", async () => {
    const code = await generatePairingCode(pool);

    const first = await request(app).post("/auth/pair").send({ pairingCode: code, deviceName: "phone", platform: "android" });
    expect(first.status).toBe(201);
    expect(first.body.data.accessToken).toBeTypeOf("string");
    expect(first.body.data.refreshToken).toBeTypeOf("string");

    const second = await request(app).post("/auth/pair").send({ pairingCode: code, deviceName: "phone-2", platform: "android" });
    expect(second.status).toBe(401);
    expect(second.body.error.code).toBe("pairing_already_used");
  });

  it("requires a bearer token on protected routes", async () => {
    const res = await request(app).get("/providers");
    expect(res.status).toBe(401);
  });

  it("issues a new access token via refresh, and rejects a bad refresh token", async () => {
    const code = await generatePairingCode(pool);
    const pair = await request(app).post("/auth/pair").send({ pairingCode: code, deviceName: "phone", platform: "android" });

    const refreshed = await request(app).post("/auth/refresh").send({ refreshToken: pair.body.data.refreshToken });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.accessToken).toBeTypeOf("string");

    const bad = await request(app).post("/auth/refresh").send({ refreshToken: "not-a-real-token" });
    expect(bad.status).toBe(401);
  });

  it("lets a paired device see itself in /auth/sessions, and revoke works", async () => {
    const code = await generatePairingCode(pool);
    const pair = await request(app).post("/auth/pair").send({ pairingCode: code, deviceName: "phone", platform: "android" });
    const token = pair.body.data.accessToken as string;

    const sessions = await request(app).get("/auth/sessions").set("Authorization", `Bearer ${token}`);
    expect(sessions.status).toBe(200);
    expect(sessions.body.data).toHaveLength(1);
    expect(sessions.body.data[0].deviceName).toBe("phone");

    const sessionId = sessions.body.data[0].id as string;
    const revoke = await request(app).post("/auth/revoke").set("Authorization", `Bearer ${token}`).send({ deviceSessionId: sessionId });
    expect(revoke.status).toBe(204);

    const afterRevoke = await request(app).get("/providers").set("Authorization", `Bearer ${token}`);
    expect(afterRevoke.status).toBe(401);
  });
});
