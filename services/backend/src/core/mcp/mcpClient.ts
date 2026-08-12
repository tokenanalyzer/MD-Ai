import { safeFetch } from "../security/ssrfGuard.js";

/**
 * A minimal client for the real Model Context Protocol's JSON-RPC 2.0
 * request/response transport (`tools/list`, `tools/call`) — the exact
 * mechanism `docs/architecture/08-deployment-architecture.md` names for
 * OpenClaw: "the `tools.source = 'mcp_server'` mechanism already
 * accommodates an external action-execution server without a new
 * concept". This talks to any compliant MCP server, not a bespoke
 * OpenClaw-specific protocol — OpenClaw is simply the first server this
 * connects to once a real endpoint exists to point it at.
 */

export class McpProtocolError extends Error {
  constructor(
    readonly serverUrl: string,
    readonly method: string,
    message: string,
  ) {
    super(`MCP server "${serverUrl}" ${method} failed: ${message}`);
    this.name = "McpProtocolError";
  }
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

async function callJsonRpc(serverUrl: string, method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const result = await safeFetch(serverUrl, {
    signal,
    method: "POST",
    body,
    headers: { "content-type": "application/json", accept: "application/json" },
    allowedContentTypePrefixes: ["application/json"],
    maxBytes: 500_000,
  });

  if (result.status < 200 || result.status >= 300) {
    throw new McpProtocolError(serverUrl, method, `HTTP ${result.status}`);
  }

  let parsed: JsonRpcResponse;
  try {
    parsed = JSON.parse(result.body) as JsonRpcResponse;
  } catch {
    throw new McpProtocolError(serverUrl, method, "response was not valid JSON");
  }
  if (parsed.error) {
    throw new McpProtocolError(serverUrl, method, `${parsed.error.code}: ${parsed.error.message}`);
  }
  return parsed.result;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** `tools/list` — the server's own advertised tool catalog. */
export async function listMcpServerTools(serverUrl: string, signal: AbortSignal): Promise<McpToolDescriptor[]> {
  const result = await callJsonRpc(serverUrl, "tools/list", {}, signal);
  const tools = (result as { tools?: unknown })?.tools;
  if (!Array.isArray(tools)) {
    throw new McpProtocolError(serverUrl, "tools/list", "response had no `tools` array");
  }
  return tools.filter((t): t is McpToolDescriptor => typeof t === "object" && t !== null && typeof (t as { name?: unknown }).name === "string");
}

export interface McpCallResult {
  text: string;
  isError: boolean;
  raw: unknown;
}

/** `tools/call` — normalizes the MCP `content` array (a list of `{type, text}` blocks) into a single joined string, since every built-in tool in this codebase already returns flat, agent-consumable objects rather than a content-block array. */
export async function callMcpServerTool(serverUrl: string, toolName: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
  const result = await callJsonRpc(serverUrl, "tools/call", { name: toolName, arguments: args }, signal);
  const content = (result as { content?: unknown })?.content;
  const isError = Boolean((result as { isError?: unknown })?.isError);
  const text = Array.isArray(content)
    ? content
        .filter((c): c is { type: string; text: string } => typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text")
        .map((c) => c.text)
        .join("\n")
    : "";
  return { text, isError, raw: result };
}
