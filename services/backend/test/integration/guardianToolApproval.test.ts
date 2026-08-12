import "../setupEnv.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { getTestPool, resetTestData, closeTestPool } from "../helpers/testDb.js";
import { buildTestAgentRegistry } from "../helpers/appDeps.js";
import { EventBus } from "../../src/core/events/eventBus.js";
import { invokeTool } from "../../src/core/mcp/mcpHost.js";
import { ToolApprovalDeniedError, ToolApprovalRequiredError } from "../../src/core/mcp/errors.js";
import { createApp } from "../../src/api/app.js";
import { ModelRegistryService } from "../../src/core/registry/modelRegistryService.js";
import { ensureOwner } from "../../src/db/repositories/ownerRepo.js";
import { generatePairingCode } from "../../src/core/security/pairing.js";
import pino from "pino";
import request from "supertest";

const pool = await getTestPool();
const redis = new Redis(process.env.REDIS_URL as string);

beforeEach(async () => {
  await resetTestData(pool);
  // Fixture tools requiring approval — catalog-style rows re-inserted
  // idempotently across runs, same convention as mcpHostSecurity.test.ts's
  // slow_test_tool.
  await pool.query(
    `INSERT INTO tools (id, display_name, description, input_schema, output_schema, timeout_ms, risk_level, requires_approval) VALUES
     ('guarded_high_restricted', 'Guarded High/Restricted', 'test', '{}'::jsonb, '{}'::jsonb, 5000, 'high', true),
     ('guarded_high_allowed', 'Guarded High/Allowed', 'test', '{}'::jsonb, '{}'::jsonb, 5000, 'high', true)
     ON CONFLICT (id) DO UPDATE SET risk_level = EXCLUDED.risk_level, requires_approval = EXCLUDED.requires_approval`,
  );
  await pool.query(
    `INSERT INTO agent_tool_grants (agent_id, tool_id, permission_level) VALUES
     ('crypto-intel', 'guarded_high_restricted', 'restricted'),
     ('crypto-intel', 'guarded_high_allowed', 'allowed')
     ON CONFLICT (agent_id, tool_id) DO UPDATE SET permission_level = EXCLUDED.permission_level`,
  );
});

afterAll(async () => {
  await redis.quit();
  await closeTestPool();
});

describe("Guardian's tool-approval gate in mcpHost.invokeTool (M8.3)", () => {
  it("denies a high-risk tool call at only a restricted grant, records status='denied', and writes an audit_log row — never runs the handler", async () => {
    const { toolRegistry } = buildTestAgentRegistry(pool);
    const eventBus = new EventBus(pool);
    let handlerCalled = false;
    toolRegistry.register({
      definition: (await toolRegistry.get("guarded_high_restricted"))!,
      invoke: async () => {
        handlerCalled = true;
        return {};
      },
    });

    await expect(
      invokeTool({ pool, eventBus, toolRegistry }, { toolId: "guarded_high_restricted", agentId: "crypto-intel", input: {}, toolKeys: {} }),
    ).rejects.toThrow(ToolApprovalDeniedError);

    expect(handlerCalled).toBe(false);

    const invocation = await pool.query("SELECT status, error_code FROM tool_invocations WHERE tool_id = 'guarded_high_restricted'");
    expect(invocation.rows[0]).toMatchObject({ status: "denied", error_code: "guardian_denied" });

    const blocked = await pool.query("SELECT payload FROM events WHERE event_type = 'tool.blocked' AND source_id = 'guarded_high_restricted'");
    expect(blocked.rows).toHaveLength(1);

    const audit = await pool.query("SELECT actor, action FROM audit_log WHERE target_type = 'tool_invocation'");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor: "guardian", action: "tool_approval.denied" });
  });

  it("forwards a high-risk tool call with a full allowed grant as awaiting_approval, never running the handler until a human decides", async () => {
    const { toolRegistry } = buildTestAgentRegistry(pool);
    const eventBus = new EventBus(pool);
    let handlerCalled = false;
    toolRegistry.register({
      definition: (await toolRegistry.get("guarded_high_allowed"))!,
      invoke: async () => {
        handlerCalled = true;
        return {};
      },
    });

    await expect(
      invokeTool({ pool, eventBus, toolRegistry }, { toolId: "guarded_high_allowed", agentId: "crypto-intel", input: {}, toolKeys: {} }),
    ).rejects.toThrow(ToolApprovalRequiredError);

    expect(handlerCalled).toBe(false);

    const invocation = await pool.query("SELECT status FROM tool_invocations WHERE tool_id = 'guarded_high_allowed'");
    expect(invocation.rows[0]).toMatchObject({ status: "awaiting_approval" });

    const audit = await pool.query("SELECT actor, action FROM audit_log WHERE target_type = 'tool_invocation'");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor: "guardian", action: "tool_approval.pending" });
  });
});

describe("Tool-approvals REST surface (M8.3)", () => {
  const logger = pino({ level: "silent" });
  const modelRegistry = new ModelRegistryService(pool);
  const { agentRegistry, memoryEngine, toolRegistry, botRegistry, botEngine } = buildTestAgentRegistry(pool);
  const app = createApp({ pool, redis, queues: [], eventBus: new EventBus(pool), modelRegistry, agentRegistry, memoryEngine, toolRegistry, botRegistry, botEngine, logger });

  async function pairedToken(): Promise<string> {
    await ensureOwner(pool, "Test Owner");
    const code = await generatePairingCode(pool);
    const res = await request(app).post("/auth/pair").send({ pairingCode: code, deviceName: "phone", platform: "android" });
    return res.body.data.accessToken as string;
  }

  it("lists an awaiting_approval invocation via GET /tools/approvals, then a human can approve it via POST .../decide", async () => {
    const eventBus = new EventBus(pool);
    await expect(
      invokeTool({ pool, eventBus, toolRegistry }, { toolId: "guarded_high_allowed", agentId: "crypto-intel", input: { note: "test" }, toolKeys: {} }),
    ).rejects.toThrow(ToolApprovalRequiredError);

    const token = await pairedToken();
    const list = await request(app).get("/tools/approvals").set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    const invocationId = list.body.data[0].id as string;
    expect(list.body.data[0]).toMatchObject({ toolId: "guarded_high_allowed", agentId: "crypto-intel" });

    const decide = await request(app)
      .post(`/tools/approvals/${invocationId}/decide`)
      .set("Authorization", `Bearer ${token}`)
      .send({ decision: "approved" });
    expect(decide.status).toBe(200);
    expect(decide.body.data).toMatchObject({ id: invocationId, status: "approved" });

    const row = await pool.query("SELECT status FROM tool_invocations WHERE id = $1", [invocationId]);
    expect(row.rows[0]).toMatchObject({ status: "approved" });

    const audit = await pool.query("SELECT actor, action FROM audit_log WHERE target_id = $1 ORDER BY created_at", [invocationId]);
    expect(audit.rows.map((r) => `${r.actor}:${r.action}`)).toEqual(["guardian:tool_approval.pending", "user:tool_approval.approved"]);

    // No longer awaiting approval.
    const list2 = await request(app).get("/tools/approvals").set("Authorization", `Bearer ${token}`);
    expect(list2.body.data).toHaveLength(0);
  });

  it("404s deciding an invocation that isn't (or is no longer) awaiting approval", async () => {
    const token = await pairedToken();
    const res = await request(app)
      .post("/tools/approvals/00000000-0000-0000-0000-000000000000/decide")
      .set("Authorization", `Bearer ${token}`)
      .send({ decision: "denied" });
    expect(res.status).toBe(404);
  });
});
