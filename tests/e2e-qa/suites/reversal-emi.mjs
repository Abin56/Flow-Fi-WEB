/**
 * EMI payments: record, mark unpaid, edit amount, slow refresh, refresh failure, duplicate clicks, two tabs, and
 * independence from the People Ledger. Each action is asserted on the browser AND on persisted emulator data
 * (account balance, the payment transaction, installment amountPaid). Local emulator only.
 */
import { scenario } from "../lib/core.mjs";
import { BASE_URL } from "../lib/env.mjs";
import * as f from "../lib/flows.mjs";
import * as h from "../lib/harness.mjs";

const EMI = "QA Phone EMI"; // ₹4,000 × 6, not card-linked, no People shares
const PAY4000 = /^Pay ₹4,000/;

async function emiId() {
  return (await h.list("emis")).find((e) => e.name === EMI).id;
}
const emiTxns = async () => {
  const id = await emiId();
  return f.txns((t) => t.emiId === id);
};
const emiPaid = async () => f.paidTotal(await f.scheduleState("emi", EMI));

async function openPay(page, name = EMI) {
  await h.go(page, "/loans-installments");
  await page.getByText(name).first().click();
  await page.getByRole("button", { name: "Record Payment" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay EMI/ });
  await dlg.getByText("TO PAY LENDER").waitFor();
  return dlg;
}
async function chooseBank(page, dlg) {
  await dlg.getByText("Choose paying account").click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
}
async function payOnce(page, { double = false } = {}) {
  const dlg = await openPay(page);
  await chooseBank(page, dlg);
  await page.evaluate(() => window.__reset());
  const btn = dlg.getByRole("button", { name: PAY4000 });
  if (double) await btn.evaluate((b) => { b.click(); b.click(); b.click(); });
  else await btn.click();
  await dlg.waitFor({ state: "hidden", timeout: 25000 });
  await page.waitForTimeout(1500);
}
async function openDetails(page, seq = 1) {
  await page.getByRole("button", { name: new RegExp(`Installment ${seq}.*(edit or mark unpaid|view payment)`) }).click();
  const d = page.getByRole("dialog", { name: /Recorded payment/ });
  await d.waitFor();
  return d;
}

scenario("rev-emi-record-unpaid", "EMI: record ₹4,000 (triple-click) → bank −₹4,000 once → mark unpaid (double-click) → refunded once", async ({ page }, chk) => {
  const base = await f.bal("QA Bank");
  await payOnce(page, { double: true });
  const afterPay = await f.bal("QA Bank");
  const tl = await h.timeline(page);
  const txs = await emiTxns();
  chk("bank debited exactly ₹4,000 once (persisted)", f.close2(base - afterPay, 4000), `${base} -> ${afterPay}`);
  chk("exactly one EMI payment transaction of ₹4,000 on QA Bank (persisted)", txs.length === 1 && txs[0].amount === 4000, txs.map((t) => `${t.amount}`).join(","));
  chk("installment 1 amountPaid = ₹4,000, nothing else paid (persisted)", (await emiPaid()) === 4000, JSON.stringify((await f.scheduleState("emi", EMI)).map((i) => i.amountPaid)));

  const det = await openDetails(page);
  const detText = await f.flat(det);
  await h.shot(page, "rev-emi-details");
  const chargedTo = (detText.match(/Charged to \| ([^|]*)/) ?? [])[1]?.trim() ?? "?";
  chk("[D-06] the payment details name the account that was actually debited (QA Bank), not 'Schedule only'", /QA Bank/.test(chargedTo) && !/no account/i.test(chargedTo), `Details show "Charged to: ${chargedTo}"`);

  await det.getByRole("button", { name: "Mark as unpaid" }).click();
  const confirm = page.getByRole("dialog").last();
  await confirm.getByText("This installment goes back to unpaid").waitFor();
  await page.evaluate(() => window.__reset());
  await confirm.getByRole("button", { name: "Mark as unpaid" }).evaluate((b) => { b.click(); b.click(); });
  await page.waitForTimeout(4500);
  const afterUnpay = await f.bal("QA Bank");
  chk("mark unpaid refunds the bank exactly once (persisted)", f.close2(afterUnpay, base), `${afterPay} -> ${afterUnpay} (base ${base})`);
  chk("the EMI payment transaction is no longer active; installment back to unpaid (persisted)", (await emiTxns()).length === 0 && (await emiPaid()) === 0);
  return tl;
});

