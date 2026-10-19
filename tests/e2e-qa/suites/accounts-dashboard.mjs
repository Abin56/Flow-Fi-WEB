/**
 * Browser QA scenarios (accounts-dashboard.mjs). Local emulator only — see tests/e2e-qa/README.md.
 * Each scenario drives the real UI and asserts on state read back from the emulator.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const bal = async (n) => (await h.accountBalance(n)).currentBalance;
const num = (s) => Number(String(s).replace(/[₹,\s+−-]/g, "")) * (/^[−-]/.test(String(s).trim()) ? -1 : 1);

async function addExpenseUi(page, amount, desc) {
  await h.go(page, "/transactions");
  await page.waitForTimeout(2500);
  await page.locator("button:visible", { hasText: "Add Transaction" }).first().click();
  await page.getByRole("menuitem", { name: "Expense", exact: true }).click();
  await page.getByText("Add Expense", { exact: true }).first().waitFor();
  await page.getByText(/^Account\s?\*$/).first().locator("xpath=following::button[1]").click();
  await page.getByRole("option", { name: /QA Bank/ }).first().click();
  await page.locator('input[placeholder="0.00"]').first().fill(String(amount));
  await page.locator('input[placeholder^="e.g."]').first().fill(desc);
  await page.getByRole("button", { name: "Add Expense" }).click();
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "Cancel" }).last().click().catch(() => {});
  await page.waitForTimeout(600);
}
async function openBreakdown(page) {
  await h.go(page, "/accounts");
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "View QA Bank balance breakdown" }).click();
  const dlg = page.getByRole("dialog").last();
  await dlg.getByText("TRANSACTION HISTORY").waitFor();
  await page.waitForTimeout(800);
  return dlg;
}
function parseStatement(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const start = lines.indexOf("BALANCE") + 1;
  const end = lines.findIndex((l) => l === "Opening balance");
  const body = lines.slice(start, end);
  const rows = [];
  for (let i = 0; i + 5 < body.length + 1; ) {
    // date, time, description, debit, credit, balance
    if (!/^\d{1,2} \w{3} \d{4}$/.test(body[i] || "")) { i++; continue; }
    rows.push({ date: new Date(body[i] + " " + body[i + 1]), desc: body[i + 2], debit: body[i + 3] === "—" ? 0 : num(body[i + 3]), credit: body[i + 4] === "—" ? 0 : num(body[i + 4]), balance: num(body[i + 5]) });
    i += 6;
  }
  const opening = num(lines[end + 1] || "0");
  return { rows, opening };
}

scenario("acct-running", "Accounts: Debit / Credit / Running Balance, newest-first, after real writes", async ({ page }, chk) => {
  await addExpenseUi(page, 250, "QA statement coffee");
  const persisted = await bal("QA Bank");
  const dlg = await openBreakdown(page);
  await h.shot(page, "acct-breakdown");
  const { rows, opening } = parseStatement(await dlg.innerText());
  chk("statement has rows", rows.length >= 4, rows.length);
  chk("newest-first ordering (dates non-increasing)", rows.every((r, i) => i === 0 || r.date <= rows[i - 1].date), rows.map((r) => r.date.toISOString().slice(0, 10)).join(" > "));
  chk("first row's running balance equals the persisted current balance", rows[0] && Math.abs(rows[0].balance - persisted) < 0.01, `${rows[0]?.balance} vs persisted ${persisted}`);
  const ok = rows.every((r, i) => { const older = i + 1 < rows.length ? rows[i + 1].balance : opening; return Math.abs(older + r.credit - r.debit - r.balance) < 0.01; });
  chk("every row: previous balance + credit − debit = row balance (down to opening balance)", ok, `opening ${opening}`);
  const sheetTotal = num((await dlg.innerText()).split("\n").map((l) => l.trim()).filter(Boolean)[1]);
  chk("sheet headline equals persisted balance", Math.abs(sheetTotal - persisted) < 0.01, `${sheetTotal} vs ${persisted}`);
});

scenario("acct-filter", "Accounts: 'Money out' filter keeps true running balances", async ({ page }, chk) => {
  await addExpenseUi(page, 250, "QA statement coffee");
  const dlg = await openBreakdown(page);
  const all = parseStatement(await dlg.innerText());
  await dlg.getByRole("button", { name: "Money out" }).click();
  await page.waitForTimeout(700);
  await h.shot(page, "acct-filter-out");
  const out = parseStatement(await dlg.innerText());
  chk("filter shows only debits", out.rows.length > 0 && out.rows.every((r) => r.debit > 0 && r.credit === 0), `${out.rows.length} rows`);
  const sameBalances = out.rows.every((r) => all.rows.some((a) => a.desc === r.desc && Math.abs(a.balance - r.balance) < 0.01));
  chk("filtered rows keep the balance they had in the full statement (not recomputed)", sameBalances, out.rows.map((r) => `${r.desc}:${r.balance}`).join(" | "));
});

scenario("acct-mismatch", "Accounts: stored balance deliberately corrupted in the emulator → mismatch surfaced", async ({ page }, chk) => {
  const acct = await h.accountBalance("QA Bank");
  const r = await h.patchNumber(`accounts/${acct.id}`, "currentBalance", acct.currentBalance + 777);
  chk("fixture corruption written to the EMULATOR (+₹777)", r.ok, r.status);
  await page.waitForTimeout(1500);
  const dlg = await openBreakdown(page);
  await h.shot(page, "acct-mismatch");
  const text = (await dlg.innerText()).split("\n").join(" | ");
  const warn = text.match(/[^|]*(can.t be traced|no record explains|Your records explain|mismatch)[^|]*/i);
  chk("a balance mismatch warning is shown", !!warn, warn ? warn[0].trim() : "no warning text in the sheet: " + text.slice(0, 260));
});

