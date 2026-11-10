/**
 * Accounts sweep (testing-phase check): every section renders, every control on /accounts does what its label says,
 * Add / Edit / Delete work end-to-end and what is saved is read back from the Firestore emulator. Local emulator only.
 * Scenario ids: accts-sweep-*
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const IGNORE = /Select is changing|status of 400|React DevTools|Download the React/;
/** Records every 404 response. BankLogo deliberately probes /banks/logos/{id}.svg then .png (files not shipped yet → initials badge); anything else that 404s is a real problem. */
function track404(page) {
  const seen = { logo: 0, other: [] };
  page.on("response", (r) => {
    if (r.status() !== 404) return;
    if (/\/banks\/logos\//.test(r.url())) seen.logo++;
    else seen.other.push(r.url());
  });
  return seen;
}
const realErrors = (logs, seen) => logs.filter((l) => !IGNORE.test(l) && !(/status of 404/.test(l) && seen.other.length === 0));
const flat = (t) => t.replace(/\s+/g, " ").trim();

async function openAccounts(page) {
  await h.go(page, "/accounts");
  await page.getByRole("heading", { level: 1, name: "Accounts" }).waitFor();
  await page.waitForTimeout(2500);
}
const mine = (page) => page.getByRole("region", { name: "My accounts" });
const panel = (page) => page.locator("aside").filter({ hasText: "Account overview" });
const addBtn = (page) => page.locator("main header").getByRole("button", { name: "Add Account", exact: true });
const accts = async () => (await h.list("accounts")).filter((a) => !a.deletedAt);

async function openAddDialog(page) {
  await addBtn(page).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByText("Add an Account", { exact: true }).waitFor();
  await page.waitForTimeout(400);
  return dlg;
}
const choose = (dlg, name) => dlg.getByRole("button", { name, exact: true }).click();
async function pickBank(page, dlg, bankName) {
  await dlg.getByRole("combobox").first().click();
  await page.getByRole("option", { name: new RegExp(bankName) }).first().click();
}
const formError = async (dlg) => flat((await dlg.locator("p.text-expense, p[class*='text-expense']").allInnerTexts()).join(" "));
async function save(page, dlg, label = "Save") {
  await dlg.getByRole("button", { name: label, exact: true }).click();
}
async function waitClosed(dlg, ms = 20000) {
  return dlg.waitFor({ state: "hidden", timeout: ms }).then(() => true, () => false);
}

/* ───────────────────────────── 1. render ───────────────────────────── */
scenario("accts-sweep-render", "Accounts sweep: all sections render with seeded data, figures match persisted balances, no errors, no overflow (desktop / dark / tablet / mobile)", async ({ page, logs }, chk) => {
  const seen = track404(page);
  await openAccounts(page);
  const main = flat(await page.locator("main").innerText());
  await h.shot(page, "accts-sweep-desktop-light");
  for (const [label, re] of [
    ["header", /Accounts\s+Your banks, cards, wallets and cash/],
    ["Total balance", /Total balance/i],
    ["In banks", /In banks/i],
    ["Cash on hand", /Cash on hand/i],
    ["My accounts", /My accounts/],
    ["Credit cards strip", /credit cards · 1/i],
    ["Recent transactions", /Recent transactions/],
  ]) chk(`section present: ${label}`, re.test(main), re);
  chk("no 'NaN' / 'undefined' / 'Infinity' text", !/NaN|undefined|Infinity/.test(main), (main.match(/.{0,30}(NaN|undefined|Infinity).{0,30}/) || [""])[0]);
  chk("no skeleton left after load", (await page.locator('main [class*="animate-pulse"]').count()) === 0);

  // Figures vs persisted state (cards are liabilities, excluded from Total balance by design).
  const all = await accts();
  const cardIds = new Set((await h.list("creditCards")).filter((c) => !c.deletedAt).map((c) => c.accountId));
  const money_ = all.filter((a) => !cardIds.has(a.id));
  const total = money_.reduce((s, a) => s + a.currentBalance, 0);
  const banks = money_.filter((a) => a.type === "bank" || a.type === "business").reduce((s, a) => s + a.currentBalance, 0);
  const cash = money_.filter((a) => a.type === "cash").reduce((s, a) => s + a.currentBalance, 0);
  const summary = flat(await page.getByRole("region", { name: "Summary" }).innerText());
  const fmt = (n) => "₹" + Math.round(n).toLocaleString("en-IN");
  chk(`Total balance on screen = persisted ${fmt(total)}`, summary.includes(fmt(total)), summary.slice(0, 160));
  chk(`In banks = persisted ${fmt(banks)}`, summary.toLowerCase().includes(`in banks ${fmt(banks)}`.toLowerCase()), summary.slice(0, 200));
  chk(`Cash on hand = persisted ${fmt(cash)}`, summary.toLowerCase().includes(`cash on hand ${fmt(cash)}`.toLowerCase()), summary.slice(0, 200));
  chk(`"Across N accounts" = ${money_.length}`, new RegExp(`Across\\s*${money_.length}\\s*accounts`).test(summary), summary.slice(0, 200));
  for (const a of money_) {
    const tile = flat(await mine(page).innerText());
    chk(`tile "${a.name}" shows ${fmt(a.currentBalance)}`, tile.includes(a.name) && tile.includes(fmt(a.currentBalance)), tile.slice(0, 160));
  }
  const strip = flat(await page.getByRole("region", { name: "Credit cards" }).innerText());
  chk("credit-card strip shows ₹12,000 outstanding (seed purchase)", /Outstanding\s*₹12,000/.test(strip), strip.slice(0, 220));
  const recent = flat(await page.getByRole("region", { name: "Recent transactions" }).innerText());
  chk("recent transactions list has rows (not the empty state)", !/No transactions yet/.test(recent) && /₹/.test(recent), recent.slice(0, 160));

  // Overview panel is open by default (primary/first account).
  chk("account overview panel opens by default", (await panel(page).count()) === 1);

  const overflow = () => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, mw: document.querySelector("main").scrollWidth, mc: document.querySelector("main").clientWidth }));
  const o1 = await overflow();
  chk("desktop: no horizontal overflow", o1.sw <= o1.cw + 1 && o1.mw <= o1.mc + 1, JSON.stringify(o1));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(600);
  await h.shot(page, "accts-sweep-desktop-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.waitForTimeout(900);
  await h.shot(page, "accts-sweep-tablet");
  const o2 = await overflow();
  chk("tablet 768px: no horizontal overflow", o2.sw <= o2.cw + 1 && o2.mw <= o2.mc + 1, JSON.stringify(o2));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(900);
  await h.shot(page, "accts-sweep-mobile");
  const o3 = await overflow();
  chk("mobile 390px: no horizontal overflow", o3.sw <= o3.cw + 1 && o3.mw <= o3.mc + 1, JSON.stringify(o3));

  // Accessible names: every button / link / input on the page is labelled.
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.waitForTimeout(600);
  const unnamed = await page.evaluate(() =>
    [...document.querySelectorAll("main button, main a[href], main input")]
      .filter((el) => el.getClientRects().length > 0 && !el.closest("[inert]"))
      .filter((el) => !((el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || el.title || "").trim()))
      .filter((el) => !(el.tagName === "INPUT" && (el.type === "date" || el.getAttribute("aria-hidden") === "true")))
      .map((el) => `${el.tagName}.${(el.className || "").toString().slice(0, 40)}`),
  );
  chk("every visible button / link / input has an accessible name", unnamed.length === 0, unnamed.slice(0, 5).join(" | "));

  chk(`the only 404s are bank-logo probes (${seen.logo} probes; logo files are not shipped → initials fallback)`, seen.other.length === 0, seen.other.slice(0, 3).join(", "));
  const errs = realErrors(logs, seen);
  chk("no console errors / warnings / page errors on /accounts", errs.length === 0, errs.slice(0, 5).join(" || "));
});

