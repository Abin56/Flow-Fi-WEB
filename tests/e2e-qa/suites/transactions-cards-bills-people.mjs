/**
 * Browser QA scenarios (transactions-cards-bills-people.mjs). Local emulator only — see tests/e2e-qa/README.md.
 * Each scenario drives the real UI and asserts on state read back from the emulator.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const bal = async (n) => (await h.accountBalance(n)).currentBalance;
const commits = (page) => page.evaluate(() => window.__ev.filter((e) => e.n === "commitStart").length);
const since = (page) => page.evaluate(() => Math.round(performance.now() - window.__t0));
const txns = async (desc) => (await h.list("transactions")).filter((t) => t.description === desc && !t.deletedAt);

async function openAdd(page, kind) {
  await h.go(page, "/transactions");
  await page.waitForTimeout(2500);
  await page.locator("button:visible", { hasText: "Add Transaction" }).first().click();
  await page.getByRole("menuitem", { name: kind, exact: true }).click();
  await page.getByText(`Add ${kind}`, { exact: true }).first().waitFor();
}
async function pickAccount(page, name) {
  const label = page.getByText(/^(Account|Deposit to|Received in|To account)\s?\*$/).first();
  await label.locator("xpath=following::button[1]").click();
  await page.getByRole("option", { name: new RegExp(name) }).first().click();
  await page.waitForTimeout(300);
}
async function closePanel(page) {
  await page.getByRole("button", { name: "Cancel" }).last().click().catch(() => {});
  await page.waitForTimeout(700);
}
async function fillTxn(page, amount, desc) {
  await pickAccount(page, "QA Bank");
  await page.locator('input[placeholder="0.00"]').first().fill(String(amount));
  await page.locator('input[placeholder^="e.g."]').first().fill(desc);
}

scenario("txn-expense", "Transactions: add expense ₹250 (+ triple-click duplicate guard)", async ({ page }, chk) => {
  const before = await bal("QA Bank");
  await openAdd(page, "Expense");
  await fillTxn(page, 250, "QA coffee");
  await h.shot(page, "txn-expense-form");
  const btn = page.getByRole("button", { name: "Add Expense" });
  chk("submit enabled once amount + description are filled", await btn.isEnabled());
  await page.evaluate(() => window.__reset());
  await btn.evaluate((b) => { b.click(); b.click(); b.click(); });
    await page.waitForFunction(() => (document.querySelector('input[placeholder="0.00"]') || { value: "x" }).value === "", null, { timeout: 15000 }).catch(() => {});
  const closed = await since(page);
  await h.shot(page, "txn-expense-after-save");
  const afterSaveText = (await page.locator("body").innerText()).split("\n").join(" | ");
  await page.waitForTimeout(1500);
  const tl = await h.timeline(page);
  const rows = await txns("QA coffee");
  chk("[observation] panel state after save", true, /Add Expense/.test(afterSaveText) ? "panel stays open after save" : "panel closed after save");
  const after = await bal("QA Bank");
  chk("exactly one transaction persisted despite 3 clicks", rows.length === 1, rows.length);
  chk("bank debited once, ₹250 (persisted)", Math.abs(before - after - 250) < 0.01, `${before} -> ${after}`);
  chk("amount resets after save (save-and-add-another; second save blocked until an amount is entered)", closed < 15000, `${closed} ms after click`);
  await closePanel(page);
  chk("new row visible in the list", await page.getByText("QA coffee").first().isVisible());
  return { ...tl, formResetAfterSave: closed };
});

scenario("txn-income", "Transactions: add income ₹1,000", async ({ page }, chk) => {
  const before = await bal("QA Bank");
  await openAdd(page, "Income");
  await fillTxn(page, 1000, "QA bonus");
  await page.evaluate(() => window.__reset());
  await page.getByRole("button", { name: "Add Income" }).click();
  await page.waitForFunction(() => (document.querySelector('input[placeholder="0.00"]') || { value: "x" }).value === "", null, { timeout: 15000 }).catch(() => {});
  const closed = await since(page);
  await page.waitForTimeout(1200);
  const after = await bal("QA Bank");
  chk("income persisted once", (await txns("QA bonus")).length === 1);
  chk("bank credited ₹1,000 (persisted)", Math.abs(after - before - 1000) < 0.01, `${before} -> ${after}`);
  return { ...(await h.timeline(page)), formResetAfterSave: closed };
});

scenario("txn-validation", "Transactions: error/loading states — empty submit and failed write", async ({ page }, chk) => {
  await openAdd(page, "Expense");
  const btn = page.getByRole("button", { name: "Add Expense" });
  const txt = await page.locator("body").innerText();
  chk("empty form lists what's still needed", /Still needed/.test(txt) && /Amount/.test(txt), (txt.match(/Still needed:[^\n]*\n[^\n]*\n[^\n]*/) || [""])[0].replace(/\n/g, " "));
  await page.evaluate(() => window.__reset());
  await btn.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(1200);
  chk("empty submit writes nothing and shows validation", (await commits(page)) === 0 && /required|Still needed|Enter an amount|Amount/i.test(await page.locator("body").innerText()), "commits " + (await commits(page)) + ", btn disabled=" + (await btn.isDisabled()));
  await fillTxn(page, 77, "QA offline write");
  await page.evaluate(() => window.__reset());
  await page.route("**/*:commit*", (r) => r.abort("failed"));
  await page.context().setOffline(false);
  await btn.click();
  await page.waitForTimeout(4000);
  const text = await page.locator("body").innerText();
  await h.shot(page, "txn-failed-write");
  const rows = await txns("QA offline write");
  chk("a rejected commit leaves no transaction persisted", rows.length === 0, rows.length);
  chk("user sees an error or the panel stays open (not a silent success)", /couldn.t|failed|error|try again|offline/i.test(text) || (await page.getByText("Add Expense", { exact: true }).first().isVisible()), text.match(/[^\n]*(couldn.t|failed|error|try again)[^\n]*/i)?.[0] ?? "panel remained open");
});

