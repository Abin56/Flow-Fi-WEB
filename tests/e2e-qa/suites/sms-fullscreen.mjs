/**
 * Transaction Inbox full screen while scrolling (desktop 1366x768). Seeds ~45 synthetic candidates in the Firestore EMULATOR,
 * turns full screen on, scrolls with the real mouse wheel (List and Grid — Grid is one day at a time: 30 cards on yesterday), and measures at each step:
 *  - the overlay still covers the viewport and is still the thing that scrolls (the shell's <main> never moves);
 *  - full screen is still on (the Exit button is still there);
 *  - the pinned views + filter bar stays on screen at the top, and the month heading sticks just below it — never under it;
 *  - no row/card sits half under the pinned bar with its controls covered.
 * Screenshots: tests/e2e-qa/.results/shots/fs-*.png
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
import { BASE_URL, FIRESTORE_DOCS } from "../lib/env.mjs";

const OWNER = { Authorization: "Bearer owner", "Content-Type": "application/json" };
const DAY = 86400000;
const s = (v) => ({ stringValue: v });
const n = (v) => ({ doubleValue: v });
const nul = { nullValue: null };

async function putCandidate(uid, { id, amount, merchant, accountId, daysAgo }) {
  const fields = {
    amount: n(amount),
    direction: s("debit"),
    eventType: s("upiPayment"),
    transactionDate: { timestampValue: new Date(Date.now() - daysAgo * DAY).toISOString() },
    merchant: merchant ? s(merchant) : nul,
    bankName: s("QA Bank"),
    rawLastFour: nul,
    accountId: accountId ? s(accountId) : nul,
    cardId: nul,
    referenceNumber: nul,
    confidenceLevel: s("high"),
    confidenceScore: n(0.9),
    needsReview: { booleanValue: false },
    needsReviewReasons: { arrayValue: { values: [] } },
    source: s("sms"),
    createdAt: { timestampValue: new Date().toISOString() },
    deletedAt: nul,
  };
  const r = await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsTransactionCandidates/${id}`, { method: "PATCH", headers: OWNER, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`seed ${id}: ${r.status} ${await r.text()}`);
}

async function seedPairedSwitch(uid) {
  const sw = await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsSyncConfig/backgroundUpload`, {
    method: "PATCH",
    headers: OWNER,
    body: JSON.stringify({ fields: { enabled: { booleanValue: true }, deviceId: { stringValue: "qa-sms-device" }, source: { stringValue: "pairing" } } }),
  });
  if (!sw.ok) throw new Error(`seed Auto Sync switch: ${sw.status}`);
}

/** Everything we need to judge the full-screen layout at the current scroll position. */
function measure(page) {
  return page.evaluate(() => {
    const exit = document.querySelector('button[aria-label="Exit full screen"]');
    // Full screen = the shell's Focus Mode: the sidebar + topbar slots are hidden and the page still scrolls in <main>.
    const root = document.querySelector("main");
    const hidden = (id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      return !el || getComputedStyle(el).display === "none";
    };
    const stack = document.querySelector('div.sticky[class~="z-[2]"]');
    const sb = stack?.getBoundingClientRect();
    const headings = [...document.querySelectorAll('[data-testid="candidate-group"] > div.sticky')].map((el) => el.getBoundingClientRect());
    // Grid view has no month headings: its day bar (month control + day strip) is the sticky bar that must sit right under the pinned controls.
    const navRect = document.querySelector('[data-testid="candidate-day-nav"]')?.getBoundingClientRect();
    const stuck = headings.filter((r) => r.top <= (sb?.bottom ?? 0) + 2 && r.bottom > 0).pop() ?? (navRect && navRect.top <= (sb?.bottom ?? 0) + 2 && navRect.bottom > 0 ? navRect : undefined);
    // Anything from OUTSIDE the scrolling page that wins the hit test somewhere on it (paints on top of it).
    const intruders = new Set();
    if (root) {
      const rr = root.getBoundingClientRect();
      for (let x = rr.left + 8; x < rr.right; x += 24) {
        for (let y = rr.top + 8; y < rr.bottom; y += 24) {
          const hit = document.elementFromPoint(x, y);
          if (hit && !root.contains(hit) && !hit.closest("nextjs-portal") && !hit.closest('[data-testid="fullscreen-prompt"]')) {
            intruders.add(hit.tagName.toLowerCase() + (hit.getAttribute("data-testid") ? `[${hit.getAttribute("data-testid")}]` : "") + (typeof hit.className === "string" ? "." + hit.className.split(/\s+/).slice(0, 4).join(".") : ""));
          }
        }
      }
    }
    // Any visible row checkbox that something else covers (e.g. a floating widget on the right-hand column).
    const coverers = [];
    const coveredCheckbox = [...document.querySelectorAll('[data-testid="candidate-row"] [role="checkbox"]')].filter((c) => {
      const r = c.getBoundingClientRect();
      if (r.top < Math.max(sb?.bottom ?? 0, stuck?.bottom ?? 0) + 4 || r.bottom > innerHeight - 4) return false;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || c.contains(hit) || c.parentElement?.contains(hit)) return false;
      // Next.js's dev-only indicator (shadow-DOM host <nextjs-portal>) is not part of the app and doesn't exist in production.
      if (hit.closest("nextjs-portal")) return false;
      coverers.push(hit.tagName.toLowerCase() + (typeof hit.className === "string" ? "." + hit.className.split(" ").slice(0, 3).join(".") : ""));
      return true;
    }).length;
    // A visible Review button that something else covers (rows passing under the pinned bar / the stuck heading are fine).
    const coveredReview = [...document.querySelectorAll('[data-testid="candidate-row"] button[data-review-id]')].filter((b) => {
      const r = b.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) return false;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return r.top > Math.max(sb?.bottom ?? 0, stuck?.bottom ?? 0) + 4 && r.bottom < innerHeight - 4 && hit && !b.contains(hit);
    }).length;
    const rb = root?.getBoundingClientRect();
    return {
      fullscreen: !!exit,
      chromeHidden: hidden("app-sidebar-slot") && hidden("app-topbar-slot"),
      rootRect: rb ? { top: rb.top, left: rb.left, w: rb.width, h: rb.height } : null,
      rootScroll: root?.scrollTop ?? null,
      rootScrollMax: root ? root.scrollHeight - root.clientHeight : null,
      stackTop: sb?.top ?? null,
      stackBottom: sb?.bottom ?? null,
      stuckTop: stuck?.top ?? null,
      coveredReview,
      coveredCheckbox,
      coverers,
      intruders: [...intruders],
      vh: innerHeight,
      vw: innerWidth,
    };
  });
}

