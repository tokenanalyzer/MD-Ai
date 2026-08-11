# core/mcp

MCP-compatible tool host: `ToolRegistry` implementation, built-in tool
handlers, and the client side for connecting external MCP servers
(`connectServer`). Enforces `agent_tool_grants` and the
`requires_approval` gate on every invocation — agents never call a tool
directly, only through this host. See
`docs/architecture/04-agent-interfaces.md` §5.

Planned built-in tools (M4): `web.search`, `web.fetch`, `code.exec`
(sandboxed, approval-required).
