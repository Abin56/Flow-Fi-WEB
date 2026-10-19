/**
 * Browser QA for the three UX fixes that followed the first manual QA run:
 *  D-02 Add Transaction never preselects an account from Firestore order.
 *  D-03 The Loan/EMI payment confirmation shows the exact payable amount (₹5,330.93, not ₹5,331).
 *  D-04 An "Already paid earlier" payment is labelled "no account debit" in lists and views.
 * Local emulator only — see tests/e2e-qa/README.md.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const bal = async (n) => (await h.accountBalance(n)).currentBalance;
const commits = (page) => page.evaluate(() => window.__ev.filter((e) => e.n === "commitStart").length);
const accountTrigger = (page) => page.getByText(/^(Account|Deposit to|Received in)\s?\*$/).first().locator("xpath=following::button[1]");

async function openAdd(page, kind) {
  await h.go(page, "/transactions");
  await page.waitForTimeout(2500);
  await page.locator("button:visible", { hasText: "Add Transaction" }).first().click();
  await page.getByRole("menuitem", { name: kind, exact: true }).click();
  await page.getByText(`Add ${kind}`, { exact: true }).first().waitFor();
}

/* ───────────────────────────── D-02 ───────────────────────────── */

scenario("ux-d02-no-silent-account", "D-02: Add Expense/Income start with NO account, across three fresh Firestore orderings", async ({ page }, chk, notes) => {
  const orders = [];
  for (let round = 1; round <= 3; round++) {
    if (round > 1) {
      await h.go(page, "/dev/qa");
      await h.reseed(page); // new random document ids → a different Firestore order
    }
    const accounts = await h.list("accounts"); // emulator REST order = Firestore document-id order
    orders.push(accounts.map((a) => a.type).join(">"));
    const bank = accounts.find((a) => a.name === "QA Bank");

    await openAdd(page, "Expense");
    const startText = (await accountTrigger(page).innerText()).split("\n").join(" ");
    chk(`round ${round} [${orders[round - 1]}]: Add Expense starts with no account`, /Select account/i.test(startText), startText);

    await page.locator('input[placeholder="0.00"]').first().fill("90");
    await page.locator('input[placeholder^="e.g."]').first().fill(`QA no-account ${round}`);
    await page.evaluate(() => window.__reset());
    await page.getByRole("button", { name: "Add Expense" }).click();
    await page.waitForTimeout(1200);
    chk(`round ${round}: submitting without choosing an account writes nothing and says so`, (await commits(page)) === 0 && (await page.getByText("Select an account.").count()) > 0, `commits ${await commits(page)}`);
    if (round === 1) await h.shot(page, "ux-d02-no-account-blocked");

    await accountTrigger(page).click();
    await page.getByRole("option", { name: /QA Bank/ }).first().click();
    await page.getByRole("button", { name: "Add Expense" }).click();
    await page.waitForTimeout(2500);
    const saved = (await h.list("transactions")).find((t) => t.description === `QA no-account ${round}`);
    chk(`round ${round}: after a deliberate pick it saves to exactly that account`, saved?.accountId === bank.id, `${saved?.accountId} vs bank ${bank.id}`);
    await page.getByRole("button", { name: "Cancel" }).last().click().catch(() => {});
  }
  notes.push(`Firestore account orders seen (by type): ${orders.join(" | ")}`);

  await openAdd(page, "Income");
  chk("Add Income starts with no account", /Select account/i.test(await accountTrigger(page).innerText()));
  await accountTrigger(page).click();
  const incomeOptions = await page.getByRole("option").allInnerTexts();
  chk("income's account list excludes the credit card (eligibility intact)", !incomeOptions.some((t) => /Credit Card/.test(t)) && incomeOptions.some((t) => /QA Bank/.test(t)), incomeOptions.join(" | ").split("\n").join(" "));
});

