import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setupEnv.ts"],
    hookTimeout: 20000,
    testTimeout: 20000,
    fileParallelism: false,
  },
});
