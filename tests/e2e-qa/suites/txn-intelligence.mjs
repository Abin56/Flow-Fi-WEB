/**
 * Transactions Add form — live description autocomplete + automatic category, in the real browser against the Firestore
 * EMULATOR only (see tests/e2e-qa/README.md). Works on synthetic data through the page's own form.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const dlg = (page) => page.getByRole("dialog").first();
const descInput = (page) => page.locator('input[placeholder^="e.g."]').first();
const categoryTrigger = (page) => dlg(page).getByText("Category", { exact: true }).first().locator("xpath=following::button[1]");
const accountTrigger = (page) => dlg(page).getByText(/^(Account|Deposit to|Received in)\s?\*$/).first().locator("xpath=following::button[1]");
const list = (page) => page.getByTestId("description-autocomplete");
const rows = async (page) => (await list(page).getByRole("option").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
const flat = (s) => String(s).replace(/\s+/g, " ").trim();

async function openAdd(page) {
  await h.go(page, "/transactions");
  await page.getByRole("heading", { level: 1, name: "Transactions" }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.locator("button:visible", { hasText: "Add Transaction" }).first().click();
  await page.getByRole("menuitem", { name: "Expense", exact: true }).click();
  await page.getByText("Add Expense", { exact: true }).first().waitFor();
  await page.waitForTimeout(600);
}

scenario("txn-intel-1-typing", "Add Expense: live autocomplete (merchants, typos), category auto-selected, manual category protected, saved values", async ({ page }, check) => {
  await openAdd(page);
  const input = descInput(page);

  // 'swi' → known merchants, each with its category as secondary text
  await input.click();
  await page.keyboard.type("swi", { delay: 60 });
  await list(page).waitFor({ timeout: 5000 });
  let r = await rows(page);
  check("'swi' lists Swiggy — Food Order and Swiggy Instamart", r.some((t) => /^Swiggy — Food Order/.test(t)) && r.some((t) => /^Swiggy Instamart/.test(t)), r.join(" | "));
  check("rows show the category as small secondary text", r.some((t) => /Food · Known merchant/.test(t)), r.join(" | "));
  await h.shot(page, "txn-intel-swi");

  // keyboard: ArrowDown + Enter accepts, category follows
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  check("Enter on a row fills the description", /^Swiggy — Food Order/.test(await input.inputValue()), await input.inputValue());
  check("…and auto-selects Food", /Food/.test(flat(await categoryTrigger(page).innerText())), flat(await categoryTrigger(page).innerText()));

  // 'jio' (mouse)
  await input.fill("");
  await page.keyboard.type("jio", { delay: 60 });
  await list(page).waitFor({ timeout: 5000 });
  r = await rows(page);
  check("'jio' lists Jio Mobile Recharge", r.some((t) => /^Jio Mobile Recharge/.test(t)), r.join(" | "));

  // typo
  await input.fill("");
  await page.keyboard.type("swigy", { delay: 60 });
  await list(page).waitFor({ timeout: 5000 });
  r = await rows(page);
  check("a typo ('swigy') still finds Swiggy", r.some((t) => /^Swiggy/.test(t)), r.join(" | "));
  await page.keyboard.press("Escape");

  // typed text with no click: Biryani → Food
  await input.fill("");
  await page.keyboard.type("Biryani", { delay: 40 });
  check("typing 'Biryani' alone pre-selects Food", /Food/.test(flat(await categoryTrigger(page).innerText())), flat(await categoryTrigger(page).innerText()));
  await dlg(page).getByText("Add Expense", { exact: true }).first().click(); // blur: closes the list

  // a manual category is final
  await categoryTrigger(page).click();
  await page.getByRole("option", { name: /^Shopping/ }).first().click();
  await page.waitForTimeout(500); // the closing dropdown hands focus back to its trigger — let it finish before typing
  await input.click();
  await input.fill("");
  await page.keyboard.type("Jio Recharge", { delay: 40 });
  await dlg(page).getByText("Add Expense", { exact: true }).first().click();
  check("after a manual pick, typing a Jio description does not replace it", /Shopping/.test(flat(await categoryTrigger(page).innerText())), flat(await categoryTrigger(page).innerText()));

  // save carries both fields
  await accountTrigger(page).click();
  await page.getByRole("option").first().click();
  await page.locator('input[inputmode="decimal"]').first().fill("321");
  const before = (await h.list("transactions")).map((t) => t.id);
  await page.getByRole("button", { name: /^add expense/i }).last().click();
  await page.waitForTimeout(1500);
  const made = (await h.list("transactions")).filter((t) => !before.includes(t.id));
  const cats = await h.list("categories");
  check("one transaction saved", made.length === 1, made.length);
  check("saved description is what the field showed", made[0]?.description === "Jio Recharge", made[0]?.description);
  check("saved category is the manual Shopping", cats.find((c) => c.id === made[0]?.categoryId)?.name === "Shopping", cats.find((c) => c.id === made[0]?.categoryId)?.name);
  check("amount and type unchanged", Math.abs((made[0]?.amount ?? 0) - 321) < 0.001 && made[0]?.type === "expense");
});
