/**
 * Navigation performance benchmark (nav-perf*). Local emulator only — see tests/e2e-qa/README.md.
 *
 * Clicks every real sidebar link (the same <Link> a user clicks) and records, per navigation:
 *   urlMs    click → location.pathname changed
 *   paintMs  click → new page has painted real content (no skeleton / spinner left in <main>) + 2 frames
 *   blockMs  total main-thread blocking (sum of long-task time over 50ms) inside that window
 *   maxTask  longest single task
 *   frames   worst frame gap (ms) – what the user perceives as "stuck"
 *   reqs     network requests to the emulator during the window (Firestore listens / reads)
 *
 * Pass 1 is "cold" (first visit — in `next dev` this includes on-demand route compilation); passes 2–3 are "warm"
 * (the numbers that matter for a real user once the route code is loaded). Set NAV_PERF_CPU=4 for a 4× CPU slowdown.
 * Results are printed and written to tests/e2e-qa/.results/nav-perf.json — no pass/fail threshold except a generous ceiling.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { scenario } from "../lib/core.mjs";
import { FIRESTORE_DOCS, PROJECT_ID } from "../lib/env.mjs";
import * as h from "../lib/harness.mjs";

const ONLY = process.env.NAV_PERF_ROUTES?.split(",");
const ALL_ROUTES = [
  "/dashboard", "/my-money", "/month-cycle", "/transactions", "/accounts", "/credit-cards", "/people", "/bills", "/savings",
  "/loans", "/debt-planner", "/statement-review", "/transaction-candidates", "/smart-capture", "/reports", "/analytics",
  "/activity", "/settings", "/financial-audit", "/balance-control", "/help",
];
const ROUTES = ONLY ?? ALL_ROUTES;
const CPU = Number(process.env.NAV_PERF_CPU ?? "1");
const PASSES = Number(process.env.NAV_PERF_PASSES ?? "3");
/** NAV_PERF_BULK=N adds N synthetic transactions (emulator only) so the benchmark runs against a realistic, not a toy, data set. */
const BULK = Number(process.env.NAV_PERF_BULK ?? "0");

async function addBulkTransactions(n) {
  const accounts = await h.list("accounts");
  const uid = await h.authUid();
  const cats = ["default-expense-bills-utilities", "default-expense-food", "default-expense-transport", "default-expense-shopping", "default-income-salary"];
  const now = Date.now();
  const typed = (v) => (v === null ? { nullValue: null } : v instanceof Date ? { timestampValue: v.toISOString() } : typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { booleanValue: v } : Array.isArray(v) ? { arrayValue: {} } : Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v });
  const root = `projects/${PROJECT_ID}/databases/(default)/documents/users/${uid}`;
  for (let start = 0; start < n; start += 300) {
    const writes = Array.from({ length: Math.min(300, n - start) }, (_, k) => {
      const i = start + k;
      const when = new Date(now - (i % 540) * 86_400_000 - (i % 24) * 3_600_000);
      const income = i % 17 === 0;
      const doc = {
        type: income ? "income" : "expense", amount: 50 + ((i * 37) % 4000), dateTime: when, accountId: accounts[i % accounts.length].id,
        categoryId: cats[i % cats.length], description: `Bulk ${income ? "credit" : "purchase"} ${i}`, notes: "", receiptPurpose: null, transferId: null,
        excludeFromCalculations: false, accountingMonth: null, linkedPersonId: null, owesPersonToggle: false, createdAt: when, transferMatchedAt: null,
        status: "posted", isBusiness: false, source: null, loanId: null, emiId: null, installmentId: null, installmentPaymentId: null, paymentAllocationType: null,
        isPersonLedgerMovement: false, deletedAt: null, lastEditedAt: null, editHistory: [],
      };
      return { update: { name: `${root}/transactions/bulk-${i}`, fields: Object.fromEntries(Object.entries(doc).map(([key, v]) => [key, typed(v)])) } };
    });
    const res = await fetch(`${FIRESTORE_DOCS}:commit`, { method: "POST", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" }, body: JSON.stringify({ writes }) });
    if (!res.ok) throw new Error(`bulk commit failed: ${res.status} ${await res.text()}`);
  }
}

async function installProbe(page) {
  await page.evaluate(() => {
    if (window.__navProbe) return;
    const p = (window.__navProbe = { tasks: [], reqs: 0 });
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) p.tasks.push({ s: e.startTime, d: e.duration }); }).observe({ type: "longtask", buffered: false });
    } catch {}
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (/:(8380|9399)\b|127\.0\.0\.1:8380|localhost:8380/.test(e.name)) p.reqs += 1; }).observe({ type: "resource", buffered: false });
    } catch {}
  });
}

