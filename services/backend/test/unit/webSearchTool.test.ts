import "../setupEnv.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { webSearchTool } from "../../src/core/mcp/tools/webSearchTool.js";
import { ToolNotAvailableError } from "../../src/core/mcp/errors.js";
import type { ToolExecutionContext } from "@mdai/shared-types";

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

function ctx(toolKeys: Record<string, string>): ToolExecutionContext {
  return { invocationId: "test-invocation", agentId: "research", signal: new AbortController().signal, toolKeys };
}

describe("web_search tool (M5.0 — must work via Tavily alone, not just Brave)", () => {
  it("succeeds against Tavily when only a tavily key is supplied — no Brave key present anywhere", async () => {
    mockAgent
      .get("https://api.tavily.com")
      .intercept({ path: "/search", method: "POST" })
      .reply(200, {
        results: [{ title: "MD AI overview", url: "https://example.com/md-ai", content: "A personal AI system.", published_date: "2026-01-01" }],
      });

    const output = await webSearchTool.invoke({ query: "MD AI" }, ctx({ tavily: "test-tavily-key" }));
    expect(output["provider"]).toBe("tavily");
    expect(output["results"]).toEqual([
      { title: "MD AI overview", url: "https://example.com/md-ai", snippet: "A personal AI system.", source: "tavily", publishedAt: "2026-01-01" },
    ]);
  });

  it("throws ToolNotAvailableError, never fabricating results, when neither Brave nor Tavily has a configured key", async () => {
    await expect(webSearchTool.invoke({ query: "MD AI" }, ctx({}))).rejects.toBeInstanceOf(ToolNotAvailableError);
  });
});
