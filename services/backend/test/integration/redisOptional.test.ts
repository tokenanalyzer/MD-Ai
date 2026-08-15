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

/**
 * Covers the 4 required cases for making Redis/BullMQ optional
 * (services/backend/src/config/env.ts's REDIS_URL, index.ts's conditional
 * boot): (A) present -> Bot/Automation Engine work, (B) absent -> the app
 * still builds/boots and serves requests, (C) core chat/provider-adjacent
 * routes are unaffected either way, (D) Redis-dependent routes return a
 * controlled 503 instead of crashing when absent.
 *
 * Two `createApp` instances share the same test Postgres pool/data: one
 * wired with a real Redis connection + started engines (mirrors REDIS_URL
 * present), one with redis/botEngine/automationEngine all `undefined`
 * (mirrors REDIS_URL absent) — exactly what index.ts now produces in each
 * case.
 */
const pool = await getTestPool();
const redis = new Redis(process.env.REDIS_URL as string);
const logger = pino({ level: "silent" });

const withRedisDeps = buildTestAgentRegistry(pool, redis);
const appWithRedis = createApp({
  pool,
  redis,
  queues: [],
  eventBus: new EventBus(pool),
  modelRegistry: new ModelRegistryService(pool),
  ...withRedisDeps,
  logger,
});

const withoutRedisDeps = buildTestAgentRegistry(pool);
const appWithoutRedis = createApp({
  pool,
  redis: undefined,
  queues: [],
  eventBus: new EventBus(pool),
  modelRegistry: new ModelRegistryService(pool),
  agentRegistry: withoutRedisDeps.agentRegistry,
  memoryEngine: withoutRedisDeps.memoryEngine,
  toolRegistry: withoutRedisDeps.toolRegistry,
  botRegistry: withoutRedisDeps.botRegistry,
  botEngine: undefined,
  automationEngine: undefined,
  logger,
});

let serverWithRedis: Server;
let serverWithoutRedis: Server;

beforeAll(async () => {
  await withRedisDeps.botEngine.start();
  await withRedisDeps.automationEngine.start();
  serverWithRedis = createServer(appWithRedis);
  await new Promise<void>((resolve) => serverWithRedis.listen(0, resolve));
  serverWithoutRedis = createServer(appWithoutRedis);
  await new Promise<void>((resolve) => serverWithoutRedis.listen(0, resolve));
});

afterAll(async () => {
  await withRedisDeps.botEngine.stop();
  await withRedisDeps.automationEngine.stop();
  await new Promise((resolve) => serverWithRedis.close(resolve));
  await new Promise((resolve) => serverWithoutRedis.close(resolve));
  await redis.quit();
  await closeTestPool();
});

beforeEach(async () => {
  await resetTestData(pool);
  await ensureOwner(pool, "Test Owner");
});

async function pairedToken(app: typeof appWithRedis): Promise<string> {
  const code = await generatePairingCode(pool);
  const res = await request(app).post("/auth/pair").send({ pairingCode: code, deviceName: "phone", platform: "android" });
  return res.body.data.accessToken as string;
}

describe("Redis/BullMQ optionality (Bot Engine + Automation Engine + maintenance workers)", () => {
  it("A. REDIS_URL present: Bot Engine actually runs a bot via /bots/:id/run-now", async () => {
    const token = await pairedToken(appWithRedis);
    const res = await request(appWithRedis)
      .post("/bots/news-monitor/run-now")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(202);
  });

  it("B. REDIS_URL absent: the app still boots and serves an unauthenticated liveness check", async () => {
    const res = await request(appWithoutRedis).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("C. core chat/provider-adjacent functionality is unaffected without Redis: pairing + /providers + DB-backed /bots listing all work", async () => {
    const token = await pairedToken(appWithoutRedis);
    expect(token).toBeTruthy();

    const providers = await request(appWithoutRedis).get("/providers").set("Authorization", `Bearer ${token}`);
    expect(providers.status).toBe(200);

    const bots = await request(appWithoutRedis).get("/bots").set("Authorization", `Bearer ${token}`);
    expect(bots.status).toBe(200);
    expect(Array.isArray(bots.body.data)).toBe(true);
  });

  it("D. REDIS_URL absent: /health reports Redis as disabled (not errored), and overall status isn't forced to \"error\" by that alone", async () => {
    const token = await pairedToken(appWithoutRedis);
    const res = await request(appWithoutRedis).get("/health").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.redis).toEqual({ ok: true, disabled: true });
    expect(res.body.data.queues).toEqual([]);
    expect(res.body.data.status).not.toBe("error");
  });

  it("D. REDIS_URL absent: POST /bots/:id/run-now returns a controlled 503, not a crash", async () => {
    const token = await pairedToken(appWithoutRedis);
    const res = await request(appWithoutRedis)
      .post("/bots/news-monitor/run-now")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe("service_unavailable");
  });

  it("D. REDIS_URL absent: POST /automations/:id/run returns a controlled 503, not a crash", async () => {
    const token = await pairedToken(appWithoutRedis);
    const create = await request(appWithoutRedis)
      .post("/automations")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "test automation", triggerType: "manual", actionType: "notification", actionConfig: {} });
    expect(create.status).toBe(201);

    const run = await request(appWithoutRedis)
      .post(`/automations/${create.body.data.id}/run`)
      .set("Authorization", `Bearer ${token}`);
    expect(run.status).toBe(503);
    expect(run.body.error?.code).toBe("service_unavailable");
  });
});