scenario("dash-totals", "Dashboard / Month cycle: totals follow confirmed writes without reload", async ({ page }, chk) => {
  await h.go(page, "/dashboard");
  await page.waitForTimeout(3500);
  const before = (await page.locator("main").innerText()).split("\n").join(" | ");
  const exp0 = before.match(/Expenses[\s|]*₹([\d,]+)/)?.[1];
  await addExpenseUi(page, 250, "QA dash expense");
  await h.go(page, "/dashboard");
  await page.waitForTimeout(3000);
  await h.shot(page, "dash-after-expense");
  const after = (await page.locator("main").innerText()).split("\n").join(" | ");
  const exp1 = after.match(/Expenses[\s|]*₹([\d,]+)/)?.[1];
  const total1 = after.match(/TOTAL BALANCE[\s|]*₹([\d,]+)/)?.[1];
  chk("Expenses (cash flow) increased by ₹250", exp0 && exp1 && num(exp1) - num(exp0) === 250, `${exp0} -> ${exp1}`);
  chk("Total balance reflects the debit (persisted)", total1 && Math.abs(num(total1) - ((await bal("QA Bank")) + (await bal("QA Cash")))) < 1, `${total1} vs ${(await bal("QA Bank")) + (await bal("QA Cash"))}`);
  chk("new transaction listed under Recent transactions", /QA dash expense/.test(after));
  await h.go(page, "/month-cycle");
  await page.waitForTimeout(3500);
  const mc = (await page.locator("main").innerText()).split("\n").join(" | ");
  await h.shot(page, "month-cycle");
  chk("Month cycle 'My spend' includes the new ₹250 (₹13,850 -> ₹14,100)", /MY SPEND[\s|A-Za-z]*₹14,100/.test(mc), (mc.match(/MY SPEND[^₹]*₹[\d,]+/) || [mc.slice(0, 200)])[0]);
});

scenario("dash-stale", "Dashboard: no stale balance after a Loan payment (client-side navigation)", async ({ page }, chk) => {
  const before = (await bal("QA Bank")) + (await bal("QA Cash"));
  await h.go(page, "/dashboard");
  await page.waitForTimeout(3000);
  await h.go(page, "/loans-installments");
  await page.getByText("QA Loan 12").first().click();
  await page.getByRole("button", { name: "Record Payment" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay installment/ });
  await dlg.getByText("TO PAY LENDER").waitFor();
  await dlg.getByText("Choose paying account").click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await dlg.getByRole("button", { name: /Pay ₹5,330\.93 to lender/ }).click();
  await dlg.waitFor({ state: "hidden", timeout: 20000 });
  await h.go(page, "/dashboard");
  await page.waitForTimeout(1800);
  const text = (await page.locator("main").innerText()).split("\n").join(" | ");
  const total = text.match(/TOTAL BALANCE[\s|]*₹([\d,]+)/)?.[1];
  const persisted = (await bal("QA Bank")) + (await bal("QA Cash"));
  chk("dashboard total equals the persisted balance right after the payment", total && Math.abs(num(total) - persisted) < 1, `${total} vs ${persisted} (before ${before})`);
  const debt = text.match(/Debt[\s|]*₹([\d,]+)/)?.[1];
  chk("Debt tile moved (loan principal reduced)", debt && num(debt) < 411269, `Debt ${debt}`);
});

scenario("people-payment", "People: record a payment TO QA Lender (₹2,000 from QA Bank)", async ({ page }, chk) => {
  const before = await bal("QA Bank");
  await h.go(page, "/people");
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /Open QA Lender/ }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Record payment" }).first().click();
  await page.getByText("Amount received").or(page.getByText(/Amount paid/)).first().waitFor();
  const body0 = (await page.locator("body").innerText()).split("\n").join(" | ");
  await page.getByText(/^Paid to QA/).first().click().catch(() => {});
  await page.waitForTimeout(600);
  await h.shot(page, "people-payment-form");
  const amt = page.locator("input[inputmode='decimal'], input[type='number'], input[inputmode='numeric']").first();
  await amt.fill("2000");
  await page.getByText(/Select account|Pay from|Choose account/).first().click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await page.waitForTimeout(500);
  const rec = page.getByRole("button", { name: /^Record ₹2,000/ });
  chk("primary action shows the amount", (await rec.count()) > 0, (await page.getByRole("button", { name: /^Record/ }).allInnerTexts()).join(","));
  await page.evaluate(() => window.__reset());
  await rec.first().evaluate((b) => { b.click(); b.click(); });
  await page.waitForTimeout(4500);
  const after = await bal("QA Bank");
  chk("bank debited ₹2,000 exactly once (persisted)", Math.abs(before - after - 2000) < 0.01, `${before} -> ${after}; initial dialog: ${body0.slice(body0.indexOf("Record payment"), body0.indexOf("Record payment") + 160)}`);
});

