import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 15000,
    // All suites here share ONE external Firestore Emulator instance
    // (FIRESTORE_EMULATOR_HOST). Running test files in parallel let two
    // files' cleanup logic race against each other's in-flight data under
    // shared collection paths (found via the Milestone 1 freeze: a
    // genuinely flaky test traced to rate-limit.test.ts's afterEach
    // wiping the entire "statementPassword" rate-limit namespace mid-run
    // of decrypt-document.test.ts, which uses the same namespace). Forcing
    // sequential file execution removes the whole class of cross-file
    // emulator races, not just this one instance of it.
    fileParallelism: false,
  },
});