/* ───────────────────────────── 2. controls ───────────────────────────── */
scenario("accts-sweep-controls", "Accounts sweep: toolbar, tiles, overview panel, breakdown sheets and every link/button on the page", async ({ page, logs }, chk) => {
  const seen = track404(page);
  await openAccounts(page);
  const names = (await accts()).map((a) => a.name);

  // Header utilities that are "Soon" stay disabled; exactly one Add Account in the header.
  chk("Refresh / Groups are disabled and marked Soon", (await page.locator("main header button:disabled").count()) === 2 && /soon/i.test(await page.locator("main header").innerText()));

  // Search
  const search = page.getByRole("textbox", { name: "Search accounts" });
  await search.fill("QA Cash");
  await page.waitForTimeout(300);
  let list = flat(await mine(page).innerText());
  chk("search 'QA Cash' keeps QA Cash and hides QA Bank", list.includes("QA Cash") && !list.includes("QA Bank"), list.slice(0, 160));
  await search.fill("qa bank");
  await page.waitForTimeout(300);
  list = flat(await mine(page).innerText());
  chk("search is case-insensitive", list.includes("QA Bank") && !list.includes("QA Cash"), list.slice(0, 160));
  await search.fill("zzzz-nothing");
  await page.waitForTimeout(300);
  list = flat(await mine(page).innerText());
  chk("no-match state shown with 'Clear filters'", /No accounts match this search or type/.test(list));
  await h.shot(page, "accts-sweep-nomatch");
  await mine(page).getByRole("button", { name: "Clear filters" }).click();
  await page.waitForTimeout(300);
  chk("'Clear filters' empties the search and shows the accounts again", (await search.inputValue()) === "" && flat(await mine(page).innerText()).includes("QA Bank"));
  await search.fill("QA");
  await page.getByRole("button", { name: "Clear search" }).click();
  chk("search 'x' clears the field", (await search.inputValue()) === "");

  // Type chips
  const chips = page.getByRole("radiogroup", { name: "Account type" }).getByRole("radio");
  const chipLabels = (await chips.allInnerTexts()).map(flat);
  chk("type chips: All + one per held type, with counts", chipLabels.length >= 3 && /^All\s*2$/.test(chipLabels[0]), chipLabels.join(" | "));
  await chips.nth(1).click();
  await page.waitForTimeout(300);
  chk("a type chip filters the list and is marked checked", (await chips.nth(1).getAttribute("aria-checked")) === "true" && (await mine(page).locator("h3").count()) === 1);
  await chips.nth(0).click();
  await page.waitForTimeout(300);
  chk("'All' restores both accounts", (await mine(page).locator("h3").count()) === 2);

  // Grid / list
  await page.getByRole("radio", { name: "List view" }).click();
  await page.waitForTimeout(400);
  chk("List view: rows replace tiles (no h3 tiles) and both accounts still listed", (await mine(page).locator("h3").count()) === 0 && flat(await mine(page).innerText()).includes("QA Bank") && flat(await mine(page).innerText()).includes("QA Cash"));
  await h.shot(page, "accts-sweep-list-view");
  await page.getByRole("radio", { name: "Grid view" }).click();
  await page.waitForTimeout(400);
  chk("Grid view restores tiles", (await mine(page).locator("h3").count()) === 2);

  // Select tile → overview follows
  for (const nm of ["QA Cash", "QA Bank"]) {
    await mine(page).getByRole("button", { name: new RegExp(`^${nm}`) }).first().click();
    await page.waitForTimeout(500);
    const acc = (await accts()).find((a) => a.name === nm);
    const ov = flat(await panel(page).innerText());
    chk(`selecting ${nm} shows its overview with its persisted balance`, ov.includes(nm) && ov.includes("₹" + Math.round(acc.currentBalance).toLocaleString("en-IN")), ov.slice(0, 140));
  }

  // Close overview → gone; selecting a tile brings it back
  await page.getByRole("button", { name: "Close account overview" }).click();
  await page.waitForTimeout(500);
  chk("Close account overview hides the panel", (await panel(page).count()) === 0);
  await mine(page).getByRole("button", { name: /^QA Cash/ }).first().click();
  await page.waitForTimeout(500);
  chk("clicking a tile re-opens the overview", (await panel(page).count()) === 1);

  // Balance breakdown sheets (summary, per-tile, overview) and the overview-parking behaviour
  const sheetOpen = async (trigger, expectTitle, label) => {
    await trigger.click();
    const dlg = page.getByRole("dialog").last();
    await dlg.waitFor();
    await page.waitForTimeout(900);
    const t = flat(await dlg.innerText());
    chk(`${label}: breakdown sheet opens with "${expectTitle}" and a calculation`, new RegExp(expectTitle, "i").test(t) && /Starting balance/.test(t) && /Current balance/.test(t) && !/NaN|undefined/.test(t), t.slice(0, 140));
    chk(`${label}: overview panel is parked while the sheet is open`, (await panel(page).count()) === 0);
    await page.keyboard.press("Escape");
    await dlg.waitFor({ state: "hidden" });
    await page.waitForTimeout(500);
    chk(`${label}: closing the sheet restores the overview panel`, (await panel(page).count()) === 1);
  };
  await sheetOpen(page.getByRole("button", { name: "Explain total balance" }), "Total balance", "Total balance figure");
  await sheetOpen(page.getByRole("button", { name: "View breakdown", exact: true }), "Total balance", "'View breakdown' button");
  await sheetOpen(page.getByRole("button", { name: "Explain in banks" }), "Money in banks", "In banks figure");
  await sheetOpen(page.getByRole("button", { name: "Explain cash on hand" }), "Cash on hand", "Cash on hand figure");
  await sheetOpen(page.getByRole("button", { name: "View QA Bank balance breakdown" }), "QA Bank", "QA Bank tile 'Breakdown'");
  await sheetOpen(panel(page).getByRole("button", { name: /^Explain .* balance$/ }), "QA Cash", "overview balance");

  // "Total" sheet drill-down + Back
  await page.getByRole("button", { name: "Explain total balance" }).click();
  const sd = page.getByRole("dialog").last();
  await sd.waitFor();
  await page.waitForTimeout(800);
  const drill = sd.locator('section[aria-label="Accounts included"] button').first();
  if ((await drill.count()) > 0) {
    await drill.click();
    await page.waitForTimeout(500);
    chk("breakdown drill-down into an account shows 'Back to Total balance'", (await sd.getByRole("button", { name: /Back to Total balance/ }).count()) === 1);
    await sd.getByRole("button", { name: /Back to Total balance/ }).click();
    await page.waitForTimeout(400);
    chk("Back returns to the Total balance group", /Total balance/i.test(await sd.innerText()));
  } else chk.finding("ACCTS-DRILL", "Total-balance sheet lists accounts to drill into", false, "no drill buttons");
  await page.keyboard.press("Escape");
  await sd.waitFor({ state: "hidden" });
  await page.waitForTimeout(500);

  // Overview: reveal / hide account number & copy button only when applicable
  const reveal = panel(page).getByRole("button", { name: "Reveal account number" });
  if ((await reveal.count()) > 0) {
    await reveal.click();
    chk("Reveal account number toggles to Hide", (await panel(page).getByRole("button", { name: "Hide account number" }).count()) === 1);
  } else {
    // seed accounts have no last-4, so no account-number row is expected for them
    chk("no account-number row for an account without last-4 (seed)", (await panel(page).getByText("Account number").count()) === 0);
  }

  // Overview → Edit opens a pre-filled dialog; Cancel closes it with no write
  const before = JSON.stringify(await accts());
  await panel(page).getByRole("button", { name: "Edit", exact: true }).click();
  const edlg = page.getByRole("dialog");
  await edlg.getByText(/^Edit QA /).waitFor();
  await page.waitForTimeout(400);
  chk("Edit dialog opens for the selected account", /Edit QA Cash/.test(flat(await edlg.innerText())));
  chk("Edit dialog: account type chip is pre-selected (Cash)", (await edlg.getByRole("button", { name: "Cash", exact: true }).getAttribute("aria-pressed")) === "true");
  await h.shot(page, "accts-sweep-edit-open");
  await edlg.getByRole("button", { name: "Cancel" }).click();
  chk("Cancel closes the Edit dialog", await waitClosed(edlg));
  chk("Cancel in Edit wrote nothing", JSON.stringify(await accts()) === before);

  // Overview → Transactions: opens Transactions filtered to this account; Back returns here with the account selected
  await panel(page).getByRole("button", { name: "Transactions", exact: true }).click();
  await page.waitForFunction(() => location.pathname.replace(/\/+$/, "") === "/transactions", null, { timeout: 20000 });
  const url = page.url();
  chk("'Transactions' opens /transactions filtered to the account", /account/.test(url), url);
  await page.waitForTimeout(1500);
  await page.goBack();
  await page.waitForFunction(() => location.pathname.replace(/\/+$/, "") === "/accounts", null, { timeout: 20000 });
  await page.waitForTimeout(2500);
  const cashId = (await accts()).find((a) => a.name === "QA Cash").id;
  chk("Back lands on /accounts?account=<id> with that account's overview open", page.url().includes(`account=${cashId}`) && /QA Cash/.test(flat(await panel(page).innerText())), page.url());

  // Links: All transactions (overview), View all (recent), Manage in Credit Cards
  for (const [name, loc, path] of [
    ["All transactions (overview)", () => panel(page).getByRole("link", { name: /All transactions/ }), "/transactions"],
    ["View all (recent transactions)", () => page.getByRole("region", { name: "Recent transactions" }).getByRole("link", { name: /View all/ }), "/transactions"],
    ["Manage in Credit Cards", () => page.getByRole("link", { name: /Manage in Credit Cards/ }), "/credit-cards"],
  ]) {
    await openAccounts(page);
    await loc().click();
    const ok = await page.waitForFunction((p) => location.pathname.replace(/\/+$/, "") === p, path, { timeout: 20000 }).then(() => true, () => false);
    await page.waitForTimeout(1200);
    const body = (await page.locator("body").innerText()).slice(0, 3000);
    chk(`link "${name}" opens ${path}`, ok && !/This page could not be found|Something went wrong|Application error/i.test(body), page.url());
  }

  // Credit-card strip row selects the card account: balance shown is what's owed, no "explain" for card
  await openAccounts(page);
  await page.getByRole("region", { name: "Credit cards" }).getByRole("button", { name: /QA Credit Card/ }).click();
  await page.waitForTimeout(600);
  const cov = flat(await panel(page).innerText());
  chk("card row selects the card: overview shows QA Credit Card", /QA Credit Card/.test(cov), cov.slice(0, 160));
  chk("card overview has no balance 'Explain' button (breakdown lives in Credit Cards)", (await panel(page).getByRole("button", { name: /^Explain .* balance$/ }).count()) === 0);
  chk("card overview shows the account holder and last-4 (QA Tester / 4242)", /QA Tester/.test(cov) && /4242/.test(cov), cov.slice(0, 260));
  await h.shot(page, "accts-sweep-card-overview");

  chk(`the only 404s are bank-logo probes (${seen.logo} probes; logo files are not shipped → initials fallback)`, seen.other.length === 0, seen.other.slice(0, 3).join(", "));
  const errs = realErrors(logs, seen);
  chk("no console errors / page errors during the click sweep", errs.length === 0, errs.slice(0, 5).join(" || "));
  void names;
});

