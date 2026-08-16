import "../setupEnv.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import pino from "pino";
import request from "supertest";
import { createApp } from "../../src/api/app.js";
import { AutomationEngine } from "../../src/core/automations/automationEngine.js";
import { EventBus } from "../../src/core/events/eventBus.js";
import { ModelRegistryService } from "../../src/core/registry/modelRegistryService.js";
import { generatePairingCode } from "../../src/core/security/pairing.js";
import { getBackgroundCredential } from "../../src/db/repositories/backgroundCredentialRepo.js";
import { computeWebhookSignature } from "../../src/core/automations/webhookSignature.js";
import { buildTestAgentRegistry } from "../helpers/appDeps.js";
import { getTestPool, resetTestData, closeTestPool } from "../helpers/testDb.js";
import type { NotificationSender } from "@mdai/shared-types";

const pool = await getTestPool();
const redis = new Redis(process.env.REDIS_URL as string);
const logger = pino({ level: "silent" });

const noopSender: NotificationSender = {
  async send() {
    return { delivered: [], failed: [] };
  },
};

// Fixed for the whole file (not re-derived per test) because AutomationEngine
// captures `ownerId` once at construction, but resetTestData() truncates the
// `owner` table before every test — beforeEach re-inserts the SAME id below
// so notifyForFinding's FK to owner(id) keeps resolving.
const ownerId = randomUUID();
const { agentRegistry, memoryEngine, toolRegistry, botRegistry, botEngine } = buildTestAgentRegistry(pool);
const eventBus = new EventBus(pool);
const modelRegistry = new ModelRegistryService(pool);
// This file's dedicated, started AutomationEngine — never registers a
// trigger_type='schedule' automation, so no repeatable-job cleanup hygiene
// is needed (unlike automationEngine.test.ts).
const automationEngine = new AutomationEngine({
  pool,
  eventBus,
  modelRegistry,
  agentRegistry,
  toolRegistry,
  ownerId,
  notificationSender: noopSender,
  logger,
});
const app = createApp({ pool, redis, queues: [], eventBus, modelRegistry, agentRegistry, memoryEngine, toolRegistry, botRegistry, botEngine, automationEngine, logger });

let engineStarted = false;

beforeEach(async () => {
  await resetTestData(pool);
  await pool.query("INSERT INTO owner (id, display_name) VALUES ($1, $2)", [ownerId, "Test Owner"]);
  if (!engineStarted) {
    await automationEngine.start();
    engineStarted = true;
  }
});

afterAll(async () => {
  await automationEngine.stop();
  await redis.quit();
  await closeTestPool();
});

async function pairedToken(): Promise<string> {
  const code = await generatePairingCode(pool);
  const res = await request(app).post("/auth/pair").send({ pairingCode: code, deviceName: "phone", platform: "android" });
  return res.body.data.accessToken as string;
}

describe("Automations REST surface (M10)", () => {
  it("creates a manual/notification automation, lists it, gets it by id, patches it, and deletes it", async () => {
    const token = await pairedToken();

    const create = await request(app)
      .post("/automations")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Daily digest",
        description: "Sends a summary notification",
        triggerType: "manual",
        actionType: "notification",
        actionConfig: { title: "Digest", summary: "Here's your digest", importance: "low" },
      });
    expect(create.status).toBe(201);
    expect(create.body.data).toMatchObject({ name: "Daily digest", triggerType: "manual", actionType: "notification", enabled: true });
    expect(create.body.data.webhookSecret).toBeUndefined();
    const id = create.body.data.id as string;

    const list = await request(app).get("/automations").set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.data.map((a: { id: string }) => a.id)).toContain(id);

    const get = await request(app).get(`/automations/${id}`).set("Authorization", `Bearer ${token}`);
    expect(get.status).toBe(200);
    expect(get.body.data.name).toBe("Daily digest");

    const patch = await request(app).patch(`/automations/${id}`).set("Authorization", `Bearer ${token}`).send({ enabled: false });
    expect(patch.status).toBe(200);
    expect(patch.body.data.enabled).toBe(false);

    const del = await request(app).delete(`/automations/${id}`).set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(204);

    const getAfterDelete = await request(app).get(`/automations/${id}`).set("Authorization", `Bearer ${token}`);
    expect(getAfterDelete.status).toBe(404);
  });

  it("returns a webhookSecret exactly once at creation for triggerType='webhook', never again on a later GET, and revokes the credential on delete", async () => {
    const token = await pairedToken();

    const create = await request(app)
      .post("/automations")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Webhook-triggered",
        triggerType: "webhook",
        actionType: "notification",
        actionConfig: { title: "Hook fired", summary: "x" },
      });
    expect(create.status).toBe(201);
    const id = create.body.data.id as string;
    const slug = create.body.data.webhookSlug as string;
    expect(slug).toBeTruthy();
    expect(typeof create.body.data.webhookSecret).toBe("string");
    expect((create.body.data.webhookSecret as string).length).toBeGreaterThan(10);

    const credential = await getBackgroundCredential(pool, "automation_webhook", id);
    expect(credential).toBeDefined();

    const get = await request(app).get(`/automations/${id}`).set("Authorization", `Bearer ${token}`);
    expect(get.body.data.webhookSecret).toBeUndefined();
    expect(get.body.data.webhookSlug).toBe(slug);

    const del = await request(app).delete(`/automations/${id}`).set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(204);
    expect(await getBackgroundCredential(pool, "automation_webhook", id)).toBeUndefined();
  });

  it("lists run history and runs an automation immediately via POST /:id/run", async () => {
    const token = await pairedToken();

    const create = await request(app)
      .post("/automations")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Run-now test",
        triggerType: "manual",
        actionType: "notification",
        actionConfig: { title: "x", summary: "x" },
      });
    const id = create.body.data.id as string;

    const run = await request(app).post(`/automations/${id}/run`).set("Authorization", `Bearer ${token}`);
    expect(run.status).toBe(202);
    expect(run.body.data.status).toBe("succeeded");

    const runs = await request(app).get(`/automations/${id}/runs`).set("Authorization", `Bearer ${token}`);
    expect(runs.status).toBe(200);
    expect(runs.body.data).toHaveLength(1);
    expect(runs.body.data[0]).toMatchObject({ status: "succeeded", triggerType: "manual" });
  });

  it("404s every route for an unpaired request (authGuard applies to the whole router)", async () => {
    const res = await request(app).get("/automations");
    expect(res.status).toBe(401);
  });
});

