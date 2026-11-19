/**
 * Transaction Inbox — day-wise browsing, Grid AND List: Month → Day → Cards/Rows (2026-11-19). Local emulator only (see tests/e2e-qa/README.md).
 * Seeds synthetic candidates across Dec 2025 / Sep 2026 / Oct 2026 in the Firestore EMULATOR, switches the Inbox to Grid and drives the
 * real UI. The day bar is a compact dock of day numbers (count dots, macOS-Dock-style magnification under a mouse):
 *  - the grid opens on the newest day and shows ONLY that day's cards; the strip lists only days with candidates, each with its
 *    day number, weekday and exact count; one click swaps the cards; previous/next day and month cross month + year boundaries;
 *  - a month's days fit on one compact row; on a narrow window the row scrolls sideways (wheel, keyboard) and keeps the open day in view;
 *  - hovering magnifies the day under the pointer most, its neighbours a little, flowing with the pointer, and nothing around it moves;
 *  - counts follow every filter (view, direction, search); the chosen day is kept, falls to the nearest day while it is empty, and
 *    comes back when the filter is cleared;
 *  - dismiss / Undo update the day's count at once; "Select all" applies to the open day only; Grid ⇄ List (both day-wise) and leaving the Inbox keep the day;
 *  - nothing is written when a day is chosen.
 * Screenshots: tests/e2e-qa/.results/shots/iday-*.png
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
import { BASE_URL, FIRESTORE_DOCS } from "../lib/env.mjs";

const OWNER = { Authorization: "Bearer owner", "Content-Type": "application/json" };
const s = (v) => ({ stringValue: v });
const n = (v) => ({ doubleValue: v });
const nul = { nullValue: null };
const NO_ACCOUNT = { accountId: null, rawLastFour: "7743", confidenceLevel: "low", needsReview: true, reasons: ["No matching account or card found for this message."] };

async function putCandidate(uid, { id, date, amount, merchant, accountId, direction = "debit", eventType = "upiPayment", rawLastFour = null, confidenceLevel = "high", needsReview = false, reasons = [] }) {
  const [y, mo, d, hh = 12, mm = 0] = date;
  const fields = {
    amount: n(amount),
    direction: s(direction),
    eventType: s(eventType),
    transactionDate: { timestampValue: new Date(y, mo - 1, d, hh, mm).toISOString() },
    merchant: merchant ? s(merchant) : nul,
    bankName: s("QA Bank"),
    rawLastFour: rawLastFour ? s(rawLastFour) : nul,
    accountId: accountId ? s(accountId) : nul,
    cardId: nul,
    referenceNumber: nul,
    confidenceLevel: s(confidenceLevel),
    confidenceScore: n(confidenceLevel === "high" ? 0.9 : 0.4),
    needsReview: { booleanValue: needsReview },
    needsReviewReasons: { arrayValue: { values: reasons.map((r) => s(r)) } },
    source: s("sms"),
    createdAt: { timestampValue: new Date().toISOString() },
    deletedAt: nul,
  };
  const r = await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsTransactionCandidates/iday-${id}`, { method: "PATCH", headers: OWNER, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`seed ${id}: ${r.status} ${await r.text()}`);
}

async function candidateExists(uid, id) {
  const r = await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsTransactionCandidates/iday-${id}`, { headers: OWNER });
  return r.status === 200;
}

async function countCandidates(uid) {
  const r = await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsTransactionCandidates?pageSize=300`, { headers: OWNER });
  const j = await r.json();
  return (j.documents ?? []).length;
}

async function seedPairedSwitch(uid) {
  const sw = await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsSyncConfig/backgroundUpload`, {
    method: "PATCH",
    headers: OWNER,
    body: JSON.stringify({ fields: { enabled: { booleanValue: true }, deviceId: { stringValue: "qa-sms-device" }, source: { stringValue: "pairing" } } }),
  });
  if (!sw.ok) throw new Error(`seed Auto Sync switch: ${sw.status}`);
}

// Dec 2025: 1 day · Sep 2026: 2 days (12th ×3, 30th ×1) · Oct 2026: 7 days (12 candidates). 17 in all. Newest-first within a day.
const SPEC = [
  { id: "d31", date: [2025, 12, 31, 21, 10], amount: 450, merchant: "Year End Store" },
  { id: "s12a", date: [2026, 9, 12, 9, 5], amount: 310, merchant: "Zomato Sep" },
  { id: "s12b", date: [2026, 9, 12, 13, 30], amount: 180, merchant: "Uber Sep" },
  { id: "s12c", date: [2026, 9, 12, 19, 45], amount: 12000, merchant: "Rent Sep" },
  { id: "s30", date: [2026, 9, 30, 16, 0], amount: 95, merchant: "Month End Cafe" },
  { id: "o01a", date: [2026, 10, 1, 8, 15], amount: 20, merchant: "Chai Point" },
  { id: "o01b", date: [2026, 10, 1, 20, 40], amount: 75, merchant: "Corner Shop" },
  { id: "o03a", date: [2026, 10, 3, 10, 0], amount: 640, merchant: "Swiggy Oct3" },
  { id: "o03b", date: [2026, 10, 3, 18, 30], amount: 2200, merchant: "Petrol Pump" },
  { id: "o09", date: [2026, 10, 9, 12, 0], amount: 899, merchant: "Bookstore" },
  { id: "o10a", date: [2026, 10, 10, 9, 0], amount: 500, merchant: "Metro Card" },
  { id: "o10b", date: [2026, 10, 10, 15, 0], amount: 260, merchant: "Cafe Delight" },
  { id: "o15a", date: [2026, 10, 15, 11, 0], amount: 1500, merchant: "Grocer" },
  { id: "o15b", date: [2026, 10, 15, 17, 0], amount: 310, merchant: "Pharmacy" },
  { id: "o18", date: [2026, 10, 18, 14, 0], amount: 700, merchant: "Cinema" },
  { id: "o21a", date: [2026, 10, 21, 9, 30], amount: 2000, merchant: "QA Employer Payroll", direction: "credit", eventType: "salaryCredit" },
  { id: "o21b", date: [2026, 10, 21, 18, 5], amount: 299, merchant: null, ...NO_ACCOUNT },
];
const OCT_CHIPS = ["01:2", "03:2", "09:1", "10:2", "15:2", "18:1", "21:2"];

async function seed(uid, specs = SPEC) {
  await seedPairedSwitch(uid);
  const bank = (await h.accountBalance("QA Bank")).id;
  for (const c of specs) await putCandidate(uid, { accountId: "accountId" in c ? c.accountId : bank, ...c });
}

async function openDayGrid(page) {
  await page.goto(`${BASE_URL}/transaction-candidates`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Transaction Inbox" }).waitFor({ timeout: 60000 });
  await page.getByTestId("candidates-ledger").waitFor({ timeout: 40000 });
  const grid = page.getByRole("button", { name: "Grid view" });
  if ((await grid.getAttribute("aria-pressed")) !== "true") await grid.click();
  await page.getByTestId("candidate-day-nav").waitFor({ timeout: 8000 });
  await page.waitForTimeout(500);
}

const chip = (page, day) => page.locator(`[data-testid="candidate-day-chip"][data-day="${day}"]`);
const settle = (page, ms = 350) => page.waitForTimeout(ms);

function readState(page) {
  return page.evaluate(() => {
    const q = (id) => document.querySelector(`[data-testid="${id}"]`);
    // A chip shows only its day number; the count rides on data-count (and as dots) — reported here as "03:2".
    const chips = [...document.querySelectorAll('[data-testid="candidate-day-chip"]')].map((c) => ({ day: c.getAttribute("data-day"), text: `${c.textContent.trim()}:${c.getAttribute("data-count")}`, selected: c.getAttribute("aria-selected") === "true" }));
    const cards = [...document.querySelectorAll('[data-testid="candidate-grid"] [data-testid="candidate-row"]')];
    return {
      month: q("candidate-month-title")?.textContent?.trim() ?? null,
      heading: q("candidate-day-heading")?.querySelector("h2")?.textContent?.trim() ?? null,
      total: q("candidate-day-total")?.textContent?.trim() ?? null,
      elsewhere: q("candidate-selected-elsewhere")?.textContent?.trim() ?? null,
      openDay: q("candidate-group")?.getAttribute("data-group-key") ?? null,
      chips,
      chipText: chips.map((c) => c.text),
      selectedChips: chips.filter((c) => c.selected).map((c) => c.day),
      cards: cards.map((c) => c.getAttribute("data-candidate-id").replace(/^iday-/, "")),
      allCards: document.querySelectorAll('[data-testid="candidate-row"]').length,
      shown: q("candidates-shown")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      prevDay: q("candidate-day-prev")?.getAttribute("aria-disabled"),
      nextDay: q("candidate-day-next")?.getAttribute("aria-disabled"),
      prevMonth: q("candidate-month-prev")?.getAttribute("aria-disabled"),
      nextMonth: q("candidate-month-next")?.getAttribute("aria-disabled"),
      hasPicker: !!q("candidate-month-picker"),
      pageOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

scenario(
  "iday-browse",
  "Day-wise grid: opens on the newest day, one click per day, previous/next day + month (across months and years), keyboard",
  async ({ page }, chk, notes) => {
    const uid = await h.authUid();
    await seed(uid);
    const before = await countCandidates(uid);
    await openDayGrid(page);
    let st = await readState(page);
    notes.push(JSON.stringify(st));
    await h.shot(page, "iday-open");

    chk("opens on the newest day, 21 October 2026", st.openDay === "2026-10-21" && st.heading === "21 October 2026", `${st.openDay} / ${st.heading}`);
    chk("the month control says October 2026", st.month === "October 2026", st.month);
    chk("only that day's 2 cards are on the page (not all 17)", st.allCards === 2 && eq(st.cards, ["o21b", "o21a"]), `${st.allCards}: ${st.cards}`);
    chk("the day total says 2 transactions", st.total === "2 transactions", st.total);
    chk("the strip lists ONLY the 7 October days that have transactions — each a day number with its exact count", eq(st.chipText, OCT_CHIPS), st.chipText.join(","));
    chk("the open day's chip is the selected one", eq(st.selectedChips, ["2026-10-21"]));
    chk("no later day → Next day is disabled; Previous day is not", st.nextDay === "true" && st.prevDay === "false", `${st.prevDay}/${st.nextDay}`);

    // one click on a day with several transactions
    await chip(page, "2026-10-03").click();
    await settle(page);
    st = await readState(page);
    chk("one click on 03 swaps the cards to that day's two, newest first", st.openDay === "2026-10-03" && eq(st.cards, ["o03b", "o03a"]) && st.allCards === 2, `${st.openDay} ${st.cards}`);
    chk("the heading and total follow: 03 October 2026 · 2 transactions", st.heading === "03 October 2026" && st.total === "2 transactions", `${st.heading} / ${st.total}`);
    // a day with exactly one transaction
    await chip(page, "2026-10-09").click();
    await settle(page);
    st = await readState(page);
    chk("a day with one transaction shows exactly that one card", st.openDay === "2026-10-09" && eq(st.cards, ["o09"]) && st.total === "1 transaction", `${st.cards} / ${st.total}`);
    await h.shot(page, "iday-one-card");

    // previous / next day
    await page.getByTestId("candidate-day-prev").click();
    await settle(page);
    st = await readState(page);
    chk("Previous day: 09 → 03", st.openDay === "2026-10-03", st.openDay);
    await page.getByTestId("candidate-day-next").click();
    await page.getByTestId("candidate-day-next").click();
    await settle(page);
    st = await readState(page);
    chk("Next day twice: 03 → 09 → 10", st.openDay === "2026-10-10", st.openDay);

    // keyboard in the strip
    await chip(page, "2026-10-10").focus();
    await page.keyboard.press("Home");
    await settle(page);
    st = await readState(page);
    chk("Home selects the first day (01) and moves focus with it", st.openDay === "2026-10-01" && (await page.evaluate(() => document.activeElement?.getAttribute("data-day"))) === "2026-10-01", st.openDay);
    await page.keyboard.press("ArrowRight");
    await settle(page);
    st = await readState(page);
    chk("ArrowRight selects the next day with transactions (03)", st.openDay === "2026-10-03", st.openDay);
    await page.keyboard.press("End");
    await settle(page);
    st = await readState(page);
    chk("End selects the last day (21)", st.openDay === "2026-10-21", st.openDay);

    // across a month boundary: 01 Oct ← 30 Sep
    await chip(page, "2026-10-01").click();
    await settle(page);
    await page.getByTestId("candidate-day-prev").click();
    await settle(page);
    st = await readState(page);
    chk("Previous day from 01 Oct crosses into September (30 Sep)", st.openDay === "2026-09-30" && st.month === "September 2026", `${st.openDay} / ${st.month}`);
    chk("…and the strip now shows September's days only (12, 30)", eq(st.chipText, ["12:3", "30:1"]), st.chipText.join(","));
    chk("…with its own card", eq(st.cards, ["s30"]), st.cards.join(","));

    // months: previous skips empty months and crosses the year; the picker jumps anywhere
    await page.getByTestId("candidate-month-prev").click();
    await settle(page);
    st = await readState(page);
    chk("Previous month from September skips the empty months and the year change, landing on December 2025", st.month === "December 2025" && st.openDay === "2025-12-31", `${st.month} / ${st.openDay}`);
    chk("…at the very start, Previous month and Previous day are both disabled", st.prevMonth === "true" && st.prevDay === "true", `${st.prevMonth}/${st.prevDay}`);
    await page.getByTestId("candidate-month-picker").click();
    const menu = page.getByTestId("candidate-month-menu");
    await menu.waitFor({ timeout: 4000 });
    const options = await menu.getByTestId("candidate-month-option").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    const years = await menu.evaluate((el) => [...el.querySelectorAll('[data-slot="dropdown-menu-label"]')].map((l) => l.textContent.trim()));
    notes.push(`month menu: ${years.join("/")} ${options.join(" | ")}`);
    await h.shot(page, "iday-month-menu");
    chk("the month menu lists only months with transactions, with counts, newest first", eq(options, ["October 2026, 12 transactions", "September 2026, 4 transactions", "December 2025, 1 transaction"]), options.join(" | "));
    chk("…grouped under their year", eq(years, ["2026", "2025"]), years.join(","));
    await menu.getByRole("menuitemradio", { name: /October 2026/ }).click();
    await settle(page);
    st = await readState(page);
    chk("choosing October from the menu jumps there without scrolling anything (opens its last day, 21)", st.month === "October 2026" && st.openDay === "2026-10-21", `${st.month} / ${st.openDay}`);
    await page.getByTestId("candidate-month-prev").click();
    await page.getByTestId("candidate-month-next").click();
    await settle(page);
    st = await readState(page);
    chk("arriving from an earlier month opens the FIRST day (Next month from September → 01 Oct)", st.month === "October 2026" && st.openDay === "2026-10-01", `${st.month} / ${st.openDay}`);

    // single-click affordance + layout
    const geom = await page.evaluate(() => {
      const r = (sel) => document.querySelector(sel)?.getBoundingClientRect();
      const nav = r('[data-testid="candidate-day-nav"]');
      const heading = r('[data-testid="candidate-day-heading"]');
      const firstCard = r('[data-testid="candidate-grid"] [data-testid="candidate-row"]');
      const control = r('[data-testid="candidate-month-control"]');
      const chips = [...document.querySelectorAll('[data-testid="candidate-day-chip"]')].map((c) => c.getBoundingClientRect());
      const cs = getComputedStyle(document.querySelector('[data-testid="candidate-day-nav"]'));
      return { navH: nav.height, navToCard: firstCard.top - nav.top, oneRow: chips.every((c) => Math.abs(c.top + c.height / 2 - (control.top + control.height / 2)) < 8), headingH: heading.height, chipH: chips[0].height, chipW: chips[0].width, position: cs.position };
    });
    notes.push(JSON.stringify(geom));
    chk("the day bar is one compact line (≤ 56px) with the month control and the day numbers side by side", geom.navH <= 56 && geom.oneRow, `${Math.round(geom.navH)}px, oneRow=${geom.oneRow}`);
    chk("each day is a small number (≤ 40px wide), not a card", geom.chipW <= 40, `${Math.round(geom.chipW)}px`);
    chk("cards start close under it (nav + heading ≤ 110px)", geom.navToCard <= 110, `${Math.round(geom.navToCard)}px`);
    chk("the day bar is sticky", geom.position === "sticky", geom.position);
    chk("no horizontal page scroll", !(await readState(page)).pageOverflowX);

    // reading and choosing days never writes anything
    chk("choosing days created, changed and deleted nothing (still 17 candidates)", (await countCandidates(uid)) === before && before === SPEC.length, `${before} → ${await countCandidates(uid)}`);
  },
  { viewport: { width: 1440, height: 900 }, scheme: "light" },
);

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

scenario(
  "iday-strip",
  "Day dock: on a narrow window a 31-day month scrolls sideways (wheel / keys), keeps the open day in view, fades its edges",
  async ({ page }, chk, notes) => {
    const uid = await h.authUid();
    const aug = Array.from({ length: 31 }, (_, i) => ({ id: `a${String(i + 1).padStart(2, "0")}`, date: [2026, 8, i + 1, 12, 0], amount: 100 + i, merchant: `August Shop ${i + 1}` }));
    await seed(uid, aug);
    await openDayGrid(page);
    const strip = page.getByTestId("candidate-day-strip");
    const stripState = () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-testid="candidate-day-strip"]');
        const sr = el.getBoundingClientRect();
        const sel = el.querySelector('[aria-selected="true"]');
        const cr = sel?.getBoundingClientRect();
        const main = document.querySelector("main");
        return {
          scrollLeft: Math.round(el.scrollLeft),
          overflow: el.scrollWidth > el.clientWidth + 1,
          selected: sel?.getAttribute("data-day") ?? null,
          selectedVisible: !!cr && cr.left >= sr.left - 1 && cr.right <= sr.right + 1,
          mask: getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage || "none",
          leftFade: /^linear-gradient\(to right, transparent/.test(el.style.maskImage || el.style.webkitMaskImage || ""),
          rightFade: /transparent\)$/.test(el.style.maskImage || el.style.webkitMaskImage || ""),
          mainScroll: main ? Math.round(main.scrollTop) : null,
          scrollbarHidden: getComputedStyle(el).scrollbarWidth,
          chips: el.querySelectorAll('[role="tab"]').length,
        };
      });
    let st = await stripState();
    notes.push(JSON.stringify(st));
    await h.shot(page, "iday-strip-end");
    chk("31 days on a 1100px window: the row is wider than the space and scrolls", st.chips === 31 && st.overflow, `${st.chips} chips, overflow=${st.overflow}`);
    chk("opens on 31 Aug and its day is fully in view (scrolled there)", st.selected === "2026-08-31" && st.selectedVisible && st.scrollLeft > 0, `${st.selected}, visible=${st.selectedVisible}, scrollLeft=${st.scrollLeft}`);
    chk("scrolled to the end: the left edge fades out, the right one doesn't", st.leftFade && !st.rightFade, st.mask.slice(0, 90));
    chk("no native scrollbar eats vertical space", st.scrollbarHidden === "none", st.scrollbarHidden);

    // mouse wheel over the strip scrolls it sideways, not the page
    const box = await strip.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const before = await stripState();
    await page.mouse.wheel(0, -700);
    await settle(page, 400);
    st = await stripState();
    chk("a mouse wheel over the strip scrolls it sideways", st.scrollLeft < before.scrollLeft - 100, `${before.scrollLeft} → ${st.scrollLeft}`);
    chk("…and does not scroll the page", st.mainScroll === before.mainScroll, `${before.mainScroll} → ${st.mainScroll}`);
    await page.mouse.wheel(0, -4000);
    await settle(page, 500);
    await page.mouse.wheel(0, -4000);
    await settle(page, 800); // the wheel glides (eased), so give it time to arrive
    st = await stripState();
    chk("scrolled to the start: the left fade is gone, the right one shows", st.scrollLeft <= 1 && !st.leftFade && st.rightFade, `scrollLeft=${st.scrollLeft} left=${st.leftFade} right=${st.rightFade}`);
    await h.shot(page, "iday-strip-start");

    // keyboard: Home moves the open day AND scrolls it into view
    await page.locator('[data-testid="candidate-day-chip"][aria-selected="true"]').focus();
    await page.keyboard.press("Home");
    await settle(page, 500);
    st = await stripState();
    chk("Home selects 01 Aug and keeps it in view", st.selected === "2026-08-01" && st.selectedVisible, `${st.selected}, visible=${st.selectedVisible}`);
    for (let i = 0; i < 14; i++) await page.getByTestId("candidate-day-next").click();
    await settle(page, 600);
    st = await stripState();
    chk("Next day ×14 → 15 Aug, and the row followed it", st.selected === "2026-08-15" && st.selectedVisible, `${st.selected}, visible=${st.selectedVisible}, scrollLeft=${st.scrollLeft}`);
    await page.locator('[data-testid="candidate-day-chip"][aria-selected="true"]').focus();
    await page.keyboard.press("End");
    await settle(page, 600);
    st = await stripState();
    chk("End selects 31 Aug and scrolls to the end", st.selected === "2026-08-31" && st.selectedVisible, `${st.selected}, visible=${st.selectedVisible}`);
    chk("no horizontal page scroll", !(await readState(page)).pageOverflowX);
  },
  { viewport: { width: 1100, height: 800 }, scheme: "light" },
);

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

scenario(
  "iday-filters",
  "Day-wise grid follows every filter: counts, available days/months, kept day, nearest day while empty, back on clear",
  async ({ page }, chk, notes) => {
    const uid = await h.authUid();
    await seed(uid);
    await openDayGrid(page);
    const views = page.getByRole("group", { name: "Inbox views" });
    const direction = page.getByRole("group", { name: "Filter by direction" });
    const search = page.getByRole("searchbox", { name: "Search candidates" });

    await chip(page, "2026-10-10").click();
    await settle(page);
    let st = await readState(page);
    chk("start: 10 Oct open, 17 in the inbox", st.openDay === "2026-10-10" && /17\s*in your inbox/.test(st.shown), `${st.openDay} / ${st.shown}`);

    // Attention needed → only the one candidate that needs an account
    await views.getByRole("button", { name: /Attention needed/ }).click();
    await settle(page, 500);
    st = await readState(page);
    notes.push(`attention: ${JSON.stringify({ chips: st.chipText, open: st.openDay, month: st.month, shown: st.shown })}`);
    await h.shot(page, "iday-filter-attention");
    chk("Attention needed: only 21 Oct remains, with count 1", eq(st.chipText, ["21:1"]), st.chipText.join(","));
    chk("…the open day (10 Oct, now empty) gives way to the nearest day with cards, not an empty grid", st.openDay === "2026-10-21" && eq(st.cards, ["o21b"]), `${st.openDay} ${st.cards}`);
    chk("…Showing 1 of 17", /Showing\s*1\s*of\s*17/.test(st.shown), st.shown);
    chk("…no other month is offered (nothing to choose)", !st.hasPicker && st.prevMonth === "true" && st.nextMonth === "true", `picker=${st.hasPicker} ${st.prevMonth}/${st.nextMonth}`);
    await views.getByRole("button", { name: /^All\s*\d+/ }).click();
    await settle(page, 500);
    st = await readState(page);
    chk("back to All: the chosen day (10 Oct) returns, counts are whole again", st.openDay === "2026-10-10" && eq(st.chipText, OCT_CHIPS) && st.hasPicker, `${st.openDay} / ${st.chipText.join(",")}`);

    // Clean view counts
    await views.getByRole("button", { name: /^Clean/ }).click();
    await settle(page, 500);
    st = await readState(page);
    chk("Clean: 21 Oct drops to 1 (the payroll credit), the others are untouched", st.chipText.includes("21:1") && st.chipText.includes("03:2") && st.chipText.includes("10:2"), st.chipText.join(","));
    await views.getByRole("button", { name: /^All\s*\d+/ }).click();
    await settle(page, 400);

    // Direction: Credit
    await direction.getByRole("button", { name: "Credit" }).click();
    await settle(page, 500);
    st = await readState(page);
    chk("Credit: only the payroll day is left (21 · 1), and the grid shows that card", eq(st.chipText, ["21:1"]) && eq(st.cards, ["o21a"]), `${st.chipText} ${st.cards}`);
    await direction.getByRole("button", { name: "Debit" }).click();
    await settle(page, 500);
    st = await readState(page);
    chk("Debit: 21 Oct has 1 (the unmatched debit), the rest unchanged; the chosen day (10 Oct) is back", st.openDay === "2026-10-10" && st.chipText.includes("21:1") && st.chipText.includes("10:2"), `${st.openDay} / ${st.chipText.join(",")}`);
    await direction.getByRole("button", { name: "All", exact: true }).click();
    await settle(page, 400);

    // Search across months
    await search.fill("Swiggy");
    await settle(page, 900);
    st = await readState(page);
    chk("Search 'Swiggy': a single day, 03 Oct with 1 card; the strip has just that day", eq(st.chipText, ["03:1"]) && eq(st.cards, ["o03a"]) && st.openDay === "2026-10-03", `${st.chipText} ${st.cards}`);
    await search.fill("Zomato");
    await settle(page, 900);
    st = await readState(page);
    chk("Search 'Zomato' (a September-only match): the month switches to September 2026 by itself", st.month === "September 2026" && eq(st.chipText, ["12:1"]) && eq(st.cards, ["s12a"]), `${st.month} ${st.chipText} ${st.cards}`);
    await search.fill("zzzz-nothing");
    await settle(page, 900);
    chk("A search with no match shows the ordinary empty state, not an empty day bar", (await page.getByText("No candidates match").count()) > 0 && (await page.getByTestId("candidate-day-nav").count()) === 0);
    await search.fill("");
    await settle(page, 900);
    st = await readState(page);
    chk("Clearing the search restores every day, and the day you were on (10 Oct)", st.openDay === "2026-10-10" && eq(st.chipText, OCT_CHIPS), `${st.openDay} / ${st.chipText.join(",")}`);

    // the existing month filter (toolbar) limits what the day bar can offer
    await page.getByRole("combobox", { name: "Filter by month" }).click();
    await page.getByRole("option", { name: "September 2026" }).click();
    await settle(page, 600);
    st = await readState(page);
    chk("Month filter = September 2026: the day bar offers only September (12 · 3, 30 · 1)", st.month === "September 2026" && eq(st.chipText, ["12:3", "30:1"]) && !st.hasPicker, `${st.month} ${st.chipText}`);
    await h.shot(page, "iday-filter-month");
    chk("nothing was written by filtering", (await countCandidates(uid)) === SPEC.length);
  },
  { viewport: { width: 1920, height: 1080 }, scheme: "light" },
);

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

scenario(
  "iday-actions",
  "Day-wise grid: dismiss / Undo update counts, the day survives, Select all is per day, Grid ⇄ List, leaving and returning",
  async ({ page }, chk, notes) => {
    const uid = await h.authUid();
    await seed(uid);
    await openDayGrid(page);
    const card = (id) => page.locator(`[data-testid="candidate-row"][data-candidate-id="iday-${id}"]`);
    const toast = () => page.locator('[data-toast-tone="success"]').filter({ hasText: "Candidate dismissed" }).first();

    // dismiss one of two → the day stays, its count drops; Undo brings it back
    await chip(page, "2026-10-03").click();
    await settle(page);
    await card("o03a").getByTestId("candidate-dismiss").click();
    await settle(page, 500);
    let st = await readState(page);
    chk("dismissing one of 03 Oct's two cards: the day stays open, 1 card and 1 on its chip", st.openDay === "2026-10-03" && eq(st.cards, ["o03b"]) && st.chipText.includes("03:1") && st.total === "1 transaction", `${st.cards} ${st.chipText} ${st.total}`);
    chk("…and the inbox total drops to 16", /16\s*in your inbox/.test(st.shown), st.shown);
    await toast().waitFor({ timeout: 4000 });
    await toast().getByRole("button", { name: "Undo" }).click();
    await settle(page, 500);
    st = await readState(page);
    chk("Undo restores the card and the count (03 · 2, 17 in the inbox)", eq(st.cards, ["o03b", "o03a"]) && st.chipText.includes("03:2") && /17\s*in your inbox/.test(st.shown), `${st.cards} ${st.chipText} ${st.shown}`);

    // dismiss the ONLY card of a day → nearest day takes over; Undo returns to the day
    await chip(page, "2026-10-09").click();
    await settle(page);
    await card("o09").getByTestId("candidate-dismiss").click();
    await settle(page, 600);
    st = await readState(page);
    chk("dismissing 09 Oct's only card removes its chip (no empty-day button)", !st.chipText.some((t) => t.startsWith("09")), st.chipText.join(","));
    chk("…and the view moves to the nearest day (10 Oct), never an empty grid", st.openDay === "2026-10-10" && st.cards.length === 2, `${st.openDay} ${st.cards}`);
    await toast().getByRole("button", { name: "Undo" }).click();
    await settle(page, 600);
    st = await readState(page);
    chk("Undo brings 09 Oct back AND returns to it", st.openDay === "2026-10-09" && eq(st.cards, ["o09"]) && st.chipText.includes("09:1"), `${st.openDay} ${st.cards}`);
    await page.waitForTimeout(8600);
    chk("…and the delete never ran (still in Firestore)", await candidateExists(uid, "o09"));

    // Review opens from a day card and returns to the same day, same scroll
    await chip(page, "2026-10-15").click();
    await settle(page);
    const scrollBefore = await page.evaluate(() => document.querySelector("main")?.scrollTop ?? 0);
    await card("o15a").getByRole("button", { name: /^Review/ }).click();
    await page.getByRole("dialog").first().waitFor({ timeout: 8000 });
    chk("Review opens the review sheet from a day card", await page.getByRole("dialog").first().isVisible());
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").first().waitFor({ state: "hidden", timeout: 8000 });
    await settle(page);
    st = await readState(page);
    chk("closing it lands back on 15 Oct, same cards, page not moved", st.openDay === "2026-10-15" && eq(st.cards, ["o15b", "o15a"]) && (await page.evaluate(() => document.querySelector("main")?.scrollTop ?? 0)) === scrollBefore, `${st.openDay}`);

    // Select all = this day only
    await chip(page, "2026-10-10").click();
    await settle(page);
    const selectAll = page.getByRole("checkbox", { name: /Select all visible candidates on this day/ });
    chk("the select-all says it is for this day", (await page.getByText("Select all eligible on this day").count()) === 1);
    await selectAll.click();
    await settle(page, 300);
    const ticked = () => page.locator('[data-testid="candidate-grid"] [data-testid="candidate-row"] [role="checkbox"][aria-checked="true"]').count();
    chk("Select all ticks the 2 cards of 10 Oct — and nothing else (bar: 2 selected)", (await ticked()) === 2 && (await page.getByText("2 selected", { exact: true }).count()) === 1, `${await ticked()}`);
    await chip(page, "2026-10-15").click();
    await settle(page);
    st = await readState(page);
    chk("on another day, the ticked cards are not lost and not hidden: '2 selected on other days'", st.elsewhere === "2 selected on other days" && (await ticked()) === 0, `${st.elsewhere}`);
    await selectAll.click();
    await settle(page, 300);
    chk("Select all on 15 Oct adds its 2 (4 selected in all)", (await ticked()) === 2 && (await page.getByText("4 selected", { exact: true }).count()) === 1);
    await h.shot(page, "iday-selection");

    // Grid ⇄ List keeps every row and the open day
    await page.getByRole("button", { name: "List view" }).click();
    await settle(page, 500);
    const list = await page.evaluate(() => ({
      rows: document.querySelectorAll('[data-testid="candidate-list"] [data-testid="candidate-row"]').length,
      all: document.querySelectorAll('[data-testid="candidate-row"]').length,
      nav: !!document.querySelector('[data-testid="candidate-day-nav"]'),
      open: document.querySelector('[data-testid="candidate-group"]')?.getAttribute("data-group-key"),
      heading: document.querySelector('[data-testid="candidate-day-heading"] h2')?.textContent,
    }));
    chk("List view is day-wise too: the same day bar, and only 15 Oct's 2 rows (not all 17)", list.rows === 2 && list.all === 2 && list.nav && list.open === "2026-10-15" && list.heading === "15 October 2026", JSON.stringify(list));
    await h.shot(page, "iday-list");
    await chip(page, "2026-10-10").click();
    await settle(page);
    const listDay = await page.evaluate(() => [...document.querySelectorAll('[data-testid="candidate-list"] [data-testid="candidate-row"]')].map((r) => r.getAttribute("data-candidate-id").replace(/^iday-/, "")));
    chk("a click in List swaps the rows to that day's (10 Oct: 2 rows, newest first)", eq(listDay, ["o10b", "o10a"]), listDay.join(","));
    await chip(page, "2026-10-15").click();
    await settle(page);
    await page.getByRole("button", { name: "Grid view" }).click();
    await settle(page, 500);
    st = await readState(page);
    chk("back in Grid: the same day (15 Oct) and the same selection", st.openDay === "2026-10-15" && (await ticked()) === 2 && st.elsewhere === "2 selected on other days", `${st.openDay} ${st.elsewhere}`);

    // commit one dismissal for real, then leave and come back
    await chip(page, "2026-10-09").click();
    await settle(page);
    await card("o09").getByTestId("candidate-dismiss").click();
    await page.waitForTimeout(9600);
    chk("without Undo the dismissal commits (09 Oct's candidate is gone from Firestore)", !(await candidateExists(uid, "o09")));
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(800);
    await openDayGrid(page);
    st = await readState(page);
    notes.push(`after return: ${JSON.stringify({ open: st.openDay, chips: st.chipText })}`);
    chk("returning to the Inbox lands on the nearest day to where you were (09 Oct is gone → 10 Oct)", st.openDay === "2026-10-10" && !st.chipText.some((t) => t.startsWith("09")), `${st.openDay}`);
    await chip(page, "2026-10-18").click();
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(500);
    await openDayGrid(page);
    st = await readState(page);
    chk("returning to the Inbox after choosing 18 Oct lands on 18 Oct", st.openDay === "2026-10-18", st.openDay);
  },
  { viewport: { width: 1440, height: 900 }, scheme: "light" },
);

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The scale each date number is drawn at (its font-size over the 13px rest size), keyed by day. */
const readScales = (page) =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-testid="candidate-day-chip"]')].map((c) => [c.getAttribute("data-day"), parseFloat(getComputedStyle(c.querySelector('[data-testid="candidate-day-number"]')).fontSize) / 13]),
    ),
  );