scenario("fs-inbox-scroll", "Inbox full screen stays on and lays out correctly while scrolling (list + grid, 1366x768)", async ({ page }, chk, notes) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const uid = await h.authUid();
  await seedPairedSwitch(uid);
  const bank = (await h.accountBalance("QA Bank")).id;
  for (let i = 0; i < 45; i++) {
    await putCandidate(uid, { id: `fs-cand-${String(i).padStart(4, "0")}`, amount: 100 + i, merchant: i % 4 === 0 ? null : `Shop ${i}`, accountId: bank, daysAgo: i < 30 ? 1 : Math.floor((i - 30) / 3) + 2 });
  }

  await page.goto(`${BASE_URL}/transaction-candidates`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Transaction Inbox" }).waitFor({ timeout: 60000 });
  await page.getByText("Shop 1", { exact: true }).first().waitFor({ timeout: 40000 });
  await page.waitForTimeout(600);

  for (const layout of ["list", "grid"]) {
    if (layout === "grid") await page.getByRole("button", { name: "Grid view" }).click();
    await page.getByRole("button", { name: "Full screen", exact: true }).click();
    await page.getByRole("button", { name: "Exit full screen", exact: true }).waitFor({ timeout: 5000 });
    await page.waitForTimeout(300);
    const m0 = await measure(page);
    notes.push(`${layout} start: ${JSON.stringify(m0)}`);
    await h.shot(page, `fs-${layout}-0`);
    chk(`${layout} start: nothing outside full screen paints over it`, m0.intruders.length === 0, m0.intruders.join(" | "));
    chk(`${layout}: sidebar + topbar hidden`, m0.chromeHidden);
    chk(`${layout}: full screen covers the viewport`, !!m0.rootRect && Math.abs(m0.rootRect.top) < 1 && Math.abs(m0.rootRect.h - m0.vh) < 2 && Math.abs(m0.rootRect.w - m0.vw) < 2, JSON.stringify(m0.rootRect));

    await page.mouse.move(700, 500);
    for (let step = 1; step <= 6; step++) {
      await page.mouse.wheel(0, 700);
      await page.waitForTimeout(350);
      const m = await measure(page);
      notes.push(`${layout} step ${step}: ${JSON.stringify(m)}`);
      if (step === 2 || step === 6) await h.shot(page, `fs-${layout}-${step}`);
      chk(`${layout} step ${step}: still full screen`, m.fullscreen);
      chk(`${layout} step ${step}: overlay still covers the viewport`, !!m.rootRect && Math.abs(m.rootRect.top) < 1 && Math.abs(m.rootRect.h - m.vh) < 2, JSON.stringify(m.rootRect));
      chk(`${layout} step ${step}: sidebar + topbar stay hidden`, m.chromeHidden);
      chk(`${layout} step ${step}: pinned controls fully on screen near the top`, m.stackTop != null && m.stackTop >= 0 && m.stackTop <= 80, `stack top ${m.stackTop}`);
      if (m.stuckTop != null) chk(`${layout} step ${step}: month heading sits right below the pinned controls`, m.stuckTop >= m.stackBottom - 2, `heading ${m.stuckTop} vs stack bottom ${m.stackBottom}`);
      chk(`${layout} step ${step}: no visible Review button is covered`, m.coveredReview === 0, `${m.coveredReview} covered`);
      chk(`${layout} step ${step}: no visible row checkbox is covered`, m.coveredCheckbox === 0, `${m.coveredCheckbox} covered ${m.coverers.join(" | ")}`);
      chk(`${layout} step ${step}: nothing outside full screen paints over it`, m.intruders.length === 0, m.intruders.join(" | "));
    }
    const end = await measure(page);
    // Grid shows one day at a time (yesterday holds 30 cards here), so it is a shorter page than the whole-inbox List.
    chk(`${layout}: the list scrolled (not stuck)`, end.rootScroll > (layout === "grid" ? 300 : 1000), `scrollTop ${end.rootScroll} of ${end.rootScrollMax}`);
    // The controls are usable mid-list: search still accepts typing.
    await page.getByRole("searchbox", { name: "Search candidates" }).fill("Shop 4");
    await page.waitForTimeout(500);
    chk(`${layout}: search works mid-scroll and full screen stays on`, (await measure(page)).fullscreen);
    await h.shot(page, `fs-${layout}-search`);
    await page.getByRole("searchbox", { name: "Search candidates" }).fill("");
    if (layout === "grid") {
      chk("grid survived full screen (layout preserved)", (await page.getByTestId("candidate-grid").count()) > 0);
      // Escape exits — but not while typing in the search box.
      await page.getByRole("searchbox", { name: "Search candidates" }).press("Escape");
      chk("Escape while typing does not exit full screen", (await measure(page)).fullscreen);
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Full screen", exact: true }).waitFor({ timeout: 5000 });
      const out = await measure(page);
      chk("Escape exits full screen and the shell returns", !out.fullscreen && !out.chromeHidden);
      break;
    }
    await page.getByRole("button", { name: "Exit full screen", exact: true }).click();
    await page.getByRole("button", { name: "Full screen", exact: true }).waitFor({ timeout: 5000 });
    await page.waitForTimeout(300);
  }
});
