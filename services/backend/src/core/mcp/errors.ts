/**
 * Thrown by `AgentRuntimeContext.callTool` when the requested tool truly
 * isn't usable right now — no registered implementation, the tool is
 * disabled, or (for `web_search`) no search provider key was supplied on
 * this request. This is the honest failure M3/M4 require: an agent gets a
 * clear, typed "not available" error to report as a limitation — never a
 * silent no-op or fabricated result.
 */
export class ToolNotAvailableError extends Error {
  constructor(readonly toolId: string) {
    super(`Tool "${toolId}" is not available.`);
    this.name = "ToolNotAvailableError";
  }
}

/** No `agent_tool_grants` row authorizes `agentId` to call `toolId` — the same "absence is denial" pattern as `DelegationNotAuthorizedError`. */
export class ToolPermissionDeniedError extends Error {
  constructor(
    readonly agentId: string,
    readonly toolId: string,
  ) {
    super(`${agentId} is not authorized to call tool "${toolId}" (no agent_tool_grants row)`);
    this.name = "ToolPermissionDeniedError";
  }
}

/** The MCP host's own per-tool timeout (`ToolDefinition.timeoutMs`) elapsed before the handler returned. */
export class ToolTimeoutError extends Error {
  constructor(
    readonly toolId: string,
    readonly timeoutMs: number,
  ) {
    super(`Tool "${toolId}" timed out after ${timeoutMs}ms`);
    this.name = "ToolTimeoutError";
  }
}
