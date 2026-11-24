/**
 * Repro — "Pay directly" on a shared Loan: the lender record, People ledger and Transactions must all move, bank balances must not.
 * Local emulator only, synthetic data.
 */
import { scenario } from "../lib/core.mjs";
import { FIRESTORE_DOCS } from "../lib/env.mjs";
import * as h from "../lib/harness.mjs";

const onDetailPath = () => /^\/loans\/[^/]+\/?$/.test(location.pathname) && !location.pathname.startsWith("/loans/_");
const inline = (page) => page.locator("[data-stack-layer]");

scenario("zz-direct-pay-single", "Pay directly (single installment, shared loan): installment paid, People down, Transactions row, bank unchanged", async ({ page }, chk) => {
  const uid = await h.authUid();
  const loan = (await h.list("loans")).find((row) => row.name === "QA Loan 12");
  const person = (await h.list("people")).find((row) => row.name === "QA Priya");
  const schedule = `paymentSchedules/${loan.scheduleId}/installments`;
  const first = (await h.list(schedule)).filter((i) => !i.isSkipped && i.amountDue > (i.amountPaid ?? 0)).sort((a, b) => a.sequenceNumber - b.sequenceNumber)[0];
  const patch = async (path, fields) => {
    const url = new URL(`${FIRESTORE_DOCS}/users/${uid}/${path}`);
    for (const name of Object.keys(fields)) url.searchParams.append("updateMask.fieldPaths", name);
    const r = await fetch(url, { method: "PATCH", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" }, body: JSON.stringify({ fields }) });
    if (!r.ok) throw new Error(`setup failed ${r.status}`);
  };
  await patch(`loans/${loan.id}`, { beneficiaryPersonId: { stringValue: person.id }, beneficiaryRepaysInstallments: { booleanValue: true } });
  await patch(`${schedule}/${first.id}`, { dueDate: { timestampValue: new Date(Date.now() - 86400000).toISOString() } });

  const accountsBefore = Object.fromEntries((await h.list("accounts")).map((a) => [a.name, a.currentBalance]));
  const txBefore = (await h.list("transactions")).length;
  const personBefore = (await h.list("people")).find((p) => p.id === person.id);
  const entriesBefore = (await h.list(`people/${person.id}/ledgerEntries`).catch(() => [])).length;

  await h.go(page, "/loans");
  await page.locator('[role="button"]', { hasText: "QA Loan 12" }).first().click();
  await page.waitForFunction(onDetailPath, null, { timeout: 30000 });
  await page.locator('[data-testid="loan-page"]').waitFor({ timeout: 30000 });
  await page.waitForTimeout(600);
  await page.getByTestId("installment-detail").getByRole("button", { name: /^Pay lender/ }).click();
  const payment = inline(page);
  await payment.getByRole("region", { name: "Has their share been paid?" }).waitFor();
  await payment.getByRole("radio", { name: "QA Priya paid directly" }).click();
  await page.waitForTimeout(500);
  await payment.getByLabel("Account for this record").click();
  await page.getByRole("option").first().click();
  await page.waitForTimeout(500);
  await h.shot(page, "zz-direct-1-before-save");
  console.log("STILL NEEDED:", await payment.getByText(/Still needed/).innerText().catch(() => "(none)"));
  const save = payment.getByRole("button", { name: /Record direct payment|Save payment made by/ });
  const label = await save.innerText().catch(() => "(no save button)");
  console.log("SAVE BUTTON:", label, "enabled:", await save.isEnabled().catch(() => null));
  await save.click();
  await page.waitForTimeout(6000);
  await h.shot(page, "zz-direct-2-after-save");

  const inst = (await h.list(schedule)).find((i) => i.id === first.id);
  chk("1. installment marked paid", (inst.amountPaid ?? 0) >= inst.amountDue - 0.01, `paid ${inst.amountPaid} of ${inst.amountDue}`);
  const personAfter = (await h.list("people")).find((p) => p.id === person.id);
  console.log("PERSON balance before/after:", personBefore.currentBalance, personAfter.currentBalance);
  chk("2. People balance decreased by the share", personAfter.currentBalance < personBefore.currentBalance - 0.01, `${personBefore.currentBalance} -> ${personAfter.currentBalance}`);
  const txAfter = await h.list("transactions");
  const newTx = txAfter.length - txBefore;
  console.log("NEW TRANSACTIONS:", newTx, JSON.stringify(txAfter.slice(-4).map((t) => ({ d: t.description, a: t.amount, t: t.type, ex: t.excludeFromCalculations, ppl: t.isPersonLedgerMovement, loan: t.loanId }))));
  chk("3. Transactions got a row for it", newTx >= 1, `${newTx} new`);
  const accountsAfter = Object.fromEntries((await h.list("accounts")).map((a) => [a.name, a.currentBalance]));
  const moved = Object.keys(accountsBefore).filter((n) => Math.abs(accountsBefore[n] - accountsAfter[n]) > 0.005);
  chk("4. no bank balance changed", moved.length === 0, moved.map((n) => `${n}: ${accountsBefore[n]} -> ${accountsAfter[n]}`).join("; "));

  await h.go(page, "/people");
  await page.waitForTimeout(1500);
  const peopleText = await page.locator("main").innerText();
  await h.shot(page, "zz-direct-3-people");
  await page.getByText("QA Priya").first().click().catch(() => {});
  await page.waitForTimeout(2500);
  await h.shot(page, "zz-direct-4-priya");
  console.log("PRIYA DETAIL:", (await page.locator("main").innerText()).split("\n").filter(Boolean).slice(0, 70).join(" | "));
  console.log("PEOPLE PAGE (Priya):", peopleText.split("\n").filter((l) => /Priya|₹/.test(l)).slice(0, 12).join(" | "));
  await h.go(page, "/transactions");
  await page.waitForTimeout(1500);
  const txText = await page.locator("main").innerText();
  await h.shot(page, "zz-direct-5-transactions");
  console.log("TRANSACTIONS PAGE:", txText.split("\n").filter(Boolean).slice(0, 90).join(" | "));
  void entriesBefore;
}, { viewport: { width: 1440, height: 900 }, scheme: "light" });

async function sharedLoanSetup(count) {
  const uid = await h.authUid();
  const loan = (await h.list("loans")).find((row) => row.name === "QA Loan 12");
  const person = (await h.list("people")).find((row) => row.name === "QA Priya");
  const schedule = `paymentSchedules/${loan.scheduleId}/installments`;
  const installments = (await h.list(schedule)).filter((i) => !i.isSkipped && i.amountDue > (i.amountPaid ?? 0)).sort((a, b) => a.sequenceNumber - b.sequenceNumber).slice(0, count);
  const patch = async (path, fields) => {
    const url = new URL(`${FIRESTORE_DOCS}/users/${uid}/${path}`);
    for (const name of Object.keys(fields)) url.searchParams.append("updateMask.fieldPaths", name);
    const r = await fetch(url, { method: "PATCH", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" }, body: JSON.stringify({ fields }) });
    if (!r.ok) throw new Error(`setup failed ${r.status}`);
  };
  await patch(`loans/${loan.id}`, { beneficiaryPersonId: { stringValue: person.id }, beneficiaryRepaysInstallments: { booleanValue: true } });
  await Promise.all(installments.map((i, k) => patch(`${schedule}/${i.id}`, { dueDate: { timestampValue: new Date(Date.now() - (count + 1 - k) * 86400000).toISOString() } })));
  return { loan, person, schedule, installments };
}

async function snapshot(person) {
  return {
    accounts: Object.fromEntries((await h.list("accounts")).map((a) => [a.name, a.currentBalance])),
    tx: (await h.list("transactions")).length,
    person: (await h.list("people")).find((p) => p.id === person.id).currentBalance,
  };
}

async function openLoanPay(page) {
  await h.go(page, "/loans");
  await page.locator('[role="button"]', { hasText: "QA Loan 12" }).first().click();
  await page.waitForFunction(onDetailPath, null, { timeout: 30000 });
  await page.locator('[data-testid="loan-page"]').waitFor({ timeout: 30000 });
  await page.waitForTimeout(600);
  await page.getByTestId("installment-detail").getByRole("button", { name: /^Pay lender/ }).click();
  const payment = inline(page);
  await payment.getByRole("region", { name: "Has their share been paid?" }).waitFor();
  return payment;
}

async function report(chk, label, ctx, before, after, schedule, installments) {
  const rows = await h.list(schedule);
  const paid = installments.every((i) => { const r = rows.find((x) => x.id === i.id); return (r.amountPaid ?? 0) >= r.amountDue - 0.01; });
  chk(`${label} 1. installments marked paid`, paid);
  chk(`${label} 2. People balance decreased`, after.person < before.person - 0.01, `${before.person} -> ${after.person}`);
  chk(`${label} 3. a Transactions row was added for the person`, after.tx - before.tx >= installments.length * 1 && after.tx > before.tx, `${after.tx - before.tx} new`);
  const moved = Object.keys(before.accounts).filter((n) => Math.abs(before.accounts[n] - after.accounts[n]) > 0.005);
  chk(`${label} 4. no bank balance changed`, moved.length === 0, moved.map((n) => `${n}: ${before.accounts[n]} -> ${after.accounts[n]}`).join("; "));
}

scenario("zz-direct-pay-several", "Pay several, both installments paid by the person directly", async ({ page }, chk) => {
  const { person, schedule, installments } = await sharedLoanSetup(2);
  const before = await snapshot(person);
  const payment = await openLoanPay(page);
  await payment.getByRole("radio", { name: "Pay several" }).click();
  for (const i of installments) {
    const box = payment.getByRole("checkbox", { name: `#${i.sequenceNumber}`, exact: true });
    if (!(await box.isChecked())) await box.check();
  }
  await payment.getByRole("button", { name: /^Review 2 installments/ }).click();
  for (const i of installments) await payment.getByRole("radiogroup", { name: `Who paid #${i.sequenceNumber}`, exact: true }).getByRole("radio", { name: "Paid by someone else" }).click();
  await page.waitForTimeout(400);
  await h.shot(page, "zz-several-1-review");
  const account = payment.getByRole("combobox").first();
  if (await account.isVisible().catch(() => false)) { await account.click(); await page.getByRole("option").first().click(); }
  const confirm = payment.getByRole("button", { name: /^Record 2 installments/ });
  console.log("SEVERAL CONFIRM:", await confirm.innerText().catch(() => "(none)"), await confirm.isEnabled().catch(() => null));
  await confirm.click();
  await page.waitForTimeout(7000);
  await h.shot(page, "zz-several-2-after");
  await report(chk, "several", {}, before, await snapshot(person), schedule, installments);
}, { viewport: { width: 1440, height: 900 }, scheme: "light" });
