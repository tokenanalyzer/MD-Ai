import type { BotDefinition, BotRunContext, BotRunResult, NormalizedFinding } from "@mdai/shared-types";

/**
 * M5.9: generic, configured topics/sources via the existing
 * `SearchProvider` abstraction (M4.4) — no new integration. Deterministic
 * filtering/dedup runs here, before anything reaches an LLM: most articles
 * never trigger a model call at all, since only findings that clear
 * `ESCALATION_MIN_IMPORTANCE` (core/bots/dedup.ts) get escalated by the
 * shared pipeline, and this bot itself never calls one.
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

export const newsMonitor: BotDefinition = {
  id: "news-monitor",
  displayName: "News Monitor",
  description:
    "Tracks configured topics via the existing SearchProvider abstraction. Deterministic filtering and dedup run before anything reaches an LLM.",
  version: "0.1.0",
  category: "news",
  scheduleCron: "*/30 * * * *",
  defaultConfig: { topics: ["AI agents", "Gemini", "NVIDIA", "Open-source AI"] },
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
          category: "news",
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
