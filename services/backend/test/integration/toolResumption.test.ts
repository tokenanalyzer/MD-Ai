import "../setupEnv.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import type { ToolHandler } from "@mdai/shared-types";
import { getTestPool, resetTestData, closeTestPool } from "../helpers/testDb.js";
import { buildTestAgentRegistry } from "../helpers/appDeps.js";
import { EventBus } from "../../src/core/events/eventBus.js";
import { invokeTool, resumeApprovedToolInvocation } from "../../src/core/mcp/mcpHost.js";
import { ToolApprovalRequiredError, ToolResumptionNotAllowedError } from "../../src/core/mcp/errors.js";
import { decideToolInvocation } from "../../src/db/repositories/toolRepo.js";
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
  await pool.query(
    `INSERT INTO tools (id, display_name, description, input_schema, output_schema, timeout_ms, risk_level, requires_approval) VALUES
     ('resumable_tool', 'Resumable Tool', 'test', '{}'::jsonb, '{}'::jsonb, 200, 'high', true)
     ON CONFLICT (id) DO UPDATE SET risk_level = EXCLUDED.risk_level, requires_approval = EXCLUDED.requires_approval`,
  );
  await pool.query(
    `INSERT INTO agent_tool_grants (agent_id, tool_id, permission_level) VALUES ('crypto-intel', 'resumable_tool', 'allowed')
     ON CONFLICT (agent_id, tool_id) DO UPDATE SET permission_level = EXCLUDED.permission_level`,
  );
});

afterAll(async () => {
  await redis.quit();
  await closeTestPool();
});

async function createAwaitingApprovalInvocation(toolRegistry: ReturnType<typeof buildTestAgentRegistry>["toolRegistry"]): Promise<string> {
  const eventBus = new EventBus(pool);
  try {
    await invokeTool({ pool, eventBus, toolRegistry }, { toolId: "resumable_tool", agentId: "crypto-intel", input: { echo: "hi" }, toolKeys: {} });
  } catch (err) {
    if (!(err instanceof ToolApprovalRequiredError)) throw err;
    return err.invocationId;
  }
  throw new Error("expected ToolApprovalRequiredError");
}

