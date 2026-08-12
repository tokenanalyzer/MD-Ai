import type { SearchProvider } from "@mdai/shared-types";
import { braveSearchProvider } from "./braveSearch.js";
import { tavilySearchProvider } from "./tavilySearch.js";

/**
 * Every configured `SearchProvider`, keyed by id — add a new vendor here
 * only, nothing else changes (`webSearchTool.ts` never hard-codes a
 * vendor). Neither entry is "the" provider; both are equally optional —
 * whichever one the caller supplied a key for on this request wins (see
 * `resolveSearchProvider` below). A vendor with no key configured simply
 * never gets picked; there is no separate "enabled" flag to manage.
 */
export const SEARCH_PROVIDERS: Record<string, SearchProvider> = {
  [braveSearchProvider.id]: braveSearchProvider,
  [tavilySearchProvider.id]: tavilySearchProvider,
};

/** Picks the first provider the caller supplied a `toolKeys` entry for. `undefined` means none is configured — callers must throw `ToolNotAvailableError`, never fabricate results. */
export function resolveSearchProvider(
  toolKeys: Record<string, string>,
): { provider: SearchProvider; apiKey: string } | undefined {
  for (const provider of Object.values(SEARCH_PROVIDERS)) {
    const apiKey = toolKeys[provider.id];
    if (apiKey) return { provider, apiKey };
  }
  return undefined;
}
