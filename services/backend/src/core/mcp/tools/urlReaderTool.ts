import type { ToolDefinition, ToolExecutionContext, ToolHandler } from "@mdai/shared-types";
import { safeFetch } from "../../security/ssrfGuard.js";
import { htmlToText } from "./htmlToText.js";
import { truncateText } from "./resultLimits.js";

const DEFINITION: ToolDefinition = {
  id: "url_reader",
  displayName: "URL Reader",
  description:
    "Fetches a single HTTPS URL and extracts readable text, with SSRF protection (private IP / localhost / cloud metadata endpoint blocking), size limits, and redirect limits.",
  version: "0.1.0",
  inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  outputSchema: {
    type: "object",
    properties: { url: { type: "string" }, title: { type: "string" }, text: { type: "string" }, truncated: { type: "boolean" } },
  },
  source: "builtin",
  mcpMetadata: {},
  requiredCapabilities: ["network"],
  riskLevel: "medium",
  requiresApproval: false,
  defaultAccess: "restricted",
  enabled: true,
  health: "unknown",
  timeoutMs: 15000,
  owner: "system",
};

export const urlReaderTool: ToolHandler = {
  definition: DEFINITION,

  async invoke(input, ctx: ToolExecutionContext) {
    const url = String(input["url"] ?? "").trim();
    if (!url) throw new Error("url_reader: 'url' is required");

    const result = await safeFetch(url, {
      signal: ctx.signal,
      maxBytes: 3_000_000,
      allowedContentTypePrefixes: ["text/", "application/json", "application/xml", "application/xhtml"],
    });

    const isHtml = result.contentType.includes("html");
    const { title, text } = isHtml ? htmlToText(result.body) : { title: undefined, text: result.body };
    const bounded = truncateText(text);

    return {
      url: result.finalUrl,
      title,
      text: bounded.text,
      truncated: result.truncated || bounded.truncated,
    };
  },
};
