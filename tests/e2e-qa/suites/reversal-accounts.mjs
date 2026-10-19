/**
 * Accounts statement running balances against an independent reconstruction from the persisted transactions:
 * many rows with "Show more", four records sharing ONE timestamp, a backdated edit, a deleted transaction, and the
 * Money in / Money out filters. Local emulator only — see tests/e2e-qa/README.md.
 */
import { scenario } from "../lib/core.mjs";
import * as f from "../lib/flows.mjs";
import * as h from "../lib/harness.mjs";

async function seeded(page) {
  await h.addFixture(page, "history");
}

async function readAll(page) {
  const dlg = await f.openBreakdown(page);
  const firstPage = await f.collectStatementRows(dlg);
  const moreLabel = (await dlg.getByRole("button", { name: /Show \d+ more/ }).count()) ? await dlg.getByRole("button", { name: /Show \d+ more/ }).first().innerText() : "";
  const clicks = await f.showAll(dlg);
  const all = await f.collectStatementRows(dlg);
  return { dlg, firstPage, moreLabel: moreLabel.split("\n").join(" "), clicks, all, text: await dlg.innerText() };
}

function pageScenario(id, title, opts) {
  scenario(id, title, async ({ page }, chk) => {
    await seeded(page);
    const expected = await f.reconstructStatement("QA Bank");
    const r = await readAll(page);
    await h.shot(page, `${id}-sheet`);
    chk("more than one page of history exists (30 rows per page)", expected.rows.length > 30, `${expected.rows.length} counted rows`);
    chk("first page shows 30 rows and offers 'Show N more'", r.firstPage.rows.length === 30 && /Show \d+ more/.test(r.moreLabel), `${r.firstPage.rows.length} rows; "${r.moreLabel}"`);
    chk("'Show more' loads the rest (every counted row displayed)", r.all.rows.length === expected.rows.length, `${r.all.rows.length} of ${expected.rows.length} after ${r.clicks} click(s)`);
    const diffs = f.diffStatement(r.all.rows, expected.rows);
    chk("every displayed row (description, debit, credit, running balance) equals the reconstruction from persisted transactions", diffs.length === 0, diffs.join(" || ") || `${expected.rows.length} rows match`);
    chk("the newest row's balance equals the persisted current balance, and opening balance matches", f.close2(r.all.rows[0].balance, expected.current) && f.close2(r.all.opening ?? NaN, expected.opening), `${r.all.rows[0].balance} vs ${expected.current}`);
    chk("no balance-mismatch warning is shown (records explain the stored balance)", !/can.t be traced|no record explains|Your records explain/.test(r.text) && f.close2(expected.derived, expected.current), `derived ${expected.derived} vs stored ${expected.current}`);
    const ties = r.all.rows.filter((x) => / tie$/.test(x.desc)).map((x) => x.desc);
    const expTies = expected.rows.filter((x) => / tie$/.test(x.desc)).map((x) => x.desc);
    chk("four records sharing one exact timestamp appear in the reconstructed tie order (time added, then id)", ties.length === 4 && JSON.stringify(ties) === JSON.stringify(expTies), `${ties.join(" > ")}`);
    // Same data, loaded again — the order must not depend on load order.
    const again = await readAll(page);
    chk("reloading the sheet gives the identical statement (order independent of load order)", JSON.stringify(again.all.rows) === JSON.stringify(r.all.rows));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    chk("no horizontal page overflow", overflow <= 1, `${overflow}px`);
  }, opts);
}
pageScenario("rev-acct-pagination-reconcile", "Accounts: 39 counted rows, Show more, same-timestamp ties — running balances equal the reconstruction (desktop·light)", { viewport: { width: 1920, height: 1080 }, scheme: "light" });
pageScenario("rev-acct-pagination-mobile-dark", "Accounts: the same reconciliation on mobile 390×844, dark", { viewport: { width: 390, height: 844 }, scheme: "dark" });

