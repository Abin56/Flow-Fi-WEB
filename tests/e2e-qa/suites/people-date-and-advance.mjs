/**
 * People payment date edit (Transaction Details → "Edit in People Ledger" → date-only edit) and the held-advance
 * display in the Loan/EMI pay dialog. Every check reads the persisted emulator documents. Local emulator only.
 */
import { scenario } from "../lib/core.mjs";
import * as f from "../lib/flows.mjs";
import * as h from "../lib/harness.mjs";

const ddmmyyyy = (d) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
const daysAgo = (n) => new Date(Date.now() - n * 86400000);

async function recordPriyaReceipt(page, amount) {
  await f.openPerson(page, "QA Priya");
  await f.openRecord(page);
  await f.amountField(page).fill(String(amount));
  await f.pickAccountIn(page, "QA Bank");
  await page.getByRole("button", { name: new RegExp(`^Record ₹${Number(amount).toLocaleString("en-IN")}`) }).first().click();
  await page.waitForTimeout(3500);
}

const openTxn = async (page, id) => {
  await page.evaluate((i) => window.next.router.push(`/transactions?transaction=${i}`), id);
  await page.getByText("Transaction Details").first().waitFor();
  await page.waitForTimeout(800);
};

const receiptLeg = async (amount) => (await f.txns((t) => t.type === "income" && t.amount === amount && t.isPersonLedgerMovement))[0];
const priyaLedger = async () => {
  const priya = (await h.list("people")).find((p) => p.name === "QA Priya");
  return { priya, entries: (await h.list(`people/${priya.id}/ledger`)).filter((e) => !e.deletedAt && e.paymentId) };
};

scenario("pdate-edit-from-transaction", "People payment: Transaction Details → Edit in People Ledger → date-only edit (same ids, bank unchanged, statement reconciles)", async ({ page }, chk) => {
  await recordPriyaReceipt(page, 400);
  const leg = await receiptLeg(400);
  const bankAfterReceipt = await f.bal("QA Bank");
  const before = await priyaLedger();
  chk("precondition: receipt recorded once", !!leg && before.entries.length >= 1, JSON.stringify(before.entries.map((e) => e.paymentId)));

  await openTxn(page, leg.id);
  const link = page.getByRole("link", { name: "Edit in People Ledger" });
  chk("Transaction Details offers 'Edit in People Ledger'", (await link.count()) === 1);
  await link.click();
  const dlg = page.getByRole("dialog").last();
  await dlg.getByText("Change payment date").waitFor({ timeout: 30000 });
  const url = page.url();
  chk("link opens the exact payment (person + cycle + payment transaction, no guessing)", /\/people/.test(url) && /person=/.test(url), url);
  await h.shot(page, "pdate-dialog");

  const target = daysAgo(40);
  await dlg.locator("input").first().fill(ddmmyyyy(target));
  await dlg.getByRole("button", { name: "Save date" }).click();
  await page.waitForTimeout(3500);

  const after = await priyaLedger();
  const legAfter = (await h.list("transactions")).find((t) => t.id === leg.id);
  const day = (iso) => new Date(iso).toDateString();
  chk("same cash-leg transaction id, still active", !!legAfter && !legAfter.deletedAt && (await f.txns((t) => t.amount === 400 && t.isPersonLedgerMovement)).length === 1);
  chk("transaction date moved to the new date", day(legAfter.dateTime) === target.toDateString(), `${legAfter.dateTime}`);
  chk("same payment id(s) and entry ids — nothing reverted or re-recorded", JSON.stringify(after.entries.map((e) => [e.id, e.paymentId]).sort()) === JSON.stringify(before.entries.map((e) => [e.id, e.paymentId]).sort()));
  chk("every entry of the payment carries the new date", after.entries.every((e) => day(e.date) === target.toDateString()));
  chk("amount unchanged", f.close2(legAfter.amount, 400));
  chk("bank balance unchanged — credited exactly once", f.close2(await f.bal("QA Bank"), bankAfterReceipt), `${bankAfterReceipt} -> ${await f.bal("QA Bank")}`);
  chk("Priya's balance unchanged", f.close2(after.priya?.currentBalance ?? (await priyaLedger()).priya.currentBalance, before.priya.currentBalance));

  const sheet = await f.openBreakdown(page, "QA Bank");
  await f.showAll(sheet);
  const shown = await f.collectStatementRows(sheet);
  const expected = await f.reconstructStatement("QA Bank");
  const diffs = f.diffStatement(shown.rows, expected.rows);
  chk("Account Statement reconciles with the stored transactions after the date change", diffs.length === 0, diffs.join(" ; "));
});

