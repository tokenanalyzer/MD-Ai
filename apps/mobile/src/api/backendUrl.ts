import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";

const OVERRIDE_KEY = "mdai.backendUrl";

function defaultBackendUrl(): string {
  const fromConfig = Constants.expoConfig?.extra?.["mdaiBackendUrl"];
  return typeof fromConfig === "string" ? fromConfig : "http://10.0.2.2:8080";
}

let cached: string | undefined;

/** The owner's own Oracle Cloud backend URL — user-configurable from Settings, not hardcoded for a real deployment. */
export async function getBackendUrl(): Promise<string> {
  if (cached) return cached;
  const stored = await SecureStore.getItemAsync(OVERRIDE_KEY);
  cached = stored ?? defaultBackendUrl();
  return cached;
}

export async function setBackendUrl(url: string): Promise<void> {
  await SecureStore.setItemAsync(OVERRIDE_KEY, url);
  cached = url;
}

export function wsUrlFrom(httpUrl: string): string {
  return httpUrl.replace(/^http/, "ws");
}
