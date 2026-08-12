import { describe, expect, it } from "vitest";
import { MAX_TOOL_TEXT_CHARS, truncateText } from "../../src/core/mcp/tools/resultLimits.js";

describe("Tool result limits (M4.12)", () => {
  it("passes short text through unchanged", () => {
    const { text, truncated } = truncateText("hello world");
    expect(text).toBe("hello world");
    expect(truncated).toBe(false);
  });

  it("truncates text past the default bound rather than dumping it whole into an LLM context", () => {
    const long = "x".repeat(MAX_TOOL_TEXT_CHARS + 500);
    const { text, truncated } = truncateText(long);
    expect(truncated).toBe(true);
    expect(text.length).toBe(MAX_TOOL_TEXT_CHARS);
  });

  it("honors a custom limit", () => {
    const { text, truncated } = truncateText("abcdefghij", 5);
    expect(text).toBe("abcde");
    expect(truncated).toBe(true);
  });
});
