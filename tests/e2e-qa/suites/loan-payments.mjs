/**
 * Browser QA scenarios (loan-payments.mjs). Local emulator only — see tests/e2e-qa/README.md.
 * Each scenario drives the real UI and asserts on state read back from the emulator.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
import * as f from "../lib/flows.mjs";
import { BASE_URL } from "../lib/env.mjs";

async function openPay(page, loan = "QA Loan 12") {
  await h.go(page, "/loans-installments");
  await page.getByText(loan).first().click();
  await page.getByRole("button", { name: "Record Payment" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay installment|Pay EMI/ });
  await dlg.getByText("TO PAY LENDER").waitFor();
  return dlg;
}
async function pickAccount(page, dlg, acct) {
  await dlg.getByText("Choose paying account").click();
  await page.getByRole("option", { name: new RegExp(acct) }).click();
}
const bal = async (n) => (await h.accountBalance(n)).currentBalance;
const commits = (page) => page.evaluate(() => window.__ev.filter((e) => e.n === "commitStart").length);
const payBtn = (dlg) => dlg.getByRole("button", { name: /^Pay ₹/ }).last();
const PAY = /Pay ₹5,330\.93 to lender/;

scenario("loan-record", "Loan: record full installment from bank", async ({ page }, chk) => {
  const before = await bal("QA Bank");
  const dlg = await openPay(page);
  await pickAccount(page, dlg, "QA Bank");
  await page.evaluate(() => window.__reset());
  await dlg.getByRole("button", { name: PAY }).click();
  await page.waitForTimeout(5000);
  const tl = await h.timeline(page);
  await h.shot(page, "loan-record-after");
  const after = await bal("QA Bank");
  chk("loading feedback shown", tl.loading != null, `${tl.loading} ms after t0`);
  chk("exactly one Firestore commit", (await commits(page)) === 1, await commits(page));
  chk("success appears only AFTER the commit finished", tl.success >= tl.commitEnd, `commitEnd ${tl.commitEnd} ms, success ${tl.success} ms`);
  chk("dialog closed", tl.dialogClosed != null, `${tl.dialogClosed} ms`);
  chk("bank debited by ~₹5,331 (persisted)", Math.abs(before - after - 5331) < 1, `${before} -> ${after}`);
  chk("success -> close < 2.5 s when refresh is fast", tl.dialogClosed - tl.success < 2500, `${tl.dialogClosed - tl.success} ms`);
  return tl;
});

scenario("loan-partial", "Loan: partial payment of ₹2,000 via 'Part payment or another amount'", async ({ page }, chk) => {
  const before = await bal("QA Bank");
  const dlg = await openPay(page);
  await pickAccount(page, dlg, "QA Bank");
  await dlg.getByRole("radio", { name: /Part payment or another amount/ }).click();
  await dlg.locator("input:visible:not([aria-label=\"Payment date\"]):not([type=date])").first().fill("2000");
  await page.waitForTimeout(400);
  await h.shot(page, "loan-partial-dialog");
  const label = await payBtn(dlg).innerText();
  chk("primary action reflects the partial amount", /2,000/.test(label), label);
  await page.evaluate(() => window.__reset());
  await payBtn(dlg).click();
  await page.waitForTimeout(4000);
  const tl = await h.timeline(page);
  const after = await bal("QA Bank");
  chk("bank debited exactly ₹2,000 (persisted)", Math.abs(before - after - 2000) < 0.01, `${before} -> ${after}`);
  chk("success after commit; dialog closed", tl.success >= tl.commitEnd && tl.dialogClosed != null, JSON.stringify(tl));
  return tl;
});

scenario("loan-insufficient", "Loan: insufficient funds (QA Cash ₹5,000 < ₹5,331)", async ({ page }, chk) => {
  const before = await bal("QA Cash");
  const dlg = await openPay(page);
  await pickAccount(page, dlg, "QA Cash");
  await page.waitForTimeout(500);
  await h.shot(page, "loan-insufficient-dialog");
  const text = await dlg.innerText();
  const btn = dlg.getByRole("button", { name: /^Pay / }).last();
  const disabled = await btn.isDisabled();
  const warn = text.match(/[^\n]*(not enough|insufficient|short|exceeds)[^\n]*/i);
  chk("user is warned about insufficient funds", !!warn, warn ? warn[0] : "no warning text found");
  chk("payment cannot be submitted", disabled, `disabled=${disabled}`);
  await page.evaluate(() => window.__reset());
  await btn.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(1500);
  chk("no write attempted", (await commits(page)) === 0, await commits(page));
  chk("cash unchanged (persisted)", (await bal("QA Cash")) === before, `${before} -> ${await bal("QA Cash")}`);
});

