# ADR-005: Defer Node16/NodeNext TypeScript module migration, suppress node10 deprecation for now

**Status:** Accepted
**Date:** 2026-08-03
**Backlog task:** none — discovered as an editor/tooling diagnostic, not a backlog task
**Architecture section(s) affected:** none

## Context

`functions/tsconfig.json` uses `"module": "commonjs"` with `"moduleResolution": "node"` (the legacy "node10" resolution algorithm). TypeScript 5.9's language service (as surfaced by VS Code) flags this combination:

> Option 'moduleResolution=node10' is deprecated and will stop functioning in TypeScript 7.0.

Two config-only fixes were evaluated and both are blocked by TypeScript's own compiler rules, not by a missing flag:

- **`moduleResolution: "bundler"`** — rejected outright by `tsc` (`TS5095`): bundler resolution is only legal when `module` is `"preserve"` or `"es2015"`+ (an ESM-family setting). It cannot be combined with `module: "commonjs"`, which this package requires (Firebase Functions Gen 2 on Node 20 loads `lib/index.js` as CommonJS; `functions/package.json` has no `"type": "module"`).
- **`moduleResolution: "node16"`/`"nodenext"`** — the actually-current, non-deprecated resolution mode. But TypeScript requires `module` to match (`TS5110`), and Node16/NodeNext module mode requires every relative import to carry an explicit file extension (`.js`, resolved against the `.ts` source). All current relative imports across `functions/src/**` and `functions/tests/**` are extensionless (e.g. `"../pdf/pdf-document-provider"`). Migrating is a real, repo-wide, mechanical refactor — not a tsconfig edit — plus adding an explicit `"type": "commonjs"` to `functions/package.json` to pin per-file module format under Node16 semantics.

There is also a second-order mismatch: the TypeScript CLI installed in `functions/node_modules` (5.9.3, the source of truth for `build`/`typecheck`/CI) and VS Code's bundled TS server disagree on the accepted string value for the suppression flag itself — the CLI accepts `"ignoreDeprecations": "5.0"`, VS Code's server asks for `"6.0"`. Only one value can be set at a time, so one of the two surfaces will always show a diagnostic until they're on the same TypeScript version.

Given the project is mid-milestone on Statement Intelligence / PDF parsing, a repository-wide import-extension refactor was judged out of scope and unnecessary risk for a cosmetic editor warning.

## Decision

Keep `"module": "commonjs"` and `"moduleResolution": "node"`, and suppress the deprecation notice with `"ignoreDeprecations": "5.0"` — the value accepted by the CLI TypeScript (5.9.3), which is the actual source of truth for `npm run build`, `npm run typecheck`, and `vitest`. VS Code's TS server (bundled version, distinct from `node_modules`) will continue to show this as a red diagnostic on `tsconfig.json` line 5; that is accepted as cosmetic noise, not a real build/CI failure, and should not be worked around by chasing whichever value VS Code currently wants.

No import paths, module settings, or `package.json` fields were changed. `tsc -p tsconfig.test.json --noEmit`, `tsc` (build), and `vitest run` (141 tests, 14 files) all pass as of this decision.

## Consequences

- The project remains on the deprecated "node10" resolution algorithm. Per Microsoft's own deprecation notice, this will stop working in TypeScript 7.0 — this ADR's suppression is time-bounded by that, not indefinite.
- VS Code will keep showing a diagnostic on `functions/tsconfig.json` until either VS Code's bundled TS server version and the project's installed TypeScript version converge, or the Node16/NodeNext migration (below) happens.
- Everything else about the architecture and build pipeline is unchanged: `module: "commonjs"` output, Firebase Functions Gen 2 Node 20 runtime compatibility, and Vitest configuration all continue to work exactly as before.

## Conditions for revisiting (dedicated maintenance milestone)

Perform the full Node16/NodeNext migration as its own scoped milestone, **after** the PDF Statement Parsing / Statement Intelligence work reaches production-readiness, when any of the following becomes true:
- TypeScript 7.0 ships and removes node10 resolution entirely (hard deadline).
- A dependency or Firebase Functions tooling upgrade requires ESM output or NodeNext module resolution directly.
- The team has bandwidth for a dedicated PR that: adds `.js` extensions to every relative import in `functions/src/**` and `functions/tests/**`; sets `"module": "node16"` and `"moduleResolution": "node16"` in both `tsconfig.json` and `tsconfig.test.json`; adds `"type": "commonjs"` to `functions/package.json` to pin per-file module format explicitly; and re-runs the full build/typecheck/test suite to confirm no regressions.

## Alternatives considered

- **`moduleResolution: "bundler"`.** Rejected — hard compiler error (`TS5095`) when combined with the required `module: "commonjs"`; not a workaround-around-able limitation.
- **Full Node16/NodeNext migration now.** Rejected for this moment — correct long-term fix, but a genuine repo-wide refactor (import extensions + package.json module type) carries unnecessary risk while the PDF parser/Statement Intelligence milestone is active. Deferred, not abandoned; see conditions above.
- **Set `ignoreDeprecations` to whatever value silences VS Code's current warning (`"6.0"`).** Rejected — that value is invalid for the CLI TypeScript actually used by build/CI (`TS5103`), so it would trade a cosmetic editor warning for a real build failure. The CLI is the source of truth; VS Code's diagnostic is accepted as-is.
