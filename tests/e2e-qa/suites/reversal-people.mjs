/**
 * People Ledger money movements: receipts, partial settlement, duplicate clicks, revert, edit, insufficient funds,
 * a stale action after cancellation from a second tab, and independence from the lender-side Loan/EMI schedule.
 * Every action is asserted on both the browser and the persisted emulator data. Local emulator only.
 */
import { scenario } from "../lib/core.mjs";
import { BASE_URL } from "../lib/env.mjs";
import * as f from "../lib/flows.mjs";
import * as h from "../lib/harness.mjs";

const RECORD_400 = /^Record ₹400/;

/** In the Edit-payment panel: set the amount received AND the allocation on the lent row to the same value. */
async function setEditAmount(pg, amount) {
  await f.amountField(pg).fill(String(amount));
  const row = pg.getByRole("dialog").last().getByText("QA lent to Ravi").first().locator("xpath=ancestor::*[count(.//button[normalize-space()='Skip'])=1][1]");
  await row.locator("input").first().fill(String(amount));
  await pg.waitForTimeout(400);
}

async function receiptFromPriya(page, amount, label) {
  await f.openPerson(page, "QA Priya");
  await f.openRecord(page);
  await f.amountField(page).fill(String(amount));
  await f.pickAccountIn(page, "QA Bank");
  const btn = page.getByRole("button", { name: label ?? new RegExp(`^Record ₹${Number(amount).toLocaleString("en-IN")}`) }).first();
  return btn;
}

scenario("rev-people-receipt-partial-duplicate", "People: ₹400 partial receipt from Priya (triple-click) → bank +₹400 once, ₹600 still owed", async ({ page }, chk) => {
  const before = await f.bal("QA Bank");
  const btn = await receiptFromPriya(page, 400, RECORD_400);
  await page.evaluate(() => window.__reset());
  await btn.evaluate((b) => { b.click(); b.click(); b.click(); });
  await page.waitForTimeout(4500);
  const after = await f.bal("QA Bank");
  const income = await f.txns((t) => t.type === "income" && t.amount === 400 && t.accountId === (before && undefined) );
  const received = await f.txns((t) => t.type === "income" && t.amount === 400);
  const body = (await page.locator("body").innerText()).split("\n").join(" ");
  await h.shot(page, "rev-people-receipt");
  chk("bank credited exactly ₹400 once (persisted)", f.close2(after - before, 400), `${before} -> ${after}`);
  chk("exactly one ₹400 receipt transaction persisted", received.length === 1 && income.length <= 1, received.length);
  chk("UI: ₹600 still pending (partial settlement)", /CURRENT PENDING\s*₹600/.test(body) || /₹600/.test(body), (body.match(/CURRENT PENDING[^A-Z]{0,20}/) ?? ["?"])[0]);
  chk("UI: row shows 'Got ₹400 · ₹600 left'", /Got ₹400 · ₹600 left/.test(body));
  return await h.timeline(page);
});

const revertBody = async ({ page }, chk) => {
  const base = await f.bal("QA Bank");
  const btn = await receiptFromPriya(page, 400, RECORD_400);
  await btn.click();
  await page.waitForTimeout(3500);
  const afterReceipt = await f.bal("QA Bank");
  chk("precondition: receipt recorded (+₹400)", f.close2(afterReceipt - base, 400), `${base} -> ${afterReceipt}`);
  await f.expandRow(page, "QA team dinner");
  await page.evaluate(() => window.__reset());
  const dialogText = await f.confirmRevert(page, { double: true });
  await page.waitForTimeout(4000);
  const afterRevert = await f.bal("QA Bank");
  const body = (await page.locator("body").innerText()).split("\n").join(" ");
  await h.shot(page, "rev-people-revert");
  chk("confirmation states the effect (remove ₹400 from QA Bank)", /remove ₹400 from QA Bank/.test(dialogText), dialogText.slice(0, 200));
  chk("bank back to the pre-receipt balance — refunded exactly once (persisted)", f.close2(afterRevert, base), `${afterReceipt} -> ${afterRevert} (base ${base})`);
  chk("the receipt transaction is no longer active (persisted)", (await f.txns((t) => t.type === "income" && t.amount === 400)).length === 0);
  chk("UI: the ₹1,000 share is owed in full again", /₹1,000 to receive/.test(body) || /CURRENT PENDING\s*₹1,000/.test(body));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  chk("no horizontal page overflow", overflow <= 1, `${overflow}px`);
  return await h.timeline(page);
};
scenario("rev-people-revert", "People: revert a ₹400 receipt (confirm double-click) → bank refunded once, ₹1,000 owed again", revertBody);
scenario("rev-people-revert-mobile-dark", "People: the same revert on mobile 390×844, dark", revertBody, { viewport: { width: 390, height: 844 }, scheme: "dark" });