const rectsOf = (page) =>
  page.evaluate(() => {
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return [Math.round(b.left * 10) / 10, Math.round(b.top * 10) / 10, Math.round(b.width * 10) / 10, Math.round(b.height * 10) / 10];
    };
    return {
      // the CELLS (what a click lands on) — they must never move or resize while a number grows inside them
      chips: [...document.querySelectorAll('[data-testid="candidate-day-chip"]')].map(r),
      nav: r(document.querySelector('[data-testid="candidate-day-nav"]')),
      card: r(document.querySelector('[data-testid="candidate-day-nav"] > div')),
      heading: r(document.querySelector('[data-testid="candidate-day-heading"]')),
      grid: r(document.querySelector('[data-testid="candidate-group"]')),
      scroll: document.querySelector("main")?.scrollTop ?? 0,
    };
  });
const centreOfChip = async (page, day) => {
  const b = await chip(page, day).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const stripInfo = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="candidate-day-strip"]');
    const sr = el.getBoundingClientRect();
    const sel = el.querySelector('[aria-selected="true"]');
    const cr = sel?.getBoundingClientRect();
    return {
      left: Math.round(el.scrollLeft),
      max: el.scrollWidth - el.clientWidth,
      selected: sel?.getAttribute("data-day") ?? null,
      selectedVisible: !!cr && cr.left >= sr.left - 1 && cr.right <= sr.right + 1,
      dragging: el.dataset.dragging === "true",
    };
  });
