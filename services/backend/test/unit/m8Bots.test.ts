import { describe, expect, it } from "vitest";
import type { BotDefinition, BotRunContext, SearchResultItem } from "@mdai/shared-types";
import { marketScanner } from "../../src/core/bots/marketScanner.js";
import { liquidityMonitor } from "../../src/core/bots/liquidityMonitor.js";
import { volumeAnomalyMonitor } from "../../src/core/bots/volumeAnomalyMonitor.js";
import { socialTrendMonitor } from "../../src/core/bots/socialTrendMonitor.js";
import { businessOpportunityMonitor } from "../../src/core/bots/businessOpportunityMonitor.js";

function makeCtx(
  config: Record<string, unknown>,
  searchImpl: (query: string, maxResults?: number) => Promise<{ results: SearchResultItem[]; provider: string } | undefined>,
): BotRunContext {
  return {
    botId: "test",
    config,
    signal: new AbortController().signal,
    callSearchProvider: searchImpl,
  };
}

const NEW_BOTS: BotDefinition[] = [marketScanner, liquidityMonitor, volumeAnomalyMonitor, socialTrendMonitor, businessOpportunityMonitor];

describe("M8.5 remaining bots — roster", () => {
  it("registers exactly the five roadmap bots with the seeded ids/categories/topics", () => {
    const byId = new Map(NEW_BOTS.map((b) => [b.id, b]));
    expect([...byId.keys()].sort()).toEqual([
      "business-opportunity-monitor",
      "liquidity-monitor",
      "market-scanner",
      "social-trend-monitor",
      "volume-anomaly-monitor",
    ]);
    expect(byId.get("market-scanner")?.category).toBe("market");
    expect(byId.get("liquidity-monitor")?.category).toBe("market");
    expect(byId.get("volume-anomaly-monitor")?.category).toBe("market");
    expect(byId.get("social-trend-monitor")?.category).toBe("social");
    expect(byId.get("business-opportunity-monitor")?.category).toBe("business");
    for (const bot of NEW_BOTS) {
      expect(bot.capabilities).toEqual(["research"]);
      // Every bot's own description must honestly disclose it has no live
      // market/social data feed — never implying real-time access it
      // doesn't have.
      if (bot.id !== "business-opportunity-monitor") {
        expect(bot.description.toLowerCase()).toMatch(/no live|not a live|no connected/);
      }
    }
  });
});

describe("M8.5 remaining bots — run() behavior", () => {
  it("market-scanner skips a topic quietly (never fabricating) when no search provider is configured", async () => {
    const ctx = makeCtx({ topics: ["crypto market"] }, async () => undefined);
    const result = await marketScanner.run(ctx);
    expect(result.status).toBe("succeeded");
    expect(result.findings).toEqual([]);
    expect(result.resourceMetadata).toMatchObject({ topicsConfigured: 1, topicsSearched: 0 });
  });

  it("liquidity-monitor produces a deterministic, deduplicated finding from a matching, recent article", async () => {
    const article: SearchResultItem = {
      title: "Stablecoin depeg triggers exchange liquidity crisis",
      url: "https://news.example.com/depeg-story",
      snippet: "A major stablecoin briefly depegged, straining exchange liquidity.",
      source: "news.example.com",
      publishedAt: new Date().toISOString(),
    };
    const ctx = makeCtx({ topics: ["stablecoin depeg"] }, async () => ({ results: [article], provider: "brave" }));

    const result = await liquidityMonitor.run(ctx);
    expect(result.status).toBe("succeeded");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ category: "market", importance: "high" });
    expect(result.findings[0]?.dedupKey).toBe("stablecoin depeg::news.example.com/depeg-story");
  });

  it("volume-anomaly-monitor marks a non-matching or stale article as low importance", async () => {
    const staleArticle: SearchResultItem = {
      title: "Unrelated headline",
      url: "https://news.example.com/unrelated",
      snippet: "Nothing to do with the topic.",
      source: "news.example.com",
      publishedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
    };
    const ctx = makeCtx({ topics: ["unusual trading volume"] }, async () => ({ results: [staleArticle], provider: "brave" }));

    const result = await volumeAnomalyMonitor.run(ctx);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.importance).toBe("low");
  });

  it("social-trend-monitor and business-opportunity-monitor tag findings with their own category", async () => {
    const article: SearchResultItem = {
      title: "Viral trend explodes online",
      url: "https://news.example.com/viral",
      snippet: "A viral trend is spreading.",
      source: "news.example.com",
      publishedAt: new Date().toISOString(),
    };
    const socialCtx = makeCtx({ topics: ["viral trend"] }, async () => ({ results: [article], provider: "brave" }));
    const socialResult = await socialTrendMonitor.run(socialCtx);
    expect(socialResult.findings[0]?.category).toBe("social");

    const bizArticle: SearchResultItem = {
      title: "Startup funding round announced",
      url: "https://news.example.com/funding",
      snippet: "A startup closed a new funding round.",
      source: "news.example.com",
      publishedAt: new Date().toISOString(),
    };
    const bizCtx = makeCtx({ topics: ["startup funding round"] }, async () => ({ results: [bizArticle], provider: "brave" }));
    const bizResult = await businessOpportunityMonitor.run(bizCtx);
    expect(bizResult.findings[0]?.category).toBe("business");
  });

  it("dedupKey is stable across a URL's trailing slash/case so the same article never double-fires", async () => {
    const ctx = makeCtx({ topics: ["new market entrant"] }, async () => ({
      results: [
        {
          title: "New market entrant announced",
          url: "https://News.Example.com/Entrant/",
          snippet: "s",
          source: "news.example.com",
        },
      ],
      provider: "brave",
    }));
    const result = await businessOpportunityMonitor.run(ctx);
    expect(result.findings[0]?.dedupKey).toBe("new market entrant::news.example.com/entrant");
  });
});