scenario("rev-people-stale-revert-two-tabs", "People: revert in tab A, then the same revert from stale tab B → refused, bank refunded exactly once", async ({ page, ctx }, chk) => {
  const base = await f.bal("QA Bank");
  const btn = await receiptFromPriya(page, 400, RECORD_400);
  await btn.click();
  await page.waitForTimeout(3500);
  // Tab B opens Priya's page and expands the row (it now holds the revert control).
  const tabB = await ctx.newPage();
  tabB.setDefaultTimeout(30000);
  await tabB.goto(`${BASE_URL}/people`, { waitUntil: "domcontentloaded" });
  await f.openPerson(tabB, "QA Priya");
  await f.expandRow(tabB, "QA team dinner");
  await tabB.getByTitle("Revert this payment").first().waitFor();
  // Tab B opens the revert confirmation and leaves it open (this is the stale state).
  await tabB.getByTitle("Revert this payment").first().click();
  const dlgB = tabB.getByRole("dialog").last();
  await dlgB.getByText("Revert payment?").waitFor();
  // Tab A reverts.
  await page.bringToFront();
  await f.expandRow(page, "QA team dinner");
  await f.confirmRevert(page);
  await page.waitForTimeout(3500);
  chk("tab A: revert refunded the bank", f.close2(await f.bal("QA Bank"), base), `${await f.bal("QA Bank")} (base ${base})`);
  // Tab B confirms its (now stale) revert.
  await tabB.bringToFront();
  await tabB.waitForTimeout(1500);
  const before = await f.bal("QA Bank");
  const confirmB = dlgB.getByRole("button", { name: "Revert payment" });
  const confirmEnabled = (await confirmB.count()) > 0 && (await confirmB.isEnabled().catch(() => false));
  let outcome = confirmEnabled ? "" : "tab B's confirm was already disabled/removed by the live update";
  if (confirmEnabled) {
    await confirmB.click().catch(() => {});
    await tabB.waitForTimeout(3500);
    outcome = (await tabB.locator("body").innerText()).split("\n").join(" ").match(/[^.]*(already|no longer|couldn.t|not found|reverted|can.t)[^.]*/i)?.[0] ?? "no message shown";
  }
  await h.shot(tabB, "rev-people-stale-revert");
  chk("tab B's stale revert did not refund a second time (persisted)", f.close2(await f.bal("QA Bank"), before) && f.close2(await f.bal("QA Bank"), base), `${before} -> ${await f.bal("QA Bank")}; ${outcome}`);
  chk("still no active ₹400 receipt", (await f.txns((t) => t.type === "income" && t.amount === 400)).length === 0);
  await tabB.close();
});

scenario("rev-people-insufficient", "People: a payment OUT of ₹6,000 from QA Cash (₹5,000) is refused, nothing written", async ({ page }, chk) => {
  const cash = await f.bal("QA Cash");
  await f.openPerson(page, "QA Priya");
  await f.openRecord(page, { paid: true });
  await f.amountField(page).fill("6000");
  await page.getByText(/Select account|Pay from/).first().click();
  await page.getByRole("option", { name: /QA Cash/ }).click();
  await page.waitForTimeout(700);
  await h.shot(page, "rev-people-insufficient");
  const text = (await page.locator("body").innerText()).split("\n").join(" | ");
  const warn = text.match(/[^|]*(not enough|enough balance|insufficient|short by)[^|]*/i);
  const rec = page.getByRole("button", { name: /^Record ₹6,000/ }).first();
  chk("UI warns that QA Cash can't cover it", !!warn, warn ? warn[0].trim() : "no warning text: " + text.slice(text.indexOf("Amount"), text.indexOf("Amount") + 200));
  await page.evaluate(() => window.__reset());
  const disabled = await rec.isDisabled().catch(() => true);
  await rec.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(2500);
  chk("Record is blocked (disabled, or refused on save)", disabled || (await f.commits(page)) === 0 || f.close2(await f.bal("QA Cash"), cash), `disabled=${disabled}`);
  chk("cash unchanged and no payment transaction written (persisted)", f.close2(await f.bal("QA Cash"), cash) && (await f.txns((t) => t.amount === 6000)).length === 0, `${cash} -> ${await f.bal("QA Cash")}`);
});

