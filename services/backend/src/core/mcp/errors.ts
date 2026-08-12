/**
 * Thrown by `AgentRuntimeContext.callTool` until the real MCP host exists
 * (M4). This is the honest failure the M3 instructions require: an agent
 * that tries to use a tool gets a clear, typed "not available" error to
 * report as a limitation — never a silent no-op that could be mistaken
 * for a real (if empty) result.
 */
export class ToolNotAvailableError extends Error {
  constructor(readonly toolId: string) {
    super(`Tool "${toolId}" is not available — no MCP host is connected yet (see docs/architecture/09-roadmap.md M4).`);
    this.name = "ToolNotAvailableError";
  }
}