scenario("ux-d02-explicit-context", "D-02: opened from an account's own transaction list (explicit context) the account IS preselected; clearing the filter empties it again", async ({ page }, chk, notes) => {
  // The real user path: Accounts → open an account → Transactions (the list is then filtered to that account).
  await h.go(page, "/accounts");
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /^QA Bank Savings Account/ }).click();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Transactions", exact: true }).click();
  await page.getByText("Account: QA Bank").first().waitFor();
  await page.locator("button:visible", { hasText: "Add Transaction" }).first().click();
  await page.getByRole("menuitem", { name: "Expense", exact: true }).click();
  await page.getByText("Add Expense", { exact: true }).first().waitFor();
  const text = (await accountTrigger(page).innerText()).split("\n").join(" ");
  chk("with the list filtered to QA Bank, Add Expense starts on QA Bank (visible, user-initiated)", /QA Bank/.test(text), text);
  await h.shot(page, "ux-d02-explicit-context");
  await page.getByRole("button", { name: "Cancel" }).last().click().catch(() => {});
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: /Clear filters/ }).first().click();
  await page.waitForTimeout(800);
  await page.locator("button:visible", { hasText: "Add Transaction" }).first().click();
  await page.getByRole("menuitem", { name: "Expense", exact: true }).click();
  await page.getByText("Add Expense", { exact: true }).first().waitFor();
  chk("with the filter cleared it starts empty again", /Select account/i.test(await accountTrigger(page).innerText()));

  // Observation only (existing behaviour, not asserted): does a fresh deep link keep the account filter?
  const bank = (await h.list("accounts")).find((a) => a.name === "QA Bank");
  await page.goto(`${new URL(page.url()).origin}/transactions?account=${bank.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  notes.push(`observation: a fresh load of /transactions?account=<id> ${(await page.getByText("Account: QA Bank").count()) > 0 ? "keeps" : "drops"} the account filter`);
});

scenario("ux-d02-split-expense", "D-02: the Split Expense form also starts without an account", async ({ page }, chk) => {
  await h.go(page, "/transactions");
  await page.waitForTimeout(2500);
  await page.locator("button:visible", { hasText: "Add Transaction" }).first().click();
  await page.getByRole("menuitem", { name: /Split Expense/ }).click();
  await page.waitForTimeout(1200);
  const dlg = page.getByRole("dialog").last();
  const txt = (await dlg.innerText()).split("\n").join(" | ");
  await h.shot(page, "ux-d02-split-form");
  chk("Split Expense account selector shows the placeholder, not an account", /Select account/i.test(txt), txt.slice(0, 240));
});

/* ───────────────────────────── D-03 ───────────────────────────── */

scenario("ux-d03-exact-amount", "D-03: Loan payment confirmation shows ₹5,330.93 everywhere it states the payable amount", async ({ page }, chk) => {
  const before = await bal("QA Bank");
  await h.go(page, "/loans-installments");
  await page.getByText("QA Loan 12").first().click();
  await page.getByRole("button", { name: "Record Payment" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay installment/ });
  await dlg.getByText("TO PAY LENDER").waitFor();
  await dlg.getByText("Choose paying account").click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await page.waitForTimeout(500);
  await h.shot(page, "ux-d03-exact-dialog");
  const txt = (await dlg.innerText()).split("\n").join(" | ");
  chk("primary button reads Pay ₹5,330.93 to lender", (await dlg.getByRole("button", { name: /Pay ₹5,330\.93 to lender/ }).count()) === 1);
  chk("headline, option amount and money-move note all show ₹5,330.93", (txt.match(/₹5,330\.93/g) ?? []).length >= 4, `${(txt.match(/₹5,330\.93/g) ?? []).length} occurrences`);
  chk("no rounded ₹5,331 remains in the dialog", !/₹5,331(?!\.)/.test(txt), (txt.match(/[^|]*₹5,331(?!\.)[^|]*/) ?? ["none"])[0]);
  await dlg.getByRole("button", { name: /Pay ₹5,330\.93 to lender/ }).click();
  await dlg.waitFor({ state: "hidden", timeout: 20000 });
  await page.waitForTimeout(1500);
  const after = await bal("QA Bank");
  chk("the persisted debit is exactly ₹5,330.93 — what was displayed", Math.abs(before - after - 5330.93) < 0.005, `${before} -> ${after} (debit ${(before - after).toFixed(2)})`);
});

/* ───────────────────────────── D-04 ───────────────────────────── */

function historicalLabelScenario(id, title, opts) {
  scenario(id, title, async ({ page }, chk) => {
    await h.go(page, "/transactions");
    await page.waitForTimeout(3000);
    await h.shot(page, `${id}-transactions`);
    const row = page.locator("tr, [role=row]").filter({ hasText: "QA Loan 12" }).first();
    const rowText = (await row.innerText()).split("\n").join(" | ");
    chk("Transactions: the row says 'Already paid earlier · no account debit'", /Already paid earlier · no account debit/i.test(rowText), rowText.slice(0, 220));
    chk("Transactions: the amount is shown (₹5,331) without a minus sign", /₹5,331/.test(rowText) && !/[−-]\s?₹5,331/.test(rowText), rowText.slice(0, 220));
    const groceries = (await page.locator("tr, [role=row]").filter({ hasText: "QA groceries" }).first().innerText()).split("\n").join(" | ");
    chk("an ordinary expense row is unchanged (still −₹850, no label)", /−₹850/.test(groceries) && !/no account debit/i.test(groceries), groceries.slice(0, 160));
    const overflowT = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    chk("Transactions: no horizontal overflow", overflowT <= 1, `${overflowT}px`);

    await h.go(page, "/dashboard");
    await page.waitForTimeout(3500);
    await h.shot(page, `${id}-dashboard`);
    const dash = (await page.locator("main").innerText()).split("\n").join(" | ");
    chk("Dashboard → Recent transactions: labelled 'Already paid earlier · no account debit'", /Already paid earlier · no account debit/i.test(dash), (dash.match(/Loan payment[^|]*\|[^|]*\|[^|]*\|[^|]*/) ?? ["not found"])[0]);
    chk("Dashboard: cash-flow accounting unchanged (Expenses ₹3,850, Total balance ₹1,41,150)", /Expenses[\s|]*₹3,850/.test(dash) && /TOTAL BALANCE[\s|]*₹1,41,150/.test(dash), (dash.match(/Expenses[\s|]*₹[\d,]+/) ?? ["?"])[0]);
    const overflowD = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    chk("Dashboard: no horizontal overflow", overflowD <= 1, `${overflowD}px`);

    await h.go(page, "/loans-installments");
    await page.getByText("QA Loan 12").first().click();
    await page.waitForTimeout(2500);
    // The payment-history list loads after the drawer opens — wait for it rather than sleeping.
    await page.waitForFunction(() => /no account debit recorded/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
    const drawer = (await page.locator("body").innerText()).split("\n").join(" | ");
    await h.shot(page, `${id}-loan-history`);
    const installmentRow = (await page.getByRole("button", { name: /Installment 1 .*edit or mark unpaid|Installment 1 .*view payment details/ }).first().innerText()).split("\n").join(" | ");
    chk("Loan view → Installments: the paid-earlier row says 'already paid earlier — no account debit', never 'from QA Bank'", /already paid earlier — no account debit/i.test(installmentRow) && !/from QA Bank/.test(installmentRow), installmentRow.slice(0, 200));
    chk("Loan view: the paid-earlier payment is labelled 'Already paid earlier' with 'no account debit recorded'", /Already paid earlier/.test(drawer) && /no account debit recorded/i.test(drawer), (drawer.match(/[^|]*no account debit[^|]*/i) ?? ["label not found in the open Loan view"])[0]);
  }, opts);
}
historicalLabelScenario("ux-d04-desktop-light", "D-04: historical payment labelled — desktop, light", { viewport: { width: 1920, height: 1080 }, scheme: "light" });
historicalLabelScenario("ux-d04-mobile-dark", "D-04: historical payment labelled — mobile 390×844, dark", { viewport: { width: 390, height: 844 }, scheme: "dark" });
