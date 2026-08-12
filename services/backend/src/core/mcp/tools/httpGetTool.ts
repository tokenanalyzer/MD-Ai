import type { ToolDefinition, ToolExecutionContext, ToolHandler } from "@mdai/shared-types";
import { safeFetch } from "../../security/ssrfGuard.js";
import { truncateText } from "./resultLimits.js";

const DEFINITION: ToolDefinition = {
  id: "generic_http_get",
  displayName: "Generic HTTP GET Connector",
  description:
    "Restricted HTTPS GET to a caller-specified URL. SSRF-protected, size-limited, never forwards or accepts model-supplied credentials/Authorization headers.",
  version: "0.1.0",
  inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  outputSchema: {
    type: "object",
    properties: { status: { type: "integer" }, contentType: { type: "string" }, body: { type: "string" }, truncated: { type: "boolean" } },
  },
  source: "builtin",
  mcpMetadata: {},
  requiredCapabilities: ["network"],
  riskLevel: "medium",
  requiresApproval: false,
  defaultAccess: "restricted",
  enabled: true,
  health: "unknown",
  timeoutMs: 10000,
  owner: "system",
};

/**
 * Deliberately the only tool-specific config: no headers/auth field exists
 * on this tool's input schema at all, so a model can never invent or
 * extract an `Authorization` header, a cookie, or any other credential
 * through this connector — not "filtered out," structurally absent from
 * what the handler even reads off `input`.
 */
export const httpGetTool: ToolHandler = {
  definition: DEFINITION,

  async invoke(input, ctx: ToolExecutionContext) {
    const url = String(input["url"] ?? "").trim();
    if (!url) throw new Error("generic_http_get: 'url' is required");

    // Smaller size/redirect budget than url_reader — this connector is
    // explicitly the more restricted of the two per M4.9's permission table.
    const result = await safeFetch(url, {
      signal: ctx.signal,
      maxBytes: 500_000,
      maxRedirects: 2,
      allowedContentTypePrefixes: ["text/", "application/json", "application/xml"],
    });

    const bounded = truncateText(result.body);
    return {
      status: result.status,
      contentType: result.contentType,
      body: bounded.text,
      truncated: result.truncated || bounded.truncated,
    };
  },
};
