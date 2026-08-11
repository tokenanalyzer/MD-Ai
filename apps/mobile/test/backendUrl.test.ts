import { afterEach, describe, expect, it, vi } from "vitest";

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

vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: { mdaiBackendUrl: "http://10.0.2.2:8080" } } },
}));

afterEach(() => {
  store.clear();
  vi.resetModules();
});

describe("backendUrl", () => {
  it("defaults to the emulator alias from app.json's extra config", async () => {
    const { getBackendUrl } = await import("../src/api/backendUrl");
    expect(await getBackendUrl()).toBe("http://10.0.2.2:8080");
  });

  it("persists an override via setBackendUrl and returns it thereafter", async () => {
    const { getBackendUrl, setBackendUrl } = await import("../src/api/backendUrl");
    await setBackendUrl("https://my-oracle-box.example.com");
    expect(await getBackendUrl()).toBe("https://my-oracle-box.example.com");
  });

  it("converts http(s) to ws(s) for the WebSocket gateway", async () => {
    const { wsUrlFrom } = await import("../src/api/backendUrl");
    expect(wsUrlFrom("http://10.0.2.2:8080")).toBe("ws://10.0.2.2:8080");
    expect(wsUrlFrom("https://my-box.example.com")).toBe("wss://my-box.example.com");
  });
});
