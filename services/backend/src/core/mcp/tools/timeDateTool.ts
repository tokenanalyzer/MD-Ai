import type { ToolDefinition, ToolHandler } from "@mdai/shared-types";

const DEFINITION: ToolDefinition = {
  id: "time_date",
  displayName: "Time / Date",
  description: "Returns the current date/time deterministically — never uses an LLM.",
  version: "0.1.0",
  inputSchema: { type: "object", properties: { timezoneOffsetMinutes: { type: "integer" } } },
  outputSchema: { type: "object", properties: { iso: { type: "string" }, unixMs: { type: "integer" } } },
  source: "builtin",
  mcpMetadata: {},
  requiredCapabilities: ["compute"],
  riskLevel: "low",
  requiresApproval: false,
  defaultAccess: "allowed",
  enabled: true,
  health: "healthy",
  timeoutMs: 1000,
  owner: "system",
};

export const timeDateTool: ToolHandler = {
  definition: DEFINITION,

  async invoke(input) {
    const now = new Date();
    const offsetRaw = input["timezoneOffsetMinutes"];
    const offsetMinutes = typeof offsetRaw === "number" && Number.isFinite(offsetRaw) ? offsetRaw : 0;
    const shifted = new Date(now.getTime() + offsetMinutes * 60_000);
    return { iso: shifted.toISOString(), unixMs: now.getTime() };
  },
};
