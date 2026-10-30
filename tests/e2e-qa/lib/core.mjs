/** Scenario registry and runner: each scenario gets a fresh browser + freshly reset fixtures. */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RESULTS_DIR, shot, start } from "./harness.mjs";

const queue = [];
export const results = {};

const IGNORED_CONSOLE = /Select is changing|status of 400|React DevTools|Download the React/;

/** Registers a scenario. `body({ page, logs }, check, notes)` may return a timeline object. */
export function scenario(id, name, body, opts) {
  queue.push({ id, name, body, opts });
}

/** Retired scenario: it drives UI that is no longer routed. Kept (not run) so its history stays readable; see the note at the call site. */
export function retiredScenario() {}

async function runOne({ id, name, body, opts = {} }) {
  const checks = [];
  const notes = [];
  let ctx;
  let ms;
  const t0 = Date.now();
  const check = (description, ok, observed) => checks.push({ d: description, ok: !!ok, obs: observed === undefined ? "" : String(observed) });
  /**
   * A KNOWN, documented finding (not a harness failure): the check states the EXPECTED behaviour. If it holds it is a
   * normal pass; if it doesn't, the observed behaviour is recorded as a finding with its id and the run does not fail,
   * so a documented defect stays visible in every run instead of being hidden or blocking unrelated results.
   */
  check.finding = (id, description, expectedOk, observed) =>
    checks.push({ d: `[${id}] ${description}`, ok: true, finding: expectedOk ? null : id, obs: observed === undefined ? "" : String(observed) });
  try {
    ctx = await start({ viewport: { width: 1920, height: 1080 }, ...opts });
    ms = await body(ctx, check, notes);
  } catch (e) {
    check("scenario ran without harness error", false, String(e).split("\n").slice(0, 3).join(" / "));
    if (ctx) await shot(ctx.page, `${id}-error`).catch(() => {});
  }
  const errs = ctx ? ctx.logs.filter((l) => !IGNORED_CONSOLE.test(l)) : [];
  if (errs.length > 0) notes.push(`console: ${errs.slice(0, 3).join(" || ")}`);
  results[id] = { name, verdict: checks.length > 0 && checks.every((c) => c.ok) ? "pass" : "fail", checks, notes, ms, secs: Math.round((Date.now() - t0) / 1000) };
  console.log(`\n== ${id} ${results[id].verdict.toUpperCase()}  ${ms ? JSON.stringify(ms) : ""}`);
  for (const c of checks) console.log(`  ${c.finding ? "FINDING" : c.ok ? "ok " : "BAD"} ${c.d}${c.obs ? `  -> ${c.obs}` : ""}`);
  for (const n of notes) console.log(`  note: ${n}`);
  if (ctx) await ctx.browser.close();
}

/** Runs every registered scenario whose id starts with `filter` (all when empty), then writes results.json. */
export async function runAll(filter = "") {
  const selected = queue.filter((s) => !filter || filter === "all" || s.id.startsWith(filter));
  if (selected.length === 0) throw new Error(`No scenario matches "${filter}". Known: ${queue.map((s) => s.id).join(", ")}`);
  for (const s of selected) await runOne(s);
  writeResults();
  return selected.length;
}

/** Writes everything recorded so far (called again after the safety checks, which run outside the registry). */
export function writeResults() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(path.join(RESULTS_DIR, "results.json"), JSON.stringify(results, null, 1));
}

export function registeredIds() {
  return queue.map((s) => s.id);
}
