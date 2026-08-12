import "../setupEnv.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { getTestPool, resetTestData, closeTestPool } from "../helpers/testDb.js";
import { buildTestAgentRegistry } from "../helpers/appDeps.js";
import { EventBus } from "../../src/core/events/eventBus.js";
import { invokeTool } from "../../src/core/mcp/mcpHost.js";
import { ToolNotAvailableError, ToolPermissionDeniedError, ToolTimeoutError } from "../../src/core/mcp/errors.js";
import type { ToolHandler } from "@mdai/shared-types";

const pool = await getTestPool();
const redis = new Redis(process.env.REDIS_URL as string);

beforeEach(async () => {
  await resetTestData(pool);
});

afterAll(async () => {
  await redis.quit();
  await closeTestPool();
});

describe("MCP host security (M4.15)", () => {
  it("blocks a tool call from an agent with no agent_tool_grants row (permission bypass attempt)", async () => {
    const { toolRegistry } = buildTestAgentRegistry(pool);
    const eventBus = new EventBus(pool);

    // "reviewer" has no tool grants at all in M4's seed data.
    await expect(
      invokeTool({ pool, eventBus, toolRegistry }, { toolId: "calculator", agentId: "reviewer", input: {}, toolKeys: {} }),
    ).rejects.toThrow(ToolPermissionDeniedError);

    const blocked = await pool.query("SELECT payload FROM events WHERE event_type = 'tool.blocked'");
    expect(blocked.rows).toHaveLength(1);
    expect(blocked.rows[0].payload.reason).toContain("no agent_tool_grants row");

    const invocations = await pool.query("SELECT * FROM tool_invocations");
    expect(invocations.rows).toHaveLength(0);
  });

  it("refuses an unregistered/disabled tool id honestly rather than crashing", async () => {
    const { toolRegistry } = buildTestAgentRegistry(pool);
    const eventBus = new EventBus(pool);

    await expect(
      invokeTool({ pool, eventBus, toolRegistry }, { toolId: "does_not_exist", agentId: "research", input: {}, toolKeys: {} }),
    ).rejects.toThrow(ToolNotAvailableError);

    await pool.query(`UPDATE tools SET enabled = false WHERE id = 'calculator'`);
    await expect(
      invokeTool({ pool, eventBus, toolRegistry }, { toolId: "calculator", agentId: "research", input: {}, toolKeys: {} }),
    ).rejects.toThrow(ToolNotAvailableError);
  });

  it("times out a slow handler at the tool's configured timeout and records status='timeout'", async () => {
    const { toolRegistry } = buildTestAgentRegistry(pool);
    const eventBus = new EventBus(pool);

    // Both rows are test-fixture data inserted directly (not seeded by any
    // migration), so they must tolerate being re-inserted across repeated
    // runs against the same persistent test database — tools/
    // agent_tool_grants are catalog data (like agents), deliberately not
    // truncated by resetTestData between tests.
    await pool.query(
      `INSERT INTO tools (id, display_name, description, input_schema, output_schema, timeout_ms) VALUES
       ('slow_test_tool', 'Slow Test Tool', 'test', '{}'::jsonb, '{}'::jsonb, 50)
       ON CONFLICT (id) DO UPDATE SET timeout_ms = 50`,
    );
    await pool.query(
      `INSERT INTO agent_tool_grants (agent_id, tool_id, permission_level) VALUES ('research', 'slow_test_tool', 'allowed')
       ON CONFLICT (agent_id, tool_id) DO NOTHING`,
    );

    const slowHandler: ToolHandler = {
      definition: {
        id: "slow_test_tool",
        displayName: "Slow Test Tool",
        description: "test",
        version: "0.1.0",
        inputSchema: {},
        outputSchema: {},
        source: "builtin",
        mcpMetadata: {},
        requiredCapabilities: [],
        riskLevel: "low",
        requiresApproval: false,
        defaultAccess: "allowed",
        enabled: true,
        health: "unknown",
        timeoutMs: 50,
        owner: "system",
      },
      invoke: (_input, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    toolRegistry.register(slowHandler);

    await expect(
      invokeTool({ pool, eventBus, toolRegistry }, { toolId: "slow_test_tool", agentId: "research", input: {}, toolKeys: {} }),
    ).rejects.toThrow(ToolTimeoutError);

    const invocation = await pool.query("SELECT status, error_code FROM tool_invocations WHERE tool_id = 'slow_test_tool'");
    expect(invocation.rows[0]).toMatchObject({ status: "timeout", error_code: "timeout" });

    const timeoutEvents = await pool.query("SELECT payload FROM events WHERE event_type = 'tool.timeout'");
    expect(timeoutEvents.rows).toHaveLength(1);
  });

  it("marks an invalid/malformed PDF as a failed invocation instead of crashing the process", async () => {
    const { toolRegistry } = buildTestAgentRegistry(pool);
    const eventBus = new EventBus(pool);

    const brokenPdfHandler: ToolHandler = {
      definition: {
        id: "pdf_reader",
        displayName: "PDF Text Extraction",
        description: "test",
        version: "0.1.0",
        inputSchema: {},
        outputSchema: {},
        source: "builtin",
        mcpMetadata: {},
        requiredCapabilities: [],
        riskLevel: "low",
        requiresApproval: false,
        defaultAccess: "allowed",
        enabled: true,
        health: "unknown",
        timeoutMs: 15000,
        owner: "system",
      },
      invoke: async () => {
        throw new Error("pdf_reader: not a valid PDF (malformed header)");
      },
    };
    toolRegistry.register(brokenPdfHandler);

    await expect(
      invokeTool(
        { pool, eventBus, toolRegistry },
        { toolId: "pdf_reader", agentId: "research", input: { url: "https://example.com/broken.pdf" }, toolKeys: {} },
      ),
    ).rejects.toThrow(/not a valid PDF/);

    const invocation = await pool.query("SELECT status FROM tool_invocations WHERE tool_id = 'pdf_reader'");
    expect(invocation.rows[0]).toMatchObject({ status: "failed" });
  });

  it("never includes toolKeys in the persisted invocation input or in any published event", async () => {
    const { toolRegistry } = buildTestAgentRegistry(pool);
    const eventBus = new EventBus(pool);
    const SECRET = "super-secret-tool-credential-should-never-leak";

    await invokeTool(
      { pool, eventBus, toolRegistry },
      { toolId: "calculator", agentId: "research", input: { expression: "1+1" }, toolKeys: { brave: SECRET } },
    );

    const invocations = await pool.query("SELECT input, output FROM tool_invocations");
    expect(JSON.stringify(invocations.rows)).not.toContain(SECRET);

    const events = await pool.query("SELECT payload FROM events WHERE event_type LIKE 'tool.%'");
    expect(JSON.stringify(events.rows)).not.toContain(SECRET);
  });
});
