import "../setupEnv.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { McpProtocolError, callMcpServerTool, listMcpServerTools } from "../../src/core/mcp/mcpClient.js";

let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;

beforeEach(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
});

/**
 * M10: the real MCP JSON-RPC 2.0 transport OpenClaw (or any compliant MCP
 * server) is reached through — see `core/mcp/mcpClient.ts`'s header
 * comment. Tested against a protocol-compliant mock, since no real
 * OpenClaw endpoint exists to test against yet.
 */
describe("MCP JSON-RPC client (M10)", () => {
  it("tools/list returns the server's advertised tool catalog", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/rpc", method: "POST" })
      .reply(
        200,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: [
              { name: "search_docs", description: "Search internal docs", inputSchema: { type: "object" } },
              { name: "no_description_tool" },
            ],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const tools = await listMcpServerTools("https://example.com/rpc", new AbortController().signal);
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ name: "search_docs", description: "Search internal docs" });
    expect(tools[1]).toMatchObject({ name: "no_description_tool" });
  });

  it("throws McpProtocolError when the response has no `tools` array", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/rpc", method: "POST" })
      .reply(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { notTools: [] } }), {
        headers: { "content-type": "application/json" },
      });

    await expect(listMcpServerTools("https://example.com/rpc", new AbortController().signal)).rejects.toThrow(
      McpProtocolError,
    );
  });

  it("throws McpProtocolError when the server returns a JSON-RPC error object", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/rpc", method: "POST" })
      .reply(200, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } }), {
        headers: { "content-type": "application/json" },
      });

    await expect(listMcpServerTools("https://example.com/rpc", new AbortController().signal)).rejects.toThrow(
      /Method not found/,
    );
  });

  it("throws McpProtocolError on a non-2xx HTTP status", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/rpc", method: "POST" })
      .reply(503, "unavailable", { headers: { "content-type": "application/json" } });

    await expect(listMcpServerTools("https://example.com/rpc", new AbortController().signal)).rejects.toThrow(
      McpProtocolError,
    );
  });

  it("throws McpProtocolError when the response body is not valid JSON", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/rpc", method: "POST" })
      .reply(200, "not json at all", { headers: { "content-type": "application/json" } });

    await expect(listMcpServerTools("https://example.com/rpc", new AbortController().signal)).rejects.toThrow(
      McpProtocolError,
    );
  });

  it("tools/call normalizes MCP content blocks into a single joined text string", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/rpc", method: "POST", body: (b: string) => b.includes('"tools/call"') && b.includes("search_docs") })
      .reply(
        200,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            isError: false,
            content: [
              { type: "text", text: "First block." },
              { type: "text", text: "Second block." },
              { type: "image", data: "base64-ignored" },
            ],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const result = await callMcpServerTool("https://example.com/rpc", "search_docs", { query: "hello" }, new AbortController().signal);
    expect(result.text).toBe("First block.\nSecond block.");
    expect(result.isError).toBe(false);
  });

  it("tools/call propagates the server's isError flag without throwing", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/rpc", method: "POST" })
      .reply(
        200,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { isError: true, content: [{ type: "text", text: "Tool execution failed upstream." }] },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const result = await callMcpServerTool("https://example.com/rpc", "broken_tool", {}, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("failed upstream");
  });
});
