import type { ToolDefinition, ToolExecutionContext, ToolHandler } from "@mdai/shared-types";
import { ToolNotAvailableError } from "../errors.js";
import { resolveSearchProvider } from "./searchProviders/index.js";

const DEFINITION: ToolDefinition = {
  id: "web_search",
  displayName: "Web Search",
  description:
    "Searches the web via a configured search provider and returns structured results (title, url, snippet, source). Returns ToolNotAvailableError, never fabricated results, when no provider is configured.",
  version: "0.1.0",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" }, maxResults: { type: "integer" } },
    required: ["query"],
  },
  outputSchema: { type: "object", properties: { results: { type: "array" }, provider: { type: "string" } } },
  source: "builtin",
  mcpMetadata: {},
  requiredCapabilities: ["network"],
  riskLevel: "low",
  requiresApproval: false,
  defaultAccess: "restricted",
  enabled: true,
  health: "unknown",
  timeoutMs: 15000,
  owner: "system",
};

export const webSearchTool: ToolHandler = {
  definition: DEFINITION,

  async invoke(input, ctx: ToolExecutionContext) {
    const query = String(input["query"] ?? "").trim();
    if (!query) throw new Error("web_search: 'query' is required");
    const maxResults = typeof input["maxResults"] === "number" ? Math.floor(input["maxResults"]) : 5;

    const resolved = resolveSearchProvider(ctx.toolKeys);
    if (!resolved) {
      throw new ToolNotAvailableError("web_search");
    }

    const results = await resolved.provider.search(resolved.apiKey, query, maxResults, ctx.signal);
    return { results, provider: resolved.provider.id };
  },
};