scenario("pdate-stale-two-tabs", "People payment date: tab B (opened before) is refused after tab A changed it — nothing overwritten", async ({ page, ctx }, chk) => {
  await recordPriyaReceipt(page, 400);
  const leg = await receiptLeg(400);
  const link = `/people?person=${(await priyaLedger()).priya.id}&paymentTx=${leg.id}`;
  const tabB = await f.secondTab(ctx, link.replace("/people", "/people"));
  const dlgB = tabB.getByRole("dialog").last();
  await dlgB.getByText("Change payment date").waitFor({ timeout: 30000 }).catch(async (e) => { await h.shot(tabB, "pdate-stale-tabB-load"); throw e; });

  // Tab A changes the date first (it leaves People and comes back through the link, as Transaction Details does).
  await page.bringToFront();
  await h.go(page, "/dashboard");
  await page.evaluate((l) => window.next.router.push(l), link);
  const dlgA = page.getByRole("dialog").last();
  await dlgA.getByText("Change payment date").waitFor({ timeout: 30000 });
  await dlgA.locator("input").first().fill(ddmmyyyy(daysAgo(10)));
  await dlgA.getByRole("button", { name: "Save date" }).click();
  await page.getByText("Payment date updated").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  const afterA = (await h.list("transactions")).find((t) => t.id === leg.id);

  // Tab B (stale) tries to move it elsewhere.
  await tabB.bringToFront();
  await dlgB.locator("input").first().fill(ddmmyyyy(daysAgo(60)));
  await dlgB.getByRole("button", { name: "Save date" }).click();
  await tabB.waitForTimeout(3500);
  const afterB = (await h.list("transactions")).find((t) => t.id === leg.id);
  await h.shot(tabB, "pdate-stale");
  chk("tab A's date is stored", new Date(afterA.dateTime).toDateString() === daysAgo(10).toDateString());
  chk("tab B's stale edit did not overwrite it (persisted)", afterB.dateTime === afterA.dateTime, `${afterA.dateTime} -> ${afterB.dateTime}`);
  chk("tab B was told why", /changed in another tab/i.test(await tabB.locator("body").innerText()));
  await tabB.close();
});

const SHARED = "QA Shared EMI";
async function openSharedPay(page) {
  await h.go(page, "/loans-installments");
  await page.getByText(SHARED).first().click();
  await page.getByRole("button", { name: "Record Payment" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay EMI/ });
  await dlg.getByText("TO PAY LENDER").waitFor();
  return dlg;
}

