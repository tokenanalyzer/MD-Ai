import { defineConfig } from "vitest/config";

/**
 * Covers pure logic only (docs/architecture/10-android-setup.md §1) — the
 * secure vault wrapper and backend-URL resolution — not anything that
 * needs a real React Native runtime or Android Keystore. `expo-secure-store`
 * is mocked in each test file with an in-memory Map standing in for the
 * Keystore-backed native store, so this verifies the *logic* (index
 * bookkeeping, last-4 computation, request-scoped key assembly), not that
 * the real native module behaves the same way — that gap is exactly what
 * `docs/architecture/10-android-setup.md` documents as unverified.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
