/**
 * Smart Capture sweep (testing-phase check): the page renders without errors or overflow, every control (tabs, clear, clipboard,
 * extract, image choose / replace / remove / crop / drop / paste, column mapping, header actions + confirmations) does what its
 * label says, pasted text and screenshots are read to the exact date / description / amount / Cr-Dr, and the duplicates Review &
 * Import shows are the right ones. Local emulator only; Smart Capture itself must write nothing. Scenario ids: sc-sweep-*
 *
 * Screenshots are SYNTHETIC (HTML tables captured with Playwright), so the ground truth is known exactly.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
import { BASE_URL } from "../lib/env.mjs";

const IGNORED = /Select is changing|status of 400|React DevTools|Download the React/;
const flat = (s) => String(s).replace(/\s+/g, " ").trim();
const pad2 = (n) => String(n).padStart(2, "0");
const day = (offset) => new Date(Date.now() + offset * 86400000);
const ddmmyyyy = (offset) => `${pad2(day(offset).getDate())}/${pad2(day(offset).getMonth() + 1)}/${day(offset).getFullYear()}`;
const fmtIn = (n) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const paise = (n) => Math.round(n * 100);

async function snapshotWrites() {
  const [txns, accounts, imports] = await Promise.all([h.list("transactions"), h.list("accounts"), h.list("documentImports")]);
  return JSON.stringify({ txns: txns.length, balances: accounts.map((a) => `${a.name}:${a.currentBalance}`).sort(), imports: imports.length });
}

async function openCapture(page) {
  await page.evaluate(() => window.next.router.push("/smart-capture"));
  await page.getByRole("heading", { name: "Smart Capture" }).waitFor({ timeout: 240000 });
  await page.waitForTimeout(800);
}

/** A second tab in the same signed-in browser: its own sessionStorage and in-memory handoff, so each capture starts clean. */
async function freshTab(ctx, logs) {
  const p = await ctx.newPage();
  p.on("console", (m) => {
    if (["error", "warning"].includes(m.type())) logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`);
  });
  p.on("pageerror", (e) => logs.push(`[pageerror] ${String(e).slice(0, 300)}`));
  await p.goto(`${BASE_URL}/smart-capture`, { waitUntil: "domcontentloaded" });
  await p.getByRole("heading", { name: "Smart Capture" }).waitFor({ timeout: 240000 });
  await p.waitForTimeout(1000);
  return p;
}

const atRecon = (page, timeout = 240000) => page.waitForFunction(() => location.pathname.replace(/[/]$/, "") === "/reconciliation", null, { timeout });
const reconRow = (page, desc) => page.locator('[data-testid="recon-row"]').filter({ hasText: desc }).first();
const reconRows = (page) =>
  page.getByTestId("recon-row").evaluateAll((els) =>
    els.map((e) => ({
      id: e.dataset.rowId,
      state: e.dataset.state,
      amount: e.dataset.amount === "" ? null : Number(e.dataset.amount),
      dir: e.dataset.direction,
      desc: e.dataset.description,
      decision: e.dataset.decision,
      text: e.innerText.replace(/\s+/g, " ").trim(),
      check: e.querySelector('[data-testid="row-check-label"]')?.textContent ?? null,
    })),
  );

/** Optional "Match your columns" step: confirm the detected columns (no-op when the text isn't a table). */
async function confirmColumns(page) {
  const confirm = page.getByTestId("mapping-confirm");
  await Promise.race([confirm.waitFor({ timeout: 120000 }).catch(() => null), atRecon(page, 120000).catch(() => null)]);
  if (await confirm.count()) await confirm.click();
}

async function landOnReview(page) {
  await confirmColumns(page);
  await atRecon(page);
  await page.getByRole("heading", { name: "Review & Import" }).waitFor({ timeout: 240000 });
  await page.getByTestId("handoff-notice").waitFor({ timeout: 240000 });
}

async function chooseAccount(page, name) {
  await page.getByRole("button", { name: /(Choose|Change) statement account/ }).click();
  await page.getByRole("option", { name: new RegExp(name) }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-row"]')].every((r) => r.getAttribute("data-state") !== "pending"), null, { timeout: 90000 });
  await page.getByTestId("import-summary").waitFor({ timeout: 60000 });
}

/** Paste text → Extract → (columns) → Review & Import, on a fresh tab. Returns { tab, rows }. */
async function pasteAndRead(ctx, logs, text, { account = "QA Bank" } = {}) {
  const tab = await freshTab(ctx, logs);
  await tab.getByLabel("Pasted statement text").fill(text);
  await tab.getByRole("button", { name: /Extract transactions/ }).click();
  await landOnReview(tab);
  if (account) await chooseAccount(tab, account);
  return { tab, rows: await reconRows(tab) };
}

/** Expected-vs-read comparison in statement order. Date is checked against the row's own text ("05 Sep 2026"). */
function compare(truth, rows) {
  const monthName = (d) => d.toLocaleString("en-IN", { month: "short" });
  const bad = [];
  truth.forEach((t, i) => {
    const r = rows[i];
    if (!r) return bad.push(`row ${i + 1}: missing (${t.desc})`);
    if (paise(r.amount ?? -1) !== paise(t.amount)) bad.push(`row ${i + 1} ${t.desc}: amount ${r.amount} ≠ ${t.amount}`);
    if (r.dir !== t.dir) bad.push(`row ${i + 1} ${t.desc}: direction ${r.dir} ≠ ${t.dir}`);
    if (!r.desc.toUpperCase().includes(t.desc.toUpperCase().slice(0, 8))) bad.push(`row ${i + 1}: description "${r.desc}" ≠ "${t.desc}"`);
    if (t.date) {
      const d = t.date;
      // Review & Import lists a row's date as "07 Nov" (the year is implied by the statement period).
      const hit = new RegExp(`\\b0?${d.getDate()}\\s+${monthName(d).slice(0, 3)}`, "i").test(r.text);
      if (!hit) bad.push(`row ${i + 1} ${t.desc}: date ${d.toDateString()} not found in "${r.text.slice(0, 80)}"`);
    }
  });
  if (rows.length !== truth.length) bad.push(`row count ${rows.length} ≠ ${truth.length}`);
  return bad;
}

// ---------------------------------------------------------------------------------------------------------------

scenario("sc-sweep-render", "Smart Capture sweep: page renders, tabs and header OK, no errors / overflow (desktop, dark, tablet, mobile), nothing written", async ({ page, logs }, chk) => {
  const before = await snapshotWrites();
  await openCapture(page);
  const text = flat(await page.locator("main").innerText());
  await h.shot(page, "sc-sweep-desktop");
  chk("header: Smart Capture + 2-step progress", (await page.getByRole("list", { name: "Progress" }).innerText()).replace(/\s+/g, " ").match(/Capture.*Review & Import/s) != null);
  chk("'Review & Import' step disabled until a capture is handed over", await page.getByTestId("workspace-header").getByRole("button", { name: "Review & Import" }).isDisabled());
  chk("privacy note shown", /Processed on this device/i.test(await page.locator("body").innerText()));
  chk("two source tabs: Paste text (selected) / Screenshot", (await page.getByRole("tab", { name: /Paste text/ }).getAttribute("aria-selected")) === "true" && (await page.getByRole("tab", { name: /Screenshot/ }).getAttribute("aria-selected")) === "false");
  chk("three how-to steps", /Open your card statement/.test(text) && /Select just the transaction rows/.test(text) && /Paste below and extract/.test(text));
  chk("Extract disabled while empty", await page.getByRole("button", { name: /Extract transactions/ }).isDisabled());
  chk("sample placeholder shown", ((await page.getByLabel("Pasted statement text").getAttribute("placeholder")) ?? "").includes("SWIGGY"));
  chk("no header source actions with nothing captured", (await page.getByTestId("clear-capture").count()) === 0 && (await page.getByTestId("paste-new").count()) === 0);
  chk("no NaN / undefined", !/NaN|undefined|Infinity/.test(text));

  const overflow = () => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, mw: document.querySelector("main").scrollWidth, mc: document.querySelector("main").clientWidth }));
  for (const [name, vp] of [["desktop", null], ["laptop", { width: 1366, height: 768 }], ["tablet", { width: 768, height: 1024 }], ["mobile", { width: 390, height: 844 }], ["narrow", { width: 320, height: 640 }]]) {
    if (vp) { await page.setViewportSize(vp); await page.waitForTimeout(800); await h.shot(page, `sc-sweep-${name}`); }
    const o = await overflow();
    chk(`${name}: no horizontal overflow`, o.sw <= o.cw + 1 && o.mw <= o.mc + 1, JSON.stringify(o));
    if (name === "desktop") { await page.emulateMedia({ colorScheme: "dark" }); await page.waitForTimeout(500); await h.shot(page, "sc-sweep-dark"); await page.emulateMedia({ colorScheme: "light" }); }
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  // Screenshot tab, desktop and phone
  await page.getByRole("tab", { name: /Screenshot/ }).click();
  await page.waitForTimeout(400);
  await h.shot(page, "sc-sweep-screenshot-tab");
  const t2 = flat(await page.locator("main").innerText());
  chk("Screenshot tab: drop zone + Choose image + limits", /Drop a screenshot/.test(t2) && (await page.getByRole("button", { name: "Choose image" }).count()) === 1 && /15 MB/.test(t2));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  const o2 = await overflow();
  chk("Screenshot tab (phone): no horizontal overflow", o2.sw <= o2.cw + 1, JSON.stringify(o2));
  await page.setViewportSize({ width: 1366, height: 768 });
  const unnamed = await page.evaluate(() => [...document.querySelectorAll("main button, main a[href], main input, main select, main textarea")].filter((el) => el.getClientRects().length > 0 && !el.closest("[inert]") && el.type !== "file").filter((el) => !((el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || el.title || (el.labels && el.labels[0]?.innerText) || "").trim())).map((el) => `${el.tagName}.${String(el.className).slice(0, 40)}`));
  chk("every visible control has an accessible name", unnamed.length === 0, unnamed.slice(0, 5).join(" | "));
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 4).join(" || "));
  chk("page wrote nothing", (await snapshotWrites()) === before);
});

scenario("sc-sweep-text-input", "Smart Capture sweep (paste): Extract enable/disable, clear, line count, tab switch keeps text, clipboard button, garbage/empty input messages, header actions", async ({ page, ctx, logs }, chk) => {
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(BASE_URL).origin }).catch(() => {});
  const before = await snapshotWrites();
  await openCapture(page);
  const ta = page.getByLabel("Pasted statement text");
  const extract = page.getByRole("button", { name: /Extract transactions/ });

  await ta.fill("   \n  \t ");
  chk("whitespace only keeps Extract disabled", await extract.isDisabled());
  await ta.fill("hello world\nthis is not a statement\nnothing here");
  chk("some text enables Extract", await extract.isEnabled());
  chk("line counter shows 3 lines", /3 lines/.test(await page.locator("main").innerText()));
  await extract.click();
  const err = page.getByRole("alert").filter({ hasText: /No transaction rows found/ });
  await err.waitFor({ timeout: 15000 });
  chk("no rows → clear error that tells what a row looks like", /start with a date/.test(await err.innerText()), await err.innerText());
  chk("still on Smart Capture (nothing handed over)", new URL(page.url()).pathname.replace(/\/$/, "") === "/smart-capture");

  // header source actions appear once there is text
  chk("header shows Paste new statement + Clear capture once text exists", (await page.getByTestId("paste-new").count()) === 1 && (await page.getByTestId("clear-capture").count()) === 1);
  chk("privacy note replaced by actions", (await page.locator("[data-testid=workspace-header]").innerText()).indexOf("Processed on this device") === -1);

  // Tab switch keeps the text
  await page.getByRole("tab", { name: /Screenshot/ }).click();
  await page.getByRole("tab", { name: /Paste text/ }).click();
  chk("switching tabs keeps the pasted text", (await ta.inputValue()).startsWith("hello world"));
  chk("switching tabs clears the old error", (await page.locator("p[role=alert]").count()) === 0, await page.locator("p[role=alert]").allInnerTexts());
  await page.getByRole("tab", { name: /Screenshot/ }).click();
  chk("the Screenshot tab does not show the pasted-text error", (await page.locator("p[role=alert]").count()) === 0, await page.locator("p[role=alert]").allInnerTexts());
  await page.getByRole("tab", { name: /Paste text/ }).click();

  // Clear (X)
  await page.getByRole("button", { name: "Clear pasted text" }).click();
  chk("X clears the text and disables Extract", (await ta.inputValue()) === "" && (await extract.isDisabled()));
  chk("X button gone when empty", (await page.getByRole("button", { name: "Clear pasted text" }).count()) === 0);

  // Clipboard button
  const hasClipBtn = (await page.getByRole("button", { name: "Paste from clipboard" }).count()) === 1;
  chk("'Paste from clipboard' button present", hasClipBtn);
  if (hasClipBtn) {
    await page.evaluate(() => navigator.clipboard.writeText("05/09/2026\tCLIPBOARD CAFE\t120.00 Dr"));
    await page.getByRole("button", { name: "Paste from clipboard" }).click();
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="Pasted statement text"]')?.value.includes("CLIPBOARD CAFE"), null, { timeout: 8000 }).catch(() => {});
    chk("clipboard text lands in the box", (await ta.inputValue()).includes("CLIPBOARD CAFE"), await ta.inputValue());
    await page.evaluate(() => navigator.clipboard.writeText("   "));
    await page.getByRole("button", { name: "Paste from clipboard" }).click();
    await page.getByRole("alert").filter({ hasText: /clipboard is empty/i }).waitFor({ timeout: 8000 }).then(() => chk("blank clipboard → 'clipboard is empty' message", true), () => chk("blank clipboard → 'clipboard is empty' message", false));
  }

  // Paste new statement / Clear capture clear the box (no review → no confirmation)
  await ta.fill("05/09/2026\tKEEP ME\t99.00 Dr");
  await page.getByTestId("paste-new").click();
  chk("Paste new statement empties the box with no prompt (nothing reviewed yet)", (await ta.inputValue()) === "" && (await page.getByRole("dialog").count()) === 0);
  await ta.fill("05/09/2026\tKEEP ME\t99.00 Dr");
  await page.getByTestId("clear-capture").click();
  chk("Clear capture empties the box", (await ta.inputValue()) === "");

  // Very long single-line + huge paste must not freeze/crash
  const big = Array.from({ length: 800 }, (_, i) => `${ddmmyyyy(-(i % 40))}\tMERCHANT ${i + 1}\t${(100 + i).toFixed(2)} Dr`).join("\n");
  await ta.fill(big);
  chk("800-line paste: counter shows 800", /800 lines/.test(await page.locator("main").innerText()));
  chk("nothing written by any of this", (await snapshotWrites()) === before);
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors", errs.length === 0, errs.slice(0, 4).join(" || "));
});

scenario("sc-sweep-text-accuracy", "Smart Capture sweep (paste): dates, descriptions, amounts and Cr/Dr read exactly across statement formats; totals ignored", async ({ ctx, logs }, chk, notes) => {
  const before = await snapshotWrites();
  const d = (o) => day(o);

  // 1) tab-separated, DD/MM/YYYY, Indian grouping, Cr/Dr markers, summary lines to ignore
  const t1 = [
    { date: d(-3), desc: "SWIGGY BANGALORE", amount: 452, dir: "debit", s: "Dr" },
    { date: d(-4), desc: "AMAZON PAY INDIA", amount: 124999, dir: "debit", s: "Dr" },
    { date: d(-5), desc: "REFUND MYNTRA", amount: 1299, dir: "credit", s: "Cr" },
    { date: d(-6), desc: "BIGBASKET SUPERMARKET", amount: 1234567.89, dir: "debit", s: "Dr" },
  ];
  const text1 = ["Statement for September", ...t1.map((t) => `${ddmmyyyy(Math.round((t.date - Date.now()) / 86400000))}\t${t.desc}\t${fmtIn(t.amount)} ${t.s}`), "Opening Balance\t10,000.00", "Total Amount Due\t1,28,000.00", "Minimum Amount Due\t5,000.00", "Credit Limit\t3,00,000.00"].join("\n");
  const r1 = await pasteAndRead(ctx, logs, text1);
  await h.shot(r1.tab, "sc-sweep-text-1");
  notes.push(`fmt1 rows: ${JSON.stringify(r1.rows.map((r) => [r.desc, r.amount, r.dir, r.state, r.check]))}`);
  const bad1 = compare(t1, r1.rows);
  chk("fmt 1 (tab, DD/MM/YYYY, Cr/Dr, ₹12,34,567.89): every field exact, 4 rows, summary lines ignored", bad1.length === 0, bad1.join(" | "));
  chk("fmt 1: clean pasted rows need no individual confirmation", r1.rows.every((r) => !r.check), JSON.stringify(r1.rows.map((r) => r.check)));
  await r1.tab.close();

  // 2) "05 Sep 2026" dates, ₹ / Rs. / INR prefixes, space-separated
  const mon = (dt) => dt.toLocaleString("en-GB", { month: "short" });
  const dm = (dt) => `${pad2(dt.getDate())} ${mon(dt)} ${dt.getFullYear()}`;
  const t2 = [
    { date: d(-2), desc: "ZOMATO ORDER", amount: 349.5, dir: "debit", s: "₹349.50" },
    { date: d(-3), desc: "UBER INDIA SYSTEMS", amount: 1250, dir: "debit", s: "Rs. 1,250.00" },
    { date: d(-4), desc: "PHARMACY APOLLO", amount: 87.25, dir: "debit", s: "INR 87.25" },
  ];
  const text2 = t2.map((t) => `${dm(t.date)}   ${t.desc}   ${t.s}`).join("\n");
  const r2 = await pasteAndRead(ctx, logs, text2);
  notes.push(`fmt2 rows: ${JSON.stringify(r2.rows.map((r) => [r.desc, r.amount, r.dir, r.state, r.check]))}`);
  const bad2 = compare(t2, r2.rows);
  chk("fmt 2 (05 Sep 2026, ₹ / Rs. / INR): amounts, dates and descriptions exact", bad2.length === 0, bad2.join(" | "));
  const unflagged2 = r2.rows.filter((r) => !r.check && r.dir !== "debit");
  chk("fmt 2: no unmarked row silently classed as a credit", unflagged2.length === 0, JSON.stringify(unflagged2.map((r) => r.desc)));
  await r2.tab.close();

  // 3) bank table with Debit / Credit / Balance columns (header row)
  const t3 = [
    { date: d(-2), desc: "UPI/CAFE COFFEE DAY", amount: 180, dir: "debit" },
    { date: d(-3), desc: "NEFT SALARY ACME CORP", amount: 52000, dir: "credit" },
    { date: d(-4), desc: "ATM WDL MG ROAD", amount: 5000, dir: "debit" },
  ];
  let bal = 10000;
  const lines3 = ["Date\tNarration\tDebit\tCredit\tBalance"];
  for (const t of t3.slice().reverse()) {
    bal += t.dir === "credit" ? t.amount : -t.amount;
    t.balance = bal;
  }
  for (const t of t3) lines3.push(`${ddmmyyyy(Math.round((t.date - Date.now()) / 86400000))}\t${t.desc}\t${t.dir === "debit" ? fmtIn(t.amount) : ""}\t${t.dir === "credit" ? fmtIn(t.amount) : ""}\t${fmtIn(t.balance)}`);
  const r3 = await pasteAndRead(ctx, logs, lines3.join("\n"));
  notes.push(`fmt3 rows: ${JSON.stringify(r3.rows.map((r) => [r.desc, r.amount, r.dir, r.state, r.check]))}`);
  const bad3 = compare(t3, r3.rows);
  chk("fmt 3 (Debit / Credit / Balance columns): amount, direction, date exact; Balance never read as an amount", bad3.length === 0, bad3.join(" | "));
  await r3.tab.close();

  // 4) ISO dates, minus sign and parentheses negatives, two-digit year, repeated row, no-year date
  const t4 = [
    // card-statement convention: a bracketed / negative amount is money back
    { date: d(-2), desc: "NETFLIX SUBSCRIPTION", amount: 649, dir: "credit" },
    { date: d(-2), desc: "NETFLIX SUBSCRIPTION", amount: 649, dir: "credit" },
  ];
  const iso = (dt) => `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  const text4 = [`${iso(t4[0].date)}\tNETFLIX SUBSCRIPTION\t(649.00)`, `${iso(t4[1].date)}\tNETFLIX SUBSCRIPTION\t(649.00)`, `${iso(d(-9))}\tREVERSAL SHOP\t+300.00`].join("\n");
  const r4 = await pasteAndRead(ctx, logs, text4);
  notes.push(`fmt4 rows: ${JSON.stringify(r4.rows.map((r) => [r.desc, r.amount, r.dir, r.state, r.check]))}`);
  const bad4 = compare(t4, r4.rows.slice(0, 2));
  chk("fmt 4 (ISO dates, (649.00) bracketed amounts): amount, direction, date exact", bad4.length === 0, bad4.slice(0, 3).join(" | "));
  chk("fmt 4: '+300.00' with no Cr/Dr marker is flagged for a Debit/Credit choice, never guessed", !!r4.rows[2] && r4.rows[2].amount === 300 && !!r4.rows[2].check, JSON.stringify(r4.rows[2]));
  chk("fmt 4: the identical pair is kept as TWO rows, both flagged for one look (never auto-merged)", r4.rows.length >= 2 && r4.rows.slice(0, 2).every((r) => r.check), JSON.stringify(r4.rows.slice(0, 2).map((r) => r.check)));
  await r4.tab.close();

  // 5) a row with no year and a row with an ambiguous amount must never be silently trusted
  const text5 = [`05 Sep\tNO YEAR SHOP\t200.00 Dr`, `${ddmmyyyy(-2)}\tTWO AMOUNTS SHOP 150.00\t300.00 Dr`].join("\n");
  const r5 = await pasteAndRead(ctx, logs, text5);
  notes.push(`fmt5 rows: ${JSON.stringify(r5.rows.map((r) => [r.desc, r.amount, r.dir, r.state, r.check]))}`);
  chk("fmt 5: a date with no year still reads ₹200 as a charge on 05 Sep", !!r5.rows[0] && r5.rows[0].amount === 200 && r5.rows[0].dir === "debit" && /05 Sep/.test(r5.rows[0].text), JSON.stringify(r5.rows[0]));
  chk("fmt 5: a row with two amounts is flagged, not guessed", r5.rows[1] && !!r5.rows[1].check, JSON.stringify(r5.rows[1]));
  await r5.tab.close();

  chk("NOTHING written by any capture", (await snapshotWrites()) === before);
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors", errs.length === 0, errs.slice(0, 4).join(" || "));
});

scenario("sc-sweep-duplicates", "Smart Capture sweep: duplicates against FlowFi are right — exact, near, same-day-different-amount, opposite direction, deleted, other account, repeats inside the paste", async ({ ctx, logs }, chk, notes) => {
  const accounts = await h.list("accounts");
  const bank = accounts.find((a) => a.name === "QA Bank");
  const cash = accounts.find((a) => a.name === "QA Cash");
  const cats = await h.list("categories");
  const cat = cats.find((c) => c.type === "expense" && !c.deletedAt && c.isActive !== false);
  const raw = (id, desc, amount, offset, extra = {}) =>
    h.createDocUnderUser(`transactions/${id}`, { type: "expense", amount, dateTime: day(offset), accountId: bank.id, categoryId: cat.id, description: desc, notes: "", status: "posted", source: "manual", createdAt: day(offset), deletedAt: null, excludeFromCalculations: false, editHistory: [], ...extra });
  await raw("sw_exact", "SW EXACT CAFE", 640, -3);
  await raw("sw_near", "SW NEAR STORE", 100.7, -4);
  await raw("sw_sameday", "SW SAME DAY SHOP", 500, -5);
  await raw("sw_deleted", "SW DELETED SHOP", 777, -6, { deletedAt: day(-1) });
  await raw("sw_cash", "SW CASH ONLY SHOP", 333, -7, { accountId: cash.id });
  await raw("sw_exp_for_credit", "SW OPPOSITE", 910, -8);
  const before = await snapshotWrites();

  const rowsIn = [
    `${ddmmyyyy(-3)}\tSW EXACT CAFE\t640.00 Dr`, // exact duplicate
    `${ddmmyyyy(-4)}\tSW NEAR STORE\t100.00 Dr`, // near amount
    `${ddmmyyyy(-5)}\tSW SAME DAY SHOP\t999.00 Dr`, // same merchant+date, different amount
    `${ddmmyyyy(-6)}\tSW DELETED SHOP\t777.00 Dr`, // matches only a deleted record → no match
    `${ddmmyyyy(-7)}\tSW CASH ONLY SHOP\t333.00 Dr`, // exists on QA Cash, not on QA Bank
    `${ddmmyyyy(-8)}\tSW OPPOSITE\t910.00 Cr`, // same amount/date but a refund-direction credit
    `${ddmmyyyy(-9)}\tSW BRAND NEW\t55.55 Dr`, // nothing in FlowFi
  ].join("\n");
  const { tab, rows } = await pasteAndRead(ctx, logs, rowsIn);
  await h.shot(tab, "sc-sweep-dups");
  const by = (name) => rows.find((r) => r.desc.includes(name));
  notes.push(`states: ${JSON.stringify(rows.map((r) => [r.desc, r.amount, r.dir, r.state]))}`);
  chk("7 rows read", rows.length === 7, rows.length);
  chk("exact duplicate → exact_candidate", by("EXACT")?.state === "exact_candidate", by("EXACT")?.state);
  chk("₹100.00 vs FlowFi ₹100.70 → a possible match, not exact / no-match", !!by("NEAR") && !["exact_candidate", "no_match"].includes(by("NEAR").state), by("NEAR")?.state);
  chk("same merchant + date, different amount → not exact", by("SAME DAY")?.state !== "exact_candidate", by("SAME DAY")?.state);
  chk("a deleted FlowFi transaction never counts as a duplicate", by("DELETED")?.state === "no_match", by("DELETED")?.state);
  chk("a transaction on a DIFFERENT account is not an exact duplicate on this account", by("CASH ONLY")?.state !== "exact_candidate", by("CASH ONLY")?.state);
  chk("an incoming credit is not an exact duplicate of an expense", by("OPPOSITE")?.state !== "exact_candidate", by("OPPOSITE")?.state);
  chk("a genuinely new row → no_match", by("BRAND NEW")?.state === "no_match", by("BRAND NEW")?.state);
  chk("nothing is decided automatically", rows.every((r) => r.decision === ""));

  // The summary counts agree with the row states
  const dupCount = Number(await tab.getByTestId("summary-duplicates").locator("dd").innerText().catch(() => "NaN"));
  const poss = rows.filter((r) => ["exact_candidate", "near_amount", "same_merchant_date", "multiple"].includes(r.state)).length;
  chk("summary 'possible duplicates' count equals the rows flagged", dupCount === poss, `${dupCount} vs ${poss}`);

  // The dock for the exact row compares with the right FlowFi transaction
  await reconRow(tab, "SW EXACT").click();
  const dock = tab.getByTestId("resolution-dock");
  await dock.waitFor({ timeout: 30000 });
  const dockText = flat(await dock.innerText());
  chk("dock for the exact duplicate shows the existing SW EXACT CAFE ₹640.00", /SW EXACT CAFE/i.test(dockText) && /640\.00/.test(dockText), dockText.slice(0, 220));
  await reconRow(tab, "SW NEAR").click();
  const nearText = flat(await tab.getByTestId("resolution-dock").innerText());
  chk("dock for the near row shows FlowFi's ₹100.70 beside the statement's ₹100.00", /100\.70/.test(nearText) && /100\.00/.test(nearText), nearText.slice(0, 220));
  chk("NOTHING written while reviewing duplicates", (await snapshotWrites()) === before);
  await tab.close();

  // Repeats inside one paste are flagged, and the same text re-pasted in a new tab finds the same duplicates (stable)
  const rep = [`${ddmmyyyy(-2)}\tSW TWICE SHOP\t45.00 Dr`, `${ddmmyyyy(-2)}\tSW TWICE SHOP\t45.00 Dr`, `${ddmmyyyy(-2)}\tSW TWICE SHOP\t46.00 Dr`].join("\n");
  const r2 = await pasteAndRead(ctx, logs, rep);
  const twice = r2.rows.filter((r) => r.desc.includes("TWICE"));
  chk("identical rows inside the paste are flagged as possible repeats", twice.slice(0, 2).every((r) => /repeat/i.test(r.check ?? "") || !!r.check), JSON.stringify(twice.map((r) => r.check)));
  chk("a similar row with a different amount is NOT flagged as a repeat", !/repeat/i.test(twice[2]?.check ?? ""), twice[2]?.check);
  await r2.tab.close();
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors", errs.length === 0, errs.slice(0, 4).join(" || "));
});

// ---------------------------------------------------------------------------------------------------------------
// Screenshots

const TRUTH = [
  { date: -2, desc: "SWIGGY BANGALORE", amount: 452, dir: "debit" },
  { date: -3, desc: "AMAZON PAY INDIA PRIVATE", amount: 124999, dir: "debit" },
  { date: -4, desc: "REFUND MYNTRA DESIGNS", amount: 1299, dir: "credit" },
  { date: -5, desc: "UBER INDIA SYSTEMS", amount: 389.5, dir: "debit" },
  { date: -6, desc: "BIGBASKET SUPERMARKET", amount: 2812.75, dir: "debit" },
  { date: -7, desc: "CASHBACK CREDIT", amount: 150, dir: "credit" },
];

function imageHtml(style) {
  const dm = (o) => `${pad2(day(o).getDate())} ${day(o).toLocaleString("en-GB", { month: "short" })} ${day(o).getFullYear()}`;
  const dd = (o) => ddmmyyyy(o);
  let head;
  let rows;
  if (style === "rupee") {
    head = "<tr><th>Date</th><th>Transaction Details</th><th class='a'>Amount</th></tr>";
    rows = TRUTH.map((r) => `<tr><td>${dm(r.date)}</td><td>${r.desc}</td><td class="a">${r.dir === "credit" ? "+ " : ""}₹${fmtIn(r.amount)}</td></tr>`).join("");
  } else if (style === "drcr") {
    head = "<tr><th>Date</th><th>Description</th><th class='a'>Debit</th><th class='a'>Credit</th></tr>";
    rows = TRUTH.map((r) => `<tr><td>${dd(r.date)}</td><td>${r.desc}</td><td class="a">${r.dir === "debit" ? fmtIn(r.amount) : ""}</td><td class="a">${r.dir === "credit" ? fmtIn(r.amount) : ""}</td></tr>`).join("");
  } else {
    head = "<tr><th>Date</th><th>Transaction Details</th><th class='a'>Amount (Rs.)</th></tr>";
    rows = TRUTH.map((r) => `<tr><td>${dd(r.date)}</td><td>${r.desc}</td><td class="a">${fmtIn(r.amount)} ${r.dir === "credit" ? "Cr" : "Dr"}</td></tr>`).join("");
  }
  return `<html><body style="margin:0;background:#fff"><div id="s" style="display:inline-block;padding:24px;background:#fff;font-family:Arial,sans-serif;font-size:16px;color:#111">
  <div style="font-weight:bold;margin-bottom:12px">QA SYNTHETIC STATEMENT</div>
  <table style="border-collapse:collapse"><thead>${head}</thead><tbody>${rows}</tbody></table>
  <div style="margin-top:12px">Total Amount Due &nbsp;&nbsp; 1,29,000.00</div>
  <style>td,th{padding:7px 24px 7px 0;text-align:left} .a{text-align:right}</style></div></body></html>`;
}

async function renderImage(ctx, style) {
  const scratch = await ctx.newPage();
  await scratch.setViewportSize({ width: 1100, height: 700 });
  await scratch.setContent(imageHtml(style));
  const buffer = await scratch.locator("#s").screenshot();
  await scratch.close();
  return buffer;
}

async function loadImage(page, buffer, name = "statement.png", mimeType = "image/png") {
  await page.getByRole("tab", { name: /Screenshot/ }).click();
  await page.getByLabel("Choose screenshot").setInputFiles({ name, mimeType, buffer });
  await page.getByTestId("crop-area").waitFor({ timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="crop-area"] img')?.complete, null, { timeout: 30000 });
}

scenario("sc-sweep-image-input", "Smart Capture sweep (screenshot): choose / drop / paste an image, wrong type, over 15 MB, crop + 'Use whole image', Replace, Remove, tabs", async ({ page, logs }, chk) => {
  const before = await snapshotWrites();
  await openCapture(page);
  await page.getByRole("tab", { name: /Screenshot/ }).click();
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 600;
    c.height = 300;
    const g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, 600, 300);
    g.fillStyle = "#000";
    g.font = "20px Arial";
    g.fillText("05/09/2026  TEST SHOP   123.00 Dr", 20, 60);
    return c.toDataURL("image/png").split(",")[1];
  });
  const buffer = Buffer.from(png, "base64");

  // wrong type
  await page.getByLabel("Choose screenshot").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  const typeErr = page.getByRole("alert").filter({ hasText: /isn't an image/ });
  await typeErr.waitFor({ timeout: 8000 }).then(() => chk("a text file → \"isn't an image\" message", true), () => chk("a text file → \"isn't an image\" message", false));
  chk("…and no image preview is created", (await page.getByTestId("crop-area").count()) === 0);
  // PDF (a very common wrong choice)
  await page.getByLabel("Choose screenshot").setInputFiles({ name: "statement.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") });
  chk("a PDF is refused with the same clear message", (await page.getByRole("alert").filter({ hasText: /isn't an image/ }).count()) === 1);
  // too big
  await page.getByLabel("Choose screenshot").setInputFiles({ name: "huge.png", mimeType: "image/png", buffer: Buffer.alloc(15 * 1024 * 1024 + 10, 1) });
  await page.getByRole("alert").filter({ hasText: /over 15 MB/ }).waitFor({ timeout: 15000 }).then(() => chk("an image over 15 MB → 'over 15 MB' message", true), () => chk("an image over 15 MB → 'over 15 MB' message", false));
  chk("…and nothing is loaded", (await page.getByTestId("crop-area").count()) === 0);

  // valid image
  await page.getByLabel("Choose screenshot").setInputFiles({ name: "ok.png", mimeType: "image/png", buffer });
  await page.getByTestId("crop-area").waitFor({ timeout: 20000 });
  chk("a valid PNG loads (error cleared)", (await page.locator("p[role=alert]").count()) === 0 && (await page.getByTestId("crop-area").count()) === 1, await page.locator("p[role=alert]").allInnerTexts());
  chk("shows file name + Replace + Remove + 'Read text'", /ok\.png/.test(await page.locator("main").innerText()) && (await page.getByRole("button", { name: /Replace/ }).count()) >= 1 && (await page.getByRole("button", { name: /Remove/ }).count()) === 1 && (await page.getByRole("button", { name: "Read text" }).count()) === 1);
  chk("header now offers Replace screenshot / Paste new statement / Clear capture", (await page.getByTestId("replace-screenshot").count()) === 1 && (await page.getByTestId("paste-new").count()) === 1 && (await page.getByTestId("clear-capture").count()) === 1);
  await h.shot(page, "sc-sweep-image-loaded");

  // crop
  const area = page.getByTestId("crop-area");
  const box = await area.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  chk("dragging selects an area ('Reading only the selected area')", /Reading only the selected area/.test(await page.locator("main").innerText()));
  chk("button now says 'Read selected area'", (await page.getByRole("button", { name: "Read selected area" }).count()) === 1);
  await h.shot(page, "sc-sweep-image-cropped");
  await page.getByRole("button", { name: /Use whole image/ }).click();
  chk("'Use whole image' removes the selection", !/Reading only the selected area/.test(await page.locator("main").innerText()) && (await page.getByRole("button", { name: "Read text" }).count()) === 1);
  // a plain click must not make a selection
  await page.mouse.click(box.x + 50, box.y + 50);
  chk("a plain click does not select anything", !/Reading only the selected area/.test(await page.locator("main").innerText()));

  // Remove returns to the drop zone
  await page.getByRole("button", { name: /Remove/ }).click();
  chk("Remove returns to the drop zone", (await page.getByTestId("crop-area").count()) === 0 && (await page.getByText(/Drop a screenshot/).count()) === 1);

  // drag and drop
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "dropped.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const zone = [...document.querySelectorAll("div")].find((d) => d.className.includes("border-dashed"));
    zone.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    zone.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, png);
  await page.getByTestId("crop-area").waitFor({ timeout: 15000 }).then(() => chk("dropping an image onto the zone loads it", /dropped\.png/.test("dropped.png")), () => chk("dropping an image onto the zone loads it", false));
  await page.getByRole("button", { name: /Remove/ }).click();

  // paste an image with Ctrl+V while on the Paste-text tab → switches to Screenshot
  await page.getByRole("tab", { name: /Paste text/ }).click();
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "clip.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, png);
  await page.getByTestId("crop-area").waitFor({ timeout: 15000 }).then(() => chk("Ctrl+V of an image anywhere loads it into the Screenshot tab", true), () => chk("Ctrl+V of an image anywhere loads it into the Screenshot tab", false));
  chk("…and the Screenshot tab is selected", (await page.getByRole("tab", { name: /Screenshot/ }).getAttribute("aria-selected")) === "true");

  // Replace via header → no review yet, so it goes straight back to a fresh screenshot state
  await page.getByTestId("replace-screenshot").click();
  await page.waitForTimeout(500);
  chk("header 'Replace screenshot' (no review yet) → clean drop zone with no prompt", (await page.getByRole("dialog").count()) === 0 && (await page.getByText(/Drop a screenshot/).count()) === 1);
  chk("nothing written", (await snapshotWrites()) === before);
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors", errs.length === 0, errs.slice(0, 4).join(" || "));
});

for (const style of ["standard", "rupee", "drcr"]) {
  scenario(`sc-sweep-image-${style}`, `Smart Capture sweep (screenshot, ${style}): OCR reads dates / descriptions / amounts / Cr-Dr exactly, or flags them — never a silent misread`, async ({ page, ctx, logs }, chk, notes) => {
    const before = await snapshotWrites();
    const buffer = await renderImage(ctx, style);
    await openCapture(page);
    await loadImage(page, buffer);
    const t0 = Date.now();
    await page.getByRole("button", { name: /Read text/ }).click();
    await landOnReview(page);
    await chooseAccount(page, "QA Bank");
    const rows = await reconRows(page);
    await h.shot(page, `sc-sweep-image-${style}-review`);
    notes.push(`${style}: ${Date.now() - t0} ms · rows ${JSON.stringify(rows.map((r) => [r.desc, r.amount, r.dir, r.check]))}`);
    const truth = TRUTH.map((t) => ({ ...t, date: day(t.date) }));
    const bad = compare(truth, rows);
    const unsafe = truth.map((t, i) => ({ t, r: rows[i] })).filter(({ t, r }) => r && !r.check && (paise(r.amount ?? -1) !== paise(t.amount) || r.dir !== t.dir));
    chk("every statement row found (the 'Total Amount Due' line ignored)", rows.length === TRUTH.length, `${rows.length}`);
    chk("no misread amount / direction is ever left unflagged", unsafe.length === 0, JSON.stringify(unsafe.map(({ t, r }) => [t.desc, t.amount, r.amount, r.dir])));
    if (style !== "rupee") chk("description / date / direction / amount all exact", bad.length === 0, bad.join(" | "));
    else notes.push("rupee-glyph misreads (all flagged): " + bad.length);
    chk("every row is either read exactly or carries a check", truth.every((t, i) => rows[i] && ((paise(rows[i].amount ?? -1) === paise(t.amount) && rows[i].dir === t.dir) || !!rows[i].check)), JSON.stringify(rows.map((r) => [r.desc, r.amount, r.dir, r.check])));
    // The screenshot is shown beside the row, from memory
    await reconRow(page, "SWIGGY").click();
    await page.getByTestId("dock-details").click().catch(() => {});
    chk("the source screenshot strip is available for the row", (await page.getByRole("dialog").getByTestId("row-zoom").locator("img").count()) >= 1);
    await page.keyboard.press("Escape");
    chk("NOTHING written", (await snapshotWrites()) === before);
    const errs = logs.filter((l) => !IGNORED.test(l));
    chk("no console errors", errs.length === 0, errs.slice(0, 4).join(" || "));
  });
}

// ---------------------------------------------------------------------------------------------------------------

scenario("sc-sweep-source-actions", "Smart Capture sweep: after extracting — Back to capture, review-in-progress banner, Paste new / Clear / Replace / Retry each ask first and 'Keep my review' keeps everything", async ({ page, logs }, chk) => {
  const before = await snapshotWrites();
  await openCapture(page);
  const text = [`${ddmmyyyy(-2)}\tSA CAFE ONE\t210.00 Dr`, `${ddmmyyyy(-3)}\tSA SHOP TWO\t330.00 Dr`, `${ddmmyyyy(-4)}\tSA REFUND THREE\t99.00 Cr`].join("\n");
  await page.getByLabel("Pasted statement text").fill(text);
  await page.getByRole("button", { name: /Extract transactions/ }).click();
  await landOnReview(page);
  await chooseAccount(page, "QA Bank");
  chk("3 rows arrived", /3 .*rows? arrived/.test(await page.getByTestId("handoff-notice").innerText()), await page.getByTestId("handoff-notice").innerText());

  // Make some review work: exclude a row
  await reconRow(page, "SHOP TWO").dblclick();
  await page.getByRole("switch", { name: "Include this row" }).click();
  await page.keyboard.press("Escape");

  // Back to capture via the "Capture" step
  await page.getByRole("list", { name: "Progress" }).getByRole("link", { name: /Capture/ }).click();
  await page.getByRole("heading", { name: "Smart Capture" }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(1000);
  chk("back on Smart Capture with the statement text still in the box", (await page.getByLabel("Pasted statement text").inputValue()).includes("SA CAFE ONE"));
  chk("'review in progress' banner is shown", (await page.getByTestId("review-in-progress").count()) === 1 && /3 rows/.test(await page.getByTestId("review-in-progress").innerText()), await page.getByTestId("review-in-progress").innerText().catch(() => ""));
  chk("'Review & Import' step is now enabled", await page.getByTestId("workspace-header").getByRole("button", { name: "Review & Import" }).isEnabled());
  await page.getByRole("button", { name: "Return to Review & Import" }).click();
  await page.getByRole("heading", { name: "Review & Import" }).waitFor({ timeout: 60000 });
  chk("Return to Review & Import keeps the review and the exclusion", (await reconRow(page, "SHOP TWO").getAttribute("data-state")) === "excluded");
  await page.getByRole("list", { name: "Progress" }).getByRole("link", { name: /Capture/ }).click();
  await page.getByRole("heading", { name: "Smart Capture" }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(800);

  // Each destructive header action asks first; "Keep my review" changes nothing
  for (const [testId, title] of [["paste-new", /Paste a new statement\?/], ["clear-capture", /Clear this capture\?/]]) {
    await page.getByTestId(testId).click();
    const dlg = page.getByRole("dialog");
    await dlg.waitFor({ timeout: 8000 }).catch(() => {});
    const dtext = flat(await dlg.innerText().catch(() => ""));
    chk(`${testId}: asks first and says what is lost`, title.test(dtext) && /Nothing has been imported/.test(dtext) && /your include\/exclude choices|extracted row/.test(dtext), dtext.slice(0, 240));
    await dlg.getByRole("button", { name: "Keep my review" }).click();
    await page.waitForTimeout(400);
    chk(`${testId}: 'Keep my review' leaves text + review untouched`, (await page.getByLabel("Pasted statement text").inputValue()).includes("SA CAFE ONE") && (await page.getByTestId("review-in-progress").count()) === 1);
  }
  await h.shot(page, "sc-sweep-confirm");

  // Confirm "Clear capture": box emptied, banner gone, Review & Import step disabled again
  await page.getByTestId("clear-capture").click();
  await page.getByRole("dialog").getByRole("button", { name: /Clear capture/ }).click();
  await page.waitForTimeout(600);
  chk("confirmed Clear capture empties the box and the banner", (await page.getByLabel("Pasted statement text").inputValue()) === "" && (await page.getByTestId("review-in-progress").count()) === 0);
  chk("…and the Review & Import step is disabled again", await page.getByTestId("workspace-header").getByRole("button", { name: "Review & Import" }).isDisabled());
  chk("nothing written by any of it", (await snapshotWrites()) === before);
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors", errs.length === 0, errs.slice(0, 4).join(" || "));
});

scenario("sc-sweep-column-mapping", "Smart Capture sweep: Match your columns — roles editable, Reset, error for missing Amount blocks Confirm, preview + totals follow the mapping, Edit source goes back", async ({ page, logs }, chk) => {
  const before = await snapshotWrites();
  await openCapture(page);
  const lines = ["Date\tNarration\tDebit\tCredit\tBalance", `${ddmmyyyy(-2)}\tMAP CAFE\t200.00\t\t9,800.00`, `${ddmmyyyy(-3)}\tMAP SALARY\t\t5,000.00\t10,000.00`, `${ddmmyyyy(-4)}\tMAP SHOP\t1,500.00\t\t5,000.00`].join("\n");
  await page.getByLabel("Pasted statement text").fill(lines);
  await page.getByRole("button", { name: /Extract transactions/ }).click();
  const step = page.getByTestId("column-mapping");
  await step.waitFor({ timeout: 60000 });
  await h.shot(page, "sc-sweep-mapping");
  chk("table text stops at 'Match your columns' first", (await step.count()) === 1 && /3 rows/.test(await step.innerText()), flat(await step.innerText()).slice(0, 80));
  chk("'Detected automatically' shown", /Detected automatically/.test(await step.innerText()));
  const roleOf = (i) => page.getByTestId(`column-role-${i}`).inputValue();
  const roles = [await roleOf(0), await roleOf(1), await roleOf(2), await roleOf(3), await roleOf(4)];
  chk("columns detected: Date, Description, Debit, Credit, Balance", JSON.stringify(roles) === JSON.stringify(["date", "description", "debit", "credit", "balance"]), JSON.stringify(roles));
  const result = flat(await page.getByTestId("mapping-result").innerText());
  chk("preview totals: Charges ₹1,700.00, Credits ₹5,000.00", /Charges ₹1,700\.00/.test(result) && /Credits ₹5,000\.00/.test(result), result.slice(0, 200));
  chk("Balance never shown as an amount in the preview", !/9,800|10,000/.test(flat(await page.getByTestId("mapping-result").innerText()).replace(/₹5,000\.00/g, "")));

  // Change a role → Reset appears; set Debit to Ignore → error / totals change
  await page.getByTestId("column-role-2").selectOption("ignore");
  await page.waitForTimeout(400);
  chk("changing a role shows 'Reset to detected'", (await page.getByTestId("mapping-reset").count()) === 1);
  const afterIgnore = flat(await page.getByTestId("mapping-result").innerText().catch(() => ""));
  chk("ignoring Debit removes the charges from the preview", !/Charges ₹1,700\.00/.test(afterIgnore), afterIgnore.slice(0, 160));
  await page.getByTestId("mapping-reset").click();
  chk("Reset to detected restores the mapping", (await roleOf(2)) === "debit" && (await page.getByTestId("mapping-reset").count()) === 0);

  // Remove the Date role → required-role error disables Confirm
  await page.getByTestId("column-role-0").selectOption("ignore");
  await page.waitForTimeout(400);
  chk("no Date column → an error is shown and Confirm is disabled", (await page.getByTestId("mapping-error").count()) >= 1 && (await page.getByTestId("mapping-confirm").isDisabled()), await page.getByTestId("mapping-error").first().innerText().catch(() => "none"));
  const fix = page.getByTestId("mapping-fix");
  if (await fix.count()) { await fix.first().click(); await page.waitForTimeout(300); }
  else await page.getByTestId("mapping-reset").click();
  chk("fixing it re-enables Confirm", await page.getByTestId("mapping-confirm").isEnabled());

  // Edit source → back to the text, intact
  await page.getByTestId("mapping-back").click();
  await page.waitForTimeout(400);
  chk("'Edit source' returns to the pasted text, unchanged", (await page.getByLabel("Pasted statement text").inputValue()) === lines);
  chk("nothing written", (await snapshotWrites()) === before);
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors", errs.length === 0, errs.slice(0, 4).join(" || "));
});
