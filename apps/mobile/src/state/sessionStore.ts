import { create } from "zustand";
import * as SecureStore from "expo-secure-store";
import { pairDevice, refreshAccessToken, type PairResponse } from "../api/client";

const ACCESS_TOKEN_KEY = "mdai.session.accessToken";
const REFRESH_TOKEN_KEY = "mdai.session.refreshToken";

interface SessionState {
  accessToken: string | null;
  refreshToken: string | null;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  pair: (pairingCode: string, deviceName: string) => Promise<void>;
  tryRefresh: () => Promise<boolean>;
  signOut: () => Promise<void>;
}

async function persistTokens(accessToken: string, refreshToken: string): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(ACCESS_TOKEN_KEY, accessToken),
    SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken),
  ]);
}

/**
 * Device session state. Tokens are stored via the same Keystore-backed
 * SecureStore as provider keys (docs/architecture/07-security-model.md
 * §2) — this is what "local gate" protects, distinct from provider keys
 * which additionally travel to the backend per-request.
 */
export const useSessionStore = create<SessionState>((set, get) => ({
  accessToken: null,
  refreshToken: null,
  hydrated: false,

  hydrate: async () => {
    const [accessToken, refreshToken] = await Promise.all([
      SecureStore.getItemAsync(ACCESS_TOKEN_KEY),
      SecureStore.getItemAsync(REFRESH_TOKEN_KEY),
    ]);
    set({ accessToken, refreshToken, hydrated: true });
  },

  pair: async (pairingCode: string, deviceName: string) => {
    const res: PairResponse = await pairDevice({ pairingCode, deviceName, platform: "android" });
    await persistTokens(res.accessToken, res.refreshToken);
    set({ accessToken: res.accessToken, refreshToken: res.refreshToken });
  },

  tryRefresh: async () => {
    const refreshToken = get().refreshToken;
    if (!refreshToken) return false;
    try {
      const res = await refreshAccessToken(refreshToken);
      await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, res.accessToken);
      set({ accessToken: res.accessToken });
      return true;
    } catch {
      // Refresh token itself is invalid/revoked — the device needs to re-pair.
      await get().signOut();
      return false;
    }
  },

  signOut: async () => {
    await Promise.all([SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY), SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY)]);
    set({ accessToken: null, refreshToken: null });
  },
}));
