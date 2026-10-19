/**
 * Shared browser-QA harness: launches Chrome with every non-local request blocked (and recorded as a violation),
 * drives the local-only /dev/qa portal, reads persisted state back from the emulator's REST API, and records
 * event timings in the page.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { assertLocalEmulatorOnly, BASE_URL, BROWSER_CHANNEL, FIRESTORE_DOCS, isAllowedHost } from "./env.mjs";

export const RESULTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".results");
export const SHOTS_DIR = path.join(RESULTS_DIR, "shots");
mkdirSync(SHOTS_DIR, { recursive: true });

/** Requests the browser tried to make to a non-local host. Any entry fails the whole run. */
export const egressViolations = [];

/** Runs inside every page before app code: records event times, request timing and a few text milestones. */
const INIT = () => {
  window.__ev = [];
  const seen = {};
  const mark = (n) => {
    if (!seen[n]) {
      seen[n] = true;
      window.__ev.push({ n, t: performance.now() });
    }
  };
  window.__reset = () => {
    window.__ev = [];
    for (const k in seen) delete seen[k];
    window.__t0 = performance.now();
  };
  const pats = {
    loading: /Recording…|Updating payment…|Marking as unpaid…/,
    success: /Payment recorded|Payment updated|marked as unpaid|Marked as unpaid|Payment reversed/i,
    updating: /Updating balances/,
    refreshWarn: /balances couldn.t refresh/,
    slowToast: /Figures on screen may take a moment/,
  };
  const scan = () => {
    const txt = document.body ? document.body.innerText : "";
    for (const k in pats) if (pats[k].test(txt)) mark(k);
    const open = /TO PAY LENDER|TO RECEIVE|Edit payment|Mark as unpaid\?|Payment details|Pay EMI/i.test(txt);
    if (open) {
      mark("dialogOpen");
      window.__wasOpen = true;
    }
    if (window.__wasOpen && !open && seen.dialogOpen) mark("dialogClosed");
  };
  new MutationObserver(scan).observe(document, { subtree: true, childList: true, characterData: true });
  const isCommit = (u) => String(u).includes(":commit");
  const of = window.fetch;
  window.fetch = function (...a) {
    const u = a[0] && a[0].url ? a[0].url : a[0];
    const p = of.apply(this, a);
    if (isCommit(u)) {
      mark("commitStart");
      p.then(() => mark("commitEnd"), () => {});
    }
    return p;
  };
  const ox = XMLHttpRequest.prototype.open;
  const sx = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...r) {
    this.__u = String(u);
    return ox.call(this, m, u, ...r);
  };
  XMLHttpRequest.prototype.send = function (...a) {
    if (this.__u && isCommit(this.__u)) {
      mark("commitStart");
      this.addEventListener("loadend", () => mark("commitEnd"));
    }
    return sx.apply(this, a);
  };
};

export async function launch(opts = {}) {
  assertLocalEmulatorOnly();
  let browser;
  try {
    browser = await chromium.launch({ channel: BROWSER_CHANNEL, headless: true });
  } catch (e) {
    throw new Error(`Couldn't start the "${BROWSER_CHANNEL}" browser (${String(e).split("\n")[0]}). Install Chrome, or set QA_BROWSER_CHANNEL=chromium after \`npx playwright install chromium\`.`);
  }
  const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 1366, height: 768 }, colorScheme: opts.scheme ?? "light" });
  // Fail closed on the network: only localhost may be contacted. Firebase/Google endpoints are aborted and recorded.
  await ctx.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === "data:" || url.protocol === "blob:" || isAllowedHost(url.hostname)) return route.fallback();
    egressViolations.push(`${route.request().method()} ${url.origin}${url.pathname.slice(0, 40)}`);
    return route.abort("blockedbyclient");
  });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  const logs = [];
  page.on("console", (m) => {
    if (["error", "warning"].includes(m.type())) logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => logs.push(`[pageerror] ${String(e).slice(0, 300)}`));
  return { browser, ctx, page, logs };
}

export async function openPortalSignedIn(page) {
  await page.goto(`${BASE_URL}/dev/qa`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="qa-portal"]', { timeout: 60000 });
  const txt = await page.locator('[data-testid="qa-user"]').innerText();
  if (!txt.includes("synthetic QA user")) {
    await page.click('[data-testid="qa-signin"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="qa-user"]')?.textContent?.includes("synthetic QA user"), null, { timeout: 20000 });
  }
}