scenario("txn-edit-delete", "Transactions: edit amount ₹250→₹300, then delete", async ({ page }, chk) => {
  const base = await bal("QA Bank");
  await openAdd(page, "Expense");
  await fillTxn(page, 250, "QA edit me");
  await page.getByRole("button", { name: "Add Expense" }).click();
  await page.waitForTimeout(2500);
  await closePanel(page);
  const row = page.locator("tr, [role=row]").filter({ hasText: "QA edit me" }).first();
  await row.getByRole("button", { name: "Edit transaction" }).click();
  await page.waitForTimeout(1500);
  await h.shot(page, "txn-edit-form");
  await page.locator('input[placeholder="0.00"]').first().fill("300");
  const names = await page.getByRole("button").evaluateAll((els) => els.filter((e) => e.offsetParent).map((e) => e.innerText.trim()).filter((t) => /Save|Update|Edit/.test(t)));
  const save = page.getByRole("button", { name: /^(Save|Update)/ }).first();
  await page.evaluate(() => window.__reset());
  await save.click();
  await page.waitForTimeout(3500);
  const afterEdit = await bal("QA Bank");
  chk("edit persisted: account reflects ₹300 (not 250+300)", Math.abs(base - afterEdit - 300) < 0.01, `${base} -> ${afterEdit}; buttons seen: ${names.join(",")}`);
  const row2 = page.locator("tr, [role=row]").filter({ hasText: "QA edit me" }).first();
  await row2.getByRole("button", { name: "Delete transaction" }).click();
  await page.waitForTimeout(800);
  await h.shot(page, "txn-delete-confirm");
  const dlg = page.getByRole("dialog").last();
  const delBtns = await dlg.getByRole("button").allInnerTexts();
  await dlg.getByRole("button", { name: /^Delete/ }).last().click();
  await page.waitForTimeout(3500);
  const afterDel = await bal("QA Bank");
  chk("delete restores the account balance (persisted)", Math.abs(afterDel - base) < 0.01, `${afterEdit} -> ${afterDel} (base ${base}); confirm buttons: ${delBtns.join(",")}`);
  chk("deleted transaction no longer listed", (await page.getByText("QA edit me").count()) === 0);
});

