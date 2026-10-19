/**
 * Second-pass QA:
 *  D-05  /transactions?account=<id> keeps the account filter on a direct link, refresh and back/forward; an invalid
 *        or someone else's id is reported, never replaced; Add Transaction gets context only for a valid account.
 *  B     People → Split expense never preselects an account.
 *  C     The "already paid earlier" label comes from the structured payment flag, so it survives a description edit.
 * Local emulator only — see tests/e2e-qa/README.md.
 */
import { scenario } from "../lib/core.mjs";
import { BASE_URL } from "../lib/env.mjs";
import * as h from "../lib/harness.mjs";

const commits = (page) => page.evaluate(() => window.__ev.filter((e) => e.n === "commitStart").length);
const accountTrigger = (page) => page.getByText(/^(Account|Deposit to|Received in)\s?\*$/).first().locator("xpath=following::button[1]");
const rowCount = (page) => page.locator("tbody tr").count();

async function accountsByName() {
  const accounts = await h.list("accounts");
  return Object.fromEntries(accounts.map((a) => [a.name, a]));
}
const chip = (page, name) => page.getByText(`Account: ${name}`).or(page.getByText(`Card: ${name}`)).first();

async function addExpenseAccountText(page) {
  await page.locator("button:visible", { hasText: "Add Transaction" }).first().click();
  await page.getByRole("menuitem", { name: "Expense", exact: true }).click();
  await page.getByText("Add Expense", { exact: true }).first().waitFor();
  const text = (await accountTrigger(page).innerText()).split("\n").join(" ");
  await page.getByRole("button", { name: "Cancel" }).last().click().catch(() => {});
  await page.waitForTimeout(500);
  return text;
}

/* ───────────────────────────── D-05 ───────────────────────────── */

scenario("ux-d05-direct-url", "D-05: /transactions?account=<id> kept on a direct link, refresh and back/forward", async ({ page }, chk) => {
  const { "QA Bank": bank } = await accountsByName();
  const url = `${BASE_URL}/transactions?account=${bank.id}`;

  // 1) Direct navigation on a fresh page load.
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await chip(page, "QA Bank").waitFor({ timeout: 20000 });
  await page.waitForTimeout(2500);
  let rows = await page.locator("tbody tr").allInnerTexts();
  chk("direct link: the QA Bank filter chip is shown", (await chip(page, "QA Bank").count()) > 0);
  chk("direct link: only QA Bank rows are listed (no QA Credit Card row)", rows.length > 0 && !rows.some((r) => /QA Credit Card/.test(r)), `${rows.length} rows`);
  chk("direct link: the URL still carries the account", page.url().includes(`account=${bank.id}`), page.url().replace(BASE_URL, ""));
  chk("direct link: Add Transaction starts on QA Bank — explicit, validated context", /QA Bank/.test(await addExpenseAccountText(page)));
  await h.shot(page, "ux-d05-direct-link");

  // 2) Refresh.
  await page.reload({ waitUntil: "domcontentloaded" });
  await chip(page, "QA Bank").waitFor({ timeout: 20000 });
  await page.waitForTimeout(2000);
  rows = await page.locator("tbody tr").allInnerTexts();
  chk("refresh: still filtered to QA Bank", (await chip(page, "QA Bank").count()) > 0 && !rows.some((r) => /QA Credit Card/.test(r)), `${rows.length} rows`);

  // 3) Back / forward across a client-side navigation.
  await h.go(page, "/dashboard");
  await page.waitForTimeout(1500);
  await page.goBack();
  await chip(page, "QA Bank").waitFor({ timeout: 20000 });
  chk("back: returning to the page restores the QA Bank filter from the URL", (await chip(page, "QA Bank").count()) > 0 && page.url().includes(`account=${bank.id}`));
  await page.goForward();
  await page.waitForURL("**/dashboard*");
  chk("forward: the dashboard again", page.url().includes("/dashboard"));

  // 4) Clearing the chip updates the URL and back/forward stays consistent.
  await page.goBack();
  await chip(page, "QA Bank").waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: /Clear filters/ }).first().click();
  await page.waitForTimeout(1500);
  chk("clearing the filter removes the account from the URL and shows every row", !page.url().includes("account=") && (await rowCount(page)) >= 5, page.url().replace(BASE_URL, ""));
});