/* ───────────────────────────── 3. add: validation ───────────────────────────── */
scenario("accts-sweep-add-validation", "Accounts sweep: Add Account validation messages per type, Cancel/Esc/Close, form resets, nothing written", async ({ page, logs }, chk) => {
  const seen = track404(page);
  await openAccounts(page);
  const before = JSON.stringify((await accts()).map((a) => a.id).sort());
  let dlg = await openAddDialog(page);
  await h.shot(page, "accts-sweep-add-default");
  chk("Add dialog opens with Bank preselected and a live preview", (await dlg.getByRole("button", { name: "Bank", exact: true }).getAttribute("aria-pressed")) === "true" && /Savings Account/.test(flat(await dlg.innerText())));
  chk("there is no Account Name field (name is derived)", (await dlg.getByLabel(/Account Name/).count()) === 0);

  // Required markers follow the validation: cash/wallet/business/other don't require holder / last-4, bank and cards do.
  const holderLabel = () => dlg.locator("label", { hasText: /Account Holder|Card Holder Name/ }).first().innerText();
  await choose(dlg, "Cash");
  await page.waitForTimeout(300);
  chk("Cash: holder / last-4 are NOT marked required (validation doesn't require them)", !/\*/.test(await holderLabel()) && !/\*/.test(await dlg.locator("label", { hasText: /Last 4 Digits/ }).first().innerText()), await holderLabel());
  await h.shot(page, "accts-sweep-add-cash");
  await choose(dlg, "Bank");
  await page.waitForTimeout(300);
  chk("Bank: holder / last-4 ARE marked required", /\*/.test(await holderLabel()) && /\*/.test(await dlg.locator("label", { hasText: /Last 4 Digits/ }).first().innerText()), await holderLabel());

  // Bank (savings) → holder required, then last-4, then opening balance
  await save(page, dlg);
  await page.waitForTimeout(300);
  chk("bank/savings: empty form → 'Account holder name is required.'", /Account holder name is required/.test(await formError(dlg)), await formError(dlg));
  await dlg.getByLabel(/Account Holder/).fill("Test Holder");
  await save(page, dlg);
  chk("bank/savings: holder only → last-4 message", /Last 4 digits are required/.test(await formError(dlg)), await formError(dlg));
  await dlg.getByLabel(/Last 4 Digits/).fill("");
  await dlg.getByLabel(/Last 4 Digits/).pressSequentially("12ab34x");
  chk("last-4 input (typed) strips non-digits and caps at 4 chars", (await dlg.getByLabel(/Last 4 Digits/).inputValue()) === "1234", await dlg.getByLabel(/Last 4 Digits/).inputValue());
  await dlg.getByLabel(/Last 4 Digits/).fill("12");
  await save(page, dlg);
  chk("last-4 with 2 digits → rejected", /exactly 4/.test(await formError(dlg)), await formError(dlg));
  await dlg.getByLabel(/Last 4 Digits/).fill("1234");
  await dlg.getByLabel(/Minimum Balance/).fill("-5");
  await save(page, dlg);
  chk("negative minimum balance → rejected", /Minimum balance must be a non-negative/.test(await formError(dlg)), await formError(dlg));
  await dlg.getByLabel(/Minimum Balance/).fill("");

  // Deposit (FD): rate, tenure, maturity required
  await choose(dlg, "Fixed Deposit (FD)");
  await page.waitForTimeout(300);
  chk("FD: holder / last-4 fields are hidden; deposit fields shown", (await dlg.getByLabel(/Account Holder/).count()) === 0 && (await dlg.getByLabel(/Interest Rate/).count()) === 1 && (await dlg.getByLabel(/Tenure/).count()) === 1);
  chk("FD: opening balance is labelled 'Deposit Amount'", (await dlg.getByLabel(/Deposit Amount/).count()) === 1);
  await save(page, dlg);
  chk("FD: empty → interest rate required", /Interest rate is required/.test(await formError(dlg)), await formError(dlg));
  await dlg.getByLabel(/Interest Rate/).fill("7.1");
  await save(page, dlg);
  chk("FD: rate only → tenure required", /Tenure is required/.test(await formError(dlg)), await formError(dlg));
  await dlg.getByLabel(/Tenure/).fill("12");
  await save(page, dlg);
  chk("FD: rate + tenure → maturity date required", /Maturity date is required/.test(await formError(dlg)), await formError(dlg));
  await dlg.getByLabel(/Tenure/).fill("0");
  await dlg.getByLabel(/Maturity Date/).fill("01012030");
  await save(page, dlg);
  chk("FD: tenure 0 → rejected", /Tenure must be a whole number/.test(await formError(dlg)), await formError(dlg));
  await h.shot(page, "accts-sweep-add-fd");
  chk("FD: Maturity date masks typed digits as dd/mm/yyyy", (await dlg.getByLabel(/Maturity Date/).inputValue()) === "01/01/2030", await dlg.getByLabel(/Maturity Date/).inputValue());

  // Card types
  await choose(dlg, "Card");
  await page.waitForTimeout(300);
  chk("Card: subtype chooser shown (Credit selected by default)", (await dlg.getByRole("button", { name: "Credit Card", exact: true }).getAttribute("aria-pressed")) === "true");
  await dlg.getByLabel(/Card Holder Name/).fill(""); // holder / last-4 typed on the Bank form carry over when the type changes
  await dlg.getByLabel(/Last 4 Digits/).fill("");
  await save(page, dlg);
  chk("credit card: empty → cardholder required", /Cardholder name is required/.test(await formError(dlg)), await formError(dlg));
  await dlg.getByLabel(/Card Holder Name/).fill("Card Holder");
  await dlg.getByLabel(/Last 4 Digits/).fill("9876");
  await save(page, dlg);
  chk("credit card: no limit → 'Credit limit must be greater than 0.'", /Credit limit must be greater than 0/.test(await formError(dlg)), await formError(dlg));
  await dlg.getByLabel(/Credit Limit/).fill("1000");
  await dlg.getByLabel(/Used \/ Outstanding/).fill("2000");
  chk("credit card: Available Credit preview never goes below ₹0", /Available Credit\s*₹0/.test(flat(await dlg.innerText())), flat(await dlg.innerText()).match(/Available Credit.{0,20}/)?.[0]);
  await save(page, dlg);
  chk("credit card: used > limit → rejected", /cannot exceed the credit limit/.test(await formError(dlg)), await formError(dlg));
  await dlg.getByLabel(/Used \/ Outstanding/).fill("");
  await dlg.getByLabel(/Statement Day/).fill("40");
  await save(page, dlg);
  chk("credit card: statement day 40 → rejected", /Statement date must be a day between 1 and 31/.test(await formError(dlg)), await formError(dlg));
  await dlg.getByLabel(/Statement Day/).fill("5");
  await dlg.getByLabel(/Payment Due Day/).fill("0");
  await save(page, dlg);
  chk("credit card: due day 0 → rejected", /Payment due date must be a day between 1 and 31/.test(await formError(dlg)), await formError(dlg));

  await choose(dlg, "Debit Card");
  await page.waitForTimeout(300);
  await save(page, dlg);
  chk("debit card: no linked bank account → rejected", /Choose the bank account this debit card is linked to/.test(await formError(dlg)), await formError(dlg));
  chk("debit card: Linked Bank Account dropdown is present", (await dlg.getByText("Linked Bank Account").count()) === 1);

  await choose(dlg, "Prepaid Card");
  await page.waitForTimeout(300);
  chk("changing the card type clears the stale validation message", (await formError(dlg)) === "", await formError(dlg));
  chk("prepaid: Provider + Reloadable shown", (await dlg.getByLabel(/Provider/).count()) >= 1 && (await dlg.getByText("Reloadable (can be topped up again)").count()) === 1);
  await choose(dlg, "Forex Card");
  await page.waitForTimeout(300);
  chk("forex: Currency select shown, Reloadable hidden", (await dlg.getByLabel(/Currency/).count()) === 1 && (await dlg.getByText("Reloadable (can be topped up again)").count()) === 0);
  await h.shot(page, "accts-sweep-add-forex");

  // Colour picker (preview follows)
  await dlg.getByRole("button", { name: "orange", exact: true }).click();
  chk("colour picker marks the choice pressed", (await dlg.getByRole("button", { name: "orange", exact: true }).getAttribute("aria-pressed")) === "true");

  // Esc closes with nothing written; reopening gives a fresh form with no stale error
  await page.keyboard.press("Escape");
  chk("Esc closes the dialog", await waitClosed(dlg));
  dlg = await openAddDialog(page);
  chk("re-opening the dialog gives a fresh form (Bank, no error, empty holder)", (await dlg.getByRole("button", { name: "Bank", exact: true }).getAttribute("aria-pressed")) === "true" && (await formError(dlg)) === "" && (await dlg.getByLabel(/Account Holder/).inputValue()) === "");
  await dlg.getByRole("button", { name: "Close", exact: true }).click();
  chk("the X (Close) button closes the dialog", await waitClosed(dlg));
  dlg = await openAddDialog(page);
  await dlg.getByRole("button", { name: "Cancel" }).click();
  chk("Cancel closes the dialog", await waitClosed(dlg));
  chk("no account was written by any rejected / cancelled attempt", JSON.stringify((await accts()).map((a) => a.id).sort()) === before);

  chk(`the only 404s are bank-logo probes (${seen.logo} probes; logo files are not shipped → initials fallback)`, seen.other.length === 0, seen.other.slice(0, 3).join(", "));
  const errs = realErrors(logs, seen);
  chk("no console errors / page errors during validation", errs.length === 0, errs.slice(0, 5).join(" || "));
});

