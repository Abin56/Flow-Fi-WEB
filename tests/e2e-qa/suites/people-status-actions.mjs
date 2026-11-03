/**
 * People ledger: update a share's status straight from its row — "Already received" (person gave it; already in my
 * balance) and "Bank already paid" (lender installment paid outside FlowFi) — plus the Pay dialog's "Mark as paid" strip.
 * Every check reads the persisted emulator documents. Local emulator only.
 */
import { scenario } from "../lib/core.mjs";
import * as f from "../lib/flows.mjs";
import * as h from "../lib/harness.mjs";

const ms = (v) => (v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : Number(v));
const personDoc = async (name) => (await h.list("people")).find((p) => p.name === name);
const activeEntries = async (id) => (await h.list(`people/${id}/ledger`)).filter((e) => !e.deletedAt);
const mobile = (page) => (page.viewportSize()?.width ?? 1000) < 500;
const sfx = (page) => (mobile(page) ? "-mobile" : "");
const emiInst = async () => {
  const emi = (await h.list("emis")).find((d) => d.name === "QA Shared EMI" && !d.deletedAt);
  return (await h.list(`paymentSchedules/${emi.scheduleId}/installments`)).filter((i) => !i.deletedAt).map((i) => [i.id, i.amountDue, i.amountPaid, ms(i.dueDate), i.sequenceNumber]).sort((a, b) => a[4] - b[4]);
};
const snapshot = async () => ({
  bank: await f.bal("QA Bank"),
  tx: new Set((await h.list("transactions")).filter((t) => !t.deletedAt).map((t) => t.id)),
  priya: await personDoc("QA Priya"),
  inst: await emiInst(),
});

async function openPriya(page) {
  await h.addFixture(page, "shared-emi");
  await f.openPerson(page, "QA Priya");
  const bank = page.locator('[data-testid="row-bank-already-paid"]:visible').first();
  await bank.waitFor({ state: "attached", timeout: 30000 }).catch(() => {});
  if (!(await bank.isVisible().catch(() => false))) {
    await h.shot(page, `ps-open-person${sfx(page)}`);
    await page.locator("text=/QA Shared EMI/ >> visible=true").first().click().catch(() => {});
    await page.waitForTimeout(800);
    await h.shot(page, `ps-open-person-clicked${sfx(page)}`);
  }
  await bank.waitFor({ timeout: 30000 });
}

const noOverflow = async (page, chk) => {
  const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  chk("no horizontal page overflow", o <= 1, `${o}px`);
};

const receivedBody = async ({ page }, chk) => {
  await openPriya(page);
  const s0 = await snapshot();
  const body0 = (await page.locator("body").innerText()).split("\n").join(" ");
  chk("row shows the lender chip 'Bank overdue' beside Priya's share", /Bank overdue/.test(body0));
  const sibling = page.locator('[data-testid="row-bank-already-paid"]:visible').first().locator("xpath=..");
  const btn = sibling.getByTestId("row-already-received");
  chk("the row offers 'Already received' AND 'Bank already paid' as separate actions", (await btn.count()) === 1);
  await h.shot(page, `ps-row-actions${sfx(page)}`);
  await btn.click();
  const box = page.getByTestId("rp-in-balance").getByRole("checkbox");
  await box.waitFor({ timeout: 20000 });
  chk("Record payment opens with 'Already in my account balance' ticked", await box.isChecked());
  await h.shot(page, `ps-received-panel${sfx(page)}`);
  const record = page.getByRole("button", { name: /^Record ₹1,000 received earlier/ }).first();
  await record.waitFor({ timeout: 10000 }).catch(() => {});
  await f.pickAccountIn(page, "QA Bank");
  await record.waitFor({ timeout: 10000 });
  await page.evaluate(() => window.__reset());
  await record.evaluate((b) => { b.click(); b.click(); });
  await page.waitForTimeout(4500);
  await h.shot(page, `ps-received-after${sfx(page)}`);
  const pr = await personDoc("QA Priya");
  chk("Priya's balance dropped by exactly ₹1,000 once (persisted)", f.close2(s0.priya.currentBalance - pr.currentBalance, 1000), `${s0.priya.currentBalance} -> ${pr.currentBalance}`);
  const earlier = (await activeEntries(pr.id)).filter((e) => e.recordedEarlier === true);
  chk("one receipt, marked received earlier (persisted)", earlier.length === 1 && earlier[0].amount === 1000, JSON.stringify(earlier.map((e) => [e.type, e.amount])));
  chk("bank balance unchanged — no account effect (persisted)", f.close2(await f.bal("QA Bank"), s0.bank), `${s0.bank} -> ${await f.bal("QA Bank")}`);
  const newTx = (await h.list("transactions")).filter((t) => !t.deletedAt && !s0.tx.has(t.id));
  chk("only an excluded cash leg is added — nothing counted in balances (persisted)", newTx.every((t) => t.excludeFromCalculations === true), JSON.stringify(newTx.map((t) => [t.type, t.amount, t.excludeFromCalculations])));
  chk("lender schedule untouched (persisted)", JSON.stringify(await emiInst()) === JSON.stringify(s0.inst));
  const body = (await page.locator("body").innerText()).split("\n").join(" ");
  chk("UI: the row still says 'Bank overdue' — the lender state is separate", /Bank overdue/.test(body));
  await noOverflow(page, chk);
};
scenario("ps-already-received", "People row 'Already received' (double-click): Priya's ₹1,000 share recorded received earlier once; bank, schedule untouched", receivedBody);
scenario("ps-already-received-mobile-dark", "The same on mobile 390×844, dark", receivedBody, { viewport: { width: 390, height: 844 }, scheme: "dark" });

