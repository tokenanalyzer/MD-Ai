import type { SearchProvider, SearchResultItem } from "@mdai/shared-types";

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
}
interface TavilyResponse {
  results?: TavilyResult[];
}

/**
 * A second, independent `SearchProvider` (M5.0) — proves `web_search`
 * isn't coupled to Brave specifically. `resolveSearchProvider` picks
 * whichever provider the caller supplied a key for; if neither Brave nor
 * Tavily has a configured key, `web_search` still honestly reports
 * `ToolNotAvailableError` rather than silently degrading.
 */
export const tavilySearchProvider: SearchProvider = {
  id: "tavily",
  displayName: "Tavily Search",

  async search(apiKey, query, maxResults, signal): Promise<SearchResultItem[]> {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: Math.min(Math.max(maxResults, 1), 20),
      }),
    });
    if (!res.ok) {
      throw new Error(`Tavily Search request failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as TavilyResponse;
    const results = body.results ?? [];
    return results
      .filter((r): r is TavilyResult & { title: string; url: string } => Boolean(r.title && r.url))
      .map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content ?? "",
        source: "tavily",
        publishedAt: r.published_date,
      }));
  },
};
