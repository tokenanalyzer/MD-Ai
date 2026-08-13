// Minimal, monorepo-wide flat config (ESLint 9+/10 format). Recommended
// TypeScript rules only — no stylistic/formatting rules (prettier already
// owns formatting via `pnpm format`) — so `pnpm lint` catches real
// correctness issues (unused vars, floating promises, etc.) without
// re-litigating style.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.expo/**",
      "**/android/**",
      "**/ios/**",
      "**/web-build/**",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Agent/task input payloads, tool results, and event payloads are
      // legitimately typed as Record<string, unknown> throughout this
      // codebase (docs/architecture/05-event-schemas.md) — the no-explicit-any
      // ban is not part of "recommended" here, only unused-vars/no-empty etc.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // Root-level CJS tool configs (babel/metro/etc.) — `module`/`require` are
    // real Node CommonJS globals here, not undeclared variables.
    files: ["**/babel.config.js", "**/metro.config.js", "**/jest.config.js"],
    languageOptions: { globals: globals.node, sourceType: "commonjs" },
  },
  {
    // React Native/Expo screens and hooks (apps/mobile) — enforces the
    // exhaustive-deps rule several files already carry disable comments
    // for, which previously errored with "rule not found" since the plugin
    // was never actually wired in.
    files: ["apps/mobile/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // docs/architecture/07-security-model.md §4: the backend logs
    // exclusively through pino (structured, redaction-aware) — never
    // console.* — so a secret can't slip out through an ad-hoc debug log.
    // Scoped to src/, not test/, where console output is legitimate
    // (perf/latency reporting to stdout).
    files: ["services/backend/src/**/*.ts"],
    rules: { "no-console": "error" },
  },
);