scenario("loan-duplicate-click", "Loan: rapid repeated clicks record once", async ({ page }, chk) => {
  const before = await bal("QA Bank");
  const dlg = await openPay(page);
  await pickAccount(page, dlg, "QA Bank");
  await page.evaluate(() => window.__reset());
  const btn = dlg.getByRole("button", { name: PAY });
  await btn.evaluate((b) => { b.click(); b.click(); b.click(); });
  await btn.click({ clickCount: 3, force: true, timeout: 1500 }).catch(() => {});
  await page.keyboard.press("Enter").catch(() => {});
  await page.waitForTimeout(5000);
  const after = await bal("QA Bank");
  const tl = await h.timeline(page);
  chk("exactly one Firestore commit", (await commits(page)) === 1, await commits(page));
  chk("bank debited once (₹5,331), not 2x/3x (persisted)", Math.abs(before - after - 5331) < 1, `${before} -> ${after}`);
  return tl;
});

scenario("loan-slow-write", "Loan: slow Firestore write (3 s injected on :commit)", async ({ page }, chk) => {
  await page.route("**/*:commit*", async (route) => { await new Promise((r) => setTimeout(r, 3000)); await route.continue(); });
  const before = await bal("QA Bank");
  const dlg = await openPay(page);
  await pickAccount(page, dlg, "QA Bank");
  await page.evaluate(() => window.__reset());
  await dlg.getByRole("button", { name: PAY }).click();
  await page.waitForTimeout(1500);
  const mid = await h.timeline(page);
  await h.shot(page, "loan-slow-write-mid");
  chk("loading feedback shown before the write finishes", mid.loading != null && mid.commitEnd == null, JSON.stringify(mid));
  chk("NO success while the write is pending", mid.success == null, JSON.stringify(mid));
  const busy = dlg.getByRole("button", { name: /Recording/ });
  chk("primary button shows Recording… and is disabled", (await busy.count()) > 0 && (await busy.first().isDisabled()), await busy.count());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  chk("Escape cannot dismiss the dialog mid-write", await dlg.isVisible());
  await page.waitForTimeout(4500);
  const tl = await h.timeline(page);
  const after = await bal("QA Bank");
  chk("success only after commit completed", tl.success >= tl.commitEnd, `commitEnd ${tl.commitEnd}, success ${tl.success}`);
  chk("one commit; bank debited once", (await commits(page)) === 1 && Math.abs(before - after - 5331) < 1, `${before} -> ${after}`);
  return tl;
});

scenario("loan-slow-refresh", "Loan: slow derived refresh (3 s)", async ({ page }, chk) => {
  await h.arm(page, { mode: "slow", delayMs: 3000 });
  const dlg = await openPay(page);
  await pickAccount(page, dlg, "QA Bank");
  await page.evaluate(() => window.__reset());
  await dlg.getByRole("button", { name: PAY }).click();
  await page.waitForTimeout(1200);
  const mid = await h.timeline(page);
  await h.shot(page, "loan-slow-refresh-mid");
  const midBtn = await dlg.getByRole("button").last().innerText().catch(() => "(dialog gone)");
  chk("success confirmation NOT delayed by the slow refresh", mid.success != null && mid.success - mid.commitEnd < 600, `commitEnd ${mid.commitEnd}, success ${mid.success}`);
  chk("'Saved · Updating balances…' visible while refreshing", mid.updating != null && /Updating balances/.test(midBtn), midBtn.replace(/\n/g, " "));
  chk("dialog still open at +1.2 s (waiting for refresh)", mid.dialogClosed == null);
  await page.waitForTimeout(5000);
  const tl = await h.timeline(page);
  const gap = tl.dialogClosed - tl.success;
  chk("dialog closes after refresh (~3 s + hold)", tl.dialogClosed != null && gap >= 2800 && gap < 5000, `closed ${gap} ms after success`);
  chk("no refresh-failure warning", tl.refreshWarn == null);
  chk("one commit only", (await commits(page)) === 1);
  return tl;
});

scenario("loan-refresh-fail", "Loan: derived refresh fails (injected)", async ({ page }, chk) => {
  await h.arm(page, { mode: "fail", delayMs: 500 });
  const before = await bal("QA Bank");
  const dlg = await openPay(page);
  await pickAccount(page, dlg, "QA Bank");
  await page.evaluate(() => window.__reset());
  await dlg.getByRole("button", { name: PAY }).click();
  await page.waitForTimeout(4500);
  const tl = await h.timeline(page);
  await h.shot(page, "loan-refresh-fail-after");
  const after = await bal("QA Bank");
  chk("payment confirmed as recorded", tl.success != null && tl.success >= tl.commitEnd, JSON.stringify(tl));
  chk("visible warning that balances couldn't refresh", tl.refreshWarn != null, `at ${tl.refreshWarn} ms`);
  chk("committed payment NOT retried (one commit)", (await commits(page)) === 1, await commits(page));
  chk("bank debited exactly once (persisted)", Math.abs(before - after - 5331) < 1, `${before} -> ${after}`);
  chk("dialog closed", tl.dialogClosed != null, `${tl.dialogClosed}`);
  return tl;
});

