import { create } from "zustand";
import {
  deleteProviderConfig,
  listProviderConfigs,
  listProviders,
  setDefaultProviderConfig,
  testProviderConnection,
  type ProviderConfigDto,
  type ProviderDto,
} from "../api/client";
import { deleteProviderKey, setProviderKey } from "../security/secureVault";

export interface ProviderVaultEntry {
  provider: ProviderDto;
  configs: ProviderConfigDto[];
  testing: boolean;
  testError: string | null;
}

interface VaultState {
  entries: Record<string, ProviderVaultEntry>;
  loading: boolean;
  loadAll: () => Promise<void>;
  addAndTestKey: (providerId: string, apiKey: string) => Promise<void>;
  removeKey: (providerId: string, configId: string) => Promise<void>;
  setDefault: (providerId: string, configId: string) => Promise<void>;
}

export const useVaultStore = create<VaultState>((set, get) => ({
  entries: {},
  loading: false,

  loadAll: async () => {
    set({ loading: true });
    try {
      const providers = await listProviders();
      const entries: Record<string, ProviderVaultEntry> = {};
      for (const provider of providers) {
        const configs = await listProviderConfigs(provider.id);
        entries[provider.id] = { provider, configs, testing: false, testError: null };
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

    // 1. Local, authoritative copy — Android Keystore via SecureStore.
    await setProviderKey(providerId, apiKey);

    // 2. Transient test call — the backend uses this key once and never stores it
    //    (docs/architecture/07-security-model.md §3). We only keep the
    //    non-secret status/last4 it reports back.
    try {
      const { result, config } = await testProviderConnection(providerId, apiKey);
      set((s) => {
        const entry = s.entries[providerId]!;
        const others = entry.configs.filter((c) => c.id !== config.id);
        return {
          entries: {
            ...s.entries,
            [providerId]: {
              ...entry,
              configs: [...others, config],
              testing: false,
              testError: result.ok ? null : (result.error ?? "Connection failed"),
            },
          },
        };
      });
    } catch (err) {
      // Backend unreachable or rejected the request outright — the key is
      // still saved locally (last4 computed client-side) so the user isn't
      // forced to retype it once connectivity is back.
      set((s) => {
        const entry = s.entries[providerId]!;
        return {
          entries: {
            ...s.entries,
            [providerId]: {
              ...entry,
              testing: false,
              testError: err instanceof Error ? err.message : "Connection test failed",
            },
          },
        };
      });
    }
  },

  removeKey: async (providerId, configId) => {
    await deleteProviderConfig(providerId, configId);
    await deleteProviderKey(providerId);
    set((s) => {
      const entry = s.entries[providerId];
      if (!entry) return s;
      return {
        entries: { ...s.entries, [providerId]: { ...entry, configs: entry.configs.filter((c) => c.id !== configId) } },
      };
    });
  },

  setDefault: async (providerId, configId) => {
    const updated = await setDefaultProviderConfig(providerId, configId);
    set((s) => {
      const entry = s.entries[providerId];
      if (!entry) return s;
      return {
        entries: {
          ...s.entries,
          [providerId]: { ...entry, configs: entry.configs.map((c) => (c.id === updated.id ? updated : c)) },
        },
      };
    });
  },
}));
