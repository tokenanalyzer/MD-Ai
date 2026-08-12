import type { BotDefinition, BotRunContext, BotRunResult, NormalizedFinding } from "@mdai/shared-types";

/**
 * M8: same deterministic `SearchProvider` pattern as News Monitor (M5.9).
 */

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.toLowerCase().replace(/\/+$/, "");
  } catch {
    return url.toLowerCase();
  }
}

function isRecent(publishedAt: string | undefined, withinHours: number): boolean {
  if (!publishedAt) return false;
  const ts = Date.parse(publishedAt);
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts < withinHours * 60 * 60 * 1000;
}

export const businessOpportunityMonitor: BotDefinition = {
  id: "business-opportunity-monitor",
  displayName: "Business Opportunity Monitor",
  description:
    "Tracks configured business-opportunity topics (funding rounds, acquisitions, partnerships, market gaps) via the existing SearchProvider abstraction.",
  version: "0.1.0",
  category: "business",
  scheduleCron: "*/30 * * * *",
  defaultConfig: { topics: ["startup funding round", "company acquisition", "new market entrant"] },
  capabilities: ["research"],
  timeoutMs: 30000,

  async run(ctx: BotRunContext): Promise<BotRunResult> {
    const topics = Array.isArray(ctx.config["topics"]) ? (ctx.config["topics"] as string[]) : [];
    const findings: NormalizedFinding[] = [];
    let topicsSearched = 0;
    let articlesSeen = 0;

    for (const topic of topics) {
      const searched = await ctx.callSearchProvider(topic, 5);
      if (!searched) continue; // no search provider configured for background use — skip quietly, never fabricate
      topicsSearched++;

      for (const article of searched.results) {
        articlesSeen++;
        const titleMatchesTopic = article.title.toLowerCase().includes(topic.toLowerCase());
        const recent = isRecent(article.publishedAt, 24);
        findings.push({
          category: "business",
          title: article.title,
          summary: article.snippet,
          importance: titleMatchesTopic && recent ? "medium" : "low",
          confidence: titleMatchesTopic ? 0.8 : 0.5,
          sourceMetadata: { topic, provider: searched.provider, url: article.url, publishedAt: article.publishedAt },
          payload: { topic, article },
          dedupKey: `${topic.toLowerCase()}::${normalizeUrl(article.url)}`,
        });
      }
    }

    return {
      status: "succeeded",
      findings,
      resourceMetadata: { topicsConfigured: topics.length, topicsSearched, articlesSeen },
    };
  },
};
