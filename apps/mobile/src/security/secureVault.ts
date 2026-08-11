import * as SecureStore from "expo-secure-store";

/**
 * The authoritative provider-key store (docs/architecture/07-security-model.md
 * §3). `expo-secure-store` is backed by the Android Keystore — this is the
 * one and only place a provider API key persists. The backend never gets a
 * durable copy; keys are read from here and attached to individual
 * requests at call time (see src/api/client.ts, src/realtime/chatSocket.ts).
 */

const KEY_PREFIX = "mdai.provider.";
const INDEX_KEY = "mdai.provider.index";

function keyStorageId(providerId: string): string {
  return `${KEY_PREFIX}${providerId}`;
}

async function readIndex(): Promise<string[]> {
  const raw = await SecureStore.getItemAsync(INDEX_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

async function writeIndex(providerIds: string[]): Promise<void> {
  await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(providerIds));
}

export async function setProviderKey(providerId: string, apiKey: string): Promise<void> {
  await SecureStore.setItemAsync(keyStorageId(providerId), apiKey);
  const index = await readIndex();
  if (!index.includes(providerId)) {
    await writeIndex([...index, providerId]);
  }
}

export async function getProviderKey(providerId: string): Promise<string | null> {
  return SecureStore.getItemAsync(keyStorageId(providerId));
}

export async function deleteProviderKey(providerId: string): Promise<void> {
  await SecureStore.deleteItemAsync(keyStorageId(providerId));
  const index = await readIndex();
  await writeIndex(index.filter((id) => id !== providerId));
}

export async function listConfiguredProviderIds(): Promise<string[]> {
  return readIndex();
}

export function last4(apiKey: string): string {
  return apiKey.length >= 4 ? apiKey.slice(-4) : apiKey;
}

/**
 * Builds the `providerKeys` map a chat request needs, reading every
 * currently-configured key from the Keystore-backed vault. This is the
 * only place raw key values leave the vault module — callers pass the
 * resulting object straight into the API/WS layer for one request and let
 * it go out of scope immediately after (docs/architecture/
 * 07-security-model.md §3.2 applies symmetrically on the client).
 */
export async function buildProviderKeysForRequest(): Promise<Record<string, string>> {
  const ids = await listConfiguredProviderIds();
  const entries = await Promise.all(
    ids.map(async (id) => [id, await getProviderKey(id)] as const),
  );
  const result: Record<string, string> = {};
  for (const [id, key] of entries) {
    if (key) result[id] = key;
  }
  return result;
}
