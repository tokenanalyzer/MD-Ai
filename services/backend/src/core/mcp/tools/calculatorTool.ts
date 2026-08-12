import type { ToolDefinition, ToolHandler } from "@mdai/shared-types";
import { evaluateExpression } from "./safeCalculator.js";

const DEFINITION: ToolDefinition = {
  id: "calculator",
  displayName: "Calculator",
  description: "Evaluates a deterministic arithmetic expression locally — never uses an LLM.",
  version: "0.1.0",
  inputSchema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
  outputSchema: { type: "object", properties: { result: { type: "number" } } },
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

export const calculatorTool: ToolHandler = {
  definition: DEFINITION,

  // No network/timeout signal needed — this is pure, synchronous, local computation.
  async invoke(input) {
    const expression = String(input["expression"] ?? "");
    const result = evaluateExpression(expression);
    return { result };
  },
};
