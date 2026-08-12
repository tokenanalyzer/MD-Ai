import type { ToolDefinition, ToolExecutionContext, ToolHandler } from "@mdai/shared-types";
import { safeFetch } from "../../security/ssrfGuard.js";
import { truncateText } from "./resultLimits.js";

const DEFINITION: ToolDefinition = {
  id: "file_reader",
  displayName: "Text/File Reader",
  description:
    "Fetches a plain-text file over HTTPS and returns its content, bounded by a size limit. Operates on an https:// URL, not an internal object-storage reference — no uploads/object-storage subsystem exists in this codebase yet.",
  version: "0.1.0",
  inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  outputSchema: { type: "object", properties: { text: { type: "string" }, truncated: { type: "boolean" } } },
  source: "builtin",
  mcpMetadata: {},
  requiredCapabilities: ["network"],
  riskLevel: "low",
  requiresApproval: false,
  defaultAccess: "allowed",
  enabled: true,
  health: "unknown",
  timeoutMs: 10000,
  owner: "system",
};

const ALLOWED_CONTENT_TYPES = ["text/", "application/json", "application/xml", "application/x-yaml", "application/yaml"];

export const fileReaderTool: ToolHandler = {
  definition: DEFINITION,

  async invoke(input, ctx: ToolExecutionContext) {
    const url = String(input["url"] ?? "").trim();
    if (!url) throw new Error("file_reader: 'url' is required");

    const result = await safeFetch(url, {
      signal: ctx.signal,
      maxBytes: 2_000_000,
      allowedContentTypePrefixes: ALLOWED_CONTENT_TYPES,
    });

    const bounded = truncateText(result.body);
    return { text: bounded.text, truncated: result.truncated || bounded.truncated };
  },
};
