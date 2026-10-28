/**
 * Browser QA — existing Loan correction workflows actually SAVE and recalculate (lcor-*). Local emulator only.
 * The Loan Edit (rate / tenure re-plan) and Borrow More (additional disbursement) saves are driven through the real
 * dialogs; the persisted installments, loan, transactions and account balances are then read back from the emulator
 * and the resulting figures are cross-checked in Balance Control, Loans, Accounts, My Money, Month Cycle and Dashboard.
 * (EMI has no edit UI on the web — see the report; it is deliberately not scripted here.)
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const round2 = (v) => Math.round(v * 100) / 100;
const money = (t) => Number(String(t).replace(/[^0-9.\-−]/g, "").replace("−", "-"));
const share = (i) => i.principalPortion ?? i.amountDue;
const fmt = (n) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function loanState(name = "QA Loan 12") {
  const loan = (await h.list("loans")).find((l) => l.name === name);
  const insts = (await h.list(`paymentSchedules/${loan.scheduleId}/installments`)).filter((i) => !i.deletedAt).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const principalPaid = insts.reduce((a, i) => a + (i.amountPaid > 0 ? share(i) * Math.min(1, i.amountPaid / i.amountDue) : 0), 0);
  return { loan, insts, outstanding: round2(loan.loanAmount - principalPaid) };
}
const txCount = async () => (await h.list("transactions")).filter((t) => !t.deletedAt).length;

async function openLoan(page, name = "QA Loan 12") {
  await h.go(page, "/loans-installments");
  await page.getByText(name).first().click();
  await page.getByRole("button", { name: "Edit", exact: true }).waitFor();
}
async function bcFlowfi(page, productRe) {
  await h.go(page, "/balance-control");
  await page.locator('[data-testid="variance-table"]').waitFor({ timeout: 60000 });
  await page.waitForFunction(() => /\d/.test(document.querySelector('[data-testid="flowfi-value"]')?.textContent ?? ""), null, { timeout: 60000 });
  await page.waitForTimeout(1200);
  const names = await page.locator('[data-testid="product-select"] option').allInnerTexts();
  await page.locator('[data-testid="product-select"]').selectOption({ label: names.find((n) => productRe.test(n)) });
  await page.waitForTimeout(500);
  return money(await page.locator('[data-testid="variance-row-loanPrincipal"] [data-testid="flowfi-value"]').innerText());
}

scenario("lcor-edit-terms", "Loan Edit: interest-rate and tenure change re-plan only the unpaid tail; principal, cash and paid installment untouched; reflected everywhere", async ({ page }, chk) => {
  const before = await loanState();
  const bankBefore = (await h.accountBalance("QA Bank")).currentBalance;
  const txBefore = await txCount();
  const paidBefore = before.insts.filter((i) => i.amountPaid >= i.amountDue);
  const emiBefore = before.insts.find((i) => !(i.amountPaid >= i.amountDue)).amountDue;
  const bcBefore = await bcFlowfi(page, /QA Loan 12/);
  chk("precondition: Balance Control principal equals stored outstanding", Math.abs(bcBefore - before.outstanding) < 0.02, `${bcBefore} vs ${before.outstanding}`);

  await openLoan(page);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const dlg = page.getByRole("dialog").last();
  await dlg.getByLabel(/Number of installments/).fill("10");
  await dlg.getByLabel(/Interest rate/).fill("9");
  await h.shot(page, "lcor-edit-form");
  await dlg.getByRole("button", { name: /Save Changes/ }).click();
  await page.getByText(/Loan updated/i).first().waitFor({ timeout: 40000 });
  await page.waitForTimeout(2500);

  const after = await loanState();
  chk("stored rate is 9%", Number(after.loan.interest?.ratePercent) === 9, JSON.stringify(after.loan.interest));
  chk("schedule now has 10 installments", after.insts.length === 10, after.insts.length);
  chk("the paid installment is untouched (same id, amountPaid, amountDue)", paidBefore.every((p) => { const a = after.insts.find((i) => i.id === p.id); return a && a.amountPaid === p.amountPaid && a.amountDue === p.amountDue; }));
  const tail = after.insts.filter((i) => !(i.amountPaid >= i.amountDue));
  chk("unpaid tail has 9 installments", tail.length === 9, tail.length);
  chk("tail principal re-amortizes exactly the outstanding principal (no overwrite, no leak)", Math.abs(tail.reduce((a, i) => a + share(i), 0) - before.outstanding) < 0.05, `${tail.reduce((a, i) => a + share(i), 0)} vs ${before.outstanding}`);
  chk("the EMI amount changed (derived from the new rate/tenure, not typed)", Math.abs(tail[0].amountDue - emiBefore) > 1, `${emiBefore} → ${tail[0].amountDue}`);
  chk("loan amount unchanged", after.loan.loanAmount === before.loan.loanAmount);
  chk("no cash moved: bank balance and transaction count unchanged", Math.abs((await h.accountBalance("QA Bank")).currentBalance - bankBefore) < 0.005 && (await txCount()) === txBefore);

  const bcAfter = await bcFlowfi(page, /QA Loan 12/);
  chk("Balance Control remaining principal unchanged by a rate/tenure change", Math.abs(bcAfter - bcBefore) < 0.02, `${bcBefore} → ${bcAfter}`);
  await h.shot(page, "lcor-edit-balance-control");

  // Other modules render the loan consistently with the stored schedule.
  await h.go(page, "/loans-installments");
  await page.waitForTimeout(2000);
  const loansText = await page.locator("body").innerText();
  chk("Loans shows the unchanged outstanding principal", loansText.includes(fmt(before.outstanding)) || loansText.includes(Math.round(before.outstanding).toLocaleString("en-IN")), "");
  await h.go(page, "/accounts");
  await page.waitForTimeout(1500);
  chk("Accounts still shows the unchanged bank balance", (await page.locator("body").innerText()).includes(Math.round(bankBefore).toLocaleString("en-IN")));
  for (const path of ["/my-money", "/month-cycle", "/"]) {
    await h.go(page, path);
    await page.waitForTimeout(2000);
    const t = await page.locator("body").innerText();
    chk.finding(`lcor-${path}`, `${path} renders after the re-plan with no error state`, !/something went wrong|application error/i.test(t), t.slice(0, 80));
    if (path === "/month-cycle") chk.finding("lcor-mc-emi", "Month Cycle lists the loan's NEW installment amount", t.includes(fmt(tail[0].amountDue)) || t.includes(Math.round(tail[0].amountDue).toLocaleString("en-IN")), `looking for ${fmt(tail[0].amountDue)}`);
    await h.shot(page, `lcor-after-${path.replace(/\W/g, "") || "dashboard"}`);
  }
});

scenario("lcor-disbursement", "Receive More Money (additional disbursement): cash in once, principal + schedule re-planned, reflected in Balance Control and Accounts", async ({ page }, chk) => {
  const before = await loanState();
  const bankBefore = (await h.accountBalance("QA Bank")).currentBalance;
  const txBefore = await txCount();
  await openLoan(page);
  await page.getByRole("button", { name: "Receive More Money" }).click();
  const dlg = page.getByRole("dialog", { name: /Receive More Money/ });
  await dlg.getByLabel("Additional amount").fill("10000");
  await dlg.getByLabel("Payment account").selectOption({ label: /QA Bank/ }).catch(async () => {
    const opt = await dlg.getByLabel("Payment account").locator("option").allInnerTexts();
    await dlg.getByLabel("Payment account").selectOption({ label: opt.find((o) => /QA Bank/.test(o)) });
  });
  await page.waitForTimeout(600);
  const previewText = (await dlg.innerText()).replace(/\s+/g, " ");
  chk("dialog previews remaining principal before → after", new RegExp(`Remaining principal.*${Math.round(before.outstanding).toLocaleString("en-IN")}`).test(previewText), previewText.slice(0, 300));
  await h.shot(page, "lcor-disbursement-form");
  await dlg.getByRole("button", { name: /^Receive ₹/ }).last().click();
  await dlg.waitFor({ state: "hidden", timeout: 40000 });
  await page.waitForTimeout(2500);

  const after = await loanState();
  chk("loan principal outstanding rose by exactly ₹10,000", Math.abs(after.outstanding - (before.outstanding + 10000)) < 0.05, `${before.outstanding} → ${after.outstanding}`);
  chk("bank credited ₹10,000 exactly once", Math.abs((await h.accountBalance("QA Bank")).currentBalance - bankBefore - 10000) < 0.005);
  chk("exactly one new transaction", (await txCount()) === txBefore + 1, `${txBefore} → ${await txCount()}`);
  const tail = after.insts.filter((i) => !(i.amountPaid >= i.amountDue));
  chk("unpaid tail re-amortizes the new outstanding", Math.abs(tail.reduce((a, i) => a + share(i), 0) - after.outstanding) < 0.1, `${tail.reduce((a, i) => a + share(i), 0)} vs ${after.outstanding}`);
  const disb = await h.list(`loans/${after.loan.id}/additionalDisbursements`).catch(() => []);
  chk("an additional-disbursement audit record exists", disb.length === 1, disb.length);

  const bc = await bcFlowfi(page, /QA Loan 12/);
  chk("Balance Control remaining principal follows (+₹10,000)", Math.abs(bc - after.outstanding) < 0.02, `${bc} vs ${after.outstanding}`);
  await h.go(page, "/accounts");
  await page.waitForTimeout(1500);
  chk("Accounts shows the credited bank balance", (await page.locator("body").innerText()).includes(Math.round(bankBefore + 10000).toLocaleString("en-IN")));
  await h.shot(page, "lcor-disbursement-accounts");
});
