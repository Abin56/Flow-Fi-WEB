import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
    },
  },
  test: {
    environment: "node",
    globals: false,
    // functions/tests, tests/rules, and tests/integration all require a live
    // Firestore/Storage emulator and are run separately via `test:functions`
    // / `test:rules` / `test:integration`. A positional path filter
    // (`vitest run tests/rules`) does NOT override `exclude` in vitest — it
    // only narrows within the non-excluded set — so each directory is
    // conditionally excluded based on its own env var, set by the matching
    // npm script before invoking vitest directly against this same config.
    exclude: [
      "**/node_modules/**",
      "functions/**",
      ...(process.env.VITEST_RULES ? [] : ["tests/rules/**"]),
      ...(process.env.VITEST_INTEGRATION ? [] : ["tests/integration/**"]),
    ],
  },
});
