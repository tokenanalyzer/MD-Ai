import { defineConfig } from "vitest/config";

/**
 * M11: this package shipped in M10 with zero test coverage of its own —
 * its 9 state stores, API client, and realtime sockets were only
 * exercised indirectly through the Expo app's re-export shims. Covers
 * pure logic against an in-memory mock `KeyValueStore` and a mocked
 * `fetch`, same "no real native runtime" posture as apps/mobile's own
 * vitest config.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
