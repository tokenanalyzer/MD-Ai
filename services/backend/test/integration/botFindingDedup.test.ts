import "../setupEnv.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../../src/core/events/eventBus.js";
import { ModelRegistryService } from "../../src/core/registry/modelRegistryService.js";
import { ensureOwner } from "../../src/db/repositories/ownerRepo.js";
import { createBot } from "../../src/db/repositories/botRepo.js";
import { createBotRun } from "../../src/db/repositories/botRunRepo.js";
import { upsertFinding } from "../../src/db/repositories/botFindingRepo.js";
import { processBotFindings } from "../../src/core/bots/pipeline.js";
import { buildTestAgentRegistry } from "../helpers/appDeps.js";
import { getTestPool, resetTestData } from "../helpers/testDb.js";
import type { NotificationSender, NormalizedFinding } from "@mdai/shared-types";

const pool = await getTestPool();
const { agentRegistry, toolRegistry } = buildTestAgentRegistry(pool);
const modelRegistry = new ModelRegistryService(pool);

let ownerId = "";
beforeEach(async () => {
  await resetTestData(pool);
  const owner = await ensureOwner(pool, "Test Owner");
  ownerId = owner.id;
  await createBot(pool, { id: "dedup-test-bot", displayName: "Dedup Test Bot", description: "x", scheduleCron: "0 0 1 1 *" });
});

afterAll(async () => {
  // "bots" is catalog data, deliberately not truncated by resetTestData —
  // clean up this file's own test-only bot row so other files (e.g.
  // botsRoute.test.ts's "exactly the four seeded bots" assertion) don't
  // see it leak across files.
  await pool.query("DELETE FROM bots WHERE id = 'dedup-test-bot'");
});

const finding: NormalizedFinding = {
  category: "general",
  title: "Repeatable thing",
  summary: "Detected the same thing repeatedly.",
  importance: "critical",
  confidence: 1,
  sourceMetadata: {},
  payload: {},
  dedupKey: "stable-identity",
};

describe("M5.5 — deduplication at the row level", () => {
  it("collapses a repeat detection into the same row, bumping occurrence_count instead of inserting a new one", async () => {
    const run1 = await createBotRun(pool, "dedup-test-bot");
    const first = await upsertFinding(pool, { botId: "dedup-test-bot", botRunId: run1.id, finding });
    expect(first.isNewFinding).toBe(true);
    expect(first.row.occurrence_count).toBe(1);

    const run2 = await createBotRun(pool, "dedup-test-bot");
    const second = await upsertFinding(pool, { botId: "dedup-test-bot", botRunId: run2.id, finding });
    expect(second.isNewFinding).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(second.row.occurrence_count).toBe(2);
    expect(second.row.bot_run_id).toBe(run2.id);

    const rows = await pool.query("SELECT count(*) FROM bot_findings WHERE bot_id = 'dedup-test-bot'");
    expect(Number(rows.rows[0].count)).toBe(1);
  });
});

describe("M5.5/M5.6 — pipeline: cooldown suppresses repeat notifications, expiry lets a fresh one through", () => {
  it("an AI release visible across many runs produces exactly one notification per cooldown window, not one per run", async () => {
    const sent: string[] = [];
    const sender: NotificationSender = {
      async send(tokens, notification) {
        sent.push(notification.title);
        return { delivered: tokens, failed: [] };
      },
    };
    // A device session with a push token so notifyForFinding doesn't
    // short-circuit on "no_device" before reaching the interesting logic.
    const { createDeviceSession } = await import("../../src/db/repositories/deviceSessionRepo.js");
    await createDeviceSession(pool, { ownerId, deviceName: "test-phone", platform: "android", refreshTokenHash: "x", pushToken: "ExponentPushToken[test]" });
    // Loosen the default-conservative preference (HIGH) so a CRITICAL
    // finding is guaranteed to clear the importance gate in this test.
    const { updateNotificationPreferences } = await import("../../src/db/repositories/notificationPreferencesRepo.js");
    await updateNotificationPreferences(pool, ownerId, { minimumImportance: "low" });

    const deps = { pool, eventBus: new EventBus(pool), modelRegistry, agentRegistry, toolRegistry, ownerId, notificationSender: sender };

    // Simulate 3 separate bot runs all detecting the same underlying thing.
    for (let i = 0; i < 3; i++) {
      const run = await createBotRun(pool, "dedup-test-bot");
      await processBotFindings(deps, "dedup-test-bot", run.id, [finding]);
    }
    expect(sent).toHaveLength(1); // only the first run's detection actually notified

    const findingRow = await pool.query("SELECT occurrence_count, cooldown_until FROM bot_findings WHERE bot_id = 'dedup-test-bot'");
    expect(findingRow.rows[0].occurrence_count).toBe(3); // but every run's detection was still recorded

    // Expire the cooldown manually (simulating real time passing) and
    // detect it again — this time it must notify again.
    await pool.query("UPDATE bot_findings SET cooldown_until = now() - interval '1 second' WHERE bot_id = 'dedup-test-bot'");
    const run4 = await createBotRun(pool, "dedup-test-bot");
    await processBotFindings(deps, "dedup-test-bot", run4.id, [finding]);
    expect(sent).toHaveLength(2);
  });
});
