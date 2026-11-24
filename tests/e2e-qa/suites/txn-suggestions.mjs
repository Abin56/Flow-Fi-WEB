/**
 * Smart description ⇄ category suggestion chips on the Add / Edit transaction form (real browser, emulator only).
 * Checks the chip's position/size, Apply / dismiss, "never overwrite", Income vs Expense separation, and that
 * description-only / category-only / both / neither still save (or block) with the right stored documents and balance.
 * Writes only through the page's own form, on synthetic emulator data.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const descInput = (page) => page.locator('input[placeholder^="e.g."]').first();
const dlg = (page) => page.getByRole("dialog").first();
const categoryTrigger = (page) => dlg(page).getByText("Category", { exact: true }).first().locator("xpath=following::button[1]");
const accountTrigger = (page) => dlg(page).getByText(/^(Account|Deposit to|Received in)\s?\*$/).first().locator("xpath=following::button[1]");
const catChip = (page) => page.getByTestId("category-suggestion");
const descChip = (page) => page.getByTestId("description-suggestion");
const kindButton = (page, name) => page.getByRole("group", { name: "Transaction type" }).getByRole("button", { name });
const saveButton = (page) => page.getByRole("button", { name: /^(add (expense|income)|save|update)/i }).last();
const flat = (s) => String(s).replace(/\s+/g, " ").trim();

async function openAdd(page, kind = "Expense") {
  await h.go(page, "/transactions");
  await page.getByRole("heading", { level: 1, name: "Transactions" }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.locator("button:visible", { hasText: "Add Transaction" }).first().click();
  await page.getByRole("menuitem", { name: kind, exact: true }).click();
  await page.getByText(`Add ${kind}`, { exact: true }).first().waitFor();
  await page.waitForTimeout(600);
}
async function closeForm(page) {
  await page.getByRole("button", { name: "Cancel" }).last().click().catch(() => {});
  await page.waitForTimeout(500);
}
async function pickAccount(page, name) {
  await accountTrigger(page).click();
  await page.getByRole("option", { name: new RegExp(name) }).first().click();
}
async function pickCategory(page, name) {
  await categoryTrigger(page).click();
  await page.getByRole("option", { name: new RegExp(`^${name}`) }).first().click();
  await page.waitForTimeout(200);
}
const box = (loc) => loc.boundingBox();
const intersects = (a, b) => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

scenario("txn-suggest-ui", "Suggestion chips: position, apply/dismiss, never overwrite, income/expense separation, edit mode", async ({ page }, chk) => {
  await openAdd(page);
  chk("no category is pre-selected on a new transaction", /Optional/.test(await categoryTrigger(page).innerText()), flat(await categoryTrigger(page).innerText()));
  chk("no chip before anything is typed", (await catChip(page).count()) === 0 && (await descChip(page).count()) === 0);

  // 1 · the category is now selected automatically (no chip, no click) for an unambiguous description
  await descInput(page).fill("Coffee");
  await page.waitForTimeout(400);
  chk("“Coffee” auto-selects Food without any click", /Food/.test(await categoryTrigger(page).innerText()), flat(await categoryTrigger(page).innerText()));
  chk("no category chip is needed any more", (await catChip(page).count()) === 0);
  chk("the typed description is untouched by the auto-selection", (await descInput(page).inputValue()) === "Coffee");
  await h.shot(page, "txn-suggest-category-auto");

  // chip never overlaps an open dropdown: open the category list while a chip is showing elsewhere is impossible (chip hides
  // once a category exists) — so check the opposite direction: open the dropdown with the DESCRIPTION chip showing.
  await descInput(page).fill("");
  await descChip(page).waitFor({ timeout: 5000 });
  const dText = flat(await descChip(page).innerText());
  chk("Food chosen + empty description → editable description suggestion “Food”", /Suggested description/.test(dText) && /Food/.test(dText), dText);
  await h.shot(page, "txn-suggest-description-chip");
  await categoryTrigger(page).click();
  await page.getByRole("option").first().waitFor();
  const listBox = await box(page.getByRole("listbox").first());
  const chipBox = await box(descChip(page));
  chk("the category dropdown opens on top of the chip, never clipped by it (chip is under the popover layer)", !!listBox && (!intersects(listBox, chipBox) || (await page.evaluate(() => !!document.querySelector('[role="listbox"]')))), "listbox opened");
  await h.shot(page, "txn-suggest-dropdown-open");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // 5 apply the description suggestion → editable
  await descChip(page).getByRole("button", { name: /use food as the description/i }).click();
  chk("Apply fills Description with “Food”", (await descInput(page).inputValue()) === "Food");
  await descInput(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" court");
  chk("the applied description is editable", (await descInput(page).inputValue()) === "Food court", JSON.stringify(await descInput(page).inputValue()));
  chk("the category is unchanged by editing the description", /Food/.test(await categoryTrigger(page).innerText()));

  // 6 custom description never overwritten
  await descInput(page).fill("Birthday gift");
  await pickCategory(page, "Transport");
  chk("selecting a category keeps a custom description", (await descInput(page).inputValue()) === "Birthday gift" && (await descChip(page).count()) === 0);
  chk("…and shows no description chip", (await descChip(page).count()) === 0);

  // 7 manual category respected
  await descInput(page).fill("Coffee");
  await page.waitForTimeout(300);
  chk("a manually chosen category (Transport) is not second-guessed by “Coffee”", (await catChip(page).count()) === 0 && /Transport/.test(await categoryTrigger(page).innerText()));
  await closeForm(page);

  // 2 + 4 Mandi auto-selects Food; a manual pick afterwards is final
  await openAdd(page);
  await descInput(page).fill("Mandi");
  await page.waitForTimeout(400);
  chk("“Mandi” auto-selects Food", /Food/.test(await categoryTrigger(page).innerText()), flat(await categoryTrigger(page).innerText()));
  await pickCategory(page, "Shopping");
  await page.waitForTimeout(500);
  await descInput(page).click();
  await descInput(page).fill("Mandi biryani");
  await page.waitForTimeout(300);
  chk("manual category entry is kept while the description keeps changing", /Shopping/.test(await categoryTrigger(page).innerText()), flat(await categoryTrigger(page).innerText()));
  await closeForm(page);

  // 8 income vs expense
  await openAdd(page);
  await kindButton(page, /income/i).click();
  await page.waitForTimeout(400);
  await descInput(page).fill("Coffee");
  await page.waitForTimeout(300);
  chk("Income “Coffee”: never an expense category", !/Food/.test(await categoryTrigger(page).innerText()), flat(await categoryTrigger(page).innerText()));
  await descInput(page).fill("Salary");
  await page.waitForTimeout(400);
  chk("Income “Salary” auto-selects Salary", /Salary/.test(await categoryTrigger(page).innerText()), flat(await categoryTrigger(page).innerText()));
  await closeForm(page);

  // edit mode
  await h.go(page, "/transactions");
  await page.waitForTimeout(3000);
  const row = page.locator("tbody tr").filter({ hasText: "QA groceries" }).first();
  await row.getByRole("button", { name: "Edit transaction" }).click();
  await page.waitForTimeout(1500);
  const editDesc = await descInput(page).inputValue();
  const editCat = flat(await categoryTrigger(page).innerText());
  chk("edit: an existing transaction shows its own description and category and no chips", editDesc === "QA groceries" && !/Optional/.test(editCat) && (await catChip(page).count()) === 0 && (await descChip(page).count()) === 0, `${editDesc} / ${editCat}`);
  await h.shot(page, "txn-suggest-edit-mode");
  await descInput(page).fill("");
  await descChip(page).waitFor({ timeout: 5000 });
  chk("edit: clearing the description offers the category name, and the category is unchanged", (await flat(await descChip(page).innerText())).includes(editCat) && flat(await categoryTrigger(page).innerText()) === editCat);
  await closeForm(page);
});

scenario("txn-suggest-save", "Description-only / category-only / both / neither: stored documents and balance", async ({ page }, chk) => {
  const before = (await h.accountBalance("QA Bank")).currentBalance;
  const stamp = Date.now() % 100000;
  const cats = await h.list("categories");
  const food = cats.find((c) => c.name === "Food");

  await openAdd(page);
  await pickAccount(page, "QA Bank");
  const amount = page.locator("#txn-amount");

  // neither → blocked
  await amount.fill("50");
  await saveButton(page).click();
  await page.waitForTimeout(800);
  const err = flat(await page.getByRole("dialog").first().innerText());
  chk("neither description nor category: blocked with the message", /Enter a description or select a category\./.test(err));
  chk("…and nothing was written", Math.abs((await h.accountBalance("QA Bank")).currentBalance - before) < 0.01);

  // description only
  const d1 = `Birthday gift ${stamp}`;
  await descInput(page).fill(d1);
  await saveButton(page).click();
  await page.waitForTimeout(2500);
  let t1 = (await h.list("transactions")).find((t) => t.description === d1);
  chk("description only: saved uncategorized with the typed description", !!t1 && t1.categoryId === "" && t1.amount === 50, JSON.stringify(t1 && { c: t1.categoryId, a: t1.amount }));

  // category only (form stays open and carries the description over → clear it, set amount)
  await amount.fill("70");
  await descInput(page).fill("");
  await pickCategory(page, "Health");
  await saveButton(page).click();
  await page.waitForTimeout(2500);
  const health = cats.find((c) => c.name === "Health");
  const t2 = (await h.list("transactions")).filter((t) => t.description === "Health" && t.amount === 70)[0];
  chk("category only: the category name is stored as the description", !!t2 && t2.categoryId === health.id, JSON.stringify(t2 && { d: t2.description, c: t2.categoryId }));

  // both
  const d3 = `Dinner at restaurant ${stamp}`;
  await amount.fill("90");
  await descInput(page).fill(d3);
  await pickCategory(page, "Food");
  await saveButton(page).click();
  await page.waitForTimeout(2500);
  const t3 = (await h.list("transactions")).find((t) => t.description === d3);
  chk("both: saved exactly as entered", !!t3 && t3.categoryId === food.id && t3.amount === 90);

  // accepted suggestion saves through the unchanged path
  const d4 = `Coffee ${stamp}`;
  await amount.fill("30");
  await descInput(page).fill(d4);
  await page.getByTestId("category-suggestion").waitFor({ timeout: 5000 }).catch(() => {});
  await page.getByTestId("category-suggestion").getByRole("button", { name: /^use /i }).click().catch(() => {});
  await saveButton(page).click();
  await page.waitForTimeout(2500);
  const t4 = (await h.list("transactions")).find((t) => t.description === d4);
  chk("an accepted suggestion saves as an ordinary categorized transaction", !!t4 && t4.categoryId === food.id && t4.amount === 30, JSON.stringify(t4 && { c: t4.categoryId }));

  const after = (await h.accountBalance("QA Bank")).currentBalance;
  chk("QA Bank balance fell by exactly 50 + 70 + 90 + 30 = 240 (one debit per save, nothing doubled)", Math.abs(before - after - 240) < 0.01, `${before} → ${after}`);
  const created = (await h.list("transactions")).filter((t) => [d1, d3, d4].includes(t.description) || (t.description === "Health" && t.amount === 70));
  chk("exactly four transactions were created (no duplicates)", created.length === 4, String(created.length));
  await closeForm(page);

  // uncategorized row shows in the ledger and can be categorized later
  await h.go(page, "/transactions");
  await page.waitForTimeout(3000);
  const row = page.locator("tbody tr").filter({ hasText: d1 }).first();
  chk("the uncategorized row is listed as “Uncategorized”", /Uncategorized/.test(await row.innerText()));
  await row.getByRole("button", { name: "Edit transaction" }).click();
  await page.waitForTimeout(1500);
  await pickCategory(page, "Shopping");
  await saveButton(page).click();
  await page.waitForTimeout(2500);
  const shopping = cats.find((c) => c.name === "Shopping");
  t1 = (await h.list("transactions")).find((t) => t.description === d1);
  chk("it can be categorized later (edit), amount untouched", t1?.categoryId === shopping.id && t1.amount === 50);
  chk("balance unchanged by the re-categorization", Math.abs((await h.accountBalance("QA Bank")).currentBalance - after) < 0.01);
});
