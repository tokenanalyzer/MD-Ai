/**
 * MCP-compatible tool contracts. Tools are invocable capabilities, kept
 * strictly separate from agents: an agent decides *when* to call a tool,
 * the tool itself is deterministic-in-shape (typed input → typed output)
 * regardless of which agent or which LLM is calling it.
 */

export type JsonSchema = Record<string, unknown>;

export type ToolRiskLevel = "low" | "medium" | "high";

/** An agent's default relationship to a tool absent any explicit grant — see `agent_tool_grants` for the actual per-agent override. */
export type ToolAccessLevel = "allowed" | "restricted" | "denied";

export type ToolHealth = "healthy" | "degraded" | "unavailable" | "unknown";

export interface ToolDefinition {
  id: string;
  displayName: string;
  description: string;
  version: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  source: "builtin" | "mcp_server";
  /** Set when source === "mcp_server": the external MCP server this tool is proxied to. */
  mcpServerUrl?: string;
  /** Protocol-level metadata (transport, capability negotiation) for source === "mcp_server" tools — empty for builtins. */
  mcpMetadata: Record<string, unknown>;
  /** Tags describing what the tool itself needs to function, e.g. "network", "filesystem", "compute" — informational, not an access grant. */
  requiredCapabilities: string[];
  riskLevel: ToolRiskLevel;
  /** High-risk tools (code exec, purchases, irreversible external actions) must be true. None of the M4 built-in tools require this. */
  requiresApproval: boolean;
  /** This tool's baseline access level for any agent with no explicit `agent_tool_grants` row. */
  defaultAccess: ToolAccessLevel;
  enabled: boolean;
  health: ToolHealth;
  healthDetail?: string;
  timeoutMs: number;
  lastVerifiedAt?: string;
  /** Who registered this tool — "system" for every built-in tool; reserved for future user/agent-registered tools. */
  owner: string;
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
  | "timeout"
  | "blocked"
  | "awaiting_approval"
  | "denied";

export interface ToolInvocation {
  id: string;
  toolId: string;
  agentId: string;
  taskId?: string;
  /** Never contains a secret — see `07-security-model.md` §10 (M4). */
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  status: ToolInvocationStatus;
  errorCode?: string;
  error?: string;
  /** Byte/char counts, truncation flags, source counts — never the raw output payload duplicated. */
  resultMetadata?: Record<string, unknown>;
  startedAt: string;
  completedAt?: string;
  latencyMs?: number;
}

/** What a `ToolHandler.invoke` call receives beyond its typed input — the MCP host's own bookkeeping, not agent-supplied. */
export interface ToolExecutionContext {
  invocationId: string;
  agentId: string;
  taskId?: string;
  /** Aborted by the host when `definition.timeoutMs` elapses or the caller cancels — handlers must pass this into every `fetch`. */
  signal: AbortSignal;
  /** Transient, request-scoped credentials a tool needs (e.g. a search provider API key) — travels the same way `providerKeys` does, never persisted. */
  toolKeys: Record<string, string>;
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
  invoke(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<Record<string, unknown>>;
}

export interface ToolRegistry {
  list(): Promise<ToolDefinition[]>;
  get(toolId: string): Promise<ToolDefinition | undefined>;
  register(handler: ToolHandler): void;
  /** Connects to an external MCP server and registers its advertised tools. Not built in M4 — see `core/mcp/toolRegistryService.ts`. */
  connectServer(url: string): Promise<ToolDefinition[]>;
  /** Reads `agent_tool_grants`; `null` means no grant exists (denied by omission, same pattern as `AgentRegistry.isDelegationAuthorized`). */
  checkPermission(agentId: string, toolId: string): Promise<ToolAccessLevel | null>;
}

// ---- M4.4: search provider abstraction ------------------------------------

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  source: string;
  publishedAt?: string;
}

/**
 * Never hard-code the Research Agent to one vendor. Implemented once per
 * search vendor in `core/mcp/tools/searchProviders/`; `web_search`'s
 * `ToolHandler` picks whichever provider has a configured key on this
 * request, or throws `ToolNotAvailableError` if none does — never
 * fabricates results (`04-agent-interfaces.md` §5, M4.4).
 */
export interface SearchProvider {
  id: string;
  displayName: string;
  search(apiKey: string, query: string, maxResults: number, signal: AbortSignal): Promise<SearchResultItem[]>;
}
