/**
 * Card-linked EMI (isolated "QA EMI Card" + "QA Card EMI", ₹12,000 / 4 = ₹3,000 each): payment posts on the CARD (never a bank),
 * mark-unpaid reverses it once, and a stale second tab can neither charge the card twice nor pay a different installment.
 * Every check reads persisted card balance, transactions and installment amountPaid back from the emulator. Local emulator only.
 */
import { scenario } from "../lib/core.mjs";
import { BASE_URL } from "../lib/env.mjs";
import * as f from "../lib/flows.mjs";
import * as h from "../lib/harness.mjs";

const EMI = "QA Card EMI";
const CARD = "QA EMI Card";
const PAY3000 = /^Pay ₹3,000/;

const cardBal = async () => (await h.accountBalance(CARD)).currentBalance;
const emiTxns = async () => {
  const id = (await h.list("emis")).find((e) => e.name === EMI).id;
  return f.txns((t) => t.emiId === id);
};

async function openPay(page) {
  await h.go(page, "/loans-installments");
  await page.getByText(EMI).first().click();
  await page.getByRole("button", { name: "Record Payment" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay EMI/ });
  await dlg.getByText("TO PAY LENDER").waitFor();
  return dlg;
}
const paidList = async () => (await f.scheduleState("emi", EMI)).map((i) => i.amountPaid);

scenario("card-emi-pay-and-reverse", "Card EMI: pay ₹3,000 (double-click) → charged to the card once, bank untouched → mark unpaid → card restored once", async ({ page }, chk) => {
  await h.addFixture(page, "card-emi");
  const bank0 = await f.bal("QA Bank");
  const card0 = await cardBal();
  const dlg = await openPay(page);
  const dlgText = await f.flat(dlg);
  chk("the dialog names the card it will charge and asks for no bank account", /Card ••9090/.test(dlgText) && !/Choose paying account/.test(dlgText), dlgText.slice(0, 260));
  await page.evaluate(() => window.__reset());
  await dlg.getByRole("button", { name: PAY3000 }).evaluate((b) => { b.click(); b.click(); });
  await dlg.waitFor({ state: "hidden", timeout: 25000 });
  await page.waitForTimeout(1500);
  const txs = await emiTxns();
  const card = (await h.list("accounts")).find((a) => a.name === CARD);
  chk("the card balance moved by exactly ₹3,000 once (persisted)", f.close2(Math.abs(card0 - (await cardBal())), 3000), `${card0} -> ${await cardBal()}`);
  chk("the bank is untouched (persisted)", f.close2(await f.bal("QA Bank"), bank0));
  chk("exactly one EMI transaction of ₹3,000, on the card account (persisted)", txs.length === 1 && txs[0].amount === 3000 && txs[0].accountId === card.id, txs.map((t) => `${t.amount}@${t.accountId}`).join(","));
  chk("installment #1 amountPaid = ₹3,000, nothing else (persisted)", JSON.stringify(await paidList()) === JSON.stringify([3000, 0, 0, 0]), JSON.stringify(await paidList()));

  await page.getByRole("button", { name: /Installment 1.*(edit or mark unpaid|view payment)/ }).click();
  const det = page.getByRole("dialog", { name: /Recorded payment/ });
  await det.waitFor();
  const charged = (((await f.flat(det)).match(/Charged to \| ([^|]*)/) ?? [])[1] ?? "?").trim();
  await h.shot(page, "card-emi-details");
  chk("details: 'Charged to' names the card (••9090)", /••9090/.test(charged), charged);
  await det.getByRole("button", { name: "Mark as unpaid" }).click();
  const confirm = page.getByRole("dialog").last();
  await confirm.getByText("This installment goes back to unpaid").waitFor();
  await confirm.getByRole("button", { name: "Mark as unpaid" }).evaluate((b) => { b.click(); b.click(); });
  await page.waitForTimeout(4500);
  chk("mark unpaid restores the card exactly once (persisted)", f.close2(await cardBal(), card0), `${await cardBal()} (base ${card0})`);
  chk("no active EMI transaction; installment unpaid; bank still untouched (persisted)", (await emiTxns()).length === 0 && JSON.stringify(await paidList()) === JSON.stringify([0, 0, 0, 0]) && f.close2(await f.bal("QA Bank"), bank0));
});

