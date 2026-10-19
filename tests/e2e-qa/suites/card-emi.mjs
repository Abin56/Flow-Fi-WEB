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
  const impact = await f.flat(dlg.getByTestId("card-impact"));
  await h.shot(page, "card-emi-bank-funded-dialog");
  chk("the effect is shown before confirming: taken from QA Bank, nothing new charged to the card", /taken from QA Bank/.test(effect) && /Charged to card \| Nothing new/.test(impact), `${effect} // ${impact}`);
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
  const charged = (((await f.flat(det)).match(/Paid from \| ([^|]*)/) ?? [])[1] ?? "?").trim();
  chk("details: 'Paid from' names QA Bank, not the card", /QA Bank/.test(charged) && !/••9090/.test(charged), charged);
  await det.getByRole("button", { name: "Mark as unpaid" }).click();
  const confirm = page.getByRole("dialog").last();
  await confirm.getByText("This installment goes back to unpaid").waitFor();
  await confirm.getByRole("button", { name: "Mark as unpaid" }).evaluate((b) => { b.click(); b.click(); });
  await page.waitForTimeout(4500);
  chk("mark unpaid restores QA Bank exactly once; card still untouched (persisted)", f.close2(await f.bal("QA Bank"), bank0) && f.close2(await cardBal(), card0), `${await f.bal("QA Bank")} / ${await cardBal()}`);
  chk("no active EMI transaction; installment unpaid (persisted)", (await emiTxns()).length === 0 && JSON.stringify(await paidList()) === JSON.stringify([0, 0, 0, 0]));
});

// ── Case A (purchase already on the card): the payment details / unpay wording follows the legs actually posted ──
const A_CARD = "QA Case A Card";
const aBal = async () => (await h.accountBalance(A_CARD)).currentBalance;
const aTxns = async (name) => {
  const id = (await h.list("emis")).find((e) => e.name === name).id;
  return f.txns((t) => t.emiId === id);
};
async function openAPay(page, name) {
  await h.go(page, "/loans-installments");
  await page.getByText(name).first().click();
  await page.getByRole("button", { name: "Record Payment" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay EMI/ });
  await dlg.getByText("TO PAY LENDER").waitFor();
  return dlg;
}
async function openDetails(page) {
  await page.getByRole("button", { name: /Installment 1.*(edit or mark unpaid|view payment)/ }).click();
  const det = page.getByRole("dialog", { name: /Recorded payment/ });
  await det.waitFor();
  return det;
}
async function unpay(page, det) {
  await det.getByRole("button", { name: "Mark as unpaid" }).click();
  const confirm = page.getByRole("dialog").last();
  await confirm.getByText("This installment goes back to unpaid").waitFor();
  const text = await f.flat(confirm);
  await confirm.getByRole("button", { name: "Mark as unpaid" }).evaluate((b) => { b.click(); b.click(); });
  await page.waitForTimeout(4500);
  return text;
}

scenario("card-emi-case-a-wording", "Case A card EMI (interest + interest-free): effect, details and Mark-as-unpaid wording follow the legs actually posted", async ({ page }, chk) => {
  await h.addFixture(page, "card-emi-a");
  const card0 = await aBal(); // −18,000: both purchases
  // — interest EMI, charge to card: only the interest is charged —
  let dlg = await openAPay(page, "QA Case A EMI");
  const effect = await dlg.getByTestId("account-movement").innerText();
  const impactA = await f.flat(dlg.getByTestId("card-impact"));
  chk("the effect says only interest & fees are charged and the principal is already in the card balance", /₹120 interest & fees will be charged to Card ••9191/.test(effect) && /Principal · already in card balance/.test(impactA) && /you settle it with the card bill/.test(impactA), `${effect} // ${impactA}`);
  await h.shot(page, "card-emi-case-a-dialog");
  await dlg.getByRole("button", { name: /^Pay ₹3,075\.37/ }).click();
  await dlg.waitFor({ state: "hidden", timeout: 25000 });
  await page.waitForTimeout(1500);
  const txs = await aTxns("QA Case A EMI");
  chk("persisted: ONE card charge of exactly ₹120 (interest), card liability ₹18,120", txs.length === 1 && txs[0].amount === 120 && f.close2(Math.abs(card0 - (await aBal())), 120), `${txs.map((t) => t.amount)} ${card0} -> ${await aBal()}`);
  let det = await openDetails(page);
  const dText = await f.flat(det);
  const charged = ((dText.match(/Charged to \| ([^|]*)/) ?? [])[1] ?? "?").trim();
  await h.shot(page, "card-emi-case-a-details");
  chk("details show the ACTUAL card charge (₹120 interest & fees), not the ₹3,075.37 EMI", /₹120\b/.test(charged) && /interest & fees/.test(charged) && !/3,075\.37/.test(charged), charged);
  let unpayText = await unpay(page, det);
  chk("Mark as unpaid names the ₹120 interest & fees charge only", /₹120 interest & fees charge is removed/.test(unpayText), unpayText.slice(0, 300));
  chk("reversal restores the card exactly (persisted)", f.close2(await aBal(), card0) && (await aTxns("QA Case A EMI")).length === 0, `${await aBal()} (base ${card0})`);

  // — interest-free EMI, charge to card: nothing is charged at all —
  dlg = await openAPay(page, "QA Case A Free EMI");
  const effect0 = await dlg.getByTestId("account-movement").innerText();
  const impact0 = await f.flat(dlg.getByTestId("card-impact"));
  chk("interest-free: the effect says nothing new is charged", /Nothing new is charged to Card ••9191/.test(effect0) && /Charged to card \| Nothing new/.test(impact0), `${effect0} // ${impact0}`);
  await dlg.getByRole("button", { name: /^Pay ₹1,500/ }).click();
  await dlg.waitFor({ state: "hidden", timeout: 25000 });
  await page.waitForTimeout(1500);
  chk("persisted: NO transaction, card unchanged, installment paid", (await aTxns("QA Case A Free EMI")).length === 0 && f.close2(await aBal(), card0));
  det = await openDetails(page);
  const d0 = await f.flat(det);
  await h.shot(page, "card-emi-case-a-zero-details");
  chk("details do NOT say 'Charged to' the card — 'Card charge | None — principal already on the card'", !/Charged to/.test(d0) && /Card charge \| None/.test(d0), d0.slice(0, 400));
  unpayText = await unpay(page, det);
  chk("Mark as unpaid says only the schedule changes — no card charge", /Only the schedule changes — no card charge was recorded/.test(unpayText) && !/charge is removed from/.test(unpayText), unpayText.slice(0, 300));
});