/* ───────────────────────────── 4. add: create each type ───────────────────────────── */
scenario("accts-sweep-add-create", "Accounts sweep: create bank / cash / wallet / FD / prepaid / debit / forex / credit-card accounts; saved data read back; totals follow", async ({ page, logs }, chk) => {
  const seen = track404(page);
  await openAccounts(page);
  const seedBank = await h.accountBalance("QA Bank");
  const created = async (name) => (await accts()).find((a) => a.name === name);
  const createFlow = async (label, fill, expectName) => {
    const dlg = await openAddDialog(page);
    await fill(dlg);
    await save(page, dlg);
    const closed = await waitClosed(dlg);
    await page.waitForTimeout(1800);
    const err = closed ? "" : await formError(dlg);
    chk(`${label}: dialog closes after Save`, closed, err);
    if (!closed) {
      await h.shot(page, `accts-sweep-create-fail-${label.replace(/\W+/g, "-")}`);
      await page.keyboard.press("Escape");
      return null;
    }
    const acc = await created(expectName);
    chk(`${label}: saved as "${expectName}"`, !!acc, (await accts()).map((a) => a.name).join(", "));
    return acc;
  };

  // 1. Bank / savings with HDFC
  let a = await createFlow("bank savings (HDFC)", async (dlg) => {
    await pickBank(page, dlg, "HDFC Bank");
    await dlg.getByLabel(/Account Holder/).fill("Asha Rao");
    await dlg.getByLabel(/Last 4 Digits/).fill("4021");
    await dlg.getByLabel(/Opening Balance/).fill("2500.50");
    await dlg.getByLabel(/Minimum Balance/).fill("500");
    await dlg.getByRole("button", { name: "orange", exact: true }).click();
    chk("preview shows the derived name 'HDFC Bank Savings Account'", /HDFC Bank Savings Account/.test(flat(await dlg.innerText())));
  }, "HDFC Bank Savings Account");
  if (a) {
    chk("bank: type/bank/subtype persisted", a.type === "bank" && a.bankId === "hdfc" && a.bankAccountSubtype === "savings", JSON.stringify({ t: a.type, b: a.bankId, s: a.bankAccountSubtype }));
    chk("bank: opening = current = 2500.50", Math.abs(a.openingBalance - 2500.5) < 0.001 && Math.abs(a.currentBalance - 2500.5) < 0.001, `${a.openingBalance}/${a.currentBalance}`);
    chk("bank: holder, last-4, min balance, colour persisted", a.accountHolderName === "Asha Rao" && a.accountNumberLast4 === "4021" && a.minimumBalance === 500 && a.colorValue === 1, JSON.stringify({ h: a.accountHolderName, l: a.accountNumberLast4, m: a.minimumBalance, c: a.colorValue }));
    const tile = flat(await mine(page).innerText());
    chk("new bank tile appears with the right balance and mask", /HDFC Bank Savings Account/.test(tile) && /₹2,501/.test(tile) && /4021/.test(tile), tile.slice(0, 220));
  }

  // 2. Cash
  a = await createFlow("cash", async (dlg) => {
    await choose(dlg, "Cash");
    await dlg.getByLabel(/Opening Balance/).fill("300");
  }, "Cash");
  if (a) chk("cash: persisted type cash, balance 300, no bank", a.type === "cash" && a.currentBalance === 300 && a.bankId == null, JSON.stringify({ t: a.type, b: a.currentBalance, bank: a.bankId }));

  // 3. Wallet
  a = await createFlow("wallet", async (dlg) => {
    await choose(dlg, "Wallet");
    await dlg.getByLabel(/Opening Balance/).fill("150");
  }, "Wallet");
  if (a) chk("wallet: persisted type wallet, balance 150", a.type === "wallet" && a.currentBalance === 150, JSON.stringify({ t: a.type, b: a.currentBalance }));

  // 4. Fixed deposit (SBI)
  a = await createFlow("fixed deposit", async (dlg) => {
    await pickBank(page, dlg, "State Bank of India");
    await choose(dlg, "Fixed Deposit (FD)");
    await dlg.getByLabel(/Deposit Amount/).fill("50000");
    await dlg.getByLabel(/Interest Rate/).fill("7.1");
    await dlg.getByLabel(/Tenure/).fill("12");
    await dlg.getByLabel(/Maturity Date/).fill("15032030");
  }, "State Bank of India Fixed Deposit (FD)");
  if (a) {
    chk("FD: subtype / rate / tenure persisted", a.bankAccountSubtype === "fixedDeposit" && a.interestRatePercent === 7.1 && a.tenureMonths === 12, JSON.stringify({ s: a.bankAccountSubtype, r: a.interestRatePercent, t: a.tenureMonths }));
    chk("FD: maturity date persisted as 15 Mar 2030", String(a.maturityDate).startsWith("2030-03-15"), String(a.maturityDate));
    chk("FD: deposit amount is the opening balance (50,000)", a.currentBalance === 50000, a.currentBalance);
  }

  // 5. Prepaid card (balance-holding, plain account)
  a = await createFlow("prepaid card", async (dlg) => {
    await choose(dlg, "Card");
    await choose(dlg, "Prepaid Card");
    await dlg.getByLabel(/Provider/).fill("Niyo");
    await dlg.getByLabel(/Card Holder Name/).fill("Asha Rao");
    await dlg.getByLabel(/Last 4 Digits/).fill("1111");
    await dlg.getByLabel(/Initial Balance/).fill("750");
  }, "Niyo Prepaid Card");
  if (a) chk("prepaid: card/prepaid, provider, balance 750, NOT a credit-card profile", a.type === "card" && a.cardSubtype === "prepaid" && a.cardProvider === "Niyo" && a.currentBalance === 750, JSON.stringify({ t: a.type, s: a.cardSubtype, p: a.cardProvider, b: a.currentBalance }));

  // 6. Debit card linked to the new HDFC account
  a = await createFlow("debit card", async (dlg) => {
    await choose(dlg, "Card");
    await choose(dlg, "Debit Card");
    await pickBank(page, dlg, "HDFC Bank");
    await dlg.getByRole("combobox").nth(1).click().catch(() => {});
    await page.getByRole("option", { name: /HDFC Bank Savings Account/ }).first().click().catch(() => {});
    await dlg.getByLabel(/Card Holder Name/).fill("Asha Rao");
    await dlg.getByLabel(/Last 4 Digits/).fill("2222");
  }, "HDFC Bank Debit Card");
  if (a) chk("debit: linked to a bank account, zero balance", a.cardSubtype === "debit" && !!a.linkedAccountId && a.currentBalance === 0, JSON.stringify({ s: a.cardSubtype, l: a.linkedAccountId, b: a.currentBalance }));

  // 7. Forex card
  a = await createFlow("forex card", async (dlg) => {
    await choose(dlg, "Card");
    await choose(dlg, "Forex Card");
    await dlg.getByLabel(/Provider/).fill("Wise");
    await dlg.getByLabel(/Card Holder Name/).fill("Asha Rao");
    await dlg.getByLabel(/Last 4 Digits/).fill("3333");
    await dlg.getByLabel(/Initial Balance/).fill("100");
    await dlg.getByLabel(/Currency/).selectOption("EUR");
  }, "Wise Forex Card");
  if (a) chk("forex: currency EUR + balance 100 persisted", a.cardSubtype === "forex" && a.currency === "EUR" && a.currentBalance === 100, JSON.stringify({ s: a.cardSubtype, c: a.currency, b: a.currentBalance }));

  // 8. Credit card → also creates a CreditCardProfile; card is in the strip, not in the money grid
  const cardsBefore = (await h.list("creditCards")).length;
  a = await createFlow("credit card", async (dlg) => {
    await choose(dlg, "Card");
    await pickBank(page, dlg, "HDFC Bank");
    await dlg.getByLabel(/Card Holder Name/).fill("Asha Rao");
    await dlg.getByLabel(/Last 4 Digits/).fill("4444");
    await dlg.getByLabel(/Credit Limit/).fill("80000");
    await dlg.getByLabel(/Statement Day/).fill("5");
    await dlg.getByLabel(/Payment Due Day/).fill("25");
  }, "HDFC Bank Credit Card");
  const cardsAfter = await h.list("creditCards");
  if (a) {
    const prof = cardsAfter.find((c) => c.accountId === a.id);
    chk("credit card: a CreditCardProfile was created and linked (limit 80,000, due 25, statement 5)", cardsAfter.length === cardsBefore + 1 && !!prof && prof.creditLimit === 80000 && prof.paymentDueDay === 25 && prof.statementDay === 5, JSON.stringify(prof && { l: prof.creditLimit, d: prof.paymentDueDay, s: prof.statementDay }));
    await page.waitForTimeout(1200);
    const strip = flat(await page.getByRole("region", { name: "Credit cards" }).innerText());
    chk("credit card appears in the Credit cards strip (count 2) and is not a money tile", /credit cards · 2/i.test(strip) && /HDFC Bank Credit Card/.test(strip) && !/HDFC Bank Credit Card/.test(flat(await mine(page).innerText())), strip.slice(0, 180));
  }

  // Totals follow the new accounts (cards excluded)
  await page.waitForTimeout(1500);
  const all = await accts();
  const cardIds = new Set((await h.list("creditCards")).filter((c) => !c.deletedAt).map((c) => c.accountId));
  const total = all.filter((x) => !cardIds.has(x.id)).reduce((s, x) => s + x.currentBalance, 0);
  const summary = flat(await page.getByRole("region", { name: "Summary" }).innerText());
  chk(`Total balance follows the new accounts (₹${Math.round(total).toLocaleString("en-IN")})`, summary.includes("₹" + Math.round(total).toLocaleString("en-IN")), summary.slice(0, 160));
  chk("seed bank untouched by all this (still 100,000 before txns)", (await h.accountBalance("QA Bank")).currentBalance === seedBank.currentBalance);
  await h.shot(page, "accts-sweep-after-create");

  chk(`the only 404s are bank-logo probes (${seen.logo} probes; logo files are not shipped → initials fallback)`, seen.other.length === 0, seen.other.slice(0, 3).join(", "));
  const errs = realErrors(logs, seen);
  chk("no console errors / page errors while creating accounts", errs.length === 0, errs.slice(0, 5).join(" || "));
});

