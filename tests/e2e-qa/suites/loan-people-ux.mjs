/**
 * Loan & EMI + People Ledger UX (Phase 2): named payment choices, pay-in-order from a schedule row, the back-dated
 * pay-now warning, "Record past payments" for 24 months of history with mixed People answers, account-neutral People
 * receipts, a held advance offered before new money, and the exact way back from People. Every money check reads the
 * persisted emulator documents. Local emulator only.
 */
import { scenario } from "../lib/core.mjs";
import * as f from "../lib/flows.mjs";
import * as h from "../lib/harness.mjs";

async function addHistoryEmi(page) {
  const testId = "qa-seed-history-emi";
  await page.click(`[data-testid="${testId}"]`);
  await page.waitForSelector('[data-testid="qa-seed-steps"]', { timeout: 120000 });
  await page.waitForFunction((id) => !document.querySelector(`[data-testid="${id}"]`)?.textContent?.includes("Adding"), testId, { timeout: 120000 });
  const steps = (await page.locator('[data-testid="qa-seed-steps"]').innerText()).split("\n").join(" | ");
  if (/✗/.test(steps)) throw new Error(`fixture failed: ${steps}`);
}

/** Client-side navigation: polls the path and, on timeout, says which URL it was actually on. */
async function waitForPath(page, path, ms = 30000) {
  const end = Date.now() + ms;
  let href = "";
  while (Date.now() < end) {
    href = await page.evaluate(() => location.href).catch(() => href);
    if (new URL(href).pathname === path) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`expected path ${path}, still on ${href}`);
}

async function openDetails(page, name) {
  await h.go(page, "/loans-installments");
  await page.getByText(name).first().click();
  await page.waitForTimeout(1200);
}

async function chooseBank(page, dlg) {
  await dlg.getByText("Choose paying account").click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
}

const priyaId = async () => (await h.list("people")).find((p) => p.name === "QA Priya").id;
const activeEntries = async (personId) => (await h.list(`people/${personId}/ledger`)).filter((e) => !e.deletedAt);

