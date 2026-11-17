/**
 * Multi-tab behaviour (local emulator only — see tests/e2e-qa/README.md).
 * Question: does opening the app in a SECOND tab of the same browser profile close a popup that is open in the first tab?
 * The first tab is instrumented BEFORE the second tab opens, so a closed popup can be traced to its cause (an auth
 * notification, a Firestore snapshot, a route change, a storage event, a visibility/focus change).
 */
import { scenario } from "../lib/core.mjs";
import { BASE_URL } from "../lib/env.mjs";
import * as h from "../lib/harness.mjs";

const LOAN = "QA Loan 12";

/** Records everything that could plausibly close a popup, with timestamps, so a failure explains itself. */
async function instrument(page) {
  await page.evaluate(() => {
    const log = (window.__mt = { events: [], removed: [] });
    const t = () => Math.round(performance.now());
    for (const type of ["visibilitychange", "blur", "focus", "storage", "pagehide", "online", "offline"]) {
      window.addEventListener(type, (e) => log.events.push(`${t()} ${type}${type === "storage" ? ` key=${e.key}` : ""}`));
    }
    document.addEventListener("visibilitychange", () => log.events.push(`${t()} doc.visibility=${document.visibilityState}`));
    const origPush = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    history.pushState = (...a) => (log.events.push(`${t()} pushState ${String(a[2])}`), origPush(...a));
    history.replaceState = (...a) => (log.events.push(`${t()} replaceState ${String(a[2])}`), origReplace(...a));
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.removedNodes) if (n.nodeType === 1 && (n.matches?.('[role="dialog"]') || n.querySelector?.('[role="dialog"]'))) log.removed.push(`${t()} dialog removed`);
    }).observe(document.body, { childList: true, subtree: true });
  });
}

async function openPay(page) {
  await h.go(page, "/loans-installments");
  await page.getByText(LOAN).first().click();
  await page.getByRole("button", { name: "Record Payment" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay installment|Pay EMI/ });
  await dlg.getByText("TO PAY LENDER").waitFor();
  return dlg;
}

/**
 * Tab 1 opens a payment popup; tab 2 (same profile) loads and is used; tab 1's popup must survive.
 * `noHmr`: tab 1's Next.js dev-server hot-reload socket is neutralised first — what a production (static export) build
 * looks like, since only `next dev` ships that socket.
 */