scenario("card-emi-stale-two-tabs", "Card EMI: A pays #1, B's stale dialog is refused (no retry offered, card charged once); explicitly paying #2 then works", async ({ page, ctx }, chk) => {
  await h.addFixture(page, "card-emi");
  const card0 = await cardBal();
  const tabB = await ctx.newPage();
  tabB.setDefaultTimeout(30000);
  await tabB.goto(`${BASE_URL}/loans-installments`, { waitUntil: "domcontentloaded" });
  await tabB.getByText(EMI).first().click();
  await tabB.getByRole("button", { name: "Record Payment" }).click();
  const dlgB = tabB.getByRole("dialog", { name: /Pay EMI/ });
  await dlgB.getByText("TO PAY LENDER").waitFor();

  await page.bringToFront();
  const dlgA = await openPay(page);
  await dlgA.getByRole("button", { name: PAY3000 }).click();
  await dlgA.waitFor({ state: "hidden", timeout: 25000 });
  await page.waitForTimeout(1500);
  chk("tab A charged the card ₹3,000 for #1 (persisted)", f.close2(Math.abs(card0 - (await cardBal())), 3000));

  await tabB.bringToFront();
  await tabB.waitForTimeout(1500);
  const bBtn = dlgB.getByRole("button", { name: /^Pay ₹/ }).last();
  const clickable = (await bBtn.count()) > 0 && (await bBtn.isEnabled().catch(() => false));
  if (clickable) await bBtn.click().catch(() => {});
  await tabB.waitForTimeout(4500);
  const alerts = (await tabB.locator('[role="alert"], [role="status"], [data-sonner-toast]').allInnerTexts()).join(" / ").replace(/\s+/g, " ");
  const retryOffered = (await tabB.getByRole("button", { name: /try again|retry/i }).count()) > 0;
  await h.shot(tabB, "card-emi-stale-b");
  chk("tab B's stale payment charged nothing more: card still ₹3,000, #1 = ₹3,000, #2 = ₹0, one transaction (persisted)", f.close2(Math.abs(card0 - (await cardBal())), 3000) && JSON.stringify(await paidList()) === JSON.stringify([3000, 0, 0, 0]) && (await emiTxns()).length === 1, `B clickable ${clickable}; ${JSON.stringify(await paidList())}`);
  chk("tab B says the installment changed and to refresh and select it again", /changed since you opened it/i.test(alerts) && /select the installment again/i.test(alerts), alerts.slice(0, 220));
  chk("no 'Try again' / retry is offered for the stale error", !retryOffered, retryOffered ? "a retry control is visible" : "none");

  await tabB.reload({ waitUntil: "domcontentloaded" });
  await tabB.getByText(EMI).first().click();
  await tabB.getByRole("button", { name: "Record Payment" }).click();
  const dlgB2 = tabB.getByRole("dialog", { name: /Pay EMI/ });
  await dlgB2.getByText("TO PAY LENDER").waitFor();
  const shown = await f.flat(dlgB2);
  await dlgB2.getByRole("button", { name: PAY3000 }).click();
  await dlgB2.waitFor({ state: "hidden", timeout: 25000 });
  await tabB.waitForTimeout(1500);
  chk("the reopened dialog offers #2; paying it charges the card ₹3,000 more: ₹6,000, installments 3000/3000, two transactions (persisted)", /Installment #2/.test(shown) && f.close2(Math.abs(card0 - (await cardBal())), 6000) && JSON.stringify(await paidList()) === JSON.stringify([3000, 3000, 0, 0]) && (await emiTxns()).length === 2, `${shown.slice(0, 80)} | ${await cardBal()} | ${JSON.stringify(await paidList())}`);
  await tabB.close();
});

scenario("card-emi-bank-funded", "Card EMI paid from savings: the dialog offers both modes, states the effect, debits QA Bank exactly once with NO card charge → mark unpaid → bank restored once", async ({ page }, chk) => {
  await h.addFixture(page, "card-emi");
  const bank0 = await f.bal("QA Bank");
  const card0 = await cardBal();
  const dlg = await openPay(page);
  chk("both funding modes are offered; the card is the default", (await dlg.getByRole("radio", { name: /Charge to Card ••9090/ }).getAttribute("aria-checked")) === "true" && (await dlg.getByRole("radio", { name: "Pay from a bank account" }).count()) === 1);
  await dlg.getByRole("radio", { name: "Pay from a bank account" }).click();
  chk("bank mode asks for the paying account and never lists the card", await dlg.getByText("Choose paying account").isVisible());
  await dlg.getByText("Choose paying account").click();
  chk("the credit card isn't offered as a paying account", (await page.getByRole("option", { name: new RegExp(CARD) }).count()) === 0);
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await page.waitForTimeout(500);
  const effect = await dlg.getByTestId("account-movement").innerText();
  await h.shot(page, "card-emi-bank-funded-dialog");
  chk("the effect is shown before confirming: taken from QA Bank, nothing charged to the card", /taken from QA Bank/.test(effect) && /Nothing is charged to Card/.test(effect), effect);
  await page.evaluate(() => window.__reset());
  await dlg.getByRole("button", { name: PAY3000 }).evaluate((b) => { b.click(); b.click(); });
  await dlg.waitFor({ state: "hidden", timeout: 25000 });
  await page.waitForTimeout(1500);
  const txs = await emiTxns();
  const bankAcc = (await h.list("accounts")).find((a) => a.name === "QA Bank");
  chk("QA Bank debited exactly ₹3,000 once (persisted)", f.close2(bank0 - (await f.bal("QA Bank")), 3000), `${bank0} -> ${await f.bal("QA Bank")}`);
  chk("the card is untouched — no statement charge (persisted)", f.close2(await cardBal(), card0), `${card0} -> ${await cardBal()}`);
  chk("exactly one EMI transaction of ₹3,000, on the bank account (persisted)", txs.length === 1 && txs[0].amount === 3000 && txs[0].accountId === bankAcc.id, txs.map((t) => `${t.amount}@${t.accountId}`).join(","));
  chk("installment #1 amountPaid = ₹3,000 (persisted)", JSON.stringify(await paidList()) === JSON.stringify([3000, 0, 0, 0]), JSON.stringify(await paidList()));
  await page.getByRole("button", { name: /Installment 1.*(edit or mark unpaid|view payment)/ }).click();
  const det = page.getByRole("dialog", { name: /Recorded payment/ });
  await det.waitFor();
  const charged = (((await f.flat(det)).match(/Charged to \| ([^|]*)/) ?? [])[1] ?? "?").trim();
  chk("details: 'Charged to' names QA Bank, not the card", /QA Bank/.test(charged) && !/••9090/.test(charged), charged);
  await det.getByRole("button", { name: "Mark as unpaid" }).click();
  const confirm = page.getByRole("dialog").last();
  await confirm.getByText("This installment goes back to unpaid").waitFor();
  await confirm.getByRole("button", { name: "Mark as unpaid" }).evaluate((b) => { b.click(); b.click(); });
  await page.waitForTimeout(4500);
  chk("mark unpaid restores QA Bank exactly once; card still untouched (persisted)", f.close2(await f.bal("QA Bank"), bank0) && f.close2(await cardBal(), card0), `${await f.bal("QA Bank")} / ${await cardBal()}`);
  chk("no active EMI transaction; installment unpaid (persisted)", (await emiTxns()).length === 0 && JSON.stringify(await paidList()) === JSON.stringify([0, 0, 0, 0]));
});
