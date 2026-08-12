import { describe, expect, it } from "vitest";
import { SEARCH_PROVIDERS, resolveSearchProvider } from "../../src/core/mcp/tools/searchProviders/index.js";

describe("SearchProvider resolution (M5.0 — Research Agent must not be coupled to Brave)", () => {
  it("registers more than one independent provider behind the shared interface", () => {
    expect(Object.keys(SEARCH_PROVIDERS)).toEqual(expect.arrayContaining(["brave", "tavily"]));
  });

  it("resolves Brave when only a brave key is supplied", () => {
    const resolved = resolveSearchProvider({ brave: "test-brave-key" });
    expect(resolved?.provider.id).toBe("brave");
    expect(resolved?.apiKey).toBe("test-brave-key");
  });

  it("resolves Tavily when only a tavily key is supplied — no Brave key present at all", () => {
    const resolved = resolveSearchProvider({ tavily: "test-tavily-key" });
    expect(resolved?.provider.id).toBe("tavily");
    expect(resolved?.apiKey).toBe("test-tavily-key");
  });

  it("remains disabled gracefully — returns undefined — when neither provider has a configured key", () => {
    expect(resolveSearchProvider({})).toBeUndefined();
    expect(resolveSearchProvider({ someOtherTool: "irrelevant" })).toBeUndefined();
  });
});
