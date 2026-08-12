import { describe, expect, it } from "vitest";
import { CalculatorError, evaluateExpression } from "../../src/core/mcp/tools/safeCalculator.js";

describe("Calculator (M4.7 — deterministic, no LLM, no eval)", () => {
  it("evaluates basic arithmetic with correct precedence", () => {
    expect(evaluateExpression("2 + 3 * 4")).toBe(14);
    expect(evaluateExpression("(2 + 3) * 4")).toBe(20);
    expect(evaluateExpression("10 / 4")).toBe(2.5);
    expect(evaluateExpression("2 ^ 10")).toBe(1024);
    expect(evaluateExpression("-5 + 3")).toBe(-2);
  });

  it("supports the small allowed function set", () => {
    expect(evaluateExpression("sqrt(16)")).toBe(4);
    expect(evaluateExpression("abs(-7)")).toBe(7);
    expect(evaluateExpression("max(1, 5, 3)")).toBe(5);
    expect(evaluateExpression("min(1, 5, 3)")).toBe(1);
  });

  it("rejects division by zero rather than returning Infinity", () => {
    expect(() => evaluateExpression("1 / 0")).toThrow(CalculatorError);
  });

  it("rejects malformed expressions", () => {
    expect(() => evaluateExpression("2 +")).toThrow(CalculatorError);
    expect(() => evaluateExpression("(2 + 3")).toThrow(CalculatorError);
    expect(() => evaluateExpression("")).toThrow(CalculatorError);
  });

  it("never executes arbitrary code — identifiers outside the allowed function set are rejected, not evaluated", () => {
    expect(() => evaluateExpression("process.exit(1)")).toThrow(CalculatorError);
    expect(() => evaluateExpression("require('fs')")).toThrow(CalculatorError);
    expect(() => evaluateExpression("this.constructor")).toThrow(CalculatorError);
    expect(() => evaluateExpression("console.log(1)")).toThrow(CalculatorError);
  });

  it("rejects unreasonably long expressions", () => {
    expect(() => evaluateExpression("1+".repeat(1000))).toThrow(CalculatorError);
  });
});
