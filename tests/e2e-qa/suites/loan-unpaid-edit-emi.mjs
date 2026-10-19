/**
 * Browser QA scenarios (loan-unpaid-edit-emi.mjs). Local emulator only — see tests/e2e-qa/README.md.
 * Each scenario drives the real UI and asserts on state read back from the emulator.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const bal = async (n) => (await h.accountBalance(n)).currentBalance;
const commits = (page) => page.evaluate(() => window.__ev.filter((e) => e.n === "commitStart").length);

async function openDrawer(page, loan) {
  await h.go(page, "/loans-installments");
  await page.getByText(loan).first().click();
  await page.getByRole("button", { name: "Record Payment" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay installment|Pay EMI/ });
  await dlg.getByText("TO PAY LENDER").waitFor();
  return dlg;
}
async function payFromBank(page, dlg, label) {
  await dlg.getByText("Choose paying account").click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await dlg.getByRole("button", { name: label }).click();
  await dlg.waitFor({ state: "hidden", timeout: 25000 });
  await page.waitForTimeout(1500);
}
async function openDetails(page, seq) {
  await page.getByRole("button", { name: new RegExp(`Installment ${seq}.*edit or mark unpaid`) }).click();
  await page.getByRole("dialog", { name: /Recorded payment/ }).waitFor();
  return page.getByRole("dialog", { name: /Recorded payment/ });
}

scenario("loan-mark-unpaid", "Loan: mark a recorded payment as unpaid (incl. Keep payment)", async ({ page }, chk) => {
  const start = await bal("QA Bank");
  const dlg = await openDrawer(page, "QA Loan 12");
  await payFromBank(page, dlg, /Pay ₹5,330\.93 to lender/);
  const afterPay = await bal("QA Bank");
  const det = await openDetails(page, 2);
  await det.getByRole("button", { name: "Mark as unpaid" }).click();
  const confirm = page.getByRole("dialog").last();
  await confirm.getByText("This installment goes back to unpaid").waitFor();
  await page.evaluate(() => window.__reset());
  await confirm.getByRole("button", { name: "Keep payment" }).click();
  await page.waitForTimeout(800);
  chk("Keep payment performs no write", (await commits(page)) === 0 && (await bal("QA Bank")) === afterPay, `commits ${await commits(page)}`);
  await det.getByRole("button", { name: "Mark as unpaid" }).click();
  await page.getByRole("dialog").last().getByText("This installment goes back to unpaid").waitFor();
  await page.evaluate(() => window.__reset());
  const unpaid = page.getByRole("dialog").last().getByRole("button", { name: "Mark as unpaid" });
  await unpaid.evaluate((b) => { b.click(); b.click(); });
  await page.waitForTimeout(5000);
  const tl = await h.timeline(page);
  await h.shot(page, "loan-mark-unpaid-after");
  const end = await bal("QA Bank");
  chk("loading feedback shown", tl.loading != null, `${tl.loading} ms`);
  chk("success only after the commit finished", tl.success != null && tl.success >= tl.commitEnd, `commitEnd ${tl.commitEnd}, success ${tl.success}`);
  chk("double-click on confirm writes once", (await commits(page)) <= 2, `commits ${await commits(page)} (reversal tx may use >1 commit)`);
  chk("bank balance restored to pre-payment value (persisted)", Math.abs(end - start) < 0.01, `${start} -> pay -> ${afterPay} -> unpay -> ${end}`);
  chk("dialog closed", tl.dialogClosed != null, `${tl.dialogClosed}`);
  return tl;
});

scenario("loan-unpaid-slow-refresh", "Loan: mark unpaid with a slow (3 s) refresh", async ({ page }, chk) => {
  const dlg = await openDrawer(page, "QA Loan 12");
  await payFromBank(page, dlg, /Pay ₹5,330\.93 to lender/);
  await h.arm(page, { mode: "slow", delayMs: 3000 });
  const det = await openDetails(page, 2);
  await det.getByRole("button", { name: "Mark as unpaid" }).click();
  const confirm = page.getByRole("dialog").last();
  await confirm.getByText("This installment goes back to unpaid").waitFor();
  await page.evaluate(() => window.__reset());
  await confirm.getByRole("button", { name: "Mark as unpaid" }).click();
  await page.waitForTimeout(1200);
  const mid = await h.timeline(page);
  chk("confirmation not delayed by the slow refresh", mid.success != null && mid.success - mid.commitEnd < 700, `commitEnd ${mid.commitEnd}, success ${mid.success}`);
  chk("'Updating balances…' shown while refreshing", mid.updating != null, JSON.stringify(mid));
  await page.waitForTimeout(5000);
  const tl = await h.timeline(page);
  chk("dialog closes after the refresh settles", tl.dialogClosed != null && tl.dialogClosed - tl.success >= 2800, `${tl.dialogClosed - tl.success} ms after success`);
  return tl;
});

scenario("loan-edit-payment", "Loan: edit a recorded payment (₹5,331 → ₹4,000)", async ({ page }, chk) => {
  const start = await bal("QA Bank");
  const dlg = await openDrawer(page, "QA Loan 12");
  await payFromBank(page, dlg, /Pay ₹5,330\.93 to lender/);
  const det = await openDetails(page, 2);
  await det.getByRole("button", { name: "Edit payment" }).click();
  const ed = page.getByRole("dialog", { name: /Edit payment/ });
  await ed.getByText("Originally").waitFor();
  const amount = ed.locator("input:visible").first();
  await amount.fill("4000");
  await page.waitForTimeout(500);
  await h.shot(page, "loan-edit-dialog");
  const save = ed.getByRole("button").last();
  const label = await save.innerText();
  chk("save button reflects an actual change", !/No changes/i.test(label), label);
  await page.evaluate(() => window.__reset());
  await save.click();
  await page.waitForTimeout(6000);
  const tl = await h.timeline(page);
  const end = await bal("QA Bank");
  chk("success only after the commit finished", tl.success != null && tl.success >= tl.commitEnd, `commitEnd ${tl.commitEnd}, success ${tl.success}`);
  chk("bank reflects the corrected amount only (persisted)", Math.abs(start - end - 4000) < 0.01, `${start} -> ${end} (expected -4000)`);
  chk("dialog closed", tl.dialogClosed != null, `${tl.dialogClosed}`);
  return tl;
});

scenario("emi-record", "EMI: record installment of QA Phone EMI from bank", async ({ page }, chk) => {
  const before = await bal("QA Bank");
  const dlg = await openDrawer(page, "QA Phone EMI");
  const txt = await dlg.innerText();
  await dlg.getByText("Choose paying account").click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await page.evaluate(() => window.__reset());
  await dlg.getByRole("button", { name: /^Pay ₹4,000/ }).click();
  await page.waitForTimeout(5000);
  const tl = await h.timeline(page);
  await h.shot(page, "emi-record-after");
  const after = await bal("QA Bank");
  chk("dialog identified the EMI installment", /4,000/.test(txt), txt.split("\n").slice(0, 6).join(" | "));
  chk("success only after the commit finished", tl.success != null && tl.success >= tl.commitEnd, `commitEnd ${tl.commitEnd}, success ${tl.success}`);
  chk("bank debited by the EMI amount (persisted)", Math.abs(before - after - 4000) < 0.01, `${before} -> ${after}`);
  chk("dialog closed", tl.dialogClosed != null, `${tl.dialogClosed}`);
  return tl;
});

