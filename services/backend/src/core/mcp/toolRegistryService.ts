import type pg from "pg";
import type { ToolAccessLevel, ToolDefinition, ToolHandler, ToolRegistry } from "@mdai/shared-types";
import { checkToolPermission, getTool, listTools, type ToolRow } from "../../db/repositories/toolRepo.js";

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

  async connectServer(url: string): Promise<ToolDefinition[]> {
    // Honest scope boundary, not a silent no-op: M4 builds the built-in
    // tool set only (M4.3 explicitly excludes unrestricted external
    // integrations). External MCP server connection is real, planned
    // wiring for a later milestone — see docs/architecture/04-agent-interfaces.md §5.
    throw new Error(`connectServer: external MCP server support is not implemented yet (refused connecting to ${url})`);
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
