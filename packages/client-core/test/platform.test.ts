import { afterEach, describe, expect, it } from "vitest";
import { configureClientCore, getClientCoreConfig, resetClientCoreConfigForTests, wsUrlFrom, type KeyValueStore } from "../src/platform.js";

function makeStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    async getItemAsync(key) {
      return map.get(key) ?? null;
    },
    async setItemAsync(key, value) {
      map.set(key, value);
    },
    async deleteItemAsync(key) {
      map.delete(key);
    },
  };
}

afterEach(() => {
  resetClientCoreConfigForTests();
});

describe("client-core config guard (platform.ts)", () => {
  it("throws a clear error if getClientCoreConfig() is called before configureClientCore()", () => {
    expect(() => getClientCoreConfig()).toThrow(/configureClientCore\(\) must be called once/);
  });

  it("returns the exact config object passed to configureClientCore()", async () => {
    const keyValueStore = makeStore();
    const getBackendUrl = async () => "https://backend.example.com";
    configureClientCore({ keyValueStore, getBackendUrl });

    const cfg = getClientCoreConfig();
    expect(cfg.keyValueStore).toBe(keyValueStore);
    expect(await cfg.getBackendUrl()).toBe("https://backend.example.com");
  });

  it("resetClientCoreConfigForTests() clears the config so the next call throws again", () => {
    configureClientCore({ keyValueStore: makeStore(), getBackendUrl: async () => "https://x.example.com" });
    expect(() => getClientCoreConfig()).not.toThrow();

    resetClientCoreConfigForTests();
    expect(() => getClientCoreConfig()).toThrow();
  });
});

describe("wsUrlFrom", () => {
  it("rewrites http(s) to ws(s), preserving host/port/path", () => {
    expect(wsUrlFrom("http://10.0.2.2:8080")).toBe("ws://10.0.2.2:8080");
    expect(wsUrlFrom("https://backend.example.com/api")).toBe("wss://backend.example.com/api");
  });
});
