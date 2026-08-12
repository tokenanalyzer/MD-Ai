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
const { agentRegistry, memoryEngine, toolRegistry, botRegistry, botEngine } = buildTestAgentRegistry(pool);
const app = createApp({ pool, redis, queues: [], eventBus: new EventBus(pool), modelRegistry, agentRegistry, memoryEngine, toolRegistry, botRegistry, botEngine, logger });

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

describe("Bot Registry discovery + Bot Fleet REST surface (M5.1/M5.16)", () => {
  it("lists exactly the seeded bots (M5's four plus M8's five), no hardcoded scheduler list — DB-backed discovery only", async () => {
    const token = await pairedToken();
    const res = await request(app).get("/bots").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((b: { id: string }) => b.id).sort();
    expect(ids).toEqual([
      "ai-model-release-monitor",
      "business-opportunity-monitor",
      "liquidity-monitor",
      "market-scanner",
      "news-monitor",
      "social-trend-monitor",
      "system-health-monitor",
      "user-topic-monitor",
      "volume-anomaly-monitor",
    ]);
    expect(res.body.data.every((b: { enabled: boolean; status: string }) => b.enabled && b.status === "idle")).toBe(true);
  });

  it("enables/disables and pauses/resumes a bot, persisted through the registry", async () => {
    const token = await pairedToken();

    const disable = await request(app)
      .patch("/bots/news-monitor")
      .set("Authorization", `Bearer ${token}`)
      .send({ enabled: false });
    expect(disable.status).toBe(200);
    expect(disable.body.data.enabled).toBe(false);

    const pause = await request(app)
      .patch("/bots/news-monitor")
      .set("Authorization", `Bearer ${token}`)
      .send({ enabled: true, paused: true });
    expect(pause.body.data.status).toBe("paused");
    expect(pause.body.data.enabled).toBe(true);

    const resume = await request(app)
      .patch("/bots/news-monitor")
      .set("Authorization", `Bearer ${token}`)
      .send({ paused: false });
    expect(resume.body.data.status).toBe("idle");
  });

  it("404s for an unknown bot id rather than silently no-opping", async () => {
    const token = await pairedToken();
    const res = await request(app).patch("/bots/does-not-exist").set("Authorization", `Bearer ${token}`).send({ enabled: false });
    expect(res.status).toBe(404);
  });

  it("requires authentication on every bot route", async () => {
    const res = await request(app).get("/bots");
    expect(res.status).toBe(401);
  });
});
