import "../setupEnv.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import pino from "pino";
import request from "supertest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { createApp } from "../../src/api/app.js";
import { AutomationEngine } from "../../src/core/automations/automationEngine.js";
import { EventBus } from "../../src/core/events/eventBus.js";
import { ModelRegistryService } from "../../src/core/registry/modelRegistryService.js";
import { generatePairingCode } from "../../src/core/security/pairing.js";
import { computeWebhookSignature } from "../../src/core/automations/webhookSignature.js";
import { upsertBackgroundCredential } from "../../src/db/repositories/backgroundCredentialRepo.js";
import { encryptCredential, last4 } from "../../src/core/security/backgroundKeyVault.js";
import { invokeTool } from "../../src/core/mcp/mcpHost.js";
import { ToolPermissionDeniedError } from "../../src/core/mcp/errors.js";
import { upsertTool } from "../../src/db/repositories/toolRepo.js";
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

const ownerId = randomUUID();
const { agentRegistry, memoryEngine, toolRegistry, botRegistry, botEngine } = buildTestAgentRegistry(pool);
const eventBus = new EventBus(pool);
const modelRegistry = new ModelRegistryService(pool);
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
let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;

beforeEach(async () => {
  await resetTestData(pool);
  await pool.query("INSERT INTO owner (id, display_name) VALUES ($1, $2)", [ownerId, "Test Owner"]);
  if (!engineStarted) {
    await automationEngine.start();
    engineStarted = true;
  }
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
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

function sseBody(deltas: string[]): string {
  const events = deltas.map((d) => ({ choices: [{ delta: { content: d } }] }));
  events.push({ choices: [{ delta: {} as { content?: string }, finish_reason: "stop" } as never] });
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

function replyFor(marker: string, deltas: string[]) {
  mockAgent
    .get("https://api.groq.com")
    .intercept({ path: "/openai/v1/chat/completions", method: "POST", body: (b: string) => b.includes(marker) })
    .reply(200, sseBody(deltas));
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("waitFor timed out");
}

/**
 * M10's central safety claim: "externally triggered automations cannot
 * bypass Guardian or human approval requirements." Proven here at the
 * level this codebase already tests Guardian at everywhere else (M8.3's
 * guardianToolApproval.test.ts, M9's toolResumption.test.ts) — the real
 * `mcpHost.invokeTool` gate — but reached through the ACTUAL signed
 * webhook HTTP route rather than calling invokeTool directly, so the full
 * path (signature verification -> AutomationEngine.trigger -> dispatchAgentTask
 * -> Master's real capability delegation -> a specialist's real tool call)
 * is exercised end to end.
 */
describe("Safety invariant: a webhook-triggered automation cannot bypass Guardian's tool-approval gate (M10)", () => {
  const originalWebSearch = { risk_level: "low", requires_approval: false };

  beforeEach(async () => {
    // web_search is a shared catalog row every other test file also relies
    // on staying low-risk/no-approval — mutated here only for this
    // describe block and restored in afterEach. Safe only because
    // vitest.config.ts sets fileParallelism:false (files run one at a
    // time, never concurrently against the same DB).
    const { rows } = await pool.query("SELECT risk_level, requires_approval FROM tools WHERE id = 'web_search'");
    originalWebSearch.risk_level = rows[0].risk_level;
    originalWebSearch.requires_approval = rows[0].requires_approval;
    await pool.query("UPDATE tools SET risk_level = 'high', requires_approval = true WHERE id = 'web_search'");
  });

  afterEach(async () => {
    await pool.query("UPDATE tools SET risk_level = $1, requires_approval = $2 WHERE id = 'web_search'", [
      originalWebSearch.risk_level,
      originalWebSearch.requires_approval,
    ]);
  });

  it("a signed webhook -> agent_task automation that delegates to a specialist is blocked by Guardian at the real tool call, never reaching a live search", async () => {
    const encrypted = encryptCredential("gsk-test-safety-invariant-key-1234567890");
    await upsertBackgroundCredential(pool, "llm_provider", "groq", encrypted, last4("gsk-test-safety-invariant-key-1234567890"));

    // Intent classification delegates to crypto-intel (capability
    // "crypto-analysis"); crypto-intel's handleTask unconditionally calls
    // ctx.callTool("web_search", ...) first (specialistAgentFactory.ts) —
    // now gated, so this call throws ToolApprovalRequiredError, which
    // propagates out of the child task (runtimeContext.ts's delegate())
    // as a *failed* child task, not a crash — Master then gracefully
    // discloses the limitation and still synthesizes a final answer.
    const classification = JSON.stringify({
      delegate: true,
      capability: "crypto-analysis",
      taskObjective: "What is the current state of the crypto market?",
      memoryCommand: null,
      memoryCandidate: null,
    });
    replyFor("intent classifier", [classification]);
    replyFor("Master Agent inside MD AI", ["I could not complete that research because a required action needs your approval first."]);

    const token = await pairedToken();
    const create = await request(app)
      .post("/automations")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Webhook crypto digest",
        triggerType: "webhook",
        actionType: "agent_task",
        actionConfig: { prompt: "What is the current state of the crypto market?" },
      });
    expect(create.status).toBe(201);
    const { id, webhookSlug: slug, webhookSecret: secret } = create.body.data;

    const rawBody = JSON.stringify({ source: "n8n" });
    const signature = computeWebhookSignature(secret, Buffer.from(rawBody));
    const webhookRes = await request(app)
      .post(`/webhooks/automations/${slug}`)
      .set("Content-Type", "application/json")
      .set("X-MDAI-Signature", signature)
      .send(rawBody);
    expect(webhookRes.status).toBe(202);

    await waitFor(async () => {
      const runsRes = await request(app).get(`/automations/${id}/runs`).set("Authorization", `Bearer ${token}`);
      return runsRes.body.data.length > 0 && runsRes.body.data[0].status !== "running";
    });

    // The decisive assertion: Guardian actually intercepted the call —
    // web_search was recorded as awaiting_approval, never as succeeded,
    // and crypto-intel (the automation-delegated agent) is the caller of
    // record, exactly as a direct chat-originated call would be.
    const invocations = await pool.query(
      "SELECT status, agent_id FROM tool_invocations WHERE tool_id = 'web_search' ORDER BY created_at DESC LIMIT 1",
    );
    expect(invocations.rows).toHaveLength(1);
    expect(invocations.rows[0]).toMatchObject({ status: "awaiting_approval", agent_id: "crypto-intel" });

    // No real web_search result — a bypass would show up as a second,
    // successful invocation or as a real search result reaching the model.
    const succeeded = await pool.query("SELECT id FROM tool_invocations WHERE tool_id = 'web_search' AND status = 'succeeded'");
    expect(succeeded.rows).toHaveLength(0);

    // Guardian's own audit trail records this exactly like any other gated call.
    const invocationId = (await pool.query("SELECT id FROM tool_invocations WHERE tool_id = 'web_search' ORDER BY created_at DESC LIMIT 1")).rows[0].id;
    const audit = await pool.query("SELECT actor, action FROM audit_log WHERE target_id = $1", [invocationId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor: "guardian", action: "tool_approval.pending" });
  }, 15000);
});

describe("Safety invariant: MCP-connected tools are discoverable but never callable without an explicit grant, and are Guardian-gated identically to built-in tools (M10)", () => {
  it("upsertTool from connectServer's conservative defaults leaves a tool unreachable by any agent until an owner explicitly grants it", async () => {
    const toolId = `mcp:test-server:probe-${randomUUID()}`;
    await upsertTool(pool, {
      id: toolId,
      displayName: "Probe Tool",
      description: "A tool discovered from a hypothetical MCP server",
      inputSchema: {},
      outputSchema: {},
      source: "mcp_server",
      mcpServerUrl: "https://example.com/mcp",
      mcpMetadata: { protocol: "mcp-jsonrpc-2.0", remoteName: "probe" },
      riskLevel: "high",
      requiresApproval: true,
      defaultAccess: "restricted",
      timeoutMs: 30_000,
      owner: "mcp_server",
    });

    // "absence is denial" (M4.9): no agent_tool_grants row exists for this
    // brand-new tool, for any agent — including one Master would normally
    // delegate to.
    await expect(
      invokeTool({ pool, eventBus, toolRegistry }, { toolId, agentId: "crypto-intel", input: {}, toolKeys: {} }),
    ).rejects.toThrow(ToolPermissionDeniedError);

    const invocations = await pool.query("SELECT * FROM tool_invocations WHERE tool_id = $1", [toolId]);
    expect(invocations.rows).toHaveLength(0);
  });

  it("once granted, an MCP-sourced tool still requires human approval before running — the same Guardian gate as any built-in tool", async () => {
    const toolId = `mcp:test-server:probe2-${randomUUID()}`;
    await upsertTool(pool, {
      id: toolId,
      displayName: "Probe Tool 2",
      description: "A tool discovered from a hypothetical MCP server",
      inputSchema: {},
      outputSchema: {},
      source: "mcp_server",
      mcpServerUrl: "https://example.com/mcp",
      riskLevel: "high",
      requiresApproval: true,
      defaultAccess: "restricted",
      timeoutMs: 30_000,
      owner: "mcp_server",
    });
    await pool.query(
      `INSERT INTO agent_tool_grants (agent_id, tool_id, permission_level) VALUES ('crypto-intel', $1, 'allowed')
       ON CONFLICT (agent_id, tool_id) DO UPDATE SET permission_level = EXCLUDED.permission_level`,
      [toolId],
    );

    let handlerCalled = false;
    toolRegistry.register({
      definition: (await toolRegistry.get(toolId))!,
      invoke: async () => {
        handlerCalled = true;
        return {};
      },
    });

    const { ToolApprovalRequiredError } = await import("../../src/core/mcp/errors.js");
    await expect(
      invokeTool({ pool, eventBus, toolRegistry }, { toolId, agentId: "crypto-intel", input: {}, toolKeys: {} }),
    ).rejects.toThrow(ToolApprovalRequiredError);
    expect(handlerCalled).toBe(false);

    const invocation = await pool.query("SELECT status FROM tool_invocations WHERE tool_id = $1", [toolId]);
    expect(invocation.rows[0]).toMatchObject({ status: "awaiting_approval" });
  });

  it("re-upserting a tool on server reconnect never loosens a policy field an owner already tightened", async () => {
    const toolId = `mcp:test-server:probe3-${randomUUID()}`;
    const input = {
      id: toolId,
      displayName: "Probe Tool 3",
      description: "v1 description",
      inputSchema: {},
      outputSchema: {},
      source: "mcp_server" as const,
      mcpServerUrl: "https://example.com/mcp",
      riskLevel: "high" as const,
      requiresApproval: true,
      defaultAccess: "restricted" as const,
      timeoutMs: 30_000,
      owner: "mcp_server" as const,
    };
    await upsertTool(pool, input);

    // Simulate an owner deliberately relaxing this one tool after review.
    await pool.query("UPDATE tools SET requires_approval = false, risk_level = 'low' WHERE id = $1", [toolId]);

    // The server reconnects and re-describes the same tool with a NEW
    // description — connectServer would call upsertTool again with its
    // own conservative defaults (requiresApproval: true, riskLevel: "high").
    const reconnected = await upsertTool(pool, { ...input, description: "v2 description from a re-describing server" });

    expect(reconnected.description).toBe("v2 description from a re-describing server");
    // The owner's explicit loosening survives — upsertTool's ON CONFLICT
    // clause never touches risk_level/requires_approval/default_access.
    expect(reconnected.requires_approval).toBe(false);
    expect(reconnected.risk_level).toBe("low");
  });
});