scenario("card-pay", "Credit Card: pay full outstanding ₹12,000 from QA Bank", async ({ page }, chk) => {
  const before = await bal("QA Bank");
  const cardBefore = await bal("QA Credit Card");
  await h.go(page, "/credit-cards");
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /Pay full outstanding/ }).first().click();
  await page.getByText("PAYING FULL CARD OUTSTANDING").waitFor();
  await page.getByText("Select account").click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await h.shot(page, "card-pay-form");
  const pay = page.getByRole("button", { name: /^Pay ₹12,000/ });
  await page.evaluate(() => window.__reset());
  await pay.evaluate((b) => { b.click(); b.click(); });
  await page.waitForFunction(() => /Card outstandings*₹0/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
  const closed = await since(page);
  await h.shot(page, "card-pay-after");
  await page.getByRole("button", { name: "Cancel" }).last().click().catch(() => {});
  await page.waitForTimeout(2000);
  const after = await bal("QA Bank");
  const cardAfter = await bal("QA Credit Card");
  const body = await page.locator("body").innerText();
  chk("bank debited ₹12,000 exactly once (persisted)", Math.abs(before - after - 12000) < 0.01, `${before} -> ${after}`);
  chk("card liability cleared (persisted)", cardAfter === 0 || Math.abs(cardAfter - (cardBefore + 12000)) < 0.01, `${cardBefore} -> ${cardAfter}`);
  chk("UI shows card outstanding ₹0", /CREDIT USED\s*₹0/.test(body.replace(/\n+/g, " ")) || !/₹12,000/.test(body.split("My credit cards")[1] || ""), (body.replace(/\n+/g, " ").match(/CREDIT USED[^|]{0,30}/) || [""])[0]);
  return { ...(await h.timeline(page)), outstandingShownAsZero: closed };
});

scenario("card-cancel", "Credit Card: open payment then Cancel", async ({ page }, chk) => {
  const before = await bal("QA Bank");
  await h.go(page, "/credit-cards");
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /Pay full outstanding/ }).first().click();
  await page.getByText("PAYING FULL CARD OUTSTANDING").waitFor();
  await page.evaluate(() => window.__reset());
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.waitForTimeout(1200);
  chk("panel closed", (await page.getByText("PAYING FULL CARD OUTSTANDING").count()) === 0);
  chk("no write attempted; bank unchanged", (await commits(page)) === 0 && (await bal("QA Bank")) === before);
});

scenario("bill-pay", "Bills: Pay from my account now (QA Bank ₹1,500)", async ({ page }, chk) => {
  const before = await bal("QA Bank");
  await h.go(page, "/bills");
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /QA Electricity/ }).click();
  await page.getByRole("button", { name: "Pay…" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay QA Electricity/ });
  await dlg.waitFor();
  await dlg.getByRole("button", { name: /Pay from my account now/ }).click();
  await page.waitForTimeout(600);
  await h.shot(page, "bill-pay-form");
  const txt = await dlg.innerText();
  const acct = dlg.getByText(/Choose|Select|paying account/i).first();
  if (await acct.count()) { await acct.click().catch(() => {}); await page.getByRole("option", { name: /QA Bank/ }).click().catch(() => {}); }
  await page.evaluate(() => window.__reset());
  const pay = dlg.getByRole("button", { name: /Pay now|Pay ₹/ }).last();
  await pay.evaluate((b) => { b.click(); b.click(); });
  await dlg.waitFor({ state: "hidden", timeout: 15000 }).catch(() => {});
  const closed = await since(page);
  await page.waitForTimeout(2000);
  const after = await bal("QA Bank");
  chk("bank debited ₹1,500 exactly once (persisted)", Math.abs(before - after - 1500) < 0.01, `${before} -> ${after}; dialog: ${txt.replace(/\n+/g, " | ").slice(0, 200)}`);
  chk("dialog closed", closed < 15000, `${closed} ms`);
  return { ...(await h.timeline(page)), dialogClosed: closed };
});