scenario("uxp-hist-24-mixed-people", "24 months of history: lender paid earlier (no account change), Priya's shares answered per installment (22 already in balance, 2 still owed)", async ({ page }, chk) => {
  await addHistoryEmi(page);
  const NAME = "QA 24-Month EMI";
  const bank0 = await f.bal("QA Bank");
  const tx0 = new Set((await h.list("transactions")).map((t) => t.id));
  await openDetails(page, NAME);
  await page.getByRole("button", { name: "Record past payments" }).click();
  const dlg = page.getByRole("dialog", { name: /Record past payments/ });
  await dlg.getByTestId("bulk-step").waitFor();
  chk("opens on step 1 with nothing preselected", (await dlg.getByTestId("bulk-step").innerText()).includes("Step 1"));
  await dlg.getByRole("button", { name: /Select all unpaid \(24\)/ }).click();
  await h.shot(page, "uxp-hist-1-select");
  await dlg.getByRole("button", { name: "Continue with 24 EMIs" }).click();
  chk("dates are never assumed: the next step waits for an answer", await dlg.getByRole("button", { name: "Choose when they were paid" }).isDisabled());
  await dlg.getByRole("radio", { name: /Each on its due date/ }).click();
  await dlg.getByRole("button", { name: "Continue to people's shares" }).click({ timeout: 30000 });
  await dlg.getByText("Have the people sharing this already paid you?").waitFor();
  // Priya paid #1–#22 (already in my balance); #23 and #24 are still owed.
  const person = dlg.getByTestId(/reconcile-person-/).first();
  await person.getByRole("button", { name: "All received" }).click();
  chk("24 rows stay folded; the unanswered ones are counted, not dumped", (await dlg.getByTestId(/reconcile-unanswered-/).first().innerText()).includes("24 still need an answer"));
  await person.getByRole("button", { name: /Show each installment/ }).click();
  for (const seq of [23, 24]) await dlg.getByRole("radiogroup", { name: `QA Priya #${seq}` }).getByRole("radio", { name: "Not received yet" }).click();
  await person.getByRole("radiogroup", { name: /for all received/ }).getByRole("radio", { name: "Already in my account" }).click();
  chk("per-person count reads 22 of 24", (await dlg.getByTestId(/reconcile-count-/).first().innerText()).includes("22 of 24 marked received"));
  await h.shot(page, "uxp-hist-2-people");
  await dlg.getByText("Received into · for your records").waitFor();
  await dlg.getByLabel("Received into account").click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await dlg.getByRole("button", { name: "Continue to review" }).click();
  const review = await f.flat(dlg.getByTestId("bulk-review-summary"));
  await h.shot(page, "uxp-hist-3-review");
  chk("review: 24 EMIs, ₹48,000, each on its due date, no account change", /24 EMIs · ₹48,000 · each on its due date/.test(review) && /no account balance changes/.test(review), review);
  chk("review: Priya 22 received (already in balance) · ₹2,000 still to receive", /22 received · ₹22,000 \(₹22,000 already in your balance\)/.test(review) && /₹2,000 still to receive/.test(review), review);
  await page.evaluate(() => window.__reset());
  await dlg.getByRole("button", { name: /^Record 24 EMIs · ₹48,000 · ₹22,000 from people$/ }).click();
  await dlg.waitFor({ state: "hidden", timeout: 240000 });
  await page.waitForTimeout(2500);

  const state = await f.scheduleState("emi", NAME);
  chk("lender: #1–#24 paid ₹2,000 each, #25 onward untouched (persisted)", state.slice(0, 24).every((i) => i.amountPaid === 2000) && state.slice(24).every((i) => i.amountPaid === 0), JSON.stringify(state.map((i) => i.amountPaid)));
  chk("QA Bank balance unchanged by 24 lender + 22 People records (persisted)", f.close2(await f.bal("QA Bank"), bank0), `${bank0} -> ${await f.bal("QA Bank")}`);
  const pid = await priyaId();
  const entries = await activeEntries(pid);
  const earlier = entries.filter((e) => e.recordedEarlier === true);
  chk("People: 22 receipts marked received earlier, ₹22,000 in total (persisted)", new Set(earlier.map((e) => e.paymentId)).size === 22 && f.close2(earlier.reduce((t, e) => t + e.amount, 0), 22000), `${earlier.length} entries, ₹${earlier.reduce((t, e) => t + e.amount, 0)}`);
  const newTx = (await h.list("transactions")).filter((t) => !t.deletedAt && !tx0.has(t.id));
  chk(
    "only 22 new transactions — Priya's cash legs, all excluded from balances (the EMI posts none)",
    newTx.length === 22 && newTx.every((t) => t.excludeFromCalculations === true),
    `${newTx.length} new: ${JSON.stringify(newTx.slice(0, 3).map((t) => [t.type, t.amount, t.excludeFromCalculations]))}`,
  );
});

scenario("uxp-pay-choices-extra-mobile-dark", "Pay drawer at 390×844 dark: every amount named and visible; 'Installment + extra towards principal' debits once, exactly the total", async ({ page }, chk) => {
  await openDetails(page, "QA Loan 12");
  await page.getByRole("button", { name: "Record Payment" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay installment/ });
  await dlg.getByText("TO PAY LENDER").waitFor();
  const group = await f.flat(dlg.getByRole("radiogroup", { name: "What are you paying?" }));
  await h.shot(page, "uxp-pay-choices-mobile-dark");
  chk("amount choices are visible and named — no 'Other amount' gate", /Pay this installment/.test(group) && /Part payment or another amount/.test(group) && /Installment \+ extra towards principal/.test(group) && /All remaining installments/.test(group) && (await dlg.getByRole("button", { name: "Other amount" }).count()) === 0, group);
  chk("the scheduled total is not called a payoff", /not a bank closure amount/.test(group) && !/Pay off remaining/.test(group));
  await dlg.getByRole("radio", { name: /Installment \+ extra towards principal/ }).click();
  await dlg.getByRole("spinbutton").fill("1000");
  await chooseBank(page, dlg);
  const impact = await f.flat(dlg.getByTestId("payment-impact"));
  await dlg.getByTestId("payment-impact").scrollIntoViewIfNeeded();
  await h.shot(page, "uxp-pay-extra-impact-mobile-dark");
  chk("'What will happen' shows principal before → after and the account", /Remaining principal/.test(impact) && /QA Bank/.test(impact), impact);
  const bank0 = await f.bal("QA Bank");
  const btn = dlg.getByRole("button", { name: /^Pay ₹[\d,.]+ to lender$/ });
  const amount = Number((await btn.innerText()).replace(/[^\d.]/g, ""));
  await page.evaluate(() => window.__reset());
  await btn.evaluate((b) => { b.click(); b.click(); });
  await dlg.waitFor({ state: "hidden", timeout: 30000 });
  await page.waitForTimeout(2000);
  chk("bank debited exactly the total once (persisted; double-click)", f.close2(bank0 - (await f.bal("QA Bank")), amount), `${bank0} -> ${await f.bal("QA Bank")} (button ₹${amount})`);
  const loan = (await h.list("loans")).find((l) => l.name === "QA Loan 12");
  const prepaid = (await h.list(`loans/${loan.id}/principalPayments`).catch(() => [])).length;
  chk("the extra went to principal (the schedule's #2 is paid, the loan re-planned)", (await f.scheduleState("loan", "QA Loan 12"))[1].amountPaid > 0, `principalPayments docs: ${prepaid}`);
}, { viewport: { width: 390, height: 844 }, scheme: "dark" });

