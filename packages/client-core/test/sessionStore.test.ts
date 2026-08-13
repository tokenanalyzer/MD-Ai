import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureClientCore, resetClientCoreConfigForTests, type KeyValueStore } from "../src/platform.js";
import { useSessionStore } from "../src/state/sessionStore.js";

function makeStore(): { store: KeyValueStore; map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    store: {
      async getItemAsync(key) {
        return map.get(key) ?? null;
      },
      async setItemAsync(key, value) {
        map.set(key, value);
      },
      async deleteItemAsync(key) {
        map.delete(key);
      },
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let map: Map<string, string>;

beforeEach(() => {
  const kv = makeStore();
  map = kv.map;
  configureClientCore({ keyValueStore: kv.store, getBackendUrl: async () => "https://backend.example.com" });
  useSessionStore.setState({ accessToken: null, refreshToken: null, hydrated: false });
});

afterEach(() => {
  resetClientCoreConfigForTests();
  vi.unstubAllGlobals();
});

describe("useSessionStore — device session persisted via the host app's KeyValueStore", () => {
  it("hydrate() loads persisted tokens from the KeyValueStore into state", async () => {
    map.set("mdai.session.accessToken", "persisted-at");
    map.set("mdai.session.refreshToken", "persisted-rt");

    await useSessionStore.getState().hydrate();

    expect(useSessionStore.getState()).toMatchObject({ accessToken: "persisted-at", refreshToken: "persisted-rt", hydrated: true });
  });

  it("pair() calls the real pairing endpoint, persists both tokens, and defaults platform to 'android'", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { platform: string };
      expect(body.platform).toBe("android");
      return jsonResponse(200, { data: { accessToken: "new-at", refreshToken: "new-rt", expiresIn: 900 } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await useSessionStore.getState().pair("PAIRCODE", "My Phone");

    expect(useSessionStore.getState()).toMatchObject({ accessToken: "new-at", refreshToken: "new-rt" });
    expect(map.get("mdai.session.accessToken")).toBe("new-at");
    expect(map.get("mdai.session.refreshToken")).toBe("new-rt");
  });

  it("signOut() clears both persisted tokens and in-memory state", async () => {
    useSessionStore.setState({ accessToken: "at", refreshToken: "rt", hydrated: true });
    map.set("mdai.session.accessToken", "at");
    map.set("mdai.session.refreshToken", "rt");

    await useSessionStore.getState().signOut();

    expect(useSessionStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
    expect(map.has("mdai.session.accessToken")).toBe(false);
    expect(map.has("mdai.session.refreshToken")).toBe(false);
  });

  it("tryRefresh() returns false without calling the network when there is no refresh token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const ok = await useSessionStore.getState().tryRefresh();

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