export async function reseed(page) {
  await page.click('[data-testid="qa-reset"]');
  await page.waitForSelector('[data-testid="qa-seed-steps"]', { timeout: 120000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="qa-reset"]')?.textContent?.includes("Reset"), null, { timeout: 120000 });
}

/** Adds an opt-in fixture from the portal (must be on /dev/qa): "shared-emi", "card-emi" or "history". */
export async function addFixture(page, which) {
  const testId = which === "shared-emi" ? "qa-seed-shared-emi" : which === "card-emi" ? "qa-seed-card-emi" : "qa-seed-history";
  await page.click(`[data-testid="${testId}"]`);
  await page.waitForSelector('[data-testid="qa-seed-steps"]', { timeout: 120000 });
  await page.waitForFunction((id) => !document.querySelector(`[data-testid="${id}"]`)?.textContent?.includes("Adding"), testId, { timeout: 120000 });
  const steps = (await page.locator('[data-testid="qa-seed-steps"]').innerText()).split("\n").join(" | ");
  if (/✗/.test(steps)) throw new Error(`fixture failed: ${steps}`);
}

/** Client-side navigation — keeps the armed fault-injection hook (a reload would clear it). */
export async function go(page, href) {
  await page.evaluate((h) => window.next.router.push(h), href);
  await page.waitForURL(`**${href}*`, { timeout: 30000 });
}

export async function start(opts = {}) {
  const r = await launch(opts);
  await openPortalSignedIn(r.page);
  if (opts.reseed !== false) await reseed(r.page);
  return r;
}

/* ───────────── persisted state, read from the emulator (owner bearer: emulator-only shortcut past the rules) ───────────── */

const OWNER = { Authorization: "Bearer owner" };

function val(v) {
  if (!v) return null;
  const k = Object.keys(v)[0];
  if (k === "mapValue") return flat(v.mapValue.fields || {});
  if (k === "arrayValue") return (v.arrayValue.values || []).map(val);
  if (k === "integerValue") return Number(v.integerValue);
  if (k === "nullValue") return null;
  return v[k];
}
function flat(f) {
  const o = {};
  for (const k in f) o[k] = val(f[k]);
  return o;
}

export async function authUid() {
  const j = await (await fetch(`${FIRESTORE_DOCS}/users?pageSize=5&showMissing=true`, { headers: OWNER })).json();
  return j.documents[0].name.split("/").pop();
}

export async function list(collectionPath) {
  const uid = await authUid();
  const out = [];
  let token = "";
  do {
    const r = await fetch(`${FIRESTORE_DOCS}/users/${uid}/${collectionPath}?pageSize=300${token ? `&pageToken=${token}` : ""}`, { headers: OWNER });
    const j = await r.json();
    for (const d of j.documents || []) out.push({ id: d.name.split("/").pop(), ...flat(d.fields || {}) });
    token = j.nextPageToken || "";
  } while (token);
  return out;
}

/** Corrupts a stored number on purpose (emulator only) — used by the balance-mismatch scenario. */
export async function patchNumber(docPath, field, value) {
  const uid = await authUid();
  return fetch(`${FIRESTORE_DOCS}/users/${uid}/${docPath}?updateMask.fieldPaths=${field}`, {
    method: "PATCH",
    headers: { ...OWNER, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { [field]: { doubleValue: value } } }),
  });
}

/** Creates a document at an absolute path under /documents (emulator only) — e.g. another user's account, to prove ownership checks. */
export async function createRawDoc(docPath, stringFields) {
  const fields = Object.fromEntries(Object.entries(stringFields).map(([k, v]) => [k, { stringValue: v }]));
  return fetch(`${FIRESTORE_DOCS}/${docPath}`, { method: "PATCH", headers: { ...OWNER, "Content-Type": "application/json" }, body: JSON.stringify({ fields }) });
}

export async function accountBalance(name) {
  return (await list("accounts")).find((x) => x.name === name);
}

/** Arms (or clears) the test-only derived-refresh fault injection on the portal's query client. */
export async function arm(page, fault) {
  await page.evaluate((f) => window.__qa.setRefreshFault(f), fault);
}

/** Event times relative to the last `window.__reset()`. */
export async function timeline(page) {
  return page.evaluate(() => {
    const t0 = window.__t0 ?? 0;
    const o = {};
    for (const e of window.__ev) o[e.n] = Math.round(e.t - t0);
    return o;
  });
}

export async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
  return `shots/${name}.png`;
}