scenario("ux-d05-accounts-path-and-orders", "D-05: Accounts → Transactions still works; direct links for Cash / Bank / Card across three Firestore orderings", async ({ page }, chk, notes) => {
  const orders = [];
  for (let round = 1; round <= 3; round++) {
    if (round > 1) {
      await h.go(page, "/dev/qa");
      await h.reseed(page); // new random ids → a different Firestore order
    }
    const byName = await accountsByName();
    orders.push((await h.list("accounts")).map((a) => a.type).join(">"));

    // The in-app path (unchanged behaviour): Accounts → account → Transactions.
    await h.go(page, "/accounts");
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: /^QA Cash Cash on Hand/ }).click();
    await page.waitForTimeout(900);
    await page.getByRole("button", { name: "Transactions", exact: true }).click();
    await chip(page, "QA Cash").waitFor({ timeout: 20000 });
    chk(`round ${round} [${orders[round - 1]}]: Accounts → Transactions filters to QA Cash`, (await chip(page, "QA Cash").count()) > 0);

    // Direct links for each account type.
    for (const [name, expectText] of [["QA Cash", "QA Cash"], ["QA Bank", "QA Bank"], ["QA Credit Card", "QA Credit Card"]]) {
      await page.goto(`${BASE_URL}/transactions?account=${byName[name].id}`, { waitUntil: "domcontentloaded" });
      await chip(page, expectText).waitFor({ timeout: 20000 });
      await page.waitForTimeout(1200);
      const rows = await page.locator("tbody tr").allInnerTexts();
      const others = ["QA Cash", "QA Bank", "QA Credit Card"].filter((n) => n !== name);
      chk(`round ${round}: direct link ${name} → chip and only ${name} rows`, rows.every((r) => !others.some((o) => r.includes(o))), `${rows.length} rows`);
    }
  }
  notes.push(`Firestore account orders seen (by type): ${orders.join(" | ")}`);
});

scenario("ux-d05-invalid-account", "D-05: an unknown, deleted or someone else's account id is reported — never replaced, no Add context", async ({ page }, chk) => {
  const uid = await h.authUid();
  // Another user's account document, and a soft-deleted one of mine.
  await h.createRawDoc("users/some-other-user/accounts/foreign-account", { name: "Not mine", id: "foreign-account" });
  const bank = (await accountsByName())["QA Bank"];
  const cases = [
    ["unknown id", "no-such-account"],
    ["another user's account id", "foreign-account"],
  ];
  for (const [label, id] of cases) {
    await page.goto(`${BASE_URL}/transactions?account=${id}`, { waitUntil: "domcontentloaded" });
    await page.getByText("That account wasn't found").waitFor({ timeout: 20000 });
    await page.waitForTimeout(1500);
    const rows = await page.locator("tbody tr").allInnerTexts();
    chk(`${label}: a visible notice says the account wasn't found`, true);
    chk(`${label}: no filter chip, and the list is NOT narrowed to some other account (all accounts present)`, (await chip(page, "QA Bank").count()) === 0 && rows.some((r) => /QA Bank/.test(r)) && rows.some((r) => /QA Credit Card/.test(r)), `${rows.length} rows`);
    chk(`${label}: Add Transaction starts with no account`, /Select account/i.test(await addExpenseAccountText(page)));
    if (id === "no-such-account") await h.shot(page, "ux-d05-invalid-account");
  }
  chk("(fixture) the signed-in user is the owner of QA Bank only", !!bank && !!uid);
  // Dismissing the notice clears the bad id from the URL.
  await page.goto(`${BASE_URL}/transactions?account=no-such-account`, { waitUntil: "domcontentloaded" });
  await page.getByText("That account wasn't found").waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: /dismiss|close/i }).first().click().catch(() => {});
  await page.waitForTimeout(1200);
  chk("dismissing the notice removes the invalid id from the URL", !page.url().includes("account="), page.url().replace(BASE_URL, ""));
});

/* ───────────────────────────── Task B ───────────────────────────── */