scenario("uxp-loan-row-pay-through", "Loan schedule: 'Pay' on #4 while #2–#3 are unpaid says so and pays #2–#4 in order — never a different installment silently", async ({ page }, chk) => {
  await openDetails(page, "QA Loan 12");
  const before = await f.scheduleState("loan", "QA Loan 12");
  await page.getByRole("button", { name: /^Pay installment 4,/ }).click();
  const dlg = page.getByRole("dialog", { name: /Pay installment/ });
  await dlg.getByTestId("through-note").waitFor();
  const note = await dlg.getByTestId("through-note").innerText();
  await h.shot(page, "uxp-loan-row-pay-through");
  chk("the note names the pick and the earlier unpaid ones", /You picked installment #4/.test(note) && /#2–#3 \(still unpaid\) are paid first/.test(note), note);
  chk("'Installments #2–#4' is the selected choice", (await dlg.getByRole("radio", { name: /Installments #2–#4/ }).getAttribute("aria-checked")) === "true");
  await chooseBank(page, dlg);
  const bank0 = await f.bal("QA Bank");
  const expected = before.slice(1, 4).reduce((t, i) => t + (i.amountDue - i.amountPaid), 0);
  await dlg.getByRole("button", { name: /^Pay ₹[\d,.]+ to lender$/ }).click();
  await dlg.waitFor({ state: "hidden", timeout: 30000 });
  await page.waitForTimeout(2000);
  const after = await f.scheduleState("loan", "QA Loan 12");
  chk("#2, #3 and #4 are paid in full; #5 untouched (persisted)", [1, 2, 3].every((k) => f.close2(after[k].amountPaid, after[k].amountDue)) && after[4].amountPaid === 0, JSON.stringify(after.slice(0, 6).map((i) => i.amountPaid)));
  chk("bank debited exactly their remaining amounts, once (persisted)", f.close2(bank0 - (await f.bal("QA Bank")), expected), `${bank0} -> ${await f.bal("QA Bank")} (expected −${expected})`);
});

scenario("uxp-backdate-hint", "Pay now with a past date is flagged as a real debit on that date and offers Record past payments — nothing is written", async ({ page }, chk) => {
  await openDetails(page, "QA Phone EMI");
  await page.getByRole("button", { name: "Record Payment" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay EMI/ });
  await dlg.getByText("TO PAY LENDER").waitFor();
  await chooseBank(page, dlg);
  const commits0 = await f.commits(page);
  await dlg.getByLabel("Payment date").fill("01/01/2025");
  await dlg.getByTestId("backdate-hint").waitFor();
  const hint = await dlg.getByTestId("backdate-hint").innerText();
  await h.shot(page, "uxp-backdate-hint");
  chk("the hint names the account and the date", /real payment from QA Bank dated 1 Jan 2025/.test(hint), hint);
  await dlg.getByRole("button", { name: /Record past payments instead/ }).click();
  await page.getByTestId("bulk-step").waitFor();
  chk("switches to Record past payments (step 1), no write", (await page.getByTestId("bulk-step").innerText()).includes("Step 1") && (await f.commits(page)) === commits0);
});

scenario("uxp-people-in-balance-and-advance", "People: a held advance is offered before new money; a receipt 'already in my account balance' settles the share with no account change", async ({ page }, chk) => {
  // Priya pays ₹1,500 against her only open item, the ₹1,000 dinner share → ₹500 kept as advance (a real receipt).
  await f.openPerson(page, "QA Priya");
  await f.openRecord(page);
  await f.amountField(page).fill("1500");
  await f.pickAccountIn(page, "QA Bank");
  await page.getByRole("button", { name: /^Record ₹1,500/ }).first().click();
  await page.waitForTimeout(4000);
  // Then the shared EMI (Priya's ₹3,000 share of #1 is due).
  await h.go(page, "/dev/qa");
  await h.addFixture(page, "shared-emi");

  const bank0 = await f.bal("QA Bank");
  await f.openPerson(page, "QA Priya");
  await f.openRecord(page);
  await page.getByTestId("rp-advance-held").waitFor();
  const notice = await page.getByTestId("rp-advance-held").innerText();
  await h.shot(page, "uxp-people-advance-notice");
  chk("Record payment names the held advance and offers applying it first", /already gave you ₹500/.test(notice), notice);
  // Now the shared EMI share (₹3,000) — paid before FlowFi, already in my balance.
  // Priya's share of shared EMI #1 is ₹1,000 (₹3,000 of ₹9,000 over 3 installments).
  await f.amountField(page).fill("1000");
  await f.pickAccountIn(page, "QA Bank");
  await page.getByRole("checkbox", { name: /Already in my account balance/ }).check();
  const panelText = await f.flat(page.getByRole("form", { name: /Record payment — QA Priya/ }));
  await h.shot(page, "uxp-people-in-balance");
  chk("footer says no account changes", /no account changes/.test(panelText), panelText.slice(-400));
  const pid = await priyaId();
  const before = await activeEntries(pid);
  await page.getByRole("button", { name: /^Record ₹1,000 received earlier/ }).first().click();
  await page.waitForTimeout(4000);
  const added = (await activeEntries(pid)).filter((e) => !before.some((b) => b.id === e.id));
  chk("the receipt is stored as received earlier (persisted)", added.length > 0 && added.every((e) => e.recordedEarlier === true), JSON.stringify(added.map((e) => [e.type, e.amount, e.recordedEarlier])));
  chk("QA Bank unchanged by the earlier receipt (persisted)", f.close2(await f.bal("QA Bank"), bank0), `${bank0} -> ${await f.bal("QA Bank")}`);
  chk("the lender schedule is untouched by People receipts (persisted)", f.paidTotal(await f.scheduleState("emi", "QA Shared EMI")) === 0);
});

scenario("uxp-collect-return-to-payment", "Collect first → record Priya in People → back on the SAME agreement's payment (dialog reopened)", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  await openDetails(page, "QA Shared EMI");
  await page.getByRole("button", { name: "Record Payment" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay EMI/ });
  await dlg.getByText("TO PAY LENDER").waitFor();
  const shareActions = await f.flat(dlg.getByRole("region", { name: "Who pays this installment" }));
  chk("each person offers 'Record received' and 'Postpone' separately", /Record received/.test(shareActions) && /Postpone/.test(shareActions) && !/Record \/ postpone/.test(shareActions), shareActions);
  await dlg.getByRole("radio", { name: /Collect money from others first/ }).click();
  await dlg.getByRole("radio", { name: "Collect from QA Priya" }).click();
  await h.shot(page, "uxp-collect-first");
  const fromPath = await page.evaluate(() => location.pathname);
  await dlg.getByRole("button", { name: "Record QA Priya's payment in People" }).click();
  // Client-side navigation: wait on the URL itself (no page "load" event fires).
  await waitForPath(page, "/people");
  await page.getByText(/Amount received/).first().waitFor({ timeout: 30000 });
  await f.amountField(page).fill("1000");
  await f.pickAccountIn(page, "QA Bank");
  await page.getByRole("button", { name: /^Record ₹1,000 received/ }).first().click();
  await waitForPath(page, fromPath);
  const back = page.getByRole("dialog", { name: /Pay EMI/ });
  await back.getByText("TO PAY LENDER").waitFor({ timeout: 30000 });
  const url = page.url();
  const backText = await f.flat(back);
  await h.shot(page, "uxp-collect-returned");
  // The page consumes ?agreement= / pay=1 once it has opened them — what matters is WHICH payment is open again.
  chk("returned to the SAME agreement's payment, reopened", /QA Shared EMI · Installment #1/.test(backText) && !/pay=1/.test(url), `${url} | ${backText.slice(0, 120)}`);
  chk("…and Priya now reads Received there", /QA PRIYA \| ₹1,000 \| Received/.test(backText), backText.slice(0, 300));
  chk("the lender is still unpaid — recording Priya's money paid nobody else (persisted)", f.paidTotal(await f.scheduleState("emi", "QA Shared EMI")) === 0);
});
