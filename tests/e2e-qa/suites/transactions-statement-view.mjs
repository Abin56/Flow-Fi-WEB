/**
 * Transactions → Statement view (read-only bank-statement layout over the existing Account Statement).
 * Every displayed balance is checked against an INDEPENDENT recomputation from the documents persisted in the
 * emulator (opening + Σ signed amounts, oldest first, in whole paise). Nothing here writes financial data except the
 * synthetic fixture seeding the harness already does. Local emulator only — see tests/e2e-qa/README.md.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const paise = (n) => Math.round(n * 100);
const VP = { desktop: { width: 1366, height: 768 }, mobile: { width: 390, height: 844 } };

/** Oldest-first expected statement for one account, straight from the stored documents. */
async function expectedFor(accountName) {
  const accounts = await h.list("accounts");
  const account = accounts.find((a) => a.name === accountName);
  const txs = (await h.list("transactions"))
    .filter((t) => t.accountId === account.id && t.deletedAt == null && !t.excludeFromCalculations && t.fundedByPersonId == null)
    .sort((a, b) => new Date(a.dateTime) - new Date(b.dateTime) || new Date(a.createdAt) - new Date(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let run = paise(account.openingBalance);
  const rows = txs.map((t) => {
    run += t.type === "income" ? paise(t.amount) : -paise(t.amount);
    return { id: t.id, debit: t.type === "income" ? 0 : paise(t.amount), credit: t.type === "income" ? paise(t.amount) : 0, balance: run, transferId: t.transferId ?? null };
  });
  return { account, rows, closing: run };
}

const radio = (page, label) => page.getByRole("radio", { name: label });
async function openStatement(page, accountName) {
  await h.go(page, "/transactions");
  await radio(page, "Statement view").waitFor({ timeout: 30000 });
  await radio(page, "Statement view").click();
  if (accountName) {
    await page.getByTestId("statement-needs-account").getByRole("button", { name: new RegExp(accountName) }).click();
    await page.getByTestId("statement-header").waitFor({ timeout: 20000 });
  }
}
/** [{id, balance(paise), debit, credit}] in on-screen order (newest first) for the rendered page. */
async function shown(page) {
  return page.getByTestId("statement-row").evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute("data-transaction-id"),
      balance: Math.round(Number(el.querySelector('[data-testid="statement-balance"]').getAttribute("data-balance")) * 100),
      debit: el.querySelector('[data-testid="statement-debit"]').textContent.trim(),
      credit: el.querySelector('[data-testid="statement-credit"]').textContent.trim(),
    })),
  );
}
/** Synthetic emulator data only: a transfer created through the app's own Add Transaction dialog. */
async function addTransfer(page, from, to, amount) {
  await radio(page, "List view").waitFor({ timeout: 60000 });
  await page.locator("button:visible", { hasText: "Add Transaction" }).first().click();
  await page.getByRole("menuitem", { name: "Transfer to my account" }).click();
  await page.locator("#txn-amount").waitFor();
  await page.locator("#txn-amount").fill(String(amount));
  await page.getByText("From Account *").locator("xpath=following::button[1]").click();
  await page.getByRole("option", { name: new RegExp(from) }).click();
  await page.getByText("To Account *").locator("xpath=following::button[1]").click();
  await page.getByRole("option", { name: new RegExp(to) }).click();
  await page.locator('button[type="submit"]:visible').last().click();
  await page.waitForTimeout(2500);
  // The drawer can stay open after a save; close it so the page behind is usable again.
  if (await page.getByRole("button", { name: "Cancel" }).last().isVisible().catch(() => false)) await page.getByRole("button", { name: "Cancel" }).last().click();
  await page.waitForTimeout(600);
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

scenario("stmt-desktop-light", "Statement view: desktop light — account requirement, balances, filters, paging, actions", async ({ page }, chk) => {
  await h.go(page, "/dev/qa");
  await h.addFixture(page, "history"); // 36 statement-history transactions on QA Bank, 4 sharing one timestamp
  await h.go(page, "/transactions");
  await page.waitForTimeout(2500);
  await h.shot(page, "stmt-before-list-view");
  const listRowsBefore = await page.locator("tbody tr").count();

  // All Accounts: a clear account requirement, never a combined balance.
  await radio(page, "Statement view").click();
  await page.getByTestId("statement-needs-account").waitFor();
  chk("All Accounts: asks to choose an account", (await page.getByTestId("statement-needs-account").innerText()).includes("Choose an account"));
  chk("All Accounts: no statement rows or balances are drawn", (await page.getByTestId("statement-row").count()) === 0);
  await page.waitForTimeout(500); // let the selector's colour transition finish
  await h.shot(page, "stmt-after-needs-account-desktop-light");

  // The existing List view is untouched.
  await radio(page, "List view").click();
  await page.waitForTimeout(500);
  chk("List view unchanged after visiting Statement", (await page.locator("tbody tr").count()) === listRowsBefore, `${listRowsBefore} rows`);
  await radio(page, "Statement view").click();

  // Pick QA Bank → exact running balances.
  await page.getByTestId("statement-needs-account").getByRole("button", { name: /QA Bank/ }).click();
  await page.getByTestId("statement-header").waitFor();
  await page.getByTestId("statement-row").first().waitFor();
  const exp = await expectedFor("QA Bank");
  const expNewest = [...exp.rows].reverse();
  const expById = new Map(exp.rows.map((r) => [r.id, r]));
  chk("opening balance matches the stored opening", (await page.getByTestId("statement-opening").innerText()).replace(/[^\d.]/g, "") === (exp.account.openingBalance).toFixed(2), await page.getByTestId("statement-opening").innerText());
  chk("balance now equals the independently computed closing", (await page.getByTestId("statement-closing").innerText()).replace(/[^\d.-]/g, "") === (exp.closing / 100).toFixed(2), `${await page.getByTestId("statement-closing").innerText()} vs ${(exp.closing / 100).toFixed(2)}`);
  chk("closing balance equals the stored account balance (no drift)", Math.abs(exp.closing / 100 - exp.account.currentBalance) < 0.005);
  chk("no drift warning for a reconciled account", (await page.getByTestId("statement-header").getByRole("status").count()) === 0);
  let rows = await shown(page);
  chk("page 1 shows the newest rows in order", rows.length > 0 && rows.every((r, i) => r.id === expNewest[i].id), `${rows.length} rows`);
  chk("every balance on page 1 equals the independent running balance", rows.every((r) => r.balance === expById.get(r.id).balance));
  chk("each row is either a debit or a credit, never both", rows.every((r) => (r.debit === "—") !== (r.credit === "—")));
  chk("no horizontal page overflow", (await overflow(page)) <= 1);
  await h.shot(page, "stmt-after-bank-desktop-light");

  // Pagination: balances continue, never restart.
  const nextBtn = page.getByRole("button", { name: "Next page" });
  const perPage = rows.length;
  if (await nextBtn.isEnabled()) {
    await nextBtn.click();
    await page.waitForTimeout(400);
    const p2 = await shown(page);
    chk("page 2 balances continue the full ledger", p2.length > 0 && p2.every((r, i) => r.id === expNewest[perPage + i].id && r.balance === expById.get(r.id).balance), `${p2.length} rows`);
    const last = await page.getByRole("button", { name: "Next page" }).isDisabled();
    if (last) chk("last page ends with the opening-balance line", (await page.getByTestId("statement-opening-row").count()) === 1);
    await page.getByRole("button", { name: "Previous page" }).click();
  }
  chk("opening-balance line is not drawn mid-ledger", (await page.getByTestId("statement-opening-row").count()) === 0 || rows.length === exp.rows.length);

  // Search narrows rows, but each surviving row keeps its full-ledger balance.
  const sample = expNewest[Math.min(5, expNewest.length - 1)];
  const sampleText = (await page.locator(`[data-transaction-id="${sample.id}"]`).count()) ? await page.locator(`[data-transaction-id="${sample.id}"] button`).first().innerText() : "";
  const term = (sampleText.split("\n")[0] || "").trim().slice(0, 8);
  if (term) {
    await page.getByLabel("Search transactions").fill(term);
    await page.waitForTimeout(700);
    const filteredRows = await shown(page);
    chk("search: fewer rows, balances unchanged from the full ledger", filteredRows.length > 0 && filteredRows.length < exp.rows.length && filteredRows.every((r) => r.balance === expById.get(r.id).balance), `"${term}" → ${filteredRows.length} rows`);
    chk("search: footnote explains that balances are full-ledger", (await page.getByTestId("statement-footnote").innerText()).includes("full-ledger"));
    await h.shot(page, "stmt-after-search-filtered-desktop-light");
    await page.getByLabel("Search transactions").fill("");
    await page.waitForTimeout(500);
  }

  // Existing actions survive: Edit opens the details dialog; Delete asks for confirmation (cancelled — nothing written).
  const before = (await h.list("transactions")).filter((t) => t.deletedAt == null).length;
  await page.getByTestId("statement-row").first().getByRole("button", { name: "Edit transaction" }).click();
  await page.getByRole("dialog").first().waitFor();
  chk("Edit opens the existing transaction details", (await page.getByRole("dialog").count()) > 0);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").first().waitFor({ state: "detached" }).catch(() => {});
  await page.getByTestId("statement-row").first().getByRole("button", { name: "Delete transaction" }).click();
  await page.getByText("Delete transaction?").first().waitFor();
  await page.getByRole("button", { name: "Cancel" }).last().click();
  await page.waitForTimeout(500);
  chk("Delete shows the existing confirmation; cancelling writes nothing", (await h.list("transactions")).filter((t) => t.deletedAt == null).length === before);
});

scenario("stmt-card-and-transfers", "Statement view: credit card words balance as owed; transfer legs sit on their own accounts", async ({ page }, chk) => {
  await h.go(page, "/transactions");
  await page.waitForTimeout(2000);
  const txBefore = (await h.list("transactions")).length;
  await addTransfer(page, "QA Bank", "QA Cash", 500.25);
  await addTransfer(page, "QA Bank", "QA Credit Card", 200);
  chk("two transfer / card-bill-payment pairs were created (4 legs)", (await h.list("transactions")).length - txBefore >= 4, `+${(await h.list("transactions")).length - txBefore} docs`);
  await openStatement(page, null);
  await page.getByTestId("statement-needs-account").getByRole("button", { name: /QA Credit Card/ }).click();
  await page.getByTestId("statement-header").waitFor();
  const exp = await expectedFor("QA Credit Card");
  const header = await page.getByTestId("statement-header").innerText();
  chk("card header says the balance is what you owe", /owe/i.test(header), header.split("\n").slice(0, 3).join(" | "));
  chk("card column is labelled 'Owed after', not a savings 'Balance'", (await page.getByText("Owed after").count()) > 0);
  if (exp.rows.length > 0) {
    const rows = await shown(page);
    const byId = new Map(exp.rows.map((r) => [r.id, r]));
    chk("card running balances equal the independent computation", rows.every((r) => r.balance === byId.get(r.id).balance), `${rows.length} rows`);
    chk("card amounts shown as owed/in credit text, not bare savings balances", (await page.getByTestId("statement-row").first().innerText()).match(/owed|in credit|settled/) != null);
  }
  await h.shot(page, "stmt-after-card-desktop-light");

  // On screen: the sending account shows the DEBIT, the receiving account the CREDIT, each with the right balance.
  const accountsNow = await h.list("accounts");
  for (const [name, side, desc, amount] of [["QA Bank", "debit", "Transfer to QA Cash", "₹500.25"], ["QA Cash", "credit", "Transfer from QA Bank", "₹500.25"], ["QA Credit Card", "credit", "Transfer from QA Bank", "₹200.00"]]) {
    const id = accountsNow.find((a) => a.name === name).id;
    await h.go(page, `/transactions?account=${id}`);
    await radio(page, "Statement view").click();
    await page.getByTestId("statement-row").first().waitFor();
    const e = await expectedFor(name);
    const byId = new Map(e.rows.map((r) => [r.id, r]));
    const row = page.getByTestId("statement-row").filter({ hasText: desc }).filter({ hasText: amount }).first();
    const id2 = await row.getAttribute("data-transaction-id");
    chk(`${name}: "${desc}" ${amount} is a ${side} row`, (await row.getByTestId(`statement-${side}`).innerText()).includes(amount) && (await row.getByTestId(`statement-${side === "debit" ? "credit" : "debit"}`).innerText()).trim() === "—");
    chk(`${name}: that row's balance equals the independent running balance`, byId.get(id2)?.balance === Math.round(Number(await row.getByTestId("statement-balance").getAttribute("data-balance")) * 100));
    const all = await shown(page);
    chk(`${name}: every balance on screen equals the independent computation`, all.every((r) => r.balance === byId.get(r.id).balance), `${all.length} rows`);
    if (name === "QA Bank") await h.shot(page, "stmt-after-transfer-bank-desktop-light");
    if (name === "QA Cash") await h.shot(page, "stmt-after-transfer-cash-desktop-light");
  }

  // Every transfer pair: debit on the sending account's statement, credit on the receiving account's — never both on one.
  const accounts = await h.list("accounts");
  const txs = (await h.list("transactions")).filter((t) => t.deletedAt == null && t.transferId);
  const pairs = new Map();
  for (const t of txs) pairs.set(t.transferId, [...(pairs.get(t.transferId) ?? []), t]);
  const complete = [...pairs.values()].filter((p) => p.length === 2);
  chk("fixtures contain at least one transfer / card-bill-payment pair", complete.length > 0, `${complete.length} pairs`);
  for (const [a, b] of complete.slice(0, 2)) {
    const src = a.type === "expense" ? a : b;
    const dst = a.type === "expense" ? b : a;
    const srcName = accounts.find((x) => x.id === src.accountId).name;
    const dstName = accounts.find((x) => x.id === dst.accountId).name;
    const e1 = await expectedFor(srcName);
    const e2 = await expectedFor(dstName);
    chk(`transfer debits ${srcName}`, e1.rows.find((r) => r.id === src.id)?.debit === paise(src.amount));
    chk(`transfer credits ${dstName}`, e2.rows.find((r) => r.id === dst.id)?.credit === paise(dst.amount));
  }
});

scenario("stmt-mobile-dark", "Statement view: mobile 390 dark — layout, balances, no overflow", async ({ page }, chk) => {
  await openStatement(page, null);
  await page.waitForTimeout(500);
  await h.shot(page, "stmt-after-needs-account-mobile-dark");
  chk("needs-account panel: no horizontal overflow", (await overflow(page)) <= 1);
  await page.getByTestId("statement-needs-account").getByRole("button", { name: /QA Bank/ }).click();
  await page.getByTestId("statement-header").waitFor();
  await page.getByTestId("statement-row").first().waitFor();
  const exp = await expectedFor("QA Bank");
  const byId = new Map(exp.rows.map((r) => [r.id, r]));
  const rows = await shown(page);
  chk("mobile balances equal the independent computation", rows.length > 0 && rows.every((r) => r.balance === byId.get(r.id).balance), `${rows.length} rows`);
  chk("mobile: no horizontal page overflow", (await overflow(page)) <= 1, `${await overflow(page)}px`);
  const first = await page.getByTestId("statement-row").first().innerText();
  chk("mobile: each row shows DR/CR under the balance", /(DR|CR) ₹/.test(first), first.replace(/\n/g, " | "));
  const actions = await page.getByTestId("statement-row").first().getByRole("button", { name: "Edit transaction" }).boundingBox();
  chk("mobile: Edit action is on screen", actions && actions.x >= 0 && actions.x + actions.width <= 391);
  await h.shot(page, "stmt-after-bank-mobile-dark");
}, { viewport: VP.mobile, scheme: "dark" });

scenario("stmt-desktop-dark", "Statement view: desktop dark — layout and balances", async ({ page }, chk) => {
  await openStatement(page, "QA Bank");
  await page.getByTestId("statement-row").first().waitFor();
  const exp = await expectedFor("QA Bank");
  const byId = new Map(exp.rows.map((r) => [r.id, r]));
  const rows = await shown(page);
  chk("dark: balances equal the independent computation", rows.length > 0 && rows.every((r) => r.balance === byId.get(r.id).balance), `${rows.length} rows`);
  chk("dark: no horizontal page overflow", (await overflow(page)) <= 1);
  await h.shot(page, "stmt-after-bank-desktop-dark");
}, { viewport: VP.desktop, scheme: "dark" });

scenario("stmt-mobile-light", "Statement view: mobile 390 light — layout", async ({ page }, chk) => {
  await openStatement(page, "QA Bank");
  await page.getByTestId("statement-row").first().waitFor();
  chk("mobile light: no horizontal page overflow", (await overflow(page)) <= 1);
  await h.shot(page, "stmt-after-bank-mobile-light");
}, { viewport: VP.mobile, scheme: "light" });
