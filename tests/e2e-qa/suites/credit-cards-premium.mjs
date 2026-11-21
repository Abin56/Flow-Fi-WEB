/**
 * Credit Cards premium desktop UI (2026-11-20): Loan / EMI vs Purchases usage breakdown, the "Due today" vs
 * "no bill due" label fix, and the Bills / Transactions / Spending views. Read-side checks on synthetic emulator
 * data only. Scenario ids: ccux-*
 *
 * Fixture (on top of the base seed + card-emi + card-emi-a), all on "QA Credit Card" (statement day 1, due day 20,
 * which already carries a ₹12,000 purchase in the open cycle):
 *   two cycles ago  ₹4,000 purchase             → bill due on the 20th of THIS month — fully paid
 *   last cycle      ₹5,000 purchase + ₹3,000 EMI charge → part paid (₹2,000) → "Not split"
 *   open cycle      ₹500 refund
 *   one ₹6,000 bill payment (settles oldest first: ₹4,000 + ₹2,000)
 * Expected own outstanding 6,000 + 11,500 = 17,500; total Credit used = 12,000 (EMI lock) + 18,000 (Case A) + 17,500.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const flat = (t) => t.replace(/\s+/g, " ").trim();
const IGNORE = /Select is changing|status of 400|status of 404|React DevTools|Download the React/;
const money = (s) => Number(String(s).replace(/[₹,\s]/g, ""));

async function seedCardHistory() {
  const accounts = await h.list("accounts");
  const card = accounts.find((a) => a.name === "QA Credit Card");
  const seedPurchase = (await h.list("transactions")).find((t) => t.accountId === card.id && !t.deletedAt);
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const at = (monthOffset, day) => new Date(y, m + monthOffset, day, 12);
  const base = { notes: "", status: "posted", source: "manual", deletedAt: null, excludeFromCalculations: false, editHistory: [], transferId: null, emiId: null, loanId: null, isPersonLedgerMovement: false, linkedPersonId: null, owesPersonToggle: false, isBusiness: false };
  const tx = (id, fields) => h.createDocUnderUser(`transactions/${id}`, { ...base, accountId: card.id, categoryId: seedPurchase.categoryId, createdAt: fields.dateTime, ...fields });
  await tx("ccux_old_purchase", { type: "expense", amount: 4000, dateTime: at(-2, 15), description: "CCUX old purchase" });
  await tx("ccux_mixed_purchase", { type: "expense", amount: 5000, dateTime: at(-1, 10), description: "CCUX mixed purchase" });
  await tx("ccux_emi_charge", { type: "expense", amount: 3000, dateTime: at(-1, 12), description: "CCUX EMI charge", emiId: "ccux-emi" });
  await tx("ccux_refund", { type: "income", amount: 500, dateTime: at(0, 2), description: "CCUX refund" });
  await tx("ccux_payment", { type: "income", amount: 6000, dateTime: at(0, Math.min(3, now.getDate())), description: "CCUX bill payment", transferId: "ccux-transfer" });
}

async function openCards(page) {
  await h.go(page, "/credit-cards");
  await page.getByRole("heading", { level: 1, name: "Credit Cards" }).waitFor();
  await page.waitForTimeout(3500);
}

scenario("ccux-breakdown-labels", "Credit Cards: Loan/EMI vs Purchases adds up to Credit used; a paid bill due today never reads 'Due today'; activity views", async ({ page, logs }, chk) => {
  await h.addFixture(page, "card-emi");
  await h.addFixture(page, "card-emi-a");
  await seedCardHistory();
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCards(page);
  if (new Date().getDate() < 3) chk.finding?.("ccux-date", "fixture dates assume today is on/after the 3rd");

  // ── Summary: the parts add up to the engine's Credit used ──
  const summary = page.locator("#cc-summary");
  const sText = flat(await summary.innerText());
  const used = money((await summary.locator("p").first().innerText()).trim());
  const part = (label) => {
    const mm = sText.match(new RegExp(`${label} ₹([0-9,]+)`));
    return mm ? money(mm[1]) : 0;
  };
  const emi = part("Loan / EMI");
  const purchases = part("Purchases");
  const unsplit = part("Not split");
  await h.shot(page, "ccux-1-page");
  chk("Credit used = ₹47,500 (EMI lock 12,000 + Case A 18,000 + card 17,500)", used === 47500, `${used} · ${sText.slice(0, 220)}`);
  chk("Loan / EMI ₹30,000 = ₹12,000 locked + ₹18,000 EMI-financed purchases", emi === 30000 && /₹12,000 locked/.test(sText), sText.slice(0, 220));
  chk("Purchases ₹11,500 (₹12,000 − ₹500 refund)", purchases === 11500, purchases);
  chk("part-paid mixed bill shown as Not split ₹6,000 (not guessed)", unsplit === 6000, unsplit);
  chk("Loan / EMI + Purchases + Not split = Credit used (no double counting)", emi + purchases + unsplit === used, `${emi}+${purchases}+${unsplit} vs ${used}`);
  chk("summary keeps Credit limit, Available, Outstanding", /Credit limit ₹2,00,000/i.test(sText) && /Available ₹1,52,500/i.test(sText) && /Outstanding ₹35,500/i.test(sText), sText);

  // ── The label fix: the paid bill due TODAY must not read "Due today" anywhere ──
  const mainText = flat(await page.locator("main").innerText());
  chk("no 'Due today' while the only bill due today is fully paid", !/Due today/i.test(mainText), (mainText.match(/.{0,60}Due today.{0,40}/i) || [""])[0]);
  const tile = page.locator("#my-credit-cards [role=button]").filter({ hasText: "QA Credit Card" });
  const tileText = flat(await tile.innerText());
  chk("QA Credit Card tile: current bill is last cycle's remaining ₹6,000, due in N days", /Bill ₹6,000 · \d{1,2} [A-Z][a-z]{2}/.test(tileText) && /Due in \d+ days/.test(tileText), tileText);

  // ── Selected card panel ──
  await tile.click();
  const sheet = page.getByRole("dialog", { name: "Card activity" });
  await sheet.waitFor();
  await page.waitForTimeout(1200);
  const head = flat(await sheet.locator('[role="tablist"]').locator("xpath=../..").innerText());
  chk("sheet header Credit used = tile figure (₹17,500), bill pill ₹6,000 · Due in N days", /Credit used ₹17,500/i.test(head) && /₹6,000 · Due in \d+ days/.test(head), head.slice(0, 260));
  await h.shot(page, "ccux-2-bills");
  const bills = flat(await sheet.getByRole("region", { name: "Bills on this card" }).innerText());
  chk("bill list: paid bill marked Paid, last cycle Part paid, open cycle listed", /Paid/.test(bills) && /Part paid/.test(bills) && /Open cycle/.test(bills), bills);
  chk("Bills view: remaining ₹6,000 with Bill · Paid · Remaining summary", /Bill ₹8,000 · Paid ₹2,000 · Remaining ₹6,000/.test(flat(await sheet.innerText())));

  await sheet.getByRole("tab", { name: /Transactions/ }).click();
  await page.waitForTimeout(800);
  const tx = flat(await sheet.innerText());
  await h.shot(page, "ccux-3-transactions");
  chk("transactions filter counts: All 6 · Purchases 3 · Loan / EMI 1 · Payments & credits 2", /All 6/.test(tx) && /Purchases 3/.test(tx) && /Loan \/ EMI 1/.test(tx) && /Payments & credits 2/.test(tx), tx.slice(0, 400));
  chk("bill payment row keeps its Payment actions menu", (await sheet.getByRole("button", { name: "Payment actions" }).count()) === 1);
  await sheet.getByRole("radio", { name: /Loan \/ EMI/ }).click();
  await page.waitForTimeout(400);
  chk("Loan / EMI filter shows only the EMI charge", /CCUX EMI charge/.test(flat(await sheet.innerText())) && !/CCUX mixed purchase/.test(flat(await sheet.innerText())));

  await sheet.getByRole("tab", { name: /Spending/ }).click();
  await page.waitForTimeout(800);
  const sp = flat(await sheet.innerText());
  await h.shot(page, "ccux-4-spending");
  chk("Spending (all time) = purchases 21,000 + EMI charges 3,000 = ₹24,000 — payments not mixed in", /Card spending ₹24,000/i.test(sp), sp.slice(0, 400));
  chk("money in shown separately: Bill payments ₹6,000, Refunds ₹500", /Bill payments ₹6,000/.test(sp) && /Refunds & credits ₹500/.test(sp));
  chk("Loan / EMI charges appear as their own slice", /Loan \/ EMI charges ₹3,000/.test(sp));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(900);
  chk("Esc closes the sheet", (await sheet.count()) === 0);

  const panel = flat(await page.getByRole("region", { name: "Selected card" }).innerText());
  chk("panel: QA Credit Card breakdown Purchases ₹11,500 · Not split ₹6,000; bill ₹6,000", /Purchases[^₹]*₹11,500/.test(panel) && /Not split[^₹]*₹6,000/.test(panel) && /Remaining bill/i.test(panel) && /Bill ₹8,000 · Paid ₹2,000 · Remaining ₹6,000/.test(panel), panel.slice(0, 400));

  // ── List view: the breakdown per card ──
  await page.getByRole("radio", { name: "List" }).click();
  await page.waitForTimeout(600);
  await h.shot(page, "ccux-5-list");
  chk("list view shows each card's Loan / EMI · Purchases", /Loan \/ EMI · Purchases/i.test(flat(await page.locator("#my-credit-cards").innerText())));
  await page.getByRole("radio", { name: "Cards" }).click();

  const scroll = await page.evaluate(() => { const m = document.querySelector("main"); return { sh: m.scrollHeight, ch: m.clientHeight }; });
  chk(`desktop 1440×900: page scroll room ${scroll.sh - scroll.ch}px (before: ~100px with 3 cards)`, true);
  chk("no NaN / undefined", !/NaN|undefined|Infinity/.test(flat(await page.locator("body").innerText())));
  const errs = logs.filter((l) => !IGNORE.test(l));
  chk("no console errors", errs.length === 0, errs.slice(0, 4).join(" || "));
});

scenario("ccux-dark", "Credit Cards: dark theme desktop shots (page + sheet)", async ({ page }, chk) => {
  await h.addFixture(page, "card-emi");
  await h.addFixture(page, "card-emi-a");
  await seedCardHistory();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await openCards(page);
  await h.shot(page, "ccux-dark-1-page");
  await page.locator("#my-credit-cards [role=button]").filter({ hasText: "QA Credit Card" }).click();
  await page.getByRole("dialog", { name: "Card activity" }).waitFor();
  await page.waitForTimeout(1200);
  await h.shot(page, "ccux-dark-2-bills");
  await page.getByRole("tab", { name: /Spending/ }).click();
  await page.waitForTimeout(800);
  await h.shot(page, "ccux-dark-3-spending");
  chk("rendered", true);
});