async function twoTabs({ page, ctx }, chk, notes, { noHmr }) {
  // `noHmr`: the dev client needs its socket to initialise, so let it connect, then — once the popup is open — drop every
  // server→tab-1 HMR message. That is the only difference from the dev scenario: nothing the app does changes.
  const hmr = { pass: true };
  if (noHmr) {
    await page.routeWebSocket(/\/_next\/hmr/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => hmr.pass && ws.send(m));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.next?.router != null, null, { timeout: 60000 });
    await page.waitForTimeout(2500);
  }
  const dlg = await openPay(page);
  await instrument(page);
  if (noHmr) hmr.pass = false;
  // Playwright-side record that survives a document replacement (the page-side trace would be lost with it).
  const seen = [];
  const stamp = () => new Date().toISOString().slice(14, 23);
  page.on("framenavigated", (fr) => fr === page.mainFrame() && seen.push(`${stamp()} navigated ${fr.url()}`));
  page.on("load", () => seen.push(`${stamp()} load`));
  page.on("console", (m) => /Fast Refresh|HMR|reload|hot-update|full reload|Auth|auth/i.test(m.text()) && seen.push(`${stamp()} console[${m.type()}] ${m.text().slice(0, 160)}`));
  page.on("websocket", (w) => {
    seen.push(`${stamp()} websocket ${w.url().slice(0, 80)}`);
    // Dev-server HMR messages: a "reload" / "serverComponentChanges" here is what makes the dev client reload the page.
    w.on("framereceived", (fr) => {
      const raw = typeof fr.payload === "string" ? fr.payload : Buffer.from(fr.payload).toString("latin1");
      if (/reload|serverComponent|sync|added|removed|TURBOPACK|sessionId/i.test(raw.slice(0, 200))) seen.push(`${stamp()} HMR<- ${raw.replace(/[^ -~]/g, ".").slice(0, 110)}`);
    });
  });
  page.on("request", (r) => (r.isNavigationRequest() || /_rsc=|__nextjs|hmr|webpack-hmr|turbopack/i.test(r.url())) && seen.push(`${stamp()} request${r.isNavigationRequest() ? "(NAVIGATION)" : ""} ${r.method()} ${r.url().replace(BASE_URL, "").slice(0, 90)}`));
  page.on("requestfailed", (r) => seen.push(`${stamp()} requestFAILED ${r.url().replace(BASE_URL, "").slice(0, 90)} ${r.failure()?.errorText}`));
  page.on("response", (r) => r.request().isNavigationRequest() && seen.push(`${stamp()} navResponse ${r.status()} ${r.url().replace(BASE_URL, "").slice(0, 90)}`));
  page.on("close", () => seen.push(`${stamp()} page closed`));
  page.on("crash", () => seen.push(`${stamp()} page CRASHED`));
  seen.push(`${stamp()} tab2 opening`);
  chk("(setup) the payment popup is open in tab 1", await dlg.isVisible());

  // Tab 2: same browser profile (shared IndexedDB/localStorage → shared Firebase Auth + Firestore persistence).
  const second = await ctx.newPage();
  await second.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });
  await second.waitForSelector("main", { timeout: 60000 });
  await second.waitForTimeout(6000); // let tab 2 finish auth restore, token refresh and its Firestore listeners
  const stillOpenAfterLoad = await dlg.isVisible();

  // Navigate around in tab 2 (more auth/listener traffic) and come back to tab 1.
  await h.go(second, "/transactions").catch(() => {});
  await second.waitForTimeout(3000);
  await page.bringToFront();
  await page.waitForTimeout(2500);
  const stillOpenAfterReturn = await dlg.isVisible();

  const trace = (await page.evaluate(() => window.__mt)) ?? { events: ["(page-side trace lost: the document was REPLACED = full reload)"], removed: ["(lost)"] };
  notes.push(`tab1 playwright-side: ${seen.join(" | ")}`);
  notes.push(`tab1 trace: events=${JSON.stringify(trace.events.slice(0, 20))} removed=${JSON.stringify(trace.removed)}`);
  const reloaded = trace.removed.includes("(lost)");
  await second.close();
  return { stillOpenAfterLoad, stillOpenAfterReturn, reloaded, removed: trace.removed };
}

// Dev build (what this suite runs on): the popup is lost because the Next.js DEV server's hot-reload client reloads every
// open tab when another tab makes it compile a new route — not the app, auth, Firestore or any shared state. Recorded as a
// documented finding so it stays visible; the second scenario proves the app itself is fine once that socket is out.
scenario("multitab-popup-dev", "Dev build: a second tab's first visit to another route reloads the first tab (Next.js HMR) — popup lost", async (ctx, chk, notes) => {
  const r = await twoTabs(ctx, chk, notes, { noHmr: false });
  chk("(setup) tab 1's popup was opened", true);
  chk.finding("MT-1", "dev only: tab 1 is NOT reloaded by tab 2 (Next.js dev HMR full reload)", !r.reloaded && r.stillOpenAfterLoad && r.stillOpenAfterReturn, JSON.stringify(r));
});

scenario("multitab-popup", "Without the dev HMR socket (as in production) a second tab loaded and used never closes the first tab's popup", async (ctx, chk, notes) => {
  const r = await twoTabs(ctx, chk, notes, { noHmr: true });
  chk("tab 1's popup is still open after tab 2 loaded", r.stillOpenAfterLoad, JSON.stringify(r));
  chk("tab 1's popup is still open after using tab 2 and switching back", r.stillOpenAfterReturn, JSON.stringify(r));
  chk("tab 1's document was never replaced and no dialog node was removed", !r.reloaded && r.removed.length === 0, JSON.stringify(r.removed));
});