scenario("rev-people-vs-lender-schedule", "People: a receipt from Priya (incl. her EMI share) never marks the lender's EMI installment paid", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  const lenderBefore = await f.scheduleState("emi", "QA Shared EMI");
  const bankBefore = await f.bal("QA Bank");
  chk("(fixture) shared EMI has 3 unpaid ₹3,000 installments", lenderBefore.length === 3 && f.paidTotal(lenderBefore) === 0, JSON.stringify(lenderBefore.map((i) => i.amountPaid)));
  // ₹1,500 = dinner ₹1,000 + ₹500 of Priya's EMI share.
  const btn = await receiptFromPriya(page, 1500, /^Record ₹1,500/);
  await page.evaluate(() => window.__reset());
  await btn.evaluate((b) => { b.click(); b.click(); });
  await page.waitForTimeout(4500);
  const body = (await page.locator("body").innerText()).split("\n").join(" ");
  await h.shot(page, "rev-people-vs-lender");
  const lenderAfter = await f.scheduleState("emi", "QA Shared EMI");
  chk("bank credited ₹1,500 exactly once (persisted)", f.close2((await f.bal("QA Bank")) - bankBefore, 1500));
  chk("People side shows her EMI share partly settled (₹500 of ₹1,000)", /paid ₹500/.test(body) || /Got ₹500 · ₹500 left/.test(body), (body.match(/EMI share[^A-Z]{0,40}/) ?? ["?"])[0]);
  chk("LENDER schedule untouched: every installment amountPaid still 0 (persisted)", f.paidTotal(lenderAfter) === 0, JSON.stringify(lenderAfter.map((i) => i.amountPaid)));
  await h.go(page, "/loans-installments");
  await page.waitForTimeout(3000);
  const loansText = (await page.locator("main").innerText()).split("\n").join(" | ");
  chk("Loan & EMI still shows the shared EMI as unpaid (principal remaining ₹9,000)", /QA Shared EMI[^|]*\|[^|]*\|[^|]*\|[^|]*₹9,000/.test(loansText) || /₹9,000/.test(loansText), (loansText.match(/QA Shared EMI[^]{0,120}/) ?? ["?"])[0]);
});