describe("resumeApprovedToolInvocation (M9) — real task/tool resumption", () => {
  it("actually replays the call once a human approves, recording a real success and publishing tool.resumed then tool.completed", async () => {
    const { toolRegistry } = buildTestAgentRegistry(pool);
    let receivedInput: Record<string, unknown> | undefined;
    let receivedKeys: Record<string, string> | undefined;
    const handler: ToolHandler = {
      definition: (await toolRegistry.get("resumable_tool"))!,
      invoke: async (input, ctx) => {
        receivedInput = input;
        receivedKeys = ctx.toolKeys;
        return { ok: true };
      },
    };
    toolRegistry.register(handler);

    const invocationId = await createAwaitingApprovalInvocation(toolRegistry);
    const decided = await decideToolInvocation(pool, invocationId, "approved");
    expect(decided?.status).toBe("approved");

    const eventBus = new EventBus(pool);
    const output = await resumeApprovedToolInvocation({ pool, eventBus, toolRegistry }, invocationId, { fresh: "credential" });

    expect(output).toEqual({ ok: true });
    expect(receivedInput).toEqual({ echo: "hi" });
    expect(receivedKeys).toEqual({ fresh: "credential" });

    const row = await pool.query("SELECT status, output FROM tool_invocations WHERE id = $1", [invocationId]);
    expect(row.rows[0]).toMatchObject({ status: "succeeded", output: { ok: true } });

    const events = await pool.query(
      "SELECT event_type FROM events WHERE task_id IS NULL AND source_id = 'resumable_tool' ORDER BY id",
    );
    expect(events.rows.map((r) => r.event_type)).toEqual(
      expect.arrayContaining(["tool.discovered", "tool.permission.checked", "tool.blocked", "tool.resumed", "tool.completed"]),
    );

    // The fresh credential supplied at approval time is never persisted.
    expect(JSON.stringify(row.rows[0])).not.toContain("credential");
  });

  it("records a real failure (not stuck at 'approved') when the resumed handler throws", async () => {
    const { toolRegistry } = buildTestAgentRegistry(pool);
    toolRegistry.register({
      definition: (await toolRegistry.get("resumable_tool"))!,
      invoke: async () => {
        throw new Error("downstream failure on resume");
      },
    });

    const invocationId = await createAwaitingApprovalInvocation(toolRegistry);
    await decideToolInvocation(pool, invocationId, "approved");

    const eventBus = new EventBus(pool);
    await expect(resumeApprovedToolInvocation({ pool, eventBus, toolRegistry }, invocationId, {})).rejects.toThrow(
      "downstream failure on resume",
    );

    const row = await pool.query("SELECT status FROM tool_invocations WHERE id = $1", [invocationId]);
    expect(row.rows[0]).toMatchObject({ status: "failed" });
  });

  it("records a real timeout when the resumed handler outlives the tool's timeoutMs", async () => {
    const { toolRegistry } = buildTestAgentRegistry(pool);
    toolRegistry.register({
      definition: (await toolRegistry.get("resumable_tool"))!,
      invoke: (_input, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });

    const invocationId = await createAwaitingApprovalInvocation(toolRegistry);
    await decideToolInvocation(pool, invocationId, "approved");

    const eventBus = new EventBus(pool);
    await expect(resumeApprovedToolInvocation({ pool, eventBus, toolRegistry }, invocationId, {})).rejects.toThrow();

    const row = await pool.query("SELECT status FROM tool_invocations WHERE id = $1", [invocationId]);
    expect(row.rows[0]).toMatchObject({ status: "timeout" });
  });

  it("refuses to resume a row that is not exactly 'approved'", async () => {
    const { toolRegistry } = buildTestAgentRegistry(pool);
    const invocationId = await createAwaitingApprovalInvocation(toolRegistry);
    // Still 'awaiting_approval' — no decision made yet.
    const eventBus = new EventBus(pool);
    await expect(resumeApprovedToolInvocation({ pool, eventBus, toolRegistry }, invocationId, {})).rejects.toThrow(
      ToolResumptionNotAllowedError,
    );
  });

  it("refuses to resume the same invocation twice", async () => {
    const { toolRegistry } = buildTestAgentRegistry(pool);
    toolRegistry.register({
      definition: (await toolRegistry.get("resumable_tool"))!,
      invoke: async () => ({ ok: true }),
    });

    const invocationId = await createAwaitingApprovalInvocation(toolRegistry);
    await decideToolInvocation(pool, invocationId, "approved");

    const eventBus = new EventBus(pool);
    await resumeApprovedToolInvocation({ pool, eventBus, toolRegistry }, invocationId, {});
    // Now 'succeeded' — a second resume attempt must be refused.
    await expect(resumeApprovedToolInvocation({ pool, eventBus, toolRegistry }, invocationId, {})).rejects.toThrow(
      ToolResumptionNotAllowedError,
    );
  });

  it("refuses to resume an unknown invocation id", async () => {
    const { toolRegistry } = buildTestAgentRegistry(pool);
    const eventBus = new EventBus(pool);
    await expect(
      resumeApprovedToolInvocation({ pool, eventBus, toolRegistry }, "00000000-0000-0000-0000-000000000000", {}),
    ).rejects.toThrow(ToolResumptionNotAllowedError);
  });
});

describe("POST /tools/approvals/:id/decide (M9) — end-to-end resumption through the REST surface", () => {
  const logger = pino({ level: "silent" });
  const modelRegistry = new ModelRegistryService(pool);
  const { agentRegistry, memoryEngine, toolRegistry, botRegistry, botEngine, automationEngine } = buildTestAgentRegistry(pool);
  const app = createApp({ pool, redis, queues: [], eventBus: new EventBus(pool), modelRegistry, agentRegistry, memoryEngine, toolRegistry, botRegistry, botEngine, automationEngine, logger });

  async function pairedToken(): Promise<string> {
    await ensureOwner(pool, "Test Owner");
    const code = await generatePairingCode(pool);
    const res = await request(app).post("/auth/pair").send({ pairingCode: code, deviceName: "phone", platform: "android" });
    return res.body.data.accessToken as string;
  }

  it("approving via the REST endpoint actually runs the tool and returns its real final status", async () => {
    toolRegistry.register({
      definition: (await toolRegistry.get("resumable_tool"))!,
      invoke: async (input) => ({ echoed: input["echo"] }),
    });

    const invocationId = await createAwaitingApprovalInvocation(toolRegistry);
    const token = await pairedToken();

    const decide = await request(app)
      .post(`/tools/approvals/${invocationId}/decide`)
      .set("Authorization", `Bearer ${token}`)
      .send({ decision: "approved" });

    expect(decide.status).toBe(200);
    expect(decide.body.data).toMatchObject({ id: invocationId, status: "succeeded" });

    const row = await pool.query("SELECT output FROM tool_invocations WHERE id = $1", [invocationId]);
    expect(row.rows[0].output).toEqual({ echoed: "hi" });
  });
});