scenario("loan-refresh-8s", "Loan: refresh still running at the 8 s fallback", async ({ page }, chk) => {
  await h.arm(page, { mode: "slow", delayMs: 12000 });
  const dlg = await openPay(page);
  await pickAccount(page, dlg, "QA Bank");
  await page.evaluate(() => window.__reset());
  await dlg.getByRole("button", { name: PAY }).click();
  await page.waitForTimeout(6000);
  const mid = await h.timeline(page);
  chk("still open with 'Updating balances' at +6 s", mid.dialogClosed == null && mid.updating != null, JSON.stringify(mid));
  await page.waitForTimeout(5000);
  const tl = await h.timeline(page);
  await h.shot(page, "loan-refresh-8s-after");
  const gap = tl.dialogClosed - tl.success;
  chk("dialog closes at the ~8 s cap (7.5-9.5 s after success)", gap > 7500 && gap < 9500, `${gap} ms after success`);
  chk("'Updating balances…' fallback notice shown", tl.slowToast != null, `${tl.slowToast}`);
  chk("one commit only", (await commits(page)) === 1);
  return tl;
});


scenario("loan-stale-two-tabs", "Loan: two tabs open Pay for the same installment; A pays, B's stale dialog is refused — one debit, next installment untouched", async ({ page, ctx }, chk) => {
  const before = await bal("QA Bank");
  const paidBefore = (await f.scheduleState("loan", "QA Loan 12")).map((i) => i.amountPaid);
  const tabB = await ctx.newPage();
  tabB.setDefaultTimeout(30000);
  await tabB.goto(`${BASE_URL}/loans-installments`, { waitUntil: "domcontentloaded" });
  await tabB.getByText("QA Loan 12").first().click();
  await tabB.getByRole("button", { name: "Record Payment" }).click();
  const dlgB = tabB.getByRole("dialog", { name: /Pay installment|Pay EMI/ });
  await dlgB.getByText("TO PAY LENDER").waitFor();
  await pickAccount(tabB, dlgB, "QA Bank");

  await page.bringToFront();
  const dlgA = await openPay(page);
  await pickAccount(page, dlgA, "QA Bank");
  await dlgA.getByRole("button", { name: PAY }).click();
  await dlgA.waitFor({ state: "hidden", timeout: 25000 });
  await page.waitForTimeout(1500);
  const afterA = await bal("QA Bank");
  chk("tab A paid the installment (−₹5,331, persisted)", Math.abs(before - afterA - 5331) < 1, `${before} -> ${afterA}`);

  await tabB.bringToFront();
  await tabB.waitForTimeout(1500);
  const bBtn = dlgB.getByRole("button", { name: /^Pay ₹/ }).last();
  const clickable = (await bBtn.count()) > 0 && (await bBtn.isEnabled().catch(() => false));
  if (clickable) await bBtn.click().catch(() => {});
  await tabB.waitForTimeout(4500);
  const afterB = await bal("QA Bank");
  const loanId = (await h.list("loans")).find((l) => l.name === "QA Loan 12" && !l.deletedAt)?.id;
  const txs = (await h.list("transactions")).filter((t) => !t.deletedAt && t.loanId === loanId && !/already paid earlier/.test(t.description ?? ""));
  const target = paidBefore.findIndex((v) => v === 0); // the first unpaid installment when the tabs opened (the fixture has earlier ones paid)
  const state = await f.scheduleState("loan", "QA Loan 12");
  const alerts = (await tabB.locator('[role="alert"], [role="status"], [data-sonner-toast]').allInnerTexts()).join(" / ").replace(/\s+/g, " ").slice(0, 220);
  await h.shot(tabB, "loan-stale-two-tabs-b");
  chk("the stale error says to refresh and select the installment again, and offers no 'Try again'", !clickable || (/select the installment again/i.test(alerts) && (await tabB.getByRole("button", { name: /try again|retry/i }).count()) === 0), alerts.slice(0, 200));
  chk("tab B's stale Pay did not debit again: bank still −₹5,331 only (persisted)", Math.abs(before - afterB - 5331) < 1, `${before} -> ${afterB}; B clickable ${clickable}`);
  chk("exactly one new payment transaction; only the reviewed installment gained amountPaid, the next one is untouched (persisted)", txs.length === 1 && state[target].amountPaid > 0 && state.every((i, idx) => idx === target || i.amountPaid === paidBefore[idx]), `txns ${txs.length}; before ${JSON.stringify(paidBefore.slice(0, 4))} after ${JSON.stringify(state.slice(0, 4).map((i) => i.amountPaid))}`);
  chk("tab B explains that the installment changed", !clickable || /changed since you opened it/i.test(alerts + " " + (await f.flat(dlgB).catch(() => ""))), alerts || "no message");
  await tabB.close();
});