scenario("rev-people-edit-and-stale-edit", "People: edit a recorded receipt ₹1,000→₹700 (bank nets +₹700), then a stale edit from tab B after cancellation is refused", async ({ page, ctx }, chk) => {
  // An editable obligation: money I gave Ravi (ledger entry), not a split/EMI share (those are revert + re-record by design).
  const bank0 = await f.bal("QA Bank");
  await f.openPerson(page, "QA Ravi");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByText("I gave QA").waitFor();
  await page.getByText("I gave QA").click();
  await f.amountField(page).fill("2000");
  await page.getByPlaceholder(/e\.g\.|description/i).first().fill("QA lent to Ravi").catch(() => {});
  await f.pickAccountIn(page, "QA Bank");
  await page.getByRole("button", { name: /^Save ₹2,000/ }).click();
  await page.waitForTimeout(3500);
  const gave = await f.bal("QA Bank");
  chk("precondition: money given (bank −₹2,000)", f.close2(bank0 - gave, 2000), `${bank0} -> ${gave}`);

  // Receipt of ₹1,000 applied to that entry only (skip the split share).
  await f.openRecord(page);
  await f.amountField(page).fill("1000");
  // Put the ₹1,000 on the "lent to Ravi" row only: skip the (older) split-share row, then set the lent row's own amount.
  const panel = page.getByRole("dialog").last();
  const rowWith = (text) => panel.getByText(text).first().locator("xpath=ancestor::*[count(.//button[normalize-space()='Skip'])=1][1]");
  await rowWith("QA team dinner").getByRole("button", { name: "Skip" }).click();
  const lent = rowWith("QA lent to Ravi");
  await lent.getByRole("button", { name: "Part" }).click();
  await lent.locator("input").first().fill("1000");
  await f.pickAccountIn(page, "QA Bank");
  await page.waitForTimeout(400);
  await h.shot(page, "rev-people-edit-receipt-form");
  await page.getByRole("button", { name: /^Record ₹1,000/ }).first().click();
  await page.waitForTimeout(3500);
  const afterReceipt = await f.bal("QA Bank");
  chk("receipt recorded (+₹1,000)", f.close2(afterReceipt - gave, 1000), `${gave} -> ${afterReceipt}`);

  await f.expandRow(page, "QA lent to Ravi");
  const editBtn = page.getByTitle("Edit this payment").first();
  const editable = (await editBtn.count()) > 0;
  await h.shot(page, "rev-people-edit-row");
  chk("the receipt offers Edit (ledger obligation)", editable, `edit buttons: ${await page.getByTitle("Edit this payment").count()}`);
  if (!editable) return;

  // Tab B opens the same payment for editing, tab A cancels (reverts) it.
  const tabB = await ctx.newPage();
  tabB.setDefaultTimeout(30000);
  await tabB.goto(`${BASE_URL}/people`, { waitUntil: "domcontentloaded" });
  await f.openPerson(tabB, "QA Ravi");
  await f.expandRow(tabB, "QA lent to Ravi");
  await tabB.getByTitle("Edit this payment").first().click();
  await tabB.waitForTimeout(1200);
  await setEditAmount(tabB, 500);

  // Tab A: edit 1000 -> 700 (a normal edit, nets +700).
  await page.bringToFront();
  await editBtn.click();
  await page.waitForTimeout(1200);
  await setEditAmount(page, 700);
  await page.evaluate(() => window.__reset());
  const save = page.getByRole("button", { name: "Save changes" });
  await save.evaluate((b) => { b.click(); b.click(); });
  await page.waitForTimeout(4000);
  const afterEdit = await f.bal("QA Bank");
  chk("edit ₹1,000→₹700: bank nets +₹700 over the money given — not +₹1,700 (persisted; double-click once)", f.close2(afterEdit - gave, 700), `${gave} -> ${afterEdit}`);
  await h.shot(page, "rev-people-edit-done");

  // Tab A cancels (reverts) the payment.
  await page.waitForTimeout(1500);
  if ((await page.getByTitle("Revert this payment").count()) === 0) await f.expandRow(page, "QA lent to Ravi");
  await f.confirmRevert(page);
  await page.waitForTimeout(3500);
  const afterCancel = await f.bal("QA Bank");
  chk("cancel refunds the edited ₹700 exactly (persisted)", f.close2(afterCancel, gave), `${afterEdit} -> ${afterCancel}`);

  // Tab B (stale, still holding the old edit form) saves ₹500.
  await tabB.bringToFront();
  const bBefore = await f.bal("QA Bank");
  const saveB = tabB.getByRole("button", { name: "Save changes" });
  const saveBEnabled = (await saveB.count()) > 0 && (await saveB.isEnabled().catch(() => false));
  if (saveBEnabled) await saveB.click().catch(() => {});
  await tabB.waitForTimeout(4000);
  const bAfter = await f.bal("QA Bank");
  const msg = ((await tabB.locator('[role="alert"], [role="status"], [data-sonner-toast]').allInnerTexts()).join(" / ").replace(/\s+/g, " ").trim() || "(no alert/toast text)").slice(0, 200);
  await h.shot(tabB, "rev-people-stale-edit");
  chk("stale edit after cancellation is refused: no money moved (persisted)", f.close2(bAfter, bBefore) && f.close2(bAfter, gave), `${bBefore} -> ${bAfter}; save button ${saveBEnabled ? "was clickable" : "was disabled/gone"}; ${msg}`);
  chk("no new ₹500 payment transaction exists", (await f.txns((t) => t.type === "income" && t.amount === 500)).length === 0);
  await tabB.close();
});
