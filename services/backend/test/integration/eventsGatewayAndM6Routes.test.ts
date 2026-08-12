import "../setupEnv.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import pino from "pino";
import { Redis } from "ioredis";
import { createApp } from "../../src/api/app.js";
import { attachEventsGateway } from "../../src/api/ws/eventsGateway.js";
import { EventBus } from "../../src/core/events/eventBus.js";
import { ModelRegistryService } from "../../src/core/registry/modelRegistryService.js";
import { ensureOwner } from "../../src/db/repositories/ownerRepo.js";
import { generatePairingCode } from "../../src/core/security/pairing.js";
import { getTestPool, resetTestData, closeTestPool } from "../helpers/testDb.js";
import { collectWsFrames } from "../helpers/wsClient.js";
import { buildTestAgentRegistry } from "../helpers/appDeps.js";

const pool = await getTestPool();
const redis = new Redis(process.env.REDIS_URL as string);
const logger = pino({ level: "silent" });
const modelRegistry = new ModelRegistryService(pool);
const eventBus = new EventBus(pool);
const { agentRegistry, memoryEngine, toolRegistry, botRegistry, botEngine } = buildTestAgentRegistry(pool);
const app = createApp({ pool, redis, queues: [], eventBus, modelRegistry, agentRegistry, memoryEngine, toolRegistry, botRegistry, botEngine, logger });

let server: Server;
let wsBaseUrl: string;

beforeAll(async () => {
  server = createServer(app);
  attachEventsGateway(server, pool, eventBus);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  wsBaseUrl = `ws://127.0.0.1:${port}`;
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

describe("GET /events — M6 Command Center snapshot", () => {
  it("requires auth, and returns real events with a monotonic id cursor", async () => {
    const unauth = await request(app).get("/events");
    expect(unauth.status).toBe(401);

    const token = await pairedToken();
    await eventBus.publish({ sourceType: "system", sourceId: "test", payload: { type: "automation.triggered", automationId: "x", automationRunId: "y", triggerType: "manual" } });
    await eventBus.publish({ sourceType: "system", sourceId: "test", payload: { type: "automation.triggered", automationId: "x2", automationRunId: "y2", triggerType: "manual" } });

    const res = await request(app).get("/events").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    const ids = res.body.data.map((e: { id: number }) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("?since=<id> only returns events after that cursor", async () => {
    const token = await pairedToken();
    const first = await eventBus.publish({ sourceType: "system", sourceId: "test", payload: { type: "automation.triggered", automationId: "a", automationRunId: "b", triggerType: "manual" } });
    await eventBus.publish({ sourceType: "system", sourceId: "test", payload: { type: "automation.triggered", automationId: "c", automationRunId: "d", triggerType: "manual" } });

    const res = await request(app).get(`/events?since=${first.id}`).set("Authorization", `Bearer ${token}`);
    expect(res.body.data.every((e: { id: number }) => e.id > first.id)).toBe(true);
  });
});

describe("/ws/events — M6 live event stream", () => {
  it("replays backlog since a cursor, then tails new live events", async () => {
    const token = await pairedToken();
    const before = await eventBus.publish({ sourceType: "system", sourceId: "test", payload: { type: "automation.triggered", automationId: "before", automationRunId: "1", triggerType: "manual" } });

    const framesPromise = collectWsFrames<{ id: number; type: string }>(`${wsBaseUrl}/ws/events?token=${token}&since=${before.id - 1}`, 2, 5000);
    // Give the WS handler a moment to subscribe before publishing the "live" one.
    await new Promise((r) => setTimeout(r, 100));
    await eventBus.publish({ sourceType: "system", sourceId: "test", payload: { type: "automation.triggered", automationId: "live", automationRunId: "2", triggerType: "manual" } });

    const frames = await framesPromise;
    expect(frames).toHaveLength(2);
    expect(frames[0]?.id).toBe(before.id);
    expect(frames[1]?.type).toBe("automation.triggered");
  });

  it("rejects a connection with no token", async () => {
    await expect(collectWsFrames(`${wsBaseUrl}/ws/events`, 1, 1000)).rejects.toThrow();
  });
});

describe("GET /agents/:id/delegations — M6 Agent Detail", () => {
  it("returns Master's real delegation edges (M3's research/reviewer plus M8's specialists and Guardian), not a hardcoded list", async () => {
    const token = await pairedToken();
    const res = await request(app).get("/agents/master/delegations").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((a: { id: string }) => a.id).sort();
    expect(ids).toEqual([
      "ai-radar",
      "business-intel",
      "crypto-intel",
      "guardian",
      "news-intel",
      "research",
      "reviewer",
      "social-media",
      "stock-intel",
    ]);
  });
});

describe("GET /memory/rejected — M6 Memory Center", () => {
  it("lists a rejected memory item and excludes approved/pending ones", async () => {
    const token = await pairedToken();
    const created = await request(app)
      .post("/memory")
      .set("Authorization", `Bearer ${token}`)
      .send({ category: "knowledge", content: "reject me" });
    await request(app).post(`/memory/${created.body.data.id}/reject`).set("Authorization", `Bearer ${token}`);

    const res = await request(app).get("/memory/rejected").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some((m: { id: string }) => m.id === created.body.data.id)).toBe(true);
    expect(res.body.data.every((m: { approval_status: string }) => m.approval_status === "rejected")).toBe(true);
  });
});