scenario("rev-acct-filters-paginated", "Accounts: Money out / Money in filters over a paginated history keep every row's TRUE running balance", async ({ page }, chk) => {
  await seeded(page);
  const expected = await f.reconstructStatement("QA Bank");
  const dlg = await f.openBreakdown(page);
  for (const [label, pick] of [["Money out", (r) => r.debit > 0], ["Money in", (r) => r.credit > 0]]) {
    await dlg.getByRole("button", { name: label }).click();
    await page.waitForTimeout(600);
    const clicks = await f.showAll(dlg);
    const shown = (await f.collectStatementRows(dlg)).rows;
    const want = expected.rows.filter(pick);
    const diffs = f.diffStatement(shown, want);
    chk(`${label}: ${want.length} rows, each with its true running balance from the FULL history (not recomputed over the filtered rows)`, diffs.length === 0, `${shown.length} shown after ${clicks} 'Show more' click(s); ${diffs.join(" || ")}`);
    await h.shot(page, `rev-acct-filter-${label.replace(" ", "-").toLowerCase()}`);
  }
  await dlg.getByRole("button", { name: "All", exact: true }).click();
  await page.waitForTimeout(500);
  chk("back to All: the page size resets to 30 rows with 'Show more' available", (await dlg.getByRole("button", { name: /Show \d+ more/ }).count()) > 0);
});

scenario("rev-acct-backdated-edit", "Accounts: backdating a transaction re-orders the statement; balances still equal the reconstruction; stored balance unchanged", async ({ page }, chk) => {
  await seeded(page);
  const before = await f.bal("QA Bank");
  await h.go(page, "/transactions");
  await page.waitForTimeout(2500);
  const row = page.locator("tbody tr").filter({ hasText: "QA hist 36" }).first();
  await row.getByRole("button", { name: "Edit transaction" }).click();
  await page.waitForTimeout(1500);
  const back = new Date(Date.now() - 80 * 86_400_000);
  const dd = String(back.getDate()).padStart(2, "0");
  const mm = String(back.getMonth() + 1).padStart(2, "0");
  await page.locator('input[placeholder="dd/mm/yyyy"]').first().fill(`${dd}/${mm}/${back.getFullYear()}`);
  await h.shot(page, "rev-acct-backdate-form");
  await page.getByRole("button", { name: /^(Save|Update)/ }).first().click();
  await page.waitForTimeout(3500);
  await page.getByRole("button", { name: "Cancel" }).last().click().catch(() => {});
  chk("stored balance unchanged by moving a transaction's date (persisted)", f.close2(await f.bal("QA Bank"), before), `${before} -> ${await f.bal("QA Bank")}`);
  const moved = (await h.list("transactions")).find((t) => t.description === "QA hist 36");
  chk("the transaction's date moved ~80 days back (persisted)", Date.now() - new Date(moved.dateTime).getTime() > 79 * 86_400_000, moved.dateTime);
  const expected = await f.reconstructStatement("QA Bank");
  const r = await readAll(page);
  const diffs = f.diffStatement(r.all.rows, expected.rows);
  chk("after the backdated edit every displayed balance equals the reconstruction", diffs.length === 0, diffs.join(" || ") || `${expected.rows.length} rows match`);
  const idx = r.all.rows.findIndex((x) => x.desc === "QA hist 36");
  chk("the backdated row now sits near the bottom (oldest side), not at the top", idx > expected.rows.length - 6, `position ${idx + 1} of ${r.all.rows.length}`);
  chk("newest balance still equals the stored balance", f.close2(r.all.rows[0].balance, expected.current));
});

scenario("rev-acct-deleted", "Accounts: deleting a transaction removes it from the statement and restores the balance; reconciliation holds", async ({ page }, chk) => {
  await seeded(page);
  const before = await f.bal("QA Bank");
  const target = (await h.list("transactions")).find((t) => t.description === "QA hist 05");
  await h.go(page, "/transactions");
  await page.waitForTimeout(2500);
  await page.getByPlaceholder(/Search description/).fill("QA hist 05");
  await page.waitForTimeout(1200);
  const row = page.locator("tbody tr").filter({ hasText: "QA hist 05" }).first();
  await row.getByRole("button", { name: "Delete transaction" }).click();
  await page.waitForTimeout(800);
  await page.getByRole("dialog").last().getByRole("button", { name: /^Delete/ }).last().click();
  await page.waitForTimeout(3500);
  const after = await f.bal("QA Bank");
  chk(`balance restored by the deleted expense of ₹${target.amount} (persisted)`, f.close2(after - before, target.amount), `${before} -> ${after}`);
  chk("the transaction is soft-deleted (persisted)", !!(await h.list("transactions")).find((t) => t.id === target.id)?.deletedAt);
  const expected = await f.reconstructStatement("QA Bank");
  const r = await readAll(page);
  const diffs = f.diffStatement(r.all.rows, expected.rows);
  chk("the deleted row is gone and every remaining balance equals the reconstruction", !r.all.rows.some((x) => x.desc === "QA hist 05") && diffs.length === 0, diffs.join(" || ") || `${expected.rows.length} rows match`);
  chk("no mismatch warning after the delete", !/can.t be traced|no record explains|Your records explain/.test(r.text));
});