/** The date whose cell is nearest the middle of the strip — always fully visible, so safe to point at. */
const middleDay = (page) =>
  page.evaluate(() => {
    const s = document.querySelector('[data-testid="candidate-day-strip"]').getBoundingClientRect();
    const mid = s.left + s.width / 2;
    const chips = [...document.querySelectorAll('[data-testid="candidate-day-chip"]')];
    return chips.map((el) => ({ d: el.getAttribute("data-day"), x: Math.abs(el.getBoundingClientRect().left + 17 - mid) })).sort((a, b) => a.x - b.x)[0].d;
  });
const numberFill = (page, day) => chip(page, day).evaluate((c) => getComputedStyle(c.querySelector('[data-testid="candidate-day-number"]')).backgroundColor);
const liftOf = (page, day) => chip(page, day).evaluate((c) => Number(getComputedStyle(c.querySelector('[data-testid="candidate-day-number"]'), "::before").opacity));
const clear = (c) => /rgba\(.*,\s*0\)$/.test(c) || c === "transparent";

scenario(
  "iday-dock",
  "Date navigator: Dock-style magnification that follows the mouse, eased wheel + trackpad + drag scrolling, instant selection, nothing shifts",
  async ({ page }, chk, notes) => {
    const uid = await h.authUid();
    const aug = Array.from({ length: 31 }, (_, i) => ({ id: `k${String(i + 1).padStart(2, "0")}`, date: [2026, 8, i + 1, 12, 0], amount: 100 + i, merchant: `August Shop ${i + 1}` }));
    aug.push({ id: "k14b", date: [2026, 8, 14, 18, 0], amount: 50, merchant: "August Extra" });
    const sep = [3, 10, 17, 24, 30].map((d) => ({ id: `p${d}`, date: [2026, 9, d, 12, 0], amount: 200 + d, merchant: `September Shop ${d}` }));
    await seed(uid, [...aug, ...sep]);
    await openDayGrid(page);
    // Record every wheel event the page sees AFTER the strip had its say, with whether it was claimed (preventDefault) by the strip.
    await page.evaluate(() => {
      window.__wheel = [];
      window.addEventListener("wheel", (e) => window.__wheel.push({ dy: e.deltaY, claimed: e.defaultPrevented }), { passive: true });
    });
    const wheelLog = () => page.evaluate(() => window.__wheel);

    let info = await stripInfo(page);
    chk("opens on the newest day (30 Sep) and September's few dates fit without scrolling", info.selected === "2026-09-30" && info.max <= 1, JSON.stringify(info));
    await h.shot(page, "iday-dock-sep");

    // ── 8. Switch months: the strip is re-created, the open day is placed in view at once (no sudden jump) ──
    await page.getByTestId("candidate-month-prev").click();
    await page.waitForTimeout(60);
    info = await stripInfo(page);
    chk("switching to August opens its LAST day (31 Aug) already in view (no slide / jump)", info.selected === "2026-08-31" && info.selectedVisible && info.max > 1, JSON.stringify(info));
    await settle(page, 300);
    const rest = await readScales(page);
    chk("at rest every date number is its natural size", Object.values(rest).every((v) => Math.abs(v - 1) < 0.01), JSON.stringify(Object.values(rest).slice(0, 3)));
    const base = await rectsOf(page);
    notes.push(`cell ${base.chips[0]}, card ${base.card}, nav ${base.nav}`);
    chk("each date cell is a fixed 34×34 target", base.chips.every((c) => Math.abs(c[2] - 34) < 0.6 && Math.abs(c[3] - 34) < 0.6), `${base.chips[0][2]}×${base.chips[0][3]}`);
    chk("the whole navigator stays compact (card ≤ 46px)", base.card[3] <= 46, `${base.card[3]}px`);
    await h.shot(page, "iday-dock-rest");

    // ── 5. Horizontal scrolling to the start with the mouse wheel — eased, and the page does not move ──
    const strip = page.getByTestId("candidate-day-strip");
    const box = await strip.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const before = await stripInfo(page);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(50);
    const early = await stripInfo(page);
    await settle(page, 500);
    const afterOne = await stripInfo(page);
    notes.push(`wheel -300: ${before.left} → ${early.left} (50ms) → ${afterOne.left}`);
    chk("the wheel over the strip scrolls it sideways, gliding (not one jump)", afterOne.left < before.left - 150 && early.left > afterOne.left && early.left < before.left, `${before.left} → ${early.left} → ${afterOne.left}`);
    chk("…and the page did not scroll", (await rectsOf(page)).scroll === base.scroll);
    await page.mouse.wheel(0, -5000);
    await settle(page, 900);
    info = await stripInfo(page);
    chk("wheeled all the way to the start (01 Aug reachable)", info.left <= 1, `${info.left}`);
    await page.mouse.wheel(0, -200);
    await settle(page, 200);
    const log = await wheelLog();
    chk("while the strip can still move the wheel is claimed; once it has ARRIVED at the start the page keeps it", log.length >= 3 && log[0].claimed === true && log[log.length - 1].claimed === false && (await stripInfo(page)).left <= 1, JSON.stringify(log.map((w) => w.claimed)));
    await h.shot(page, "iday-dock-start");

    // ── 1. Hover 01: it grows to ~1.5×, 02 ~1.2×, the rest stay ──
    const still = await rectsOf(page); // the layout at rest AFTER scrolling to the start — the hover must not change it
    const c01 = await centreOfChip(page, "2026-08-01");
    await page.mouse.move(c01.x + 120, c01.y);
    await page.mouse.move(c01.x, c01.y, { steps: 8 });
    await settle(page, 350);
    let sc = await readScales(page);
    notes.push(`hover 01: ${JSON.stringify({ 1: sc["2026-08-01"], 2: sc["2026-08-02"], 3: sc["2026-08-03"], 5: sc["2026-08-05"] })}`);
    await h.shot(page, "iday-dock-hover-01");
    chk("hovering 01 grows it to 1.4–1.6×", sc["2026-08-01"] >= 1.4 && sc["2026-08-01"] <= 1.6, sc["2026-08-01"].toFixed(2));
    chk("…its neighbour 02 grows to 1.15–1.25×", sc["2026-08-02"] >= 1.15 && sc["2026-08-02"] <= 1.25, sc["2026-08-02"].toFixed(2));
    chk("…03 barely moves and dates further away stay at rest", sc["2026-08-03"] < 1.06 && sc["2026-08-06"] < 1.01 && sc["2026-08-12"] < 1.01, `${sc["2026-08-03"].toFixed(3)} / ${sc["2026-08-06"].toFixed(3)}`);
    chk("…the hovered number gets its soft lifted backdrop, a resting one has none", (await liftOf(page, "2026-08-01")) > 0.9 && (await liftOf(page, "2026-08-10")) === 0);

    // ── no layout shift, clipping or overlap at the peak ──
    const during = await rectsOf(page);
    const shifted = during.chips.some((c, i) => c.some((v, k) => Math.abs(v - still.chips[i][k]) > 0.6)) || during.nav.some((v, k) => Math.abs(v - still.nav[k]) > 0.6) || during.card.some((v, k) => Math.abs(v - still.card[k]) > 0.6) || during.heading.some((v, k) => Math.abs(v - still.heading[k]) > 0.6) || during.grid.some((v, k) => Math.abs(v - still.grid[k]) > 0.6);
    chk("magnifying moves NOTHING: no cell, card, heading or card-grid shifted a pixel (click targets stay put)", !shifted);
    const geo = await page.evaluate(() => {
      const strip = document.querySelector('[data-testid="candidate-day-strip"]').getBoundingClientRect();
      const nums = [...document.querySelectorAll('[data-testid="candidate-day-chip"]')].map((c) => ({ day: c.getAttribute("data-day"), r: c.querySelector('[data-testid="candidate-day-number"]').getBoundingClientRect() }));
      const clipped = nums.filter((n) => n.r.top < strip.top - 0.5 || n.r.bottom > strip.bottom + 0.5).map((n) => n.day);
      const overlaps = [];
      for (let i = 1; i < nums.length; i++) if (nums[i].r.width > 0 && nums[i - 1].r.right > nums[i].r.left + 0.5 && Math.abs(nums[i].r.top - nums[i - 1].r.top) < 30) overlaps.push(`${nums[i - 1].day}/${nums[i].day}`);
      return { clipped, overlaps };
    });
    chk("nothing is clipped by the bar and no two numbers overlap at the peak", geo.clipped.length === 0 && geo.overlaps.length === 0, JSON.stringify(geo));

    // ── 2. Move to 03 — the magnification follows ──
    const c03 = await centreOfChip(page, "2026-08-03");
    await page.mouse.move(c03.x, c03.y, { steps: 10 });
    await settle(page, 350);
    sc = await readScales(page);
    notes.push(`hover 03: ${JSON.stringify({ 1: sc["2026-08-01"], 2: sc["2026-08-02"], 3: sc["2026-08-03"], 4: sc["2026-08-04"] })}`);
    await h.shot(page, "iday-dock-hover-03");
    chk("moving to 03: it is now the peak (1.4–1.6×) and 01 has relaxed back (< 1.06)", sc["2026-08-03"] >= 1.4 && sc["2026-08-03"] <= 1.6 && sc["2026-08-01"] < 1.06, `03=${sc["2026-08-03"].toFixed(2)} 01=${sc["2026-08-01"].toFixed(2)}`);
    chk("…02 and 04 are the ~1.2× neighbours, equally", sc["2026-08-02"] > 1.15 && sc["2026-08-04"] > 1.15 && Math.abs(sc["2026-08-02"] - sc["2026-08-04"]) < 0.06, `${sc["2026-08-02"].toFixed(2)} / ${sc["2026-08-04"].toFixed(2)}`);

    // ── 3. Sweep across several dates: the peak follows, smoothly, no flicker ──
    const c12 = await centreOfChip(page, "2026-08-12");
    const samples = [];
    for (let i = 0; i <= 24; i++) {
      await page.mouse.move(c03.x + ((c12.x - c03.x) * i) / 24, c03.y);
      await page.waitForTimeout(45);
      samples.push(await readScales(page));
    }
    const peaks = samples.map((v) => Object.entries(v).sort((a, b) => b[1] - a[1])[0][0]);
    const peakDays = peaks.map((p) => Number(p.slice(-2)));
    const monotone = peakDays.every((d, i) => i === 0 || d >= peakDays[i - 1]);
    // the biggest frame-to-frame change of any one number during the sweep
    let worstJump = 0;
    for (let i = 1; i < samples.length; i++) for (const k of Object.keys(samples[i])) worstJump = Math.max(worstJump, Math.abs(samples[i][k] - samples[i - 1][k]));
    notes.push(`sweep 03→12: peaks ${peakDays.join(",")} worst jump ${worstJump.toFixed(2)}`);
    chk("sweeping 03 → 12: the peak moves steadily forward (never back, never skipping around)", monotone && peakDays[0] <= 4 && peakDays[peakDays.length - 1] >= 11, peakDays.join(","));
    chk("…no number ever jumps by more than 0.3× between samples (fluid, no flicker)", worstJump < 0.3, worstJump.toFixed(2));
    chk("…exactly ONE number is at the peak in every sample", samples.every((v) => Object.values(v).filter((x) => x > 1.4).length <= 1));

    // ── 7. Click a magnified date: it selects at once, and stays highlighted after the hover ends ──
    const c20 = await centreOfChip(page, "2026-08-20");
    await page.mouse.move(c20.x, c20.y, { steps: 8 });
    await settle(page, 300);
    const magnified = (await readScales(page))["2026-08-20"];
    const t0 = Date.now();
    await page.mouse.click(c20.x, c20.y);
    await page.getByRole("heading", { name: "20 August 2026" }).waitFor({ timeout: 3000 });
    const took = Date.now() - t0;
    await settle(page, 300);
    let st = await readState(page);
    const afterClick = await rectsOf(page);
    chk("clicking the magnified 20 opens it: heading, count and card", magnified > 1.4 && st.openDay === "2026-08-20" && st.heading === "20 August 2026" && st.total === "1 transaction" && eq(st.cards, ["k20"]), `${magnified.toFixed(2)}× ${st.openDay} ${st.total} ${st.cards}`);
    chk("…immediately (≤ 600ms, including the click)", took <= 600, `${took}ms`);
    chk("…no cell, card or heading moved and the page did not scroll", afterClick.chips.every((c, i) => c[1] === base.chips[i][1]) && afterClick.card.every((v, k) => Math.abs(v - base.card[k]) < 0.6) && afterClick.scroll === base.scroll);
    await page.mouse.move(c20.x, c20.y + 260, { steps: 6 });
    await settle(page, 400);
    sc = await readScales(page);
    chk("…and when the mouse leaves every date returns to its natural size", Object.values(sc).every((v) => Math.abs(v - 1) < 0.01), JSON.stringify(Object.entries(sc).filter(([, v]) => Math.abs(v - 1) >= 0.01)));
    chk("…while 20 stays the highlighted date and 31 is plain again", !clear(await numberFill(page, "2026-08-20")) && clear(await numberFill(page, "2026-08-31")), await numberFill(page, "2026-08-20"));
    await h.shot(page, "iday-dock-selected");

    // ── 6. Click-and-drag across the strip ──
    const cd = await centreOfChip(page, "2026-08-14");
    const s0 = await stripInfo(page);
    await page.mouse.move(cd.x, cd.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(cd.x - i * 20, cd.y);
      await page.waitForTimeout(40);
    }
    const mid = await stripInfo(page);
    notes.push(`drag: ${s0.left} → ${mid.left} (pointer moved 200px)`);
    const expectLeft = Math.min(s0.max, s0.left + 200);
    chk("dragging 200px left scrolls the strip exactly 1:1 while held (the grabbing state is on)", Math.abs(mid.left - expectLeft) <= 2 && mid.dragging && mid.left > s0.left + 100, `${s0.left} → ${mid.left} (expected ${expectLeft}), dragging=${mid.dragging}`);
    await h.shot(page, "iday-dock-drag");
    await page.mouse.up();
    await settle(page, 600);
    st = await readState(page);
    const afterDrag = await stripInfo(page);
    chk("releasing a drag does NOT select the date it ended on (still 20 Aug)", st.openDay === "2026-08-20" && !afterDrag.dragging, `${st.openDay}`);
    // drag back to the right (towards earlier dates)
    await page.mouse.move(cd.x, cd.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(cd.x + i * 25, cd.y);
      await page.waitForTimeout(40);
    }
    await page.mouse.up();
    await settle(page, 700);
    const back = await stripInfo(page);
    chk("dragging right scrolls back towards earlier dates", back.left < afterDrag.left - 100, `${afterDrag.left} → ${back.left}`);
    // a plain click right after still selects
    const target = await middleDay(page);
    const ct = await centreOfChip(page, target);
    await page.mouse.click(ct.x, ct.y);
    await settle(page, 300);
    st = await readState(page);
    chk("an ordinary click after dragging selects normally again", st.openDay === target, `${st.openDay} vs ${target}`);

    // ── 4. magnification keeps working after scrolling and month switches ──
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const logBefore = (await wheelLog()).length;
    // a hard spin: the 2nd and 3rd events arrive while the strip is still gliding towards the end — they must stay with the strip, not leak to the page
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(30);
    await page.mouse.wheel(0, 5000);
    await page.waitForTimeout(30);
    await page.mouse.wheel(0, 5000);
    await settle(page, 1000);
    const later = await stripInfo(page);
    const spin = (await wheelLog()).slice(logBefore);
    chk("scrolling right with the wheel reaches the last dates (31 Aug reachable)", later.left >= later.max - 1 && later.left > back.left + 100, `${back.left} → ${later.left} / ${later.max}`);
    chk("…a hard spin never leaks to the page while the strip is still gliding (all 3 events claimed)", spin.length === 3 && spin.every((w) => w.claimed), JSON.stringify(spin.map((w) => w.claimed)));
    await page.mouse.wheel(0, 300);
    await settle(page, 200);
    const atEnd = (await wheelLog()).slice(-1)[0];
    chk("…and once it has arrived at the end the page gets the wheel back", atEnd.claimed === false, JSON.stringify(atEnd));
    const visibleDay = await middleDay(page);
    const cv = await centreOfChip(page, visibleDay);
    await page.mouse.move(cv.x - 60, cv.y);
    await page.mouse.move(cv.x, cv.y, { steps: 6 });
    await settle(page, 350);
    sc = await readScales(page);
    chk("after scrolling, the date now under the pointer magnifies correctly (1.4–1.6×)", sc[visibleDay] >= 1.4 && sc[visibleDay] <= 1.6, `${visibleDay} ${sc[visibleDay].toFixed(2)}`);
    await page.getByTestId("candidate-month-next").click();
    await page.waitForTimeout(80);
    info = await stripInfo(page);
    chk("switching back to September: its first day (03 Sep) is open and in view", info.selected === "2026-09-03" && info.selectedVisible, JSON.stringify(info));
    const c10s = await centreOfChip(page, "2026-09-10");
    await page.mouse.move(c10s.x - 70, c10s.y);
    await page.mouse.move(c10s.x, c10s.y, { steps: 6 });
    await settle(page, 350);
    sc = await readScales(page);
    chk("magnification works on the new month too (10 Sep 1.4–1.6×, 03 Sep relaxed)", sc["2026-09-10"] >= 1.4 && sc["2026-09-10"] <= 1.6 && sc["2026-09-03"] < 1.2, `${sc["2026-09-10"].toFixed(2)} / ${sc["2026-09-03"].toFixed(2)}`);
    await page.mouse.click(c10s.x, c10s.y);
    await page.getByRole("heading", { name: "10 September 2026" }).waitFor({ timeout: 3000 });
    st = await readState(page);
    chk("…and clicking it opens 10 Sep", st.openDay === "2026-09-10" && eq(st.cards, ["p10"]), `${st.openDay} ${st.cards}`);

    // ── prev / next still step between days, and bring the open day into view ──
    await page.mouse.move(c10s.x, c10s.y + 260);
    await page.getByTestId("candidate-day-prev").click();
    await settle(page, 300);
    st = await readState(page);
    chk("‹ steps to the previous day (03 Sep)", st.openDay === "2026-09-03", st.openDay);
    for (let i = 0; i < 2; i++) await page.getByTestId("candidate-day-prev").click();
    await settle(page, 700);
    info = await stripInfo(page);
    chk("‹ ‹ crosses into August (31 Aug... then 30 Aug) and the open date is in view", info.selected === "2026-08-30" && info.selectedVisible, JSON.stringify(info));

    // ── List view: the same navigator ──
    await page.getByRole("button", { name: "List view" }).click();
    await settle(page, 400);
    const listOk = await page.evaluate(() => !!document.querySelector('[data-testid="candidate-day-nav"]') && document.querySelectorAll('[data-testid="candidate-list"] [data-testid="candidate-row"]').length === 1);
    chk("List view: the same navigator, that day's single row", listOk);
    await page.getByRole("button", { name: "Grid view" }).click();
    await settle(page, 300);

    // ── reduced motion: plain row, no magnification ──
    await page.emulateMedia({ reducedMotion: "reduce" });
    const cr = await centreOfChip(page, "2026-08-22");
    await page.mouse.move(cr.x - 70, cr.y);
    await page.mouse.move(cr.x, cr.y, { steps: 5 });
    await settle(page, 350);
    sc = await readScales(page);
    chk("with reduced motion on, nothing is magnified", Object.values(sc).every((v) => Math.abs(v - 1) < 0.01), JSON.stringify(Object.entries(sc).filter(([, v]) => Math.abs(v - 1) >= 0.01)));
    chk("nothing was written", (await countCandidates(uid)) === aug.length + sep.length);
  },
  { viewport: { width: 1440, height: 900 }, scheme: "light" },
);

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

