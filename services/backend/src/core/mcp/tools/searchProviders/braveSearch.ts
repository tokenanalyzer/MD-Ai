import type { SearchProvider, SearchResultItem } from "@mdai/shared-types";

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
}
interface BraveResponse {
  web?: { results?: BraveWebResult[] };
}

/**
 * One concrete `SearchProvider` — Brave Search's REST API. The Research
 * Agent never depends on this vendor directly; `webSearchTool.ts` picks
 * whichever configured provider matches the caller-supplied `toolKeys`,
 * so a second provider can be added later without touching the agent.
 */
export const braveSearchProvider: SearchProvider = {
  id: "brave",
  displayName: "Brave Search",

  async search(apiKey, query, maxResults, signal): Promise<SearchResultItem[]> {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(Math.max(maxResults, 1), 20)));

    const res = await fetch(url, {
      method: "GET",
      signal,
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
    });
    if (!res.ok) {
      throw new Error(`Brave Search request failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as BraveResponse;
    const results = body.web?.results ?? [];
    return results
      .filter((r): r is BraveWebResult & { title: string; url: string } => Boolean(r.title && r.url))
      .map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.description ?? "",
        source: "brave",
      }));
  },
};
