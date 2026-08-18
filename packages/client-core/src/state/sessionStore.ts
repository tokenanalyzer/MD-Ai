import { create } from "zustand";
import { autoPairDevice, pairDevice, refreshAccessToken, type PairResponse } from "../api/client.js";
import { getClientCoreConfig } from "../platform.js";

const ACCESS_TOKEN_KEY = "mdai.session.accessToken";
const REFRESH_TOKEN_KEY = "mdai.session.refreshToken";

interface SessionState {
  accessToken: string | null;
  refreshToken: string | null;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  pair: (pairingCode: string, deviceName: string, platform?: "android" | "pc" | "other") => Promise<void>;
  autoPair: (deviceName?: string, platform?: "android" | "pc" | "other") => Promise<void>;
  tryRefresh: () => Promise<boolean>;
  signOut: () => Promise<void>;
}

async function persistTokens(accessToken: string, refreshToken: string): Promise<void> {
  const store = getClientCoreConfig().keyValueStore;
  await Promise.all([store.setItemAsync(ACCESS_TOKEN_KEY, accessToken), store.setItemAsync(REFRESH_TOKEN_KEY, refreshToken)]);
}

/**
 * Device session state. Tokens are stored via the host app's own
 * `KeyValueStore` (mobile: Keystore-backed SecureStore —
 * docs/architecture/07-security-model.md §2) — this is what "local gate"
 * protects, distinct from provider keys which additionally travel to the
 * backend per-request.
 */
export const useSessionStore = create<SessionState>((set, get) => ({
  accessToken: null,
  refreshToken: null,
  hydrated: false,

  hydrate: async () => {
    const store = getClientCoreConfig().keyValueStore;
    const [accessToken, refreshToken] = await Promise.all([store.getItemAsync(ACCESS_TOKEN_KEY), store.getItemAsync(REFRESH_TOKEN_KEY)]);
    set({ accessToken, refreshToken, hydrated: true });
  },

  pair: async (pairingCode, deviceName, platform = "android") => {
    const res: PairResponse = await pairDevice({ pairingCode, deviceName, platform });
    await persistTokens(res.accessToken, res.refreshToken);
    set({ accessToken: res.accessToken, refreshToken: res.refreshToken });
  },

  autoPair: async (deviceName = "My Phone", platform = "android") => {
    const res: PairResponse = await autoPairDevice({ deviceName, platform });
    await persistTokens(res.accessToken, res.refreshToken);
    set({ accessToken: res.accessToken, refreshToken: res.refreshToken });
  },

  tryRefresh: async () => {
    const refreshToken = get().refreshToken;
    if (!refreshToken) return false;
    try {
      const res = await refreshAccessToken(refreshToken);
      await getClientCoreConfig().keyValueStore.setItemAsync(ACCESS_TOKEN_KEY, res.accessToken);
      set({ accessToken: res.accessToken });
      return true;
    } catch {
      // Refresh token itself is invalid/revoked — the device needs to re-pair.
      await get().signOut();
      return false;
    }
  },

  signOut: async () => {
    const store = getClientCoreConfig().keyValueStore;
    await Promise.all([store.deleteItemAsync(ACCESS_TOKEN_KEY), store.deleteItemAsync(REFRESH_TOKEN_KEY)]);
    set({ accessToken: null, refreshToken: null });
  },
}));