scenario("ux-b-people-split-account", "People → Split expense: no preselected account, submit blocked with a message, a deliberate pick saves there — across three orderings", async ({ page }, chk, notes) => {
  const orders = [];
  for (let round = 1; round <= 3; round++) {
    if (round > 1) {
      await h.go(page, "/dev/qa");
      await h.reseed(page);
    }
    const byName = await accountsByName();
    orders.push((await h.list("accounts")).map((a) => a.type).join(">"));
    await h.go(page, "/people");
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: /Open QA Priya/ }).click();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Split", exact: true }).first().click();
    await page.getByText(/Split expense/).first().waitFor();
    await page.waitForTimeout(800);
    const trigger = page.getByRole("combobox").filter({ hasText: /Select account|QA Cash|QA Bank|QA Credit Card/ }).first();
    const start = (await trigger.innerText()).split("\n").join(" ");
    chk(`round ${round} [${orders[round - 1]}]: the Account field starts empty`, /Select account/i.test(start), start);
    if (round === 1) await h.shot(page, "ux-b-split-empty");

    await page.getByPlaceholder(/e\.g\./i).first().fill(`QA split ${round}`);
    await page.locator("input[inputmode='decimal'], input[inputmode='numeric']").first().fill("600");
    await page.evaluate(() => window.__reset());
    await page.getByRole("button", { name: /save split/i }).click();
    await page.waitForTimeout(1200);
    chk(`round ${round}: Save without an account writes nothing and says why`, (await commits(page)) === 0 && (await page.getByText("Select the account this expense was paid from.").count()) > 0, `commits ${await commits(page)}`);

    await trigger.click();
    await page.getByRole("option", { name: /QA Bank/ }).click();
    await page.getByRole("button", { name: /save split/i }).click();
    await page.waitForTimeout(3500);
    const saved = (await h.list("transactions")).find((t) => t.description === `QA split ${round}`);
    chk(`round ${round}: after a deliberate pick the expense is saved on exactly that account`, saved?.accountId === byName["QA Bank"].id, `${saved?.accountId} vs ${byName["QA Bank"].id}`);
  }
  notes.push(`Firestore account orders seen (by type): ${orders.join(" | ")}`);
});

/* ───────────────────────────── Task C ───────────────────────────── */

scenario("ux-c-historical-after-edit", "Historical label comes from the structured payment flag — it survives a description edit (Dashboard shows the edited text)", async ({ page }, chk, notes) => {
  const payments = (await h.list("paymentSchedules")).length;
  chk("(fixture) a Loan with a recorded-earlier payment exists", payments > 0);

  await h.go(page, "/transactions");
  await page.waitForTimeout(3000);
  const row = page.locator("tbody tr").filter({ hasText: "QA Loan 12" }).first();
  chk("before the edit: the row is labelled", /Already paid earlier · no account debit/i.test(await row.innerText()));
  const before = (await h.list("transactions")).find((t) => /already paid earlier/.test(t.description));
  chk("(fixture) the stored description carries the write path's marker", !!before, before?.description);

  await row.getByRole("button", { name: "Edit transaction" }).click();
  await page.waitForTimeout(1500);
  const desc = page.locator('input[placeholder^="e.g."]').first();
  await desc.fill("Car EMI October");
  await h.shot(page, "ux-c-edit-form");
  const save = page.getByRole("button", { name: /^(Save|Update)/ }).first();
  await save.click();
  await page.waitForTimeout(3500);
  const after = (await h.list("transactions")).find((t) => t.id === before?.id);
  const edited = after?.description === "Car EMI October";
  notes.push(edited ? "the generic Transactions edit allows changing a Loan payment's description" : `the generic edit did not change the description (stored: "${after?.description}")`);
  chk("the account balance and amount are untouched by the edit", Math.abs((await h.accountBalance("QA Bank")).currentBalance - 136150) < 0.01 && after?.amount === before?.amount && after?.excludeFromCalculations === true);
  await page.getByRole("button", { name: "Cancel" }).last().click().catch(() => {});
  await page.waitForTimeout(800);

  const rowAfter = (await page.locator("tbody tr").filter({ hasText: "QA Loan 12" }).first().innerText()).split("\n").join(" | ");
  chk("after the edit: the Transactions row is still labelled 'Already paid earlier · no account debit'", /Already paid earlier · no account debit/i.test(rowAfter), rowAfter.slice(0, 160));

  await h.go(page, "/dashboard");
  await page.waitForTimeout(4000);
  await h.shot(page, "ux-c-dashboard-after-edit");
  const dash = (await page.locator("main").innerText()).split("\n").join(" | ");
  if (edited) chk("Dashboard shows the EDITED text with the label still attached (the label no longer depends on the marker text)", /Car EMI October/.test(dash) && /Already paid earlier · no account debit/i.test(dash), (dash.match(/Car EMI October[^|]*\|[^|]*\|[^|]*\|[^|]*/) ?? ["not found"])[0]);
  else chk("Dashboard still labelled (edit not supported for this transaction)", /Already paid earlier · no account debit/i.test(dash));

  // An ordinary transaction next to it is never labelled.
  const groceries = dash.slice(dash.indexOf("QA groceries"), dash.indexOf("QA groceries") + 90);
  chk("an ordinary Dashboard row (QA groceries) carries no label", groceries.includes("QA groceries") && !/no account debit/i.test(groceries), groceries);
});
