/**
 * Statement Review Sidebar and Bulk Assign with same-named categories (local emulator only): the category id must fit
 * each transaction's direction, an unchanged or ambiguous choice keeps the stored id, and nothing else moves.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
import { BASE_URL } from "../lib/env.mjs";

const category = (id, name, type) => h.createDocUnderUser(`categories/${id}`, { id, name, type, iconKey: "other", colorValue: 0, createdAt: new Date(), isDefault: false, isActive: true, deletedAt: null, lastEditedAt: null, editHistory: [] });

function record(marker, t, categoryName, low = false) {
  const credit = t.type === "income";
  return {
    recordType: "transaction", rawText: marker, date: new Date(t.dateTime), counterpartyRaw: marker, counterpartyNormalized: t.description, amount: t.amount, direction: credit ? "credit" : "debit", referenceNumber: null, currency: "INR",
    category: categoryName, subcategory: null, confidenceScores: low ? { overall: 0.2 } : { overall: 0.95 }, sourcePage: 1, sourceLineIndex: 1, splitParentId: null, mergedInto: null, userEdited: false, lastEditedAt: null, lastEditedBy: null, tags: [], notes: "",
    duplicateOfTransactionId: null, include: true, flowType: credit ? "income" : "expense", ownership: credit ? null : "mine", modifiers: { business: false, recurring: false, splitByCategory: false }, actionDetail: null, committedTransactionId: t.id,
    excludeFromCalculations: false, accountingMonth: null, suggestedCategory: null, suggestedAccount: null, suggestedPerson: null, suggestedTags: [], expenseType: null, transferDetected: false, recurringDetected: false, subscriptionDetected: false, duplicateCandidateOf: null, needsReview: false,
  };
}

scenario("stcat-sidebar-bulk", "Statement Review Sidebar and Bulk Assign with duplicate category names", async ({ page }, chk, notes) => {
  await category("aa-gifts-income", "Gifts", "income");
  await category("zz-gifts-expense", "Gifts", "expense");
  const all = async () => h.list("transactions");
  const start = await all();
  const expense = start.find((t) => !t.deletedAt && t.type === "expense" && t.amount === 850);
  const income = start.find((t) => !t.deletedAt && t.type === "income" && t.amount === 40000);
  const cats = await h.list("categories");
  const nameOf = (id) => cats.find((c) => c.id === id)?.name ?? null;
  const card = (await h.list("creditCards"))[0];
  await h.createDocUnderUser("financialDocuments/docstcat", { userId: "x", documentType: "credit_card_statement", accountId: card.id, fileHash: "h-stcat", storagePath: "users/x/documents/credit_card_statement/stcat.pdf", uploadedAt: new Date(), status: "parsed", bank: "HDFC", requiresPassword: false });
  await h.createDocUnderUser("documentImports/docstcat", { userId: "x", documentId: "docstcat", accountId: card.id, status: "draft", metadata: {}, summary: {}, createdAt: new Date() });
  await h.createDocUnderUser("documentImports/docstcat/records/r1", record("ROWEXPENSE", expense, nameOf(expense.categoryId), true));
  await h.createDocUnderUser("documentImports/docstcat/records/r2", record("ROWINCOME", income, nameOf(income.categoryId)));

  // Everything that must never move: every other transaction in full, both edited ones apart from their category, and every balance.
  const frozen = async () => {
    const txns = (await all()).map((t) => (t.id === expense.id || t.id === income.id ? ["id", "type", "amount", "dateTime", "accountId", "description", "deletedAt"].map((k) => t[k]) : t));
    const accounts = (await h.list("accounts")).map((a) => [a.id, a.currentBalance]);
    return JSON.stringify([txns, accounts, await h.list("expenses"), await h.list("people")]);
  };
  const before = await frozen();
  const one = async (t) => (await all()).find((x) => x.id === t.id);
  const idOf = async (t) => (await one(t)).categoryId;
  const historyOf = async (t) => ((await one(t)).editHistory ?? []).length;

  const load = async (reload) => {
    if (reload) await page.reload({ waitUntil: "domcontentloaded" });
    else await page.goto(`${BASE_URL}/statement-review/docstcat`, { waitUntil: "domcontentloaded", timeout: 240000 });
    await page.getByText("ROWEXPENSE").first().waitFor({ timeout: 180000 });
    await page.waitForTimeout(2500);
  };
  const messages = async () => (await page.locator("body").innerText()).replace(/\s+/g, " ");
  const bulk = async (name) => {
    for (const marker of ["ROWEXPENSE", "ROWINCOME"]) await page.getByText(marker).first().click({ modifiers: ["Control"] });
    await page.getByRole("button", { name: "Assign category" }).click();
    await page.getByRole("option", { name, exact: true }).first().click();
    await page.waitForTimeout(3500);
  };
  // The docked sidebar opens from the validation bar's "Review" link — here, the one low-confidence row.
  const sidebarPick = async (_marker, name) => {
    // The sidebar keeps its row until a reload; only an empty one needs the Review link again.
    const empty = page.getByText("Select a row to see its details");
    if (await empty.count()) {
      const review = page.getByRole("button", { name: "Review", exact: true });
      if (!(await review.count())) await page.getByRole("button", { name: /need.? attention|Review issues/ }).first().click({ timeout: 20000 });
      await review.first().click();
    }
    const open = page.getByRole("button", { name: "Show details panel" });
    if (await open.count()) await open.click();
    await page.getByRole("combobox").filter({ hasText: /Gifts|Shopping|Food|Salary|Groceries|Other|Uncategorized/ }).first().click({ timeout: 20000 });
    const options = await page.getByRole("option").allInnerTexts();
    await page.getByRole("option", { name, exact: true }).first().click();
    await page.waitForTimeout(3000);
    return options.map((o) => o.trim());
  };

  await load(false);

  // 1 · Bulk assign one name to an expense and an income.
  await bulk("Gifts");
  chk("Bulk: the expense gets the expense Gifts, the income the income Gifts", (await idOf(expense)) === "zz-gifts-expense" && (await idOf(income)) === "aa-gifts-income", `${await idOf(expense)} / ${await idOf(income)}`);
  await h.shot(page, "stcat-bulk");

  // 2 · Sidebar.
  await load(true);
  await sidebarPick("ROWEXPENSE", "Shopping");
  const shopping = await idOf(expense);
  chk("Sidebar: an ordinary category change is saved", (await h.list("categories")).find((c) => c.id === shopping)?.name === "Shopping", shopping);
  const options = await sidebarPick("ROWEXPENSE", "Gifts");
  notes.push(`sidebar expense options: ${options.join(" | ")}`);
  chk("Sidebar: the expense gets the expense Gifts", (await idOf(expense)) === "zz-gifts-expense", await idOf(expense));
  await h.shot(page, "stcat-sidebar");
  const edits = await historyOf(expense);
  await sidebarPick("ROWEXPENSE", "Gifts");
  chk("Sidebar: choosing the current category again writes nothing", (await idOf(expense)) === "zz-gifts-expense" && (await historyOf(expense)) === edits);
  chk("Sidebar: the income row keeps its income Gifts", (await idOf(income)) === "aa-gifts-income", await idOf(income));

  // The sidebar on the income row: choosing the current name keeps its exact id; a change and back resolves to income.
  const lowConfidence = async (which) => {
    for (const [id, marker, t] of [["r1", "ROWEXPENSE", expense], ["r2", "ROWINCOME", income]]) {
      const current = (await h.list("documentImports/docstcat/records")).find((r) => r.rawText === marker);
      await h.createDocUnderUser(`documentImports/docstcat/records/${id}`, record(marker, { ...t, dateTime: t.dateTime }, current.category, id === which));
    }
    await load(true);
  };
  await lowConfidence("r2");
  await sidebarPick("ROWINCOME", "Salary");
  await sidebarPick("ROWINCOME", "Gifts");
  chk("Sidebar: the income gets the income Gifts", (await idOf(income)) === "aa-gifts-income", await idOf(income));
  await lowConfidence("r1");

  // 3 · A second Gifts that also fits an expense (and an income).
  await sidebarPick("ROWEXPENSE", "Shopping");
  await category("mm-gifts-both", "Gifts", "both");
  await load(true);
  await sidebarPick("ROWEXPENSE", "Gifts");
  const sidebarMessage = await messages();
  await h.shot(page, "stcat-sidebar-ambiguous");
  chk("Sidebar ambiguous: the stored category is kept", (await idOf(expense)) === shopping, await idOf(expense));
  chk("Sidebar ambiguous: the message says why and what to do", /More than one category is named "Gifts"/.test(sidebarMessage) && /Choose the exact one in Transactions/.test(sidebarMessage), sidebarMessage.slice(-600));

  await load(true);
  const incomeEdits = await historyOf(income);
  await bulk("Gifts");
  const bulkMessage = await messages();
  await h.shot(page, "stcat-bulk-ambiguous");
  chk("Bulk ambiguous: the unresolved expense keeps its category", (await idOf(expense)) === shopping, await idOf(expense));
  chk("Bulk ambiguous: the income already named Gifts keeps its exact id, unwritten", (await idOf(income)) === "aa-gifts-income" && (await historyOf(income)) === incomeEdits, await idOf(income));
  chk("Bulk ambiguous: the message says why and what to do", /More than one category is named "Gifts"/.test(bulkMessage), bulkMessage.slice(-700));

  chk("no other transaction, balance, expense or person record changed; nothing added", (await frozen()) === before);
});
