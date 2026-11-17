/**
 * Runs only the nav-perf scenario against servers that are ALREADY running (emulators + dev server on the QA ports).
 *   node tests/e2e-qa/bench.mjs            # NAV_PERF_CPU=4 NAV_PERF_PASSES=3 to tune
 * Same fail-closed browser as the full suite (non-local requests blocked). Used to iterate quickly on navigation work.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const core = await import(pathToFileURL(path.join(here, "lib", "core.mjs")).href);
await import(pathToFileURL(path.join(here, "suites", "nav-perf.mjs")).href);
await core.runAll("nav-perf");
process.exit(Object.values(core.results).every((r) => r.verdict === "pass") ? 0 : 1);