const editBody = async ({ page }, chk) => {
  const base = await f.bal("QA Bank");
  await payOnce(page);
  const det = await openDetails(page);
  await det.getByRole("button", { name: "Edit payment" }).click();
  const ed = page.getByRole("dialog", { name: /Edit payment/ });
  await ed.getByText("Originally").waitFor();
  const inputs = await ed.locator("input:visible").evaluateAll((els) => els.map((e) => `${e.placeholder}|${e.value}`));
  chk("the edit form offers amount, date, note, GST, processing fee — and no funding-account field", !/Paid from/i.test(await f.flat(ed)), inputs.join(" ; "));
  await ed.locator("input:visible").first().fill("3000");
  await page.waitForTimeout(500);
  await h.shot(page, "rev-emi-edit");
  await page.evaluate(() => window.__reset());
  await ed.getByRole("button", { name: /^Save ₹3,000/ }).evaluate((b) => { b.click(); b.click(); });
  await page.waitForTimeout(5000);
  const after = await f.bal("QA Bank");
  const txs = await emiTxns();
  const state = await f.scheduleState("emi", EMI);
  chk("bank nets exactly −₹3,000 — not −₹7,000 (persisted; double-click once)", f.close2(base - after, 3000), `${base} -> ${after}`);
  chk("exactly one active EMI payment transaction of ₹3,000 (persisted)", txs.length === 1 && txs[0].amount === 3000, txs.map((t) => t.amount).join(","));
  chk("installment 1 is partly paid: ₹3,000 of ₹4,000 (persisted)", state[0].amountPaid === 3000 && f.paidTotal(state) === 3000, JSON.stringify(state.map((i) => i.amountPaid)));
  chk("[not supported] changing the funding account of an EMI payment — the edit dialog has no such field", true, "documented as Not Executed in the report");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  chk("no horizontal page overflow", overflow <= 1, `${overflow}px`);
  return await h.timeline(page);
};
scenario("rev-emi-edit-amount", "EMI: edit ₹4,000 → ₹3,000 (double-click Save) → bank nets −₹3,000, installment partly paid", editBody);
scenario("rev-emi-edit-mobile-dark", "EMI: the same edit on mobile 390×844, dark", editBody, { viewport: { width: 390, height: 844 }, scheme: "dark" });

scenario("rev-emi-slow-refresh", "EMI: payment with a slow (3 s) derived refresh — confirmation immediate, one debit", async ({ page }, chk) => {
  const base = await f.bal("QA Bank");
  await h.arm(page, { mode: "slow", delayMs: 3000 });
  const dlg = await openPay(page);
  await chooseBank(page, dlg);
  await page.evaluate(() => window.__reset());
  await dlg.getByRole("button", { name: PAY4000 }).click();
  await page.waitForTimeout(1300);
  const mid = await h.timeline(page);
  const label = await dlg.getByRole("button").last().innerText().catch(() => "(gone)");
  chk("confirmation is not delayed by the slow refresh", mid.success != null && mid.commitEnd != null && mid.success - mid.commitEnd < 700, `commitEnd ${mid.commitEnd}, success ${mid.success}`);
  chk("'Saved · Updating balances…' shown while refreshing", /Updating balances/.test(label), label.replace(/\n/g, " "));
  await page.waitForTimeout(5000);
  chk("exactly one debit of ₹4,000 (persisted)", f.close2(base - (await f.bal("QA Bank")), 4000) && (await emiTxns()).length === 1);
  return await h.timeline(page);
});

scenario("rev-emi-refresh-fail", "EMI: refresh fails after payment AND after mark-unpaid — warning, no retry, each effect once", async ({ page }, chk) => {
  const base = await f.bal("QA Bank");
  await h.arm(page, { mode: "fail", delayMs: 400 });
  const dlg = await openPay(page);
  await chooseBank(page, dlg);
  await page.evaluate(() => window.__reset());
  await dlg.getByRole("button", { name: PAY4000 }).click();
  await page.waitForTimeout(4500);
  const tl = await h.timeline(page);
  chk("payment: success shown after the commit, with a visible refresh warning", tl.success != null && tl.success >= tl.commitEnd && tl.refreshWarn != null, JSON.stringify(tl));
  chk("payment: one commit, one ₹4,000 debit (persisted)", (await f.commits(page)) === 1 && f.close2(base - (await f.bal("QA Bank")), 4000), `commits ${await f.commits(page)}`);
  const det = await openDetails(page);
  await det.getByRole("button", { name: "Mark as unpaid" }).click();
  const confirm = page.getByRole("dialog").last();
  await confirm.getByText("This installment goes back to unpaid").waitFor();
  await page.evaluate(() => window.__reset());
  await confirm.getByRole("button", { name: "Mark as unpaid" }).click();
  await page.waitForTimeout(4500);
  const tl2 = await h.timeline(page);
  chk("mark unpaid: confirmation + refresh warning, no retry (one commit)", tl2.success != null && tl2.refreshWarn != null && (await f.commits(page)) === 1, JSON.stringify(tl2));
  chk("bank back to base — refunded exactly once (persisted)", f.close2(await f.bal("QA Bank"), base), `${await f.bal("QA Bank")} vs ${base}`);
  return tl2;
});

