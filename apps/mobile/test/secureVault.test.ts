import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-in for the Android Keystore-backed native store — real
// device behavior is documented as unverified in
// docs/architecture/10-android-setup.md §1.
const store = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key);
  }),
}));

const {
  setProviderKey,
  getProviderKey,
  deleteProviderKey,
  listConfiguredProviderIds,
  buildProviderKeysForRequest,
  last4,
} = await import("../src/security/secureVault");

beforeEach(() => {
  store.clear();
});

describe("secureVault", () => {
  it("round-trips a key through the (mocked) Keystore-backed store", async () => {
    await setProviderKey("nvidia-nemotron", "nvapi-abc123");
    expect(await getProviderKey("nvidia-nemotron")).toBe("nvapi-abc123");
  });

  it("returns null for a provider with no stored key", async () => {
    expect(await getProviderKey("groq")).toBeNull();
  });

  it("maintains an index of configured providers without duplicates", async () => {
    await setProviderKey("groq", "gsk-1");
    await setProviderKey("groq", "gsk-2"); // overwrite, not a second entry
    await setProviderKey("gemini", "g-1");
    const ids = await listConfiguredProviderIds();
    expect(ids.sort()).toEqual(["gemini", "groq"]);
  });

  it("removes both the key and the index entry on delete", async () => {
    await setProviderKey("groq", "gsk-1");
    await deleteProviderKey("groq");
    expect(await getProviderKey("groq")).toBeNull();
    expect(await listConfiguredProviderIds()).not.toContain("groq");
  });

  it("deleting a never-configured provider is a harmless no-op", async () => {
    await expect(deleteProviderKey("openrouter")).resolves.toBeUndefined();
  });

  it("builds the full providerKeys map for a chat request from every configured key", async () => {
    await setProviderKey("groq", "gsk-1");
    await setProviderKey("nvidia-nemotron", "nvapi-1");
    const keys = await buildProviderKeysForRequest();
    expect(keys).toEqual({ groq: "gsk-1", "nvidia-nemotron": "nvapi-1" });
  });

  it("builds an empty map when nothing is configured", async () => {
    expect(await buildProviderKeysForRequest()).toEqual({});
  });

  it("last4 returns the trailing 4 characters", () => {
    expect(last4("nvapi-abcdef1234567890")).toBe("7890");
    expect(last4("ab")).toBe("ab"); // too short to slice meaningfully — returned as-is
  });
});
