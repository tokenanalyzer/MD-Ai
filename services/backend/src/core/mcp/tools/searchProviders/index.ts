import type { SearchProvider } from "@mdai/shared-types";
import { braveSearchProvider } from "./braveSearch.js";

/** Every configured `SearchProvider`, keyed by id — add a new vendor here only, nothing else changes (`webSearchTool.ts` never hard-codes a vendor). */
export const SEARCH_PROVIDERS: Record<string, SearchProvider> = {
  [braveSearchProvider.id]: braveSearchProvider,
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
