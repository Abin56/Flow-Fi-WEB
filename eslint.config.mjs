import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Firestore converters and similar callback interfaces require
    // positional params (e.g. fromFirestore(snapshot, options)) even when
    // unused; underscore-prefixing is the codebase's existing convention
    // for marking them intentionally unused.
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // functions/ is a separate package (docs/adr/ADR-001) with its own
    // tsconfig; functions/lib/ is tsc's compiled JS build output
    // (functions/package.json's "build" script), not hand-written source
    // — same category as .next/out/build above. functions/src and
    // functions/tests are still linted here; only the generated output is
    // excluded.
    "functions/lib/**",
  ]),
]);

export default eslintConfig;
