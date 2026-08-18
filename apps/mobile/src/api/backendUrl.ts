import Constants from "expo-constants";
import { secureStoreCompat as store } from "../platform/secureStoreCompat";

const OVERRIDE_KEY = "mdai.backendUrl";

function defaultBackendUrl(): string {
  // Dev-workflow convenience only (docs/architecture/10-android-setup.md
  // §4): EXPO_PUBLIC_* vars are inlined at bundle time by Expo/Metro, so a
  // developer can point a dev build at their own machine's LAN IP or at
  // Oracle without editing any file — `EXPO_PUBLIC_MDAI_BACKEND_URL=http://192.168.1.50:8080 npx expo start --dev-client`.
  // Not a secret: this is a hostname/port, never a provider API key — the
  // key vault (SecureStore-backed, see src/security/secureVault.ts) is
  // untouched by this.
  const fromEnv = process.env["EXPO_PUBLIC_MDAI_BACKEND_URL"];
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  const fromConfig = Constants.expoConfig?.extra?.["mdaiBackendUrl"];
  return typeof fromConfig === "string" ? fromConfig : "http://10.0.2.2:8080";
}

let cached: string | undefined;

/** The owner's own backend URL — defaults to app.json's extra.mdaiBackendUrl (the owner's real deployment), still user-configurable from Settings for switching to a different backend. */
export async function getBackendUrl(): Promise<string> {
  if (cached) return cached;
  const stored = await store.getItemAsync(OVERRIDE_KEY);
  cached = stored ?? defaultBackendUrl();
  return cached;
}

export async function setBackendUrl(url: string): Promise<void> {
  await store.setItemAsync(OVERRIDE_KEY, url);
  cached = url;
}

export function wsUrlFrom(httpUrl: string): string {
  return httpUrl.replace(/^http/, "ws");
}
