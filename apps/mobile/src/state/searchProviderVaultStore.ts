import { create } from "zustand";
import { listSearchProviders, testSearchProviderConnection, type SearchProviderDto } from "../api/client";
import {
  deleteSearchProviderKey,
  getSearchProviderKey,
  last4,
  setSearchProviderKey,
} from "../security/secureVault";

export interface SearchProviderVaultEntry {
  provider: SearchProviderDto;
  keyLast4: string | null;
  testing: boolean;
  testError: string | null;
}

interface SearchProviderVaultState {
  entries: Record<string, SearchProviderVaultEntry>;
  loading: boolean;
  loadAll: () => Promise<void>;
  addAndTestKey: (providerId: string, apiKey: string) => Promise<void>;
  removeKey: (providerId: string) => Promise<void>;
}

/**
 * The Research/specialist agents' `web_search` tool needs one of these
 * keys (see services/backend/src/core/mcp/tools/searchProviders/index.ts)
 * — a completely separate credential from any LLM provider key. Without
 * one, web_search throws ToolNotAvailableError and the agent honestly
 * falls back to its own training knowledge (see researchAgent.ts's
 * system prompt) instead of live results, which reads as "the AI doesn't
 * really search the web."
 */
export const useSearchProviderVaultStore = create<SearchProviderVaultState>((set) => ({
  entries: {},
  loading: false,

  loadAll: async () => {
    set({ loading: true });
    try {
      const providers = await listSearchProviders();
      const entries: Record<string, SearchProviderVaultEntry> = {};
      for (const provider of providers) {
        const existingKey = await getSearchProviderKey(provider.id);
        entries[provider.id] = {
          provider,
          keyLast4: existingKey ? last4(existingKey) : null,
          testing: false,
          testError: null,
        };
      }
      set({ entries, loading: false });
    } catch (err) {
      set({ loading: false });
      throw err;
    }
  },

  addAndTestKey: async (providerId, apiKey) => {
    set((s) => ({
      entries: { ...s.entries, [providerId]: { ...s.entries[providerId]!, testing: true, testError: null } },
    }));

    try {
      const result = await testSearchProviderConnection(providerId, apiKey);
      if (result.ok) {
        // Local, authoritative copy — Android Keystore via SecureStore. The
        // backend used the key for one test call and never stores it (see
        // searchProviders.ts).
        await setSearchProviderKey(providerId, apiKey);
      }
      set((s) => {
        const entry = s.entries[providerId]!;
        return {
          entries: {
            ...s.entries,
            [providerId]: {
              ...entry,
              keyLast4: result.ok ? last4(apiKey) : entry.keyLast4,
              testing: false,
              testError: result.ok ? null : (result.error ?? "Connection failed"),
            },
          },
        };
      });
    } catch (err) {
      set((s) => {
        const entry = s.entries[providerId]!;
        return {
          entries: {
            ...s.entries,
            [providerId]: { ...entry, testing: false, testError: err instanceof Error ? err.message : "Connection test failed" },
          },
        };
      });
    }
  },

  removeKey: async (providerId) => {
    await deleteSearchProviderKey(providerId);
    set((s) => {
      const entry = s.entries[providerId];
      if (!entry) return s;
      return { entries: { ...s.entries, [providerId]: { ...entry, keyLast4: null } } };
    });
  },
}));