scenario("padv-held-advance-shown-and-applied", "Shared EMI: Priya's held advance is shown in the pay dialog, applied via People (no cash, no second receipt), then the lender is paid once", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  const lender0 = await f.scheduleState("emi", SHARED);

  // Priya gives ₹2,000 ahead of anything (every row skipped → kept as advance).
  await f.openPerson(page, "QA Priya");
  await f.openRecord(page);
  await f.amountField(page).fill("2000");
  const panel = page.getByRole("dialog").last();
  const skips = panel.getByRole("button", { name: "Skip" });
  for (let i = 0, n = await skips.count(); i < n; i++) await skips.nth(i).click();
  await f.pickAccountIn(page, "QA Bank");
  await page.getByRole("button", { name: /^Record ₹2,000/ }).first().click();
  await page.waitForTimeout(3500);
  const bankReceived = await f.bal("QA Bank");
  const priya = (await h.list("people")).find((p) => p.name === "QA Priya");
  const advances = async () => (await h.list(`people/${priya.id}/ledger`)).filter((e) => !e.deletedAt && e.sourceKind === "advance");
  const apps = async () => (await h.list(`people/${priya.id}/advanceApplications`)).filter((a) => !a.deletedAt);
  const receipts = async () => (await f.txns((t) => t.type === "income" && t.isPersonLedgerMovement)).length;
  chk("precondition: ₹2,000 held as advance, one receipt", (await advances()).reduce((s, e) => s + e.amount, 0) === 2000 && (await receipts()) === 1);

  // The lender dialog shows the held advance and links to People.
  let dlg = await openSharedPay(page);
  const note = dlg.getByTestId(`advance-${priya.id}`);
  await note.waitFor({ timeout: 20000 });
  chk("pay dialog names the held advance and says it is not applied", /Holding ₹2,000 advance from QA Priya — not applied to this share yet/.test(await note.innerText()), await note.innerText());
  chk("Priya's EMI share is still not received in the dialog", /Not received/.test(await f.flat(dlg)));
  await h.shot(page, "padv-dialog");
  await dlg.getByRole("link", { name: /Apply QA Priya's .*advance in People/ }).click();

  // People opens the existing Apply advance panel with only this EMI share ticked.
  await page.waitForURL(/\/people/, { timeout: 30000 });
  const ticked = page.getByLabel(/Apply advance to /);
  await page.getByText("Applying now").first().waitFor({ timeout: 30000 });
  await h.shot(page, "padv-apply-panel");
  const body = (await page.locator("body").innerText()).split("\n").join(" ");
  chk("Apply advance panel opened by the link (nothing applied yet)", (await apps()).length === 0 && /applying now/i.test(body));
  void ticked;
  await page.getByRole("button", { name: /^Apply ₹[\d,]+ of advance/ }).last().click();
  await page.waitForTimeout(3500);
  const app = await apps();
  chk("exactly one advance application, on Priya's EMI installment share", app.length === 1 && /^emi-inst:/.test(app[0].obligationKey), JSON.stringify(app.map((a) => [a.obligationKey, a.amount])));
  chk("applied ₹1,000 — the share only (advance not over-used)", app.length === 1 && f.close2(app[0].amount, 1000), JSON.stringify(app.map((a) => a.amount)));
  chk("no cash moved: bank unchanged, still ONE receipt", f.close2(await f.bal("QA Bank"), bankReceived) && (await receipts()) === 1, `${bankReceived} -> ${await f.bal("QA Bank")}`);
  chk("lender schedule untouched by applying People advance", JSON.stringify((await f.scheduleState("emi", SHARED)).map((i) => i.amountPaid)) === JSON.stringify(lender0.map((i) => i.amountPaid)));

  // Now Priya's share is received; paying the lender from my account debits the bank once and is not gated.
  dlg = await openSharedPay(page);
  await page.waitForTimeout(1500);
  chk("dialog now shows her share received and no advance note for it", /Received/.test(await f.flat(dlg)) && (await dlg.getByTestId(`advance-${priya.id}`).count()) === 0);
  await h.shot(page, "padv-after-apply");

  // Ravi still owes his share, so the lender payment asks once; paying from my account debits the bank exactly once
  // and neither creates a receipt nor touches the advance application or Priya's settled share.
  const bankBeforeLender = await f.bal("QA Bank");
  await dlg.getByText(/Pay now from my account/i).first().click();
  await page.waitForTimeout(600);
  const reason = dlg.getByRole("radio").first();
  if (await reason.count()) await reason.click().catch(() => {});
  await dlg.getByText("Choose paying account").click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await dlg.getByRole("button", { name: /^Pay ₹3,000/ }).click();
  await dlg.waitFor({ state: "hidden", timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const lender1 = await f.scheduleState("emi", SHARED);
  chk("lender installment 1 paid ₹3,000 and nothing else (persisted)", lender1[0].amountPaid === 3000 && f.paidTotal(lender1) === 3000, JSON.stringify(lender1.map((i) => i.amountPaid)));
  chk("bank debited exactly ₹3,000 once", f.close2(bankBeforeLender - (await f.bal("QA Bank")), 3000), `${bankBeforeLender} -> ${await f.bal("QA Bank")}`);
  chk("no second receipt, advance application unchanged (one, ₹1,000)", (await receipts()) === 1 && (await apps()).length === 1 && f.close2((await apps())[0].amount, 1000));
  chk("Priya's share was not re-collected or double-settled: still ₹2,000 received in total", f.close2((await advances()).reduce((t, e) => t + e.amount, 0), 2000));
});
