/**
 * M10 PC-client foundation: the one seam every framework-agnostic module
 * in this package crosses to reach something platform-specific (secure
 * key/value storage, resolving the backend URL). A host app — the
 * existing Expo/Android app, or a future Electron/Tauri/Next.js PC
 * client — calls `configureClientCore()` once at startup with its own
 * real implementations before using anything else here; nothing in this
 * package imports `expo-*`, `react-native`, or any DOM/Node API directly.
 *
 * `apps/mobile` wires this to `secureStoreCompat` (SecureStore-backed,
 * see `docs/architecture/07-security-model.md` §3) and its existing
 * `api/backendUrl.ts` (EXPO_PUBLIC_MDAI_BACKEND_URL / app.json /
 * SecureStore override) — neither of those Expo-specific modules moved
 * here, since a PC client's real equivalents (OS keychain, a config
 * file) look nothing like them; only the *shape* they implement is
 * shared.
 */
export interface KeyValueStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export interface ClientCoreConfig {
  keyValueStore: KeyValueStore;
  /** Resolves the backend base URL (e.g. "https://my-oracle-box.example.com") — no trailing slash. */
  getBackendUrl: () => Promise<string>;
}

let config: ClientCoreConfig | undefined;

export function configureClientCore(cfg: ClientCoreConfig): void {
  config = cfg;
}

/** Test-only: clears the cached config so a test can reconfigure with a fresh mock. */
export function resetClientCoreConfigForTests(): void {
  config = undefined;
}

export function getClientCoreConfig(): ClientCoreConfig {
  if (!config) {
    throw new Error(
      "@mdai/client-core: configureClientCore() must be called once at app startup before any store or API call — see platform.ts.",
    );
  }
  return config;
}

export function wsUrlFrom(httpUrl: string): string {
  return httpUrl.replace(/^http/, "ws");
}