describe("Signed webhook trigger route — the one deliberate exception to bearer-token auth (M10)", () => {
  async function createWebhookAutomation(token: string): Promise<{ id: string; slug: string; secret: string }> {
    const create = await request(app)
      .post("/automations")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "n8n-triggered",
        triggerType: "webhook",
        actionType: "notification",
        actionConfig: { title: "Webhook fired", summary: "x" },
      });
    return { id: create.body.data.id, slug: create.body.data.webhookSlug, secret: create.body.data.webhookSecret };
  }

  it("accepts a correctly-signed request and actually triggers a run", async () => {
    const token = await pairedToken();
    const { id, slug, secret } = await createWebhookAutomation(token);

    const rawBody = JSON.stringify({ hello: "n8n" });
    const signature = computeWebhookSignature(secret, Buffer.from(rawBody));

    const res = await request(app)
      .post(`/webhooks/automations/${slug}`)
      .set("Content-Type", "application/json")
      .set("X-MDAI-Signature", signature)
      .send(rawBody);
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ accepted: true });

    // trigger() is fire-and-forget — poll briefly for the async run to land.
    let runs: unknown[] = [];
    for (let i = 0; i < 20; i++) {
      const runsRes = await request(app).get(`/automations/${id}/runs`).set("Authorization", `Bearer ${token}`);
      runs = runsRes.body.data;
      if (runs.length > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(runs.length).toBeGreaterThan(0);
    expect((runs[0] as { triggerType: string }).triggerType).toBe("webhook");
  });

  it("refuses a request with no signature header at all", async () => {
    const token = await pairedToken();
    const { slug } = await createWebhookAutomation(token);

    const res = await request(app).post(`/webhooks/automations/${slug}`).set("Content-Type", "application/json").send(JSON.stringify({}));
    expect(res.status).toBe(401);
  });

  it("refuses a request with a wrong (but well-formed) signature — a valid slug alone is never sufficient", async () => {
    const token = await pairedToken();
    const { slug } = await createWebhookAutomation(token);

    const wrongSignature = "0".repeat(64);
    const res = await request(app)
      .post(`/webhooks/automations/${slug}`)
      .set("Content-Type", "application/json")
      .set("X-MDAI-Signature", wrongSignature)
      .send(JSON.stringify({}));
    expect(res.status).toBe(401);
  });

  it("refuses a request signed for a different automation's secret (cross-automation replay)", async () => {
    const token = await pairedToken();
    const { slug } = await createWebhookAutomation(token);
    const other = await createWebhookAutomation(token);

    const rawBody = JSON.stringify({});
    const signedWithWrongSecret = computeWebhookSignature(other.secret, Buffer.from(rawBody));

    const res = await request(app)
      .post(`/webhooks/automations/${slug}`)
      .set("Content-Type", "application/json")
      .set("X-MDAI-Signature", signedWithWrongSecret)
      .send(rawBody);
    expect(res.status).toBe(401);
  });

  it("404s an unknown slug", async () => {
    const res = await request(app)
      .post("/webhooks/automations/not-a-real-slug")
      .set("Content-Type", "application/json")
      .set("X-MDAI-Signature", "a".repeat(64))
      .send(JSON.stringify({}));
    expect(res.status).toBe(404);
  });

  it("404s a disabled automation's webhook even with a correctly-signed request", async () => {
    const token = await pairedToken();
    const { id, slug, secret } = await createWebhookAutomation(token);
    await request(app).patch(`/automations/${id}`).set("Authorization", `Bearer ${token}`).send({ enabled: false });

    const rawBody = JSON.stringify({});
    const signature = computeWebhookSignature(secret, Buffer.from(rawBody));
    const res = await request(app)
      .post(`/webhooks/automations/${slug}`)
      .set("Content-Type", "application/json")
      .set("X-MDAI-Signature", signature)
      .send(rawBody);
    expect(res.status).toBe(404);
  });

  it("404s a non-webhook automation's slug lookup (there is none — only triggerType='webhook' rows ever get a slug), proving trigger_type is re-checked server-side too", async () => {
    // A manual automation has no webhook_slug at all, so any guessed slug 404s.
    const res = await request(app)
      .post("/webhooks/automations/guessed-slug-for-a-manual-automation")
      .set("Content-Type", "application/json")
      .set("X-MDAI-Signature", "a".repeat(64))
      .send(JSON.stringify({}));
    expect(res.status).toBe(404);
  });
});