for (const [name, vp, scheme] of [
  ["l1366-light", { width: 1366, height: 768 }, "light"],
  ["d1920-dark", { width: 1920, height: 1080 }, "dark"],
]) {
  scenario(
    `iday-visual-${name}`,
    `Day-wise grid looks right and keeps the existing cards (${vp.width}x${vp.height}, ${scheme})`,
    async ({ page }, chk, notes) => {
      const uid = await h.authUid();
      await seed(uid);
      await openDayGrid(page);
      await chip(page, "2026-10-10").click();
      await settle(page, 500);
      const m = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('[data-testid="candidate-grid"] [data-testid="candidate-row"]')];
        const rects = cards.map((c) => c.getBoundingClientRect());
        const nav = document.querySelector('[data-testid="candidate-day-nav"]');
        const sel = nav.querySelector('[aria-selected="true"] [data-testid="candidate-day-number"]');
        const idle = nav.querySelector('[aria-selected="false"] [data-testid="candidate-day-number"]');
        const sc = getComputedStyle(sel);
        const ic = getComputedStyle(idle);
        const card = cards[0];
        return {
          count: cards.length,
          heights: [...new Set(rects.map((r) => Math.round(r.height)))],
          radius: getComputedStyle(card).borderTopLeftRadius,
          hasCheckbox: cards.every((c) => !!c.querySelector('[role="checkbox"]')),
          hasReview: cards.every((c) => !!c.querySelector("button[data-review-id]")),
          hasDismiss: cards.every((c) => !!c.querySelector('[data-testid="candidate-dismiss"]')),
          selBg: sc.backgroundColor,
          selFg: sc.color,
          idleBg: ic.backgroundColor,
          idleFg: ic.color,
          navBg: getComputedStyle(nav).backgroundColor,
          shelfBg: getComputedStyle(nav.firstElementChild).backgroundColor,
          idleNum: getComputedStyle(nav.querySelector('[aria-selected="false"] [data-testid="candidate-day-number"]')).color,
          pageOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          chipClipped: [...nav.querySelectorAll('[data-testid="candidate-day-number"]')].some((c) => c.scrollWidth > c.clientWidth + 1),
          navH: nav.getBoundingClientRect().height,
        };
      });
      notes.push(JSON.stringify(m));
      await h.shot(page, `iday-visual-${name}`);
      // The theme uses oklch()/oklab(): take their lightness (0–1) straight; rgb() colours use the usual luma. Both on a 0–255 scale.
      const lum = (c) => {
        const ok = c.match(/^ok(?:lch|lab)\(([\d.]+)(%?)/);
        if (ok) return (ok[2] ? Number(ok[1]) / 100 : Number(ok[1])) * 255;
        const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      chk("10 Oct shows its 2 cards, unchanged in shape (≤ 180px, 10px corners)", m.count === 2 && m.heights.every((x) => x <= 180) && m.radius === "10px", `${m.count} ${m.heights} ${m.radius}`);
      chk("every card still has its checkbox, Review and Dismiss", m.hasCheckbox && m.hasReview && m.hasDismiss);
      chk("the open day is a filled pill, the others plain (selected fill is opaque, idle has none)", lum(m.selBg) !== lum(m.idleBg) && /rgba\(.*,\s*0\)$/.test(m.idleBg), `${m.selBg} vs ${m.idleBg}`);
      chk("selected number is legible on its fill", Math.abs(lum(m.selBg) - lum(m.selFg)) > 90, `${m.selFg} on ${m.selBg}`);
      chk("idle numbers are legible on the navigator card", Math.abs(lum(m.shelfBg) - lum(m.idleNum)) > 70, `${m.idleNum} on ${m.shelfBg}`);
      chk("the sticky bar has an opaque background (cards never show through)", !/rgba\(.*,\s*0\)$/.test(m.navBg) && m.navBg !== "transparent", m.navBg);
      chk("the navigator stays compact (≤ 56px incl. its sticky padding)", m.navH <= 56, `${Math.round(m.navH)}px`);
      chk("no chip text is clipped, no horizontal page scroll", !m.chipClipped && !m.pageOverflowX);
    },
    { viewport: vp, scheme },
  );
}
