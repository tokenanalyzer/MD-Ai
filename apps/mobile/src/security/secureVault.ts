import { secureStoreCompat as store } from "../platform/secureStoreCompat";

/**
 * The authoritative provider-key store (docs/architecture/07-security-model.md
 * §3). Backed by the Android Keystore on the real app (see
 * platform/secureStoreCompat.ts for the web-preview fallback) — this is
 * the one and only place a provider API key persists. The backend never
 * gets a durable copy; keys are read from here and attached to individual
 * requests at call time (see src/api/client.ts, src/realtime/chatSocket.ts).
 */

const KEY_PREFIX = "mdai.provider.";
const INDEX_KEY = "mdai.provider.index";

function keyStorageId(providerId: string): string {
  return `${KEY_PREFIX}${providerId}`;
}

async function readIndex(): Promise<string[]> {
  const raw = await store.getItemAsync(INDEX_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

async function writeIndex(providerIds: string[]): Promise<void> {
  await store.setItemAsync(INDEX_KEY, JSON.stringify(providerIds));
}

export async function setProviderKey(providerId: string, apiKey: string): Promise<void> {
  await store.setItemAsync(keyStorageId(providerId), apiKey);
  const index = await readIndex();
  if (!index.includes(providerId)) {
    await writeIndex([...index, providerId]);
  }
}

export async function getProviderKey(providerId: string): Promise<string | null> {
  return store.getItemAsync(keyStorageId(providerId));
}

export async function deleteProviderKey(providerId: string): Promise<void> {
  await store.deleteItemAsync(keyStorageId(providerId));
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

/**
 * Same vault, same on-device-only guarantee, separate index/prefix — a
 * search-provider key (Brave/Tavily) is a `toolKeys` credential, never a
 * `providerKeys` one (see schemas.ts on the backend), so it can't share
 * `mdai.provider.index` with LLM provider keys without a request builder
 * having to guess which ids belong in which map.
 */
const SEARCH_KEY_PREFIX = "mdai.searchprovider.";
const SEARCH_INDEX_KEY = "mdai.searchprovider.index";

function searchKeyStorageId(providerId: string): string {
  return `${SEARCH_KEY_PREFIX}${providerId}`;
}

async function readSearchIndex(): Promise<string[]> {
  const raw = await store.getItemAsync(SEARCH_INDEX_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

async function writeSearchIndex(providerIds: string[]): Promise<void> {
  await store.setItemAsync(SEARCH_INDEX_KEY, JSON.stringify(providerIds));
}

export async function setSearchProviderKey(providerId: string, apiKey: string): Promise<void> {
  await store.setItemAsync(searchKeyStorageId(providerId), apiKey);
  const index = await readSearchIndex();
  if (!index.includes(providerId)) {
    await writeSearchIndex([...index, providerId]);
  }
}

export async function getSearchProviderKey(providerId: string): Promise<string | null> {
  return store.getItemAsync(searchKeyStorageId(providerId));
}

export async function deleteSearchProviderKey(providerId: string): Promise<void> {
  await store.deleteItemAsync(searchKeyStorageId(providerId));
  const index = await readSearchIndex();
  await writeSearchIndex(index.filter((id) => id !== providerId));
}

export async function listConfiguredSearchProviderIds(): Promise<string[]> {
  return readSearchIndex();
}

/** Builds the `toolKeys` map a chat request needs — the search-provider counterpart to `buildProviderKeysForRequest`. */
export async function buildToolKeysForRequest(): Promise<Record<string, string>> {
  const ids = await listConfiguredSearchProviderIds();
  const entries = await Promise.all(ids.map(async (id) => [id, await getSearchProviderKey(id)] as const));
  const result: Record<string, string> = {};
  for (const [id, key] of entries) {
    if (key) result[id] = key;
  }
  return result;
}
