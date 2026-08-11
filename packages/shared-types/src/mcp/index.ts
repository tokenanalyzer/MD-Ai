/**
 * MCP-compatible tool contracts. Tools are invocable capabilities, kept
 * strictly separate from agents: an agent decides *when* to call a tool,
 * the tool itself is deterministic-in-shape (typed input → typed output)
 * regardless of which agent or which LLM is calling it.
 */

export type JsonSchema = Record<string, unknown>;

export type ToolRiskLevel = "low" | "medium" | "high";

export interface ToolDefinition {
  id: string;
  displayName: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  source: "builtin" | "mcp_server";
  /** Set when source === "mcp_server": the external MCP server this tool is proxied to. */
  mcpServerUrl?: string;
  riskLevel: ToolRiskLevel;
  /** High-risk tools (code exec, purchases, irreversible external actions) must be true. */
  requiresApproval: boolean;
  enabled: boolean;
}

export interface ToolInvocationRequest {
  toolId: string;
  taskId?: string;
  agentId: string;
  input: Record<string, unknown>;
}

export type ToolInvocationStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "awaiting_approval"
  | "denied";

export interface ToolInvocationResult {
  id: string;
  toolId: string;
  status: ToolInvocationStatus;
  output?: Record<string, unknown>;
  error?: string;
  latencyMs?: number;
}

/**
 * Implemented once per built-in tool, or once per connected external MCP
 * server (which fans out to that server's own tool list). The MCP host in
 * `core/mcp` is the only caller of this interface — agents never call tools
 * directly, they request an invocation through the host, which enforces
 * `agent_tool_grants` and the approval gate for `requiresApproval` tools.
 */
export interface ToolHandler {
  definition: ToolDefinition;
  invoke(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ToolRegistry {
  list(): Promise<ToolDefinition[]>;
  get(toolId: string): Promise<ToolDefinition | undefined>;
  register(handler: ToolHandler): void;
  /** Connects to an external MCP server and registers its advertised tools. */
  connectServer(url: string): Promise<ToolDefinition[]>;
}
