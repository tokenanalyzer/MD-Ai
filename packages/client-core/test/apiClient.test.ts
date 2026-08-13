import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureClientCore, resetClientCoreConfigForTests, type KeyValueStore } from "../src/platform.js";
import { useSessionStore } from "../src/state/sessionStore.js";
import { ApiError, listAgents, pairDevice } from "../src/api/client.js";

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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  configureClientCore({ keyValueStore: makeStore(), getBackendUrl: async () => "https://backend.example.com" });
  useSessionStore.setState({ accessToken: null, refreshToken: null, hydrated: true });
});

afterEach(() => {
  resetClientCoreConfigForTests();
  vi.unstubAllGlobals();
});

describe("api/client.ts request plumbing", () => {
  it("pairDevice() calls POST /auth/pair without an Authorization header (unauthenticated route)", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://backend.example.com/auth/pair");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["authorization"]).toBeUndefined();
      return jsonResponse(200, { data: { accessToken: "at", refreshToken: "rt", expiresIn: 900 } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await pairDevice({ pairingCode: "ABCD1234", deviceName: "test-device", platform: "android" });
    expect(res).toEqual({ accessToken: "at", refreshToken: "rt", expiresIn: 900 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("attaches a Bearer Authorization header on an authenticated call when a session token is set", async () => {
    useSessionStore.setState({ accessToken: "my-access-token", refreshToken: "my-refresh-token", hydrated: true });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer my-access-token");
      return jsonResponse(200, { data: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await listAgents();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws a typed ApiError with the server's code/message/retryable on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(404, { error: { code: "not_found", message: "Agent not found", retryable: false } })),
    );

    await expect(listAgents()).rejects.toMatchObject(
      new ApiError(404, "not_found", "Agent not found", false),
    );
  });

  it("on a 401, silently retries once via tryRefresh() and succeeds if the refresh works", async () => {
    useSessionStore.setState({ accessToken: "expired-token", refreshToken: "valid-refresh-token", hydrated: true });

    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        call++;
        if (url === "https://backend.example.com/agents" && call === 1) {
          return jsonResponse(401, { error: { code: "unauthorized", message: "expired", retryable: false } });
        }
        if (url === "https://backend.example.com/auth/refresh") {
          return jsonResponse(200, { data: { accessToken: "fresh-access-token", expiresIn: 900 } });
        }
        // Second /agents call, now with the refreshed token.
        return jsonResponse(200, { data: [{ id: "master" }] });
      }),
    );

    const result = await listAgents();
    expect(result).toEqual([{ id: "master" }]);
    expect(useSessionStore.getState().accessToken).toBe("fresh-access-token");
  });

  it("on a 401 where refresh also fails, signs the session out and propagates the original error", async () => {
    useSessionStore.setState({ accessToken: "expired-token", refreshToken: "revoked-refresh-token", hydrated: true });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "https://backend.example.com/auth/refresh") {
          return jsonResponse(401, { error: { code: "unauthorized", message: "revoked", retryable: false } });
        }
        return jsonResponse(401, { error: { code: "unauthorized", message: "expired", retryable: false } });
      }),
    );

    await expect(listAgents()).rejects.toThrow(ApiError);
    expect(useSessionStore.getState().accessToken).toBeNull();
    expect(useSessionStore.getState().refreshToken).toBeNull();
  });
});