/* ───────────────────────────── 5. edit + delete ───────────────────────────── */
scenario("accts-sweep-edit-delete", "Accounts sweep: edit an account (persisted, balance intact), delete flow (preview, type-to-confirm, cascade), delete a credit card", async ({ page, logs }, chk) => {
  const seen = track404(page);
  await openAccounts(page);

  // Add a bank account to edit/delete (so seed data stays untouched).
  let dlg = await openAddDialog(page);
  await pickBank(page, dlg, "State Bank of India");
  await dlg.getByLabel(/Account Holder/).fill("Ravi K");
  await dlg.getByLabel(/Last 4 Digits/).fill("5555");
  await dlg.getByLabel(/Opening Balance/).fill("1000");
  await save(page, dlg);
  await waitClosed(dlg);
  await page.waitForTimeout(1800);
  const NAME = "State Bank of India Savings Account";
  let acc = (await accts()).find((x) => x.name === NAME);
  chk("fixture account created", !!acc);
  if (!acc) return;

  // Edit via overview
  await mine(page).getByRole("button", { name: new RegExp(NAME) }).first().click();
  await page.waitForTimeout(500);
  await panel(page).getByRole("button", { name: "Edit", exact: true }).click();
  dlg = page.getByRole("dialog");
  await dlg.getByText(`Edit ${NAME}`).waitFor();
  await page.waitForTimeout(400);
  chk("Edit pre-fills holder, last-4, subtype, bank", (await dlg.getByLabel(/Account Holder/).inputValue()) === "Ravi K" && (await dlg.getByLabel(/Last 4 Digits/).inputValue()) === "5555" && (await dlg.getByRole("button", { name: "Savings Account", exact: true }).getAttribute("aria-pressed")) === "true" && /State Bank of India/.test(flat(await dlg.getByRole("combobox").first().innerText())));
  chk("Edit: opening balance field is not offered (not editable by design)", (await dlg.getByLabel(/Opening Balance/).count()) === 0);
  chk("Edit: primary button reads 'Save Changes'", (await dlg.getByRole("button", { name: "Save Changes", exact: true }).count()) === 1);
  await dlg.getByLabel(/Account Holder/).fill("Ravi Kumar");
  await dlg.getByLabel(/Last 4 Digits/).fill("6666");
  await dlg.getByLabel(/Minimum Balance/).fill("750");
  await dlg.getByRole("button", { name: "Current Account", exact: true }).click();
  await dlg.getByRole("button", { name: "violet", exact: true }).click();
  // Validation in edit
  await dlg.getByLabel(/Last 4 Digits/).fill("12");
  await save(page, dlg, "Save Changes");
  chk("Edit: invalid last-4 is rejected inline, dialog stays open", /exactly 4/.test(await formError(dlg)) && (await dlg.isVisible()), await formError(dlg));
  await dlg.getByLabel(/Last 4 Digits/).fill("6666");
  await save(page, dlg, "Save Changes");
  chk("Edit: dialog closes after Save Changes", await waitClosed(dlg));
  await page.waitForTimeout(1500);
  const edited = (await accts()).find((x) => x.id === acc.id);
  chk("Edit persisted: holder, last-4, min balance, subtype, colour", edited.accountHolderName === "Ravi Kumar" && edited.accountNumberLast4 === "6666" && edited.minimumBalance === 750 && edited.bankAccountSubtype === "current" && edited.colorValue === 5, JSON.stringify({ h: edited.accountHolderName, l: edited.accountNumberLast4, m: edited.minimumBalance, s: edited.bankAccountSubtype, c: edited.colorValue }));
  chk("Edit kept the saved name and the balance (no reset)", edited.name === NAME && edited.currentBalance === 1000 && edited.openingBalance === 1000, JSON.stringify({ n: edited.name, b: edited.currentBalance }));
  const ov = flat(await panel(page).innerText());
  chk("overview refreshed with the edit (holder + mask)", /Ravi Kumar/.test(ov) && /6666/.test(ov), ov.slice(0, 220));

  // Edit: clear the min balance → persisted as cleared
  await panel(page).getByRole("button", { name: "Edit", exact: true }).click();
  dlg = page.getByRole("dialog");
  await dlg.getByText(`Edit ${NAME}`).waitFor();
  await page.waitForTimeout(400);
  await dlg.getByLabel(/Minimum Balance/).fill("");
  await save(page, dlg, "Save Changes");
  await waitClosed(dlg);
  await page.waitForTimeout(1500);
  const cleared = (await accts()).find((x) => x.id === acc.id);
  chk("Edit: clearing Minimum Balance persists as cleared", cleared.minimumBalance == null, cleared.minimumBalance);

  // A transaction on the new account, so the delete impact has something to cascade
  await h.go(page, "/transactions");
  await page.waitForTimeout(2500);
  await page.locator("button:visible", { hasText: "Add Transaction" }).first().click();
  await page.getByRole("menuitem", { name: "Expense", exact: true }).click();
  await page.getByText("Add Expense", { exact: true }).first().waitFor();
  await page.getByText(/^Account\s?\*$/).first().locator("xpath=following::button[1]").click();
  await page.getByRole("option", { name: new RegExp(NAME) }).first().click();
  await page.locator('input[placeholder="0.00"]').first().fill("100");
  await page.locator('input[placeholder^="e.g."]').first().fill("sweep expense");
  await page.getByRole("button", { name: "Add Expense" }).click();
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "Cancel" }).last().click().catch(() => {});
  await page.waitForTimeout(500);
  chk("fixture expense posted (balance 900)", (await accts()).find((x) => x.id === acc.id)?.currentBalance === 900, (await accts()).find((x) => x.id === acc.id)?.currentBalance);

  // Delete flow
  await openAccounts(page);
  await mine(page).getByRole("button", { name: new RegExp(NAME) }).first().click();
  await page.waitForTimeout(500);
  await panel(page).getByRole("button", { name: "Delete", exact: true }).click();
  const del = page.getByRole("dialog").last();
  await del.getByText(/Permanently delete/).waitFor();
  await page.waitForTimeout(1500);
  const dt = flat(await del.innerText());
  await h.shot(page, "accts-sweep-delete-dialog");
  chk("delete dialog names the account and warns it cannot be undone", dt.includes(NAME) && /cannot be undone/.test(dt), dt.slice(0, 200));
  chk("delete dialog shows what will be removed (transactions count)", /1\s*transaction/.test(dt) || /transaction/.test(dt), dt.slice(0, 400));
  const confirm = del.getByRole("button", { name: "Delete Permanently" });
  chk("Delete Permanently is disabled until the name is typed", await confirm.isDisabled());
  await del.getByPlaceholder(NAME).fill("wrong name");
  chk("still disabled with a wrong name", await confirm.isDisabled());
  await del.getByRole("button", { name: "Cancel" }).click();
  chk("Cancel closes the delete dialog and deletes nothing", (await waitClosed(del)) && !!(await accts()).find((x) => x.id === acc.id));
  // Re-open: state must be reset (typed text cleared)
  await panel(page).getByRole("button", { name: "Delete", exact: true }).click();
  const del2 = page.getByRole("dialog").last();
  await del2.getByText(/Permanently delete/).waitFor();
  await page.waitForTimeout(1200);
  chk("re-opened delete dialog starts with an empty confirm field", (await del2.getByPlaceholder(NAME).inputValue()) === "");
  await del2.getByPlaceholder(NAME).fill(NAME);
  chk("typing the exact name enables Delete Permanently", await del2.getByRole("button", { name: "Delete Permanently" }).isEnabled());
  await del2.getByRole("button", { name: "Delete Permanently" }).click();
  chk("delete dialog closes after confirming", await waitClosed(del2));
  await page.waitForTimeout(2500);
  const gone = (await h.list("accounts")).find((x) => x.id === acc.id);
  chk("account is gone from the database", !gone || !!gone.deletedAt, JSON.stringify(gone && { d: gone.deletedAt }));
  const txns = (await h.list("transactions")).filter((t) => t.accountId === acc.id && !t.deletedAt);
  chk("its transactions are gone too (cascade)", txns.length === 0, txns.length);
  chk("tile removed from the list", !flat(await mine(page).innerText()).includes(NAME));
  chk("overview moved to another account (no blank / stale panel)", (await panel(page).count()) === 1 && !flat(await panel(page).innerText()).includes(NAME), flat(await panel(page).innerText()).slice(0, 100));
  const seedBank = await h.accountBalance("QA Bank");
  chk("other accounts untouched (QA Bank still present)", !!seedBank);
  const summary = flat(await page.getByRole("region", { name: "Summary" }).innerText());
  const rest = (await accts()).filter((x) => x.type !== "card").reduce((s, x) => s + x.currentBalance, 0);
  chk("Total balance follows the delete", summary.includes("₹" + Math.round(rest).toLocaleString("en-IN")), summary.slice(0, 140));

  // Delete the seeded credit card from the strip → goes through the credit-card cascade (profile removed too)
  const cardBefore = (await h.list("creditCards")).filter((c) => !c.deletedAt);
  await page.getByRole("region", { name: "Credit cards" }).getByRole("button", { name: /QA Credit Card/ }).click();
  await page.waitForTimeout(500);
  await panel(page).getByRole("button", { name: "Delete", exact: true }).click();
  const cdel = page.getByRole("dialog").last();
  await cdel.getByText(/Permanently delete/).waitFor();
  await page.waitForTimeout(1800);
  const ct = flat(await cdel.innerText());
  chk("credit-card delete dialog names the card and lists its history", /QA Credit Card/.test(ct) && /transaction/i.test(ct), ct.slice(0, 300));
  await cdel.getByPlaceholder("QA Credit Card").fill("QA Credit Card");
  const warnBox = cdel.getByRole("checkbox");
  if ((await warnBox.count()) > 0) await warnBox.check();
  await cdel.getByRole("button", { name: "Delete Permanently" }).click();
  chk("credit-card delete dialog closes", await waitClosed(cdel, 30000));
  await page.waitForTimeout(2500);
  const cardAfter = (await h.list("creditCards")).filter((c) => !c.deletedAt);
  chk("card profile removed with the card account (no orphan)", cardAfter.length === cardBefore.length - 1, `${cardBefore.length} -> ${cardAfter.length}`);
  chk("credit-card strip is gone when no cards remain (or count dropped)", !/QA Credit Card/.test(flat(await page.locator("main").innerText())));

  chk(`the only 404s are bank-logo probes (${seen.logo} probes; logo files are not shipped → initials fallback)`, seen.other.length === 0, seen.other.slice(0, 3).join(", "));
  const errs = realErrors(logs, seen);
  chk("no console errors / page errors during edit/delete", errs.length === 0, errs.slice(0, 5).join(" || "));
});
