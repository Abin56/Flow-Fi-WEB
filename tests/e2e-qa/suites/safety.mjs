/** Fail-closed checks for the QA tooling itself. Local emulator only — see tests/e2e-qa/README.md. */
import { results } from "../lib/core.mjs";
import { BASE_URL, PORTS } from "../lib/env.mjs";
import * as h from "../lib/harness.mjs";

/** These two don't need fixtures or a signed-in user, so they run with their own browser, outside `scenario()`. */
export async function runSafetyChecks() {
  const ids = [];

  // 1) With every emulator request failing, the portal must expose nothing but the failed checks.
  {
    const checks = [];
    const check = (d, ok, obs) => checks.push({ d, ok: !!ok, obs: obs === undefined ? "" : String(obs) });
    const { browser, ctx, page } = await h.launch({ viewport: { width: 1366, height: 768 } });
    await ctx.route(new RegExp(`127\\.0\\.0\\.1:(${PORTS.firestore}|${PORTS.auth})/`), (r) => r.abort("connectionrefused"));
    await page.goto(`${BASE_URL}/dev/qa`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="qa-blocked"], [data-testid="qa-portal"]', { timeout: 60000 });
    check("portal is blocked when the emulators can't be verified", (await page.locator('[data-testid="qa-blocked"]').count()) === 1);
    check("no sign-in / initialize / reset controls are rendered while blocked", (await page.locator('[data-testid="qa-signin"], [data-testid="qa-seed"], [data-testid="qa-reset"]').count()) === 0);
    const txt = await page.locator('[data-testid="qa-blocked"]').innerText().catch(() => "");
    check("the failure list names the unreachable emulators", /Firestore emulator reachable/.test(txt) && /Auth emulator reachable/.test(txt));
    await h.shot(page, "safety-guard-blocked");
    await browser.close();
    results["safety-guard-blocks"] = { name: "Safety: portal fails closed when the emulators can't be verified", verdict: checks.every((c) => c.ok) ? "pass" : "fail", checks, notes: [], secs: 0 };
    ids.push("safety-guard-blocks");
  }

  // 2) The browser may only talk to localhost: a Firebase/Google request is aborted and recorded.
  {
    const checks = [];
    const check = (d, ok, obs) => checks.push({ d, ok: !!ok, obs: obs === undefined ? "" : String(obs) });
    const { browser, page } = await h.launch();
    await page.goto(`${BASE_URL}/dev/qa`, { waitUntil: "domcontentloaded" });
    const before = h.egressViolations.length;
    const outcome = await page.evaluate(() => fetch("https://firestore.googleapis.com/v1/projects/example/databases/(default)/documents", { mode: "no-cors" }).then(() => "reached", () => "blocked"));
    check("a request to firestore.googleapis.com is blocked in the browser", outcome === "blocked", outcome);
    check("…and recorded as an egress violation", h.egressViolations.length === before + 1, h.egressViolations.at(-1));
    h.egressViolations.length = 0; // this probe was deliberate — only unexpected violations should fail the run
    await browser.close();
    results["safety-egress-blocked"] = { name: "Safety: non-local network requests are blocked and recorded", verdict: checks.every((c) => c.ok) ? "pass" : "fail", checks, notes: [], secs: 0 };
    ids.push("safety-egress-blocked");
  }

  for (const id of ids) {
    const r = results[id];
    console.log(`\n== ${id} ${r.verdict.toUpperCase()}`);
    for (const c of r.checks) console.log(`  ${c.ok ? "ok " : "BAD"} ${c.d}${c.obs ? `  -> ${c.obs}` : ""}`);
  }
}