const bankBody = async ({ page }, chk) => {
  await openPriya(page);
  const s0 = await snapshot();
  const ledger0 = JSON.stringify(await activeEntries(s0.priya.id));
  await page.locator('[data-testid="row-bank-already-paid"]:visible').first().click();
  // The list opens with this installment ticked; one installment then goes straight to the single past-payment form.
  const list = page.getByRole("dialog").last();
  chk("opens Record past payments with this installment already ticked", await list.getByRole("checkbox", { name: "#1", exact: true }).isChecked());
  await list.getByRole("button", { name: /^Continue with 1 EMI/ }).click();
  const form = page.getByRole("dialog").last();
  await form.getByTestId("past-payment-header").waitFor({ timeout: 30000 });
  await h.shot(page, `ps-bank-form${sfx(page)}`);
  chk("the form says it is a past payment — no account balance changes — for this installment (₹3,000, #1)", /no account balance changes/.test(await form.getByTestId("past-payment-header").innerText()) && /Installment #1/.test(await form.innerText()));
  chk("People answers are asked separately; nothing assumed received", /Priya: ₹1,000 still to receive/.test((await form.getByTestId("reconcile-summary").innerText()).replace(/\n/g, " ")));
  await page.evaluate(() => window.__reset());
  await form.getByRole("button", { name: /^Save past payment of ₹3,000/ }).click();
  await form.waitFor({ state: "hidden", timeout: 60000 });
  await page.waitForTimeout(3500);
  const inst = await emiInst();
  chk("installment #1 now fully paid to the lender; #2+ untouched (persisted)", inst[0][2] === inst[0][1] && inst.slice(1).every((i, k) => i[2] === s0.inst[k + 1][2]), JSON.stringify(inst.map((i) => i[2])));
  chk("bank balance unchanged — paid outside FlowFi (persisted)", f.close2(await f.bal("QA Bank"), s0.bank), `${s0.bank} -> ${await f.bal("QA Bank")}`);
  const newTx = (await h.list("transactions")).filter((t) => !t.deletedAt && !s0.tx.has(t.id));
  chk("no new transaction (no duplicate EMI expense) (persisted)", newTx.length === 0, JSON.stringify(newTx.map((t) => [t.type, t.amount])));
  const pr = await personDoc("QA Priya");
  chk("Priya's share is NOT marked received: balance and ledger unchanged (persisted)", f.close2(pr.currentBalance, s0.priya.currentBalance) && JSON.stringify(await activeEntries(pr.id)) === ledger0);
  await page.reload();
  await page.waitForTimeout(3000);
  const body = (await page.locator("body").innerText()).split("\n").join(" ");
  await h.shot(page, `ps-bank-after${sfx(page)}`);
  chk("UI: the chip now reads 'Bank paid' and no 'Bank already paid' action remains", /Bank paid/.test(body) && !/Bank overdue/.test(body) && (await page.locator('[data-testid="row-bank-already-paid"]:visible').count()) === 0);
  chk("UI: Priya's ₹1,000 share is still 'to receive'", /₹1,000 to receive/.test(body));
  await noOverflow(page, chk);
};
scenario("ps-bank-already-paid", "People row 'Bank already paid': lender installment recorded paid with no account effect / no new transaction; Priya's share stays owed; chip → Bank paid", bankBody);
scenario("ps-bank-already-paid-mobile-dark", "The same on mobile 390×844, dark", bankBody, { viewport: { width: 390, height: 844 }, scheme: "dark" });

scenario("ps-pay-dialog-strip", "Pay EMI: lender status strip → 'Already paid the lender? Mark as paid' opens the past-payment form for that installment", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  await h.go(page, "/loans-installments");
  const record = page.getByRole("button", { name: "Record Payment" });
  for (let i = 0; i < 6 && !(await record.isVisible().catch(() => false)); i++) {
    await page.getByText("QA Shared EMI").first().click();
    await record.waitFor({ timeout: 15000 }).catch(() => {});
  }
  const s0 = await snapshot();
  await record.click();
  const dlg = page.getByRole("dialog", { name: /Pay EMI/ });
  await dlg.getByText("TO PAY LENDER").waitFor();
  const dlgAny = page.getByRole("dialog").last();
  const strip = await dlg.getByTestId("lender-status-strip").innerText();
  await h.shot(page, "ps-pay-strip");
  chk("strip names the lender's state and says people's share is separate", /Lender:/.test(strip) && /overdue/.test(strip) && /separate/.test(strip), strip.replace(/\n/g, " "));
  await dlg.getByTestId("lender-already-paid").click();
  await dlgAny.getByTestId("past-payment-header").waitFor({ timeout: 15000 });
  const head = await dlgAny.getByTestId("past-payment-header").innerText();
  chk("switches to the past-payment form: no account balance changes", /no account balance changes/.test(head), head.replace(/\n/g, " "));
  await h.shot(page, "ps-pay-strip-past");
  chk("nothing written by switching (persisted)", JSON.stringify(await emiInst()) === JSON.stringify(s0.inst) && f.close2(await f.bal("QA Bank"), s0.bank));
});