scenario("card-emi-case-a-bank", "Case A card EMI paid from QA Bank: interest on the bank + principal paid to the card; details and unpay say exactly that", async ({ page }, chk) => {
  await h.addFixture(page, "card-emi-a");
  const bank0 = await f.bal("QA Bank");
  const card0 = await aBal();
  const dlg = await openAPay(page, "QA Case A EMI");
  await dlg.getByRole("radio", { name: "Pay from a bank account" }).click();
  await dlg.getByText("Choose paying account").click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await page.waitForTimeout(500);
  const effect = await dlg.getByTestId("account-movement").innerText();
  const impactB = await f.flat(dlg.getByTestId("card-impact"));
  chk("effect: taken from QA Bank; ₹2,955.37 paid toward the card balance; interest & fees shown; available credit +₹2,955.37", /₹3,075\.37 will be taken from QA Bank/.test(effect) && /Paid toward card balance \| ₹2,955\.37/.test(impactB) && /Interest & fees \| ₹120/.test(impactB) && /available credit \| .*2,955\.37/.test(impactB), `${effect} // ${impactB}`);
  await dlg.getByRole("button", { name: /^Pay ₹3,075\.37/ }).click();
  await dlg.waitFor({ state: "hidden", timeout: 25000 });
  await page.waitForTimeout(1500);
  chk("persisted: QA Bank −₹3,075.37 once; card liability −₹2,955.37 (principal paid to the card)", f.close2(bank0 - (await f.bal("QA Bank")), 3075.37) && f.close2((await aBal()) - card0, 2955.37), `${bank0} -> ${await f.bal("QA Bank")}; ${card0} -> ${await aBal()}`);
  const det = await openDetails(page);
  const dText = await f.flat(det);
  const paidFrom = ((dText.match(/Paid from \| ([^|]*)/) ?? [])[1] ?? "?").trim();
  await h.shot(page, "card-emi-case-a-bank-details");
  chk("details: 'Paid from QA Bank · ₹2,955.37 of it paid to the card'", /QA Bank/.test(paidFrom) && /2,955\.37/.test(paidFrom), paidFrom);
  const unpayText = await unpay(page, det);
  chk("Mark as unpaid: money goes back to QA Bank and the card balance goes back up by the principal", /3,075\.37 goes back to QA Bank/.test(unpayText) && /balance goes back up by .*2,955\.37/.test(unpayText), unpayText.slice(0, 320));
  chk("reversal restores both exactly (persisted)", f.close2(await f.bal("QA Bank"), bank0) && f.close2(await aBal(), card0) && (await aTxns("QA Case A EMI")).length === 0);
});

scenario("card-emi-legacy-inspection-readonly", "Financial Audit: the legacy Case A section renders read-only (current-model Case A payments are NOT flagged) and no balance moves", async ({ page }, chk) => {
  await h.addFixture(page, "card-emi-a");
  const dlg = await openAPay(page, "QA Case A EMI");
  await dlg.getByRole("button", { name: /^Pay ₹3,075\.37/ }).click();
  await dlg.waitFor({ state: "hidden", timeout: 25000 });
  await page.waitForTimeout(1500);
  const bank0 = await f.bal("QA Bank");
  const card0 = await aBal();
  await h.go(page, "/financial-audit");
  await page.getByTestId("run-audit").click();
  const sec = page.getByTestId("legacy-case-a");
  await sec.waitFor({ timeout: 30000 });
  const text = await f.flat(sec);
  await h.shot(page, "card-emi-legacy-inspection");
  chk("the section is shown and says Read-only", /Read-only/.test(text) && /billed principal twice/.test(text), text.slice(0, 240));
  chk("a payment made under the current rule (interest-only ₹120 card charge) is NOT flagged", /None found/.test(text), text.slice(0, 240));
  chk("no button in the section writes anything (no action buttons)", (await sec.getByRole("button").count()) === 0);
  chk("running the audit moved no balance (persisted)", f.close2(await f.bal("QA Bank"), bank0) && f.close2(await aBal(), card0));
});
