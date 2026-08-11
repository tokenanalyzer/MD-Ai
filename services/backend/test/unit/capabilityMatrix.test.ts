import "../setupEnv.js";
import { describe, expect, it } from "vitest";
import { isCapable, TASK_CATEGORY_REQUIREMENTS } from "../../src/core/router/capabilityMatrix.js";
import { fakeModelEntry } from "./fixtures/modelRegistryFixtures.js";

describe("capabilityMatrix", () => {
  it("has an explicit entry for every documented task category", () => {
    const categories = Object.keys(TASK_CATEGORY_REQUIREMENTS);
    expect(categories.sort()).toEqual(
      ["chat", "fast", "long-context", "reasoning", "research", "structured-output", "tool-calling", "vision"].sort(),
    );
  });

  it("no category is capable by default (undefined) — every model qualifies", () => {
    const entry = fakeModelEntry("groq/plain-model");
    expect(isCapable(entry, undefined).capable).toBe(true);
  });

  it("hard-excludes a text-only model from the vision category", () => {
    const entry = fakeModelEntry("groq/text-only", { capabilities: { ...fakeModelEntry("x").capabilities, supportsVision: false } });
    const result = isCapable(entry, "vision");
    expect(result.capable).toBe(false);
    expect(result.reason).toContain("supportsVision");
  });

  it("admits a vision-capable model to the vision category", () => {
    const entry = fakeModelEntry("gemini/vision-model", {
      capabilities: { ...fakeModelEntry("x").capabilities, supportsVision: true },
    });
    expect(isCapable(entry, "vision").capable).toBe(true);
  });

  it("hard-excludes a model without tool support from tool-calling", () => {
    const entry = fakeModelEntry("groq/no-tools", { capabilities: { ...fakeModelEntry("x").capabilities, supportsTools: false } });
    expect(isCapable(entry, "tool-calling").capable).toBe(false);
  });

  it("hard-excludes a model without structured-output support", () => {
    const entry = fakeModelEntry("groq/no-structured", {
      capabilities: { ...fakeModelEntry("x").capabilities, supportsStructuredOutput: false },
    });
    expect(isCapable(entry, "structured-output").capable).toBe(false);
  });

  it("excludes a short-context model from long-context by minContextLength", () => {
    const entry = fakeModelEntry("groq/short-ctx", {
      capabilities: { ...fakeModelEntry("x").capabilities, contextLength: 8_000 },
    });
    const result = isCapable(entry, "long-context");
    expect(result.capable).toBe(false);
    expect(result.reason).toContain("context length");
  });

  it("admits a long-context model to long-context", () => {
    const entry = fakeModelEntry("gemini/long-ctx", {
      capabilities: { ...fakeModelEntry("x").capabilities, contextLength: 1_000_000 },
    });
    expect(isCapable(entry, "long-context").capable).toBe(true);
  });

  it("does not exclude on reasoning/fast/chat/research — those are soft preferences, not hard filters", () => {
    const plain = fakeModelEntry("groq/plain");
    expect(isCapable(plain, "reasoning").capable).toBe(true);
    expect(isCapable(plain, "fast").capable).toBe(true);
    expect(isCapable(plain, "chat").capable).toBe(true);
  });

  it("research requires the long-context minimum too (32k)", () => {
    const shortCtx = fakeModelEntry("groq/short", { capabilities: { ...fakeModelEntry("x").capabilities, contextLength: 4_000 } });
    expect(isCapable(shortCtx, "research").capable).toBe(false);
  });
});
