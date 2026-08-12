import * as SecureStore from "expo-secure-store";

/**
 * M6.9 web preview: `expo-secure-store` has no web implementation (there's
 * no Android Keystore in a browser) and throws if called there. Every
 * module that persists something via SecureStore (provider keys —
 * security/secureVault.ts, session tokens — state/sessionStore.ts, the
 * backend-URL override — api/backendUrl.ts) imports this instead, so
 * `expo start --web` doesn't crash on startup. On web this falls back to
 * `localStorage` — explicitly NOT secure storage, UI-preview-only. The
 * real Android app gets the genuine Keystore-backed SecureStore; the
 * security boundary documented in docs/architecture/07-security-model.md
 * §3 only applies there.
 *
 * Deliberately not importing `Platform` from "react-native" here: that
 * package ships Flow-typed source that this repo's plain-Node vitest
 * suite (test/secureVault.test.ts, test/backendUrl.test.ts — see
 * vitest.config.ts's "no RN runtime" comment) can't parse. `document`
 * is a reliable, dependency-free web signal instead — present in every
 * browser (including react-native-web/Expo web), absent in both React
 * Native (no DOM) and this Node test environment, which is exactly the
 * three environments that need to be told apart here.
 */
const isWeb = typeof document !== "undefined";
export interface KeyValueStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

const webFallbackStore: KeyValueStore = {
  async getItemAsync(key) {
    return globalThis.localStorage?.getItem(key) ?? null;
  },
  async setItemAsync(key, value) {
    globalThis.localStorage?.setItem(key, value);
  },
  async deleteItemAsync(key) {
    globalThis.localStorage?.removeItem(key);
  },
};

export const secureStoreCompat: KeyValueStore = isWeb ? webFallbackStore : SecureStore;