async function clickNav(page, href) {
  return page.evaluate(
    (target) =>
      new Promise((resolve) => {
        const strip = (s) => s.replace(/\/+$/, "") || "/";
        const link = [...document.querySelectorAll('[data-testid="app-sidebar-slot"] a[href]')].find((a) => strip(new URL(a.href).pathname) === target);
        if (!link) return resolve({ error: `no sidebar link for ${target}` });
        const p = window.__navProbe;
        p.tasks.length = 0;
        p.reqs = 0;
        const t0 = performance.now();
        let last = t0;
        let worstFrame = 0;
        let urlAt = null;
        let settled = 0;
        const loadingNow = () => {
          const main = document.querySelector("main");
          if (!main) return true;
          return !!main.querySelector('[data-slot="skeleton"], .animate-pulse:not(.rounded-full), [aria-busy="true"]');
        };
        const tick = (now) => {
          worstFrame = Math.max(worstFrame, now - last);
          last = now;
          if (urlAt === null && strip(location.pathname) === target) urlAt = now - t0;
          if (urlAt !== null && !loadingNow()) settled += 1; else settled = 0;
          if (settled >= 2 || now - t0 > 15000) {
            const tasks = p.tasks.filter((x) => x.s >= t0 - 5);
            return resolve({
              urlMs: urlAt === null ? null : Math.round(urlAt),
              paintMs: Math.round(now - t0),
              blockMs: Math.round(tasks.reduce((a, x) => a + Math.max(0, x.d - 50), 0)),
              maxTask: Math.round(tasks.reduce((a, x) => Math.max(a, x.d), 0)),
              frames: Math.round(worstFrame),
              reqs: p.reqs,
              timedOut: now - t0 > 15000,
              stuck: now - t0 > 15000 ? [...document.querySelectorAll('main [data-slot="skeleton"], main .animate-pulse:not(.rounded-full), main [aria-busy="true"]')].slice(0, 4).map((e) => e.tagName + '.' + String(e.className).slice(0, 80) + ' in ' + String(e.parentElement && e.parentElement.innerText).slice(0, 50).split(String.fromCharCode(10)).join(' ')) : undefined,
            });
          }
          requestAnimationFrame(tick);
        };
        link.click();
        requestAnimationFrame(tick);
      }),
    href,
  );
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

scenario("nav-perf", `Sidebar navigation timing across ${ROUTES.length} pages (${PASSES} passes, CPU x${CPU})`, async ({ page }, check, notes) => {
  const client = await page.context().newCDPSession(page);
  if (process.env.NAV_PERF_REDUCED === "1") await client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  if (CPU > 1) await client.send("Emulation.setCPUThrottlingRate", { rate: CPU });
  if (BULK > 0) {
    await addBulkTransactions(BULK);
    await page.reload();
    await page.waitForSelector('[data-testid="qa-portal"]');
  }
  await h.go(page, "/dashboard");
  await page.waitForTimeout(3000 + Math.min(BULK, 10000));
  await installProbe(page);

  const all = {};
  for (let pass = 1; pass <= PASSES; pass++) {
    for (const route of ROUTES) {
      // Alternate through a neutral page so every click is a real route change.
      const r = await clickNav(page, route);
      (all[route] ??= []).push(r);
      await page.waitForTimeout(400); // let listeners / effects of the new page settle before the next click
    }
  }
  if (BULK > 0) notes.push(`${BULK} synthetic transactions added`);
  const rows = ROUTES.map((route) => {
    const cold = all[route][0];
    const warm = all[route].slice(1).filter((x) => !x.error);
    return {
      route,
      coldPaint: cold.paintMs,
      warmPaint: median(warm.map((x) => x.paintMs)),
      warmBlock: median(warm.map((x) => x.blockMs)),
      warmMaxTask: median(warm.map((x) => x.maxTask)),
      warmFrame: median(warm.map((x) => x.frames)),
      warmReqs: median(warm.map((x) => x.reqs)),
    };
  });
  console.table(rows);
  const outDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", ".results");
  writeFileSync(path.join(outDir, `nav-perf-cpu${CPU}-bulk${BULK}.json`), JSON.stringify({ cpu: CPU, rows, raw: all }, null, 1));
  const errors = Object.values(all).flat().filter((x) => x.error || x.timedOut);
  check("every navigation landed and painted", errors.length === 0, errors.slice(0, 3).map((e) => e.error ?? "timeout").join(","));
  const worstWarm = Math.max(...rows.map((r) => r.warmPaint));
  notes.push(`worst warm paint ${worstWarm}ms; median warm paint ${median(rows.map((r) => r.warmPaint))}ms`);
  return { medianWarmPaint: median(rows.map((r) => r.warmPaint)), worstWarmPaint: worstWarm };
});