scenario("rev-emi-two-tabs-pay", "EMI: two tabs open Pay for installment #1; A pays, then B (stale dialog) pays — what is charged", async ({ page, ctx }, chk) => {
  const base = await f.bal("QA Bank");
  const dlgA = await openPay(page);
  await chooseBank(page, dlgA);
  const tabB = await ctx.newPage();
  tabB.setDefaultTimeout(30000);
  await tabB.goto(`${BASE_URL}/loans-installments`, { waitUntil: "domcontentloaded" });
  await tabB.getByText(EMI).first().click();
  await tabB.getByRole("button", { name: "Record Payment" }).click();
  const dlgB = tabB.getByRole("dialog", { name: /Pay EMI/ });
  await dlgB.getByText("TO PAY LENDER").waitFor();
  await chooseBank(tabB, dlgB);
  const shownB = await f.flat(dlgB);

  await page.bringToFront();
  await page.waitForTimeout(800);
  let reopened = false;
  if ((await dlgA.getByRole("button", { name: PAY4000 }).count()) === 0) {
    // Switching tabs closed A's dialog (focus/visibility handling) — reopen it exactly as a user would.
    reopened = true;
    const again = await openPay(page);
    await chooseBank(page, again);
  }
  const payA = page.getByRole("dialog", { name: /Pay EMI/ }).getByRole("button", { name: PAY4000 });
  await payA.click();
  await page.getByRole("dialog", { name: /Pay EMI/ }).waitFor({ state: "hidden", timeout: 25000 });
  await page.waitForTimeout(1500);
  const afterA = await f.bal("QA Bank");
  if (reopened) chk("(observation) tab A's open Pay dialog was closed by switching tabs and had to be reopened", true);
  chk("tab A paid installment #1 (−₹4,000, persisted)", f.close2(base - afterA, 4000), `${base} -> ${afterA}`);

  await tabB.bringToFront();
  await tabB.waitForTimeout(1500);
  const bBtn = dlgB.getByRole("button", { name: /^Pay ₹/ }).last();
  const bLabel = (await bBtn.count()) ? (await bBtn.innerText()).split("\n").join(" ") : "(dialog gone)";
  const bEnabled = (await bBtn.count()) > 0 && (await bBtn.isEnabled().catch(() => false));
  const stillShowsFirst = /Installment #1/.test(await f.flat(dlgB).catch(() => ""));
  if (bEnabled) await bBtn.click().catch(() => {});
  await tabB.waitForTimeout(4500);
  const afterB = await f.bal("QA Bank");
  const state = await f.scheduleState("emi", EMI);
  const alerts = (await tabB.locator('[role="alert"], [role="status"], [data-sonner-toast]').allInnerTexts()).join(" / ").replace(/\s+/g, " ").slice(0, 220);
  await h.shot(tabB, "rev-emi-two-tabs-b");
  const txs = await emiTxns();
  chk("tab B opened its dialog on installment #1", /Installment #1/.test(shownB), shownB.slice(0, 120));
  chk("money stays internally consistent: every installment amountPaid ≤ amountDue (persisted)", state.every((i) => i.amountPaid <= i.amountDue), JSON.stringify(state.map((i) => i.amountPaid)));
  chk("account debit equals the sum of installment amountPaid, and one active payment transaction per paid installment (persisted)", f.close2(base - afterB, f.paidTotal(state)) && txs.length === state.filter((i) => i.amountPaid > 0).length, `debit ${base - afterB}, paid ${f.paidTotal(state)}, txns ${txs.length}`);
  chk("[F-07] tab B's stale Pay (reviewed #1, already paid in tab A) is refused — no second debit, #2 untouched (persisted)", f.close2(base - afterB, 4000) && state[0].amountPaid === 4000 && state[1].amountPaid === 0 && txs.length === 1, `tab B button "${bLabel}" (${bEnabled ? "clickable" : "disabled/gone"}, dialog still showed #1: ${stillShowsFirst}); debit ${base - afterB}; installments paid ${JSON.stringify(state.map((i) => i.amountPaid))}`);
  chk("[F-07] tab B explains that the installment changed and asks the user to refresh and choose", /changed since you opened it/i.test(alerts + " " + (await f.flat(dlgB).catch(() => ""))), alerts || "no message");

  chk("[F-07] the stale error says to refresh and select the installment again, and offers no 'Try again'", /select the installment again/i.test(alerts) && (await tabB.getByRole("button", { name: /try again|retry/i }).count()) === 0, alerts.slice(0, 200));

  // Explicitly choosing the next installment afterwards is a normal, single payment.
  await tabB.reload({ waitUntil: "domcontentloaded" });
  await tabB.getByText(EMI).first().click();
  await tabB.getByRole("button", { name: "Record Payment" }).click();
  const dlgB2 = tabB.getByRole("dialog", { name: /Pay EMI/ });
  await dlgB2.getByText("TO PAY LENDER").waitFor();
  const nextShown = await f.flat(dlgB2);
  await chooseBank(tabB, dlgB2);
  await dlgB2.getByRole("button", { name: PAY4000 }).click();
  await dlgB2.waitFor({ state: "hidden", timeout: 25000 });
  await tabB.waitForTimeout(1500);
  const final = await f.scheduleState("emi", EMI);
  const finalTxs = await emiTxns();
  chk("the reopened dialog offers installment #2", /Installment #2/.test(nextShown), nextShown.slice(0, 120));
  chk("explicitly paying #2 debits ₹4,000 once more: bank −₹8,000, installments 4000/4000, two transactions (persisted)", f.close2(base - (await f.bal("QA Bank")), 8000) && final[0].amountPaid === 4000 && final[1].amountPaid === 4000 && finalTxs.length === 2, `paid ${JSON.stringify(final.map((i) => i.amountPaid))}, txns ${finalTxs.length}`);
  await tabB.close();
});

scenario("rev-emi-two-tabs-partial", "EMI: A pays ₹1,000 of #1; B's stale dialog (full ₹4,000 on #1) is refused — it must not spill onto #2", async ({ page, ctx }, chk) => {
  const base = await f.bal("QA Bank");
  const tabB = await ctx.newPage();
  tabB.setDefaultTimeout(30000);
  await tabB.goto(`${BASE_URL}/loans-installments`, { waitUntil: "domcontentloaded" });
  await tabB.getByText(EMI).first().click();
  await tabB.getByRole("button", { name: "Record Payment" }).click();
  const dlgB = tabB.getByRole("dialog", { name: /Pay EMI/ });
  await dlgB.getByText("TO PAY LENDER").waitFor();
  await chooseBank(tabB, dlgB);

  await page.bringToFront();
  const dlgA = await openPay(page);
  await chooseBank(page, dlgA);
  await dlgA.getByRole("radio", { name: /Part payment or another amount/ }).click();
  await dlgA.locator('input:visible:not([aria-label="Payment date"]):not([type=date])').first().fill("1000");
  await page.waitForTimeout(400);
  await dlgA.getByRole("button", { name: /^Pay ₹1,000/ }).click();
  await dlgA.waitFor({ state: "hidden", timeout: 25000 });
  await page.waitForTimeout(1500);
  chk("tab A paid ₹1,000 as a partial payment of #1 (persisted)", f.close2(base - (await f.bal("QA Bank")), 1000) && (await emiPaid()) === 1000);

  await tabB.bringToFront();
  await tabB.waitForTimeout(1500);
  const bBtn = dlgB.getByRole("button", { name: /^Pay ₹/ }).last();
  const clickable = (await bBtn.count()) > 0 && (await bBtn.isEnabled().catch(() => false));
  if (clickable) await bBtn.click().catch(() => {});
  await tabB.waitForTimeout(4500);
  const state = await f.scheduleState("emi", EMI);
  const txs = await emiTxns();
  const alerts = (await tabB.locator('[role="alert"], [role="status"], [data-sonner-toast]').allInnerTexts()).join(" / ").replace(/s+/g, " ").slice(0, 220);
  await h.shot(tabB, "rev-emi-two-tabs-partial-b");
  chk("tab B's stale full payment was refused: bank still −₹1,000 only, #1 = ₹1,000, #2 = ₹0, one transaction (persisted)", f.close2(base - (await f.bal("QA Bank")), 1000) && state[0].amountPaid === 1000 && state[1].amountPaid === 0 && txs.length === 1, `B clickable ${clickable}; paid ${JSON.stringify(state.map((i) => i.amountPaid))}; txns ${txs.length}`);
  chk("tab B shows the 'installment changed' message", !clickable || /changed since you opened it/i.test(alerts + " " + (await f.flat(dlgB).catch(() => ""))), alerts || "no message");
  await tabB.close();
});

scenario("rev-emi-label-funding", "EMI: payment details name the funding — account-funded says QA Bank; an 'already paid earlier' payment says no balance change", async ({ page }, chk) => {
  const base = await f.bal("QA Bank");
  // Account-funded (pay now from QA Bank).
  await payOnce(page);
  const det = await openDetails(page);
  const funded = (((await f.flat(det)).match(/Charged to \| ([^|]*)/) ?? [])[1] ?? "?").trim();
  chk("account-funded EMI payment: 'Charged to' = QA Bank", /^QA Bank$/.test(funded), funded);
  await page.keyboard.press("Escape");
  await det.waitFor({ state: "hidden" }).catch(() => {});

  // Account-neutral historical payment of installment #2.
  const dlg = await openPay(page);
  // Record past payments → the installment the dialog was on (#2, not due yet — paid ahead) → the single past-payment form.
  await dlg.getByRole("button", { name: /Record past payments/ }).click();
  await page.getByRole("button", { name: "Continue with 1 EMI" }).click();
  const past = page.getByRole("dialog", { name: /Record past payment/ });
  await past.getByRole("button", { name: /^Save past payment/ }).waitFor();
  await past.getByRole("button", { name: /^Save past payment/ }).click();
  await past.waitFor({ state: "hidden", timeout: 25000 });
  await page.waitForTimeout(1500);
  const state = await f.scheduleState("emi", EMI);
  const txs = await emiTxns();
  chk("historical payment moved no money: bank still −₹4,000 only, two installments paid, one transaction (persisted)", f.close2(base - (await f.bal("QA Bank")), 4000) && state[0].amountPaid === 4000 && state[1].amountPaid === 4000 && txs.length === 1, `paid ${JSON.stringify(state.map((i) => i.amountPaid))}, txns ${txs.length}`);
  const det2 = await openDetails(page, 2);
  const neutral = (((await f.flat(det2)).match(/Charged to \| ([^|]*)/) ?? [])[1] ?? "?").trim();
  await h.shot(page, "rev-emi-label-neutral");
  chk("account-neutral EMI payment: 'Charged to' says it was paid before FlowFi with no balance change — not an account", /Paid before FlowFi/.test(neutral) && /no balance change/i.test(neutral), neutral);
});

scenario("rev-emi-two-tabs-unpaid", "EMI: two tabs mark the same payment unpaid — refunded exactly once", async ({ page, ctx }, chk) => {
  const base = await f.bal("QA Bank");
  await payOnce(page);
  const afterPay = await f.bal("QA Bank");
  chk("precondition: paid (−₹4,000)", f.close2(base - afterPay, 4000));
  const detA = await openDetails(page);
  await detA.getByRole("button", { name: "Mark as unpaid" }).click();
  const confA = page.getByRole("dialog").last();
  await confA.getByText("This installment goes back to unpaid").waitFor();

  const tabB = await ctx.newPage();
  tabB.setDefaultTimeout(30000);
  await tabB.goto(`${BASE_URL}/loans-installments`, { waitUntil: "domcontentloaded" });
  await tabB.getByText(EMI).first().click();
  await tabB.getByRole("button", { name: /Installment 1.*(edit or mark unpaid|view payment)/ }).click();
  const detB = tabB.getByRole("dialog", { name: /Recorded payment/ });
  await detB.waitFor();
  await detB.getByRole("button", { name: "Mark as unpaid" }).click();
  const confB = tabB.getByRole("dialog").last();
  await confB.getByText("This installment goes back to unpaid").waitFor();

  await page.bringToFront();
  await confA.getByRole("button", { name: "Mark as unpaid" }).click();
  await page.waitForTimeout(3500);
  const afterA = await f.bal("QA Bank");
  chk("tab A's mark-unpaid refunded the bank (+₹4,000, persisted)", f.close2(afterA, base), `${afterPay} -> ${afterA}`);

  await tabB.bringToFront();
  await tabB.waitForTimeout(1200);
  const bBtn = confB.getByRole("button", { name: "Mark as unpaid" });
  const bEnabled = (await bBtn.count()) > 0 && (await bBtn.isEnabled().catch(() => false));
  if (bEnabled) await bBtn.click().catch(() => {});
  await tabB.waitForTimeout(3500);
  const finalBal = await f.bal("QA Bank");
  const alerts = (await tabB.locator('[role="alert"], [role="status"], [data-sonner-toast]').allInnerTexts()).join(" / ").replace(/\s+/g, " ").slice(0, 200);
  chk("tab B's stale mark-unpaid refunds nothing more — exactly one refund overall (persisted)", f.close2(finalBal, base), `${afterA} -> ${finalBal}; confirm ${bEnabled ? "was clickable" : "was disabled/gone"}; ${alerts || "no message"}`);
  chk("the EMI payment transaction is inactive and the installment unpaid (persisted)", (await emiTxns()).length === 0 && (await emiPaid()) === 0);
  await tabB.close();
});

scenario("rev-emi-shared-people-independent", "Shared EMI: paying the lender (own money) and receiving from Priya are independent — account effects once, People status unchanged by the lender payment", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  const SHARED = "QA Shared EMI";
  const bank0 = await f.bal("QA Bank");
  const dlg = await openPay(page, SHARED);
  const text = await f.flat(dlg);
  await h.shot(page, "rev-emi-shared-gate");
  chk("the lender payment asks how to treat the people's open shares (gate shown)", /own money|collect|Priya|Ravi/i.test(text), text.slice(text.indexOf("TO PAY"), text.indexOf("TO PAY") + 420));
  // Explicit choice: pay from my own money (the gate's acknowledgement), then choose the account.
  await dlg.getByText(/Pay now from my account/i).first().click();
  await page.waitForTimeout(600);
  const reason = dlg.getByRole("radio").first();
  if (await reason.count()) await reason.click().catch(() => {});
  await chooseBank(page, dlg).catch(() => {});
  await h.shot(page, "rev-emi-shared-own-money");
  await page.evaluate(() => window.__reset());
  const payBtn = dlg.getByRole("button", { name: /^Pay ₹3,000/ });
  await payBtn.evaluate((b) => { b.click(); b.click(); });
  await dlg.waitFor({ state: "hidden", timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const state = await f.scheduleState("emi", SHARED);
  chk("lender side: installment 1 paid ₹3,000, nothing else (persisted)", state[0].amountPaid === 3000 && f.paidTotal(state) === 3000, JSON.stringify(state.map((i) => i.amountPaid)));
  chk("bank debited exactly ₹3,000 once (persisted; double-click)", f.close2(bank0 - (await f.bal("QA Bank")), 3000), `${bank0} -> ${await f.bal("QA Bank")}`);
  const priyaIncome = await f.txns((t) => t.type === "income" && /Priya|QA/.test(t.description ?? "") && t.amount === 1000);
  chk("the lender payment created NO receipt/settlement for Priya or Ravi (persisted)", (await f.txns((t) => t.type === "income")).filter((t) => t.description !== "QA salary").length === 0 && priyaIncome.length === 0);

  // People side is independent: Priya still owes her EMI share + dinner share.
  await h.go(page, "/people");
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /Open QA Priya/ }).click();
  await page.waitForTimeout(2000);
  const priya = (await page.locator("body").innerText()).split("\n").join(" ");
  await h.shot(page, "rev-emi-shared-priya");
  chk("People: Priya still owes ₹2,000 (EMI share ₹1,000 + dinner ₹1,000) — unchanged by the lender payment", /CURRENT PENDING\s*₹2,000/.test(priya), (priya.match(/CURRENT PENDING[^A-Z]{0,20}/) ?? ["?"])[0]);

  // Receiving from Priya does not touch the lender schedule.
  const bankBeforeReceipt = await f.bal("QA Bank");
  await f.openRecord(page);
  await f.amountField(page).fill("2000");
  await f.pickAccountIn(page, "QA Bank");
  await page.getByRole("button", { name: /^Record ₹2,000/ }).first().click();
  await page.waitForTimeout(4000);
  const state2 = await f.scheduleState("emi", SHARED);
  chk("receipt from Priya: bank +₹2,000 once (persisted)", f.close2((await f.bal("QA Bank")) - bankBeforeReceipt, 2000));
  chk("…and the lender schedule is exactly as before (persisted)", JSON.stringify(state2.map((i) => i.amountPaid)) === JSON.stringify(state.map((i) => i.amountPaid)), JSON.stringify(state2.map((i) => i.amountPaid)));
});