scenario("bill-earlier", "Bills: Already paid earlier — no balance change", async ({ page }, chk) => {
  const before = await bal("QA Bank");
  await h.go(page, "/bills");
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /QA Electricity/ }).click();
  await page.getByRole("button", { name: "Pay…" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay QA Electricity/ });
  await dlg.waitFor();
  await dlg.getByRole("button", { name: /Already paid earlier/ }).click();
  await page.waitForTimeout(600);
  await h.shot(page, "bill-earlier-form");
  const txt = await dlg.innerText();
  await page.evaluate(() => window.__reset());
  await dlg.getByRole("button", { name: /Record|Save|Mark|Pay now/ }).last().click();
  await dlg.waitFor({ state: "hidden", timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const after = await bal("QA Bank");
  chk("account balance unchanged (account-neutral, persisted)", after === before, `${before} -> ${after}; dialog: ${txt.replace(/\n+/g, " | ").slice(0, 220)}`);
  chk("bill shows as paid in the UI", /Paid/.test(await page.locator("body").innerText()));
});

scenario("bill-cancel-edit", "Bills: Cancel the pay dialog, then Edit the bill amount", async ({ page }, chk) => {
  await h.go(page, "/bills");
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /QA Electricity/ }).click();
  await page.getByRole("button", { name: "Pay…" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay QA Electricity/ });
  await dlg.waitFor();
  await page.evaluate(() => window.__reset());
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await page.waitForTimeout(800);
  chk("cancel performs no write", (await commits(page)) === 0);
  await page.waitForTimeout(600);
  if ((await page.getByRole("button", { name: "Edit", exact: true }).count()) === 0) await page.getByRole("button", { name: /QA Electricity/ }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.waitForTimeout(1200);
  await h.shot(page, "bill-edit-form");
  const d = page.getByRole("dialog").last();
  const inputs = await d.locator("input:visible").evaluateAll((els) => els.map((e) => `${e.name}|${e.placeholder}|${e.value}`));
  const amountInput = d.locator("input:visible").evaluateAll((els) => els.findIndex((e) => e.value === "1500" || e.value === "1500.00"));
  const idx = await amountInput;
  chk("edit form exposes the bill amount", idx >= 0, inputs.join(" ; "));
  if (idx >= 0) {
    await d.locator("input:visible").nth(idx).fill("1800");
    await page.evaluate(() => window.__reset());
    await d.getByRole("button", { name: /Save|Update/ }).last().click();
    await page.waitForTimeout(3000);
    const bills = await h.list("bills");
    chk("edited amount persisted (₹1,800)", bills.some((b) => b.name === "QA Electricity" && Number(b.amount) === 1800), JSON.stringify(bills.map((b) => [b.name, b.amount])));
  }
});

scenario("people-receipt", "People: Priya pays ₹400 of ₹1,000 into QA Bank (partial settlement)", async ({ page }, chk) => {
  const before = await bal("QA Bank");
  await h.go(page, "/people");
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /Open QA Priya/ }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Record payment" }).first().click();
  await page.getByText("Amount received").waitFor();
  await page.locator("input:visible").filter({ hasNot: page.locator("[readonly]") }).evaluateAll((els) => els.map((e) => e.placeholder));
  await page.getByText("Not paid yet").first().waitFor().catch(() => {});
  // amount input sits next to the "₹" adornment under "Amount received"
  const amt = page.locator("input[inputmode='decimal'], input[type='number'], input[inputmode='numeric']").first();
  await amt.fill("400");
  await page.getByText("Select account").first().click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await page.waitForTimeout(600);
  await h.shot(page, "people-receipt-form");
  const rec = page.getByRole("button", { name: /^Record ₹400/ });
  chk("primary action shows the amount to record", (await rec.count()) > 0, (await page.getByRole("button", { name: /^Record ₹/ }).allInnerTexts()).join(","));
  await page.evaluate(() => window.__reset());
  await rec.first().evaluate((b) => { b.click(); b.click(); });
  await page.waitForTimeout(4500);
  const tl = await h.timeline(page);
  const after = await bal("QA Bank");
  chk("bank credited ₹400 exactly once (persisted)", Math.abs(after - before - 400) < 0.01, `${before} -> ${after}`);
  const body = (await page.locator("body").innerText()).replace(/\n+/g, " ");
  chk("ledger shows ₹600 still owed", /₹600/.test(body), (body.match(/CURRENT PENDING[^|]{0,40}/) || [""])[0]);
  return tl;
});

