import type pg from "pg";
import type { ToolAccessLevel, ToolDefinition, ToolHandler, ToolRegistry } from "@mdai/shared-types";
import { checkToolPermission, getTool, listTools, upsertTool, type ToolRow } from "../../db/repositories/toolRepo.js";
import { callMcpServerTool, listMcpServerTools } from "./mcpClient.js";

/** A stable, filesystem/id-safe fragment derived from an MCP server URL, so the same server always produces the same tool ids across reconnects. */
function slugifyServerUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  } catch {
    return url.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  }
}

const MCP_TOOL_CALL_TIMEOUT_MS = 30_000;

function toDefinition(row: ToolRow): ToolDefinition {
  return {
    id: row.id,
    displayName: row.display_name,
    description: row.description,
    version: row.version,
    inputSchema: row.input_schema,
    outputSchema: row.output_schema,
    source: row.source,
    mcpServerUrl: row.mcp_server_url ?? undefined,
    mcpMetadata: row.mcp_metadata,
    requiredCapabilities: row.required_capabilities,
    riskLevel: row.risk_level,
    requiresApproval: row.requires_approval,
    defaultAccess: row.default_access,
    enabled: row.enabled,
    health: row.health,
    healthDetail: row.health_detail ?? undefined,
    timeoutMs: row.timeout_ms,
    lastVerifiedAt: row.last_verified_at?.toISOString(),
    owner: row.owner,
  };
}

/**
 * DB-backed Tool Registry (M4.1), mirroring `AgentRegistryService`'s split:
 * the `tools` table is the source of truth for every tool's *descriptive
 * and mutable* metadata (health, enabled, timeout — things that change
 * independent of code), while the in-process `Map` holds only the actual
 * `invoke()` implementations this process can dispatch to. Agents never
 * see a hardcoded tool map — they go through `list()`/`get()`, exactly
 * like `AgentRegistry.getDelegationOptions`.
 */
export class ToolRegistryService implements ToolRegistry {
  private readonly implementations = new Map<string, ToolHandler>();

  constructor(private readonly pool: pg.Pool) {}

  async list(): Promise<ToolDefinition[]> {
    const rows = await listTools(this.pool);
    return rows.map(toDefinition);
  }

  async get(toolId: string): Promise<ToolDefinition | undefined> {
    const row = await getTool(this.pool, toolId);
    return row ? toDefinition(row) : undefined;
  }

  register(handler: ToolHandler): void {
    this.implementations.set(handler.definition.id, handler);
  }

  /**
   * M10: real external MCP server connection — the mechanism
   * `docs/architecture/08-deployment-architecture.md` names for OpenClaw
   * ("the `tools.source = 'mcp_server'` mechanism already accommodates an
   * external action-execution server without a new concept"). Fetches the
   * server's own `tools/list`, persists each as a real `tools` row
   * (`upsertTool` — so `list()`/`get()`, and therefore `mcpHost.
   * invokeTool`, see it exactly like a built-in tool), and registers an
   * `invoke()` implementation that calls the server's `tools/call`.
   *
   * Deliberately conservative defaults an owner must explicitly loosen:
   * `riskLevel: "high"`, `requiresApproval: true` (Guardian's M8 gate
   * applies to every call, unmodified), and no `agent_tool_grants` row is
   * ever created here — "absence is denial" (M4.9) means connecting a
   * server makes its tools *discoverable*, never *callable*, until an
   * owner grants a specific agent access. This is what "treat it as a
   * tool source, not as an unrestricted agent" and "never bypass existing
   * security controls" mean structurally, not just as a stated intent.
   */
  async connectServer(url: string): Promise<ToolDefinition[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MCP_TOOL_CALL_TIMEOUT_MS);
    let descriptors;
    try {
      descriptors = await listMcpServerTools(url, controller.signal);
    } finally {
      clearTimeout(timeout);
    }

    const serverSlug = slugifyServerUrl(url);
    const definitions: ToolDefinition[] = [];

    for (const descriptor of descriptors) {
      const id = `mcp:${serverSlug}:${descriptor.name}`;
      const row = await upsertTool(this.pool, {
        id,
        displayName: descriptor.name,
        description: descriptor.description ?? `Tool "${descriptor.name}" from external MCP server ${url}`,
        inputSchema: descriptor.inputSchema ?? {},
        outputSchema: {},
        source: "mcp_server",
        mcpServerUrl: url,
        mcpMetadata: { protocol: "mcp-jsonrpc-2.0", remoteName: descriptor.name },
        riskLevel: "high",
        requiresApproval: true,
        defaultAccess: "restricted",
        timeoutMs: MCP_TOOL_CALL_TIMEOUT_MS,
        owner: "mcp_server",
      });
      const definition = toDefinition(row);
      definitions.push(definition);

      this.register({
        definition,
        async invoke(input, ctx) {
          const result = await callMcpServerTool(url, descriptor.name, input, ctx.signal);
          return { text: result.text, isError: result.isError, raw: result.raw };
        },
      });
    }

    return definitions;
  }

  async checkPermission(agentId: string, toolId: string): Promise<ToolAccessLevel | null> {
    return checkToolPermission(this.pool, agentId, toolId);
  }

  /**
   * Backend-only extension (like `AgentRegistryService.getCard`): the
   * actual invocable implementation, if this process has one registered.
   * A tool can exist in the DB (discoverable) without being invocable
   * here — same "DB row vs. loaded implementation" split as agents.
   */
  getImplementation(toolId: string): ToolHandler | undefined {
    return this.implementations.get(toolId);
  }
}
