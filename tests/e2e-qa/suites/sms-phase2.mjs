/**
 * SMS candidates — Phase 2 behaviour in a real browser: keyboard-only drawer navigation, the unsaved-edits guard, "Import & next",
 * inline validation, account-match evidence and last-4 suggestions, category suggestions, the duplicate comparison, and the
 * bulk-import restriction for candidates without a reliable account.
 * Local emulator only (see tests/e2e-qa/README.md): synthetic candidates are written to the Firestore EMULATOR.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
import { BASE_URL, FIRESTORE_DOCS } from "../lib/env.mjs";

const OWNER = { Authorization: "Bearer owner", "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400000;
const s = (v) => ({ stringValue: v });
const n = (v) => ({ doubleValue: v });
const nul = { nullValue: null };

async function putCandidate(uid, { id, amount, merchant, accountId, daysAgo, direction = "debit", rawLastFour = null, confidenceLevel = "high", needsReview = false, reasons = [] }) {
  const fields = {
    amount: n(amount),
    direction: s(direction),
    eventType: s("upiPayment"),
    transactionDate: { timestampValue: new Date(Date.now() - daysAgo * DAY).toISOString() },
    merchant: merchant ? s(merchant) : nul,
    bankName: s("QA Bank"),
    rawLastFour: rawLastFour ? s(rawLastFour) : nul,
    accountId: accountId ? s(accountId) : nul,
    cardId: nul,
    referenceNumber: nul,
    confidenceLevel: s(confidenceLevel),
    confidenceScore: n(confidenceLevel === "high" ? 0.9 : 0.4),
    needsReview: { booleanValue: needsReview },
    needsReviewReasons: { arrayValue: { values: reasons.map((r) => s(r)) } },
    source: s("sms"),
    createdAt: { timestampValue: new Date().toISOString() },
    deletedAt: nul,
  };
  const r = await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsTransactionCandidates/${id}`, { method: "PATCH", headers: OWNER, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`seed ${id}: ${r.status} ${await r.text()}`);
}

const rowsLocator = (page) => page.getByTestId("candidate-row");
const rowOf = (page, text) => rowsLocator(page).filter({ hasText: text }).first();
const reviewButton = (page, text) => rowOf(page, text).getByRole("button", { name: /^Review/ });
const openRow = (page, text) => reviewButton(page, text).click();
async function pickFirstOption(page, trigger) {
  await trigger.click();
  await page.getByRole("option").first().click();
}
async function openList(page) {
  await page.goto(`${BASE_URL}/transaction-candidates`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Transaction Inbox" }).waitFor({ timeout: 60000 });
}
async function openDrawerFor(page, text) {
  await openRow(page, text);
  const d = page.getByRole("dialog").first();
  await d.getByText("Transaction Details").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(500);
  return d;
}
async function closeDrawer(page, d) {
  await d.getByLabel("Close", { exact: true }).click();
  // Closing with edits asks first — discard them (nothing is ever imported by closing).
  const discard = page.getByRole("dialog").filter({ hasText: "Discard your changes?" });
  if (await discard.isVisible().catch(() => false)) await discard.getByRole("button", { name: "Discard and close" }).click();
  await d.waitFor({ state: "detached", timeout: 10000 });
  await page.waitForTimeout(300);
}

scenario("sms-10-drawer-keyboard-navigation", "Keyboard-only drawer: focus trap, J/K, unsaved-edits guard, layered Escape, focus return, Import & next, inline errors", async ({ page }, chk) => {
  const uid = await h.authUid();
  const bank = (await h.accountBalance("QA Bank")).id;
  await putCandidate(uid, { id: "sms-nav-0001", amount: 101, merchant: "Swiggy", accountId: bank, daysAgo: 1 });
  await putCandidate(uid, { id: "sms-nav-0002", amount: 102, merchant: "Zomato", accountId: bank, daysAgo: 2 });
  await putCandidate(uid, { id: "sms-nav-0003", amount: 103, merchant: "Uber", accountId: bank, daysAgo: 3 });
  await openList(page);
  await page.getByText("Swiggy").first().waitFor({ timeout: 40000 });
  const txnsBefore = (await h.list("transactions")).length;
  const balBefore = (await h.accountBalance("QA Bank")).currentBalance;

  // Open with the keyboard: focus the row's own Review button and press Enter.
  await reviewButton(page, "Swiggy").focus();
  await page.keyboard.press("Enter");
  let d = page.getByRole("dialog").first();
  await d.getByText("Transaction Details").first().waitFor({ timeout: 20000 });
  const pos = async () => (await d.getByTestId("candidate-position").innerText()).trim();
  chk("the drawer shows the current position, 1 of 3", /^1 of 3$/.test(await pos()), await pos());

  let escaped = false;
  for (let i = 0; i < 45; i++) {
    await page.keyboard.press("Tab");
    if (!(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')))) {
      escaped = true;
      break;
    }
  }
  chk("Tab never leaves the open drawer (focus trap)", !escaped);

  // J / K move between candidates and never write anything.
  await d.getByRole("button", { name: "Next candidate" }).focus();
  await page.keyboard.press("j");
  chk("J moves to the next candidate (2 of 3)", /^2 of 3$/.test(await pos()), await pos());
  await page.keyboard.press("k");
  chk("K moves back (1 of 3)", /^1 of 3$/.test(await pos()), await pos());
  chk("navigating with the keyboard imported nothing", (await h.list("transactions")).length === txnsBefore);
  // Typing J/K into a field is typing, not navigation. (Notes is folded by default — open it first.)
  await d.getByRole("button", { name: /^Notes/ }).click();
  await d.getByRole("textbox").first().focus();
  await page.keyboard.type("jk");
  chk("typing 'jk' in Notes does not navigate", /^1 of 3$/.test(await pos()));

  // Unsaved edits are never discarded silently.
  await pickFirstOption(page, d.getByRole("combobox").nth(0));
  await d.getByRole("button", { name: "Next candidate" }).click();
  const confirm = page.getByRole("dialog").filter({ hasText: "Discard your changes?" });
  await confirm.waitFor({ timeout: 10000 });
  chk("moving with unsaved edits asks first", true);
  await h.shot(page, "sms-10-discard-prompt");
  await page.keyboard.press("Escape");
  await confirm.waitFor({ state: "detached", timeout: 10000 });
  chk("Escape closes ONLY the top layer (the prompt) — the drawer stays open on the same candidate", (await d.isVisible()) && /^1 of 3$/.test(await pos()));
  chk("…and the edits are still there", !/Select a category/.test(await d.getByRole("combobox").nth(0).innerText()));
  await d.getByRole("button", { name: "Next candidate" }).click();
  await confirm.getByRole("button", { name: "Keep editing" }).click();
  chk("'Keep editing' stays put with the edits intact", /^1 of 3$/.test(await pos()) && !/Select a category/.test(await d.getByRole("combobox").nth(0).innerText()));
  await d.getByRole("button", { name: "Next candidate" }).focus();
  await page.keyboard.press("j");
  await confirm.getByRole("button", { name: "Discard and continue" }).click();
  await page.waitForTimeout(400);
  chk("'Discard and continue' moves on (2 of 3) with a clean form", /^2 of 3$/.test(await pos()) && /Select a category/.test(await d.getByRole("combobox").nth(0).innerText()), (await pos()) + " | " + (await d.getByRole("combobox").nth(0).innerText()));
  chk("nothing was imported by any of that", (await h.list("transactions")).length === txnsBefore);

  // Escape closes the drawer; focus returns to the Review button that opened it.
  await page.keyboard.press("Escape");
  await d.waitFor({ state: "detached", timeout: 10000 });
  await page.waitForTimeout(400);
  const focusedReview = await page.evaluate(() => document.activeElement?.getAttribute("data-review-id") ?? null);
  chk("focus returns to the Review button that opened the drawer", focusedReview === "sms-nav-0001", String(focusedReview));

  // Inline validation: an incomplete form writes nothing, shows the error beside the field and focuses it.
  d = await openDrawerFor(page, "Uber");
  await d.getByRole("button", { name: /Import as Transaction/ }).click({ force: true });
  await d.getByText("Choose a category to import this transaction.").waitFor({ timeout: 10000 });
  chk("an incomplete import shows the error right beside the Category field", true);
  chk("focus moved to the Category control", (await page.evaluate(() => document.activeElement?.getAttribute("role"))) === "combobox");
  chk("…and nothing was written", (await h.list("transactions")).length === txnsBefore);
  await h.shot(page, "sms-10-inline-error");
  await closeDrawer(page, d);

  // Import & next: only after a successful import does it move on.
  d = await openDrawerFor(page, "Zomato");
  chk("Zomato is 2 of 3", /^2 of 3$/.test(await pos()), await pos());
  await d.getByRole("button", { name: "Import & next" }).click({ force: true });
  await d.getByText("Choose a category to import this transaction.").waitFor({ timeout: 10000 });
  chk("'Import & next' with an invalid form does NOT move on or import", /^2 of 3$/.test(await pos()) && (await h.list("transactions")).length === txnsBefore);
  await pickFirstOption(page, d.getByRole("combobox").nth(0));
  await d.getByRole("button", { name: "Import & next" }).click();
  await page.getByText("Imported", { exact: true }).first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  chk("after the successful import the drawer is on the next candidate (Uber, 2 of 2)", /^2 of 2$/.test(await pos()) && (await d.getByText("Uber").count()) > 0, await pos());
  const imported = (await h.list("transactions")).filter((t) => t.source === "sms");
  chk("exactly one SMS transaction was created, for Zomato", imported.length === 1 && imported[0].description === "Zomato", imported.map((t) => t.description).join(","));
  chk("QA Bank was debited exactly ₹102", Math.abs(balBefore - (await h.accountBalance("QA Bank")).currentBalance - 102) < 0.01);
  const stillThere = await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsTransactionCandidates/sms-nav-0001`, { headers: OWNER });
  chk("Swiggy (not touched) is still in the queue", stillThere.ok);
  await h.shot(page, "sms-10-import-and-next");
});

scenario("sms-11-account-evidence-suggestions-duplicate", "Account evidence and last-4 suggestions (never auto-selected), category suggestions (never auto-applied), duplicate comparison without ids", async ({ page }, chk) => {
  const uid = await h.authUid();
  const bank = (await h.accountBalance("QA Bank")).id;
  await putCandidate(uid, { id: "sms-ev-last4-01", amount: 233, merchant: "Uber", accountId: null, rawLastFour: "4242", daysAgo: 1, confidenceLevel: "low", needsReview: true, reasons: ["No matching account or card found for this message."] });
  await putCandidate(uid, { id: "sms-ev-nomatch01", amount: 234, merchant: "Ola", accountId: null, rawLastFour: "0000", daysAgo: 2, confidenceLevel: "low", needsReview: true });
  await putCandidate(uid, { id: "sms-ev-nolast001", amount: 235, merchant: "Rapido", accountId: null, rawLastFour: null, daysAgo: 3, confidenceLevel: "low", needsReview: true });
  await putCandidate(uid, { id: "sms-ev-matched01", amount: 236, merchant: "Swiggy", accountId: bank, daysAgo: 4 });
  await putCandidate(uid, { id: "sms-ev-dup000001", amount: 850, merchant: "QA groceries", accountId: bank, daysAgo: 2 });
  await openList(page);
  await page.getByText("Uber").first().waitFor({ timeout: 40000 });
  const txnsBefore = (await h.list("transactions")).length;

  // 1. A last-4 that matches a saved card: suggested, not selected.
  let d = await openDrawerFor(page, "Uber");
  const ev = d.getByTestId("account-match-evidence");
  chk("nothing is selected for the reviewer: the account field shows its placeholder", /Select an account or card/.test(await d.getByRole("combobox").nth(1).innerText()));
  const sug = d.getByTestId("last-four-suggestions");
  chk("the card ending 4242 is offered as a suggestion", (await sug.count()) === 1 && /QA Credit Card/.test(await sug.innerText()) && /4242/.test(await sug.innerText()), await sug.innerText().catch(() => "none"));
  chk("the suggestion is labelled 'suggestions only; nothing is selected for you'", /nothing is selected for you/.test(await sug.innerText()));
  chk("Import stays blocked until the reviewer picks (category + account missing)", (await d.getByRole("button", { name: /Import as Transaction/ }).getAttribute("aria-disabled")) === "true");
  await h.shot(page, "sms-11-last4-suggestion");
  await d.getByRole("button", { name: /^Use QA Credit Card/ }).click();
  chk("only a click applies it", /QA Credit Card/.test(await d.getByRole("combobox").nth(1).innerText()));
  chk("the evidence now says the SMS last-4 equals the account's", /equals this account/.test(await ev.innerText()), await ev.innerText());
  await closeDrawer(page, d);

  // 2. A last-4 nothing matches.
  d = await openDrawerFor(page, "Ola");
  chk("no account ends in 0000: says so and offers nothing", /No saved account or card ends in/.test(await d.getByTestId("account-match-evidence").innerText()) && (await d.getByTestId("last-four-suggestions").count()) === 0);
  await closeDrawer(page, d);

  // 3. No last-4 at all: a bank name alone must never produce a suggestion (the bank is literally called "QA Bank").
  d = await openDrawerFor(page, "Rapido");
  const evText = await d.getByTestId("account-match-evidence").innerText();
  chk("with no last-4 it says a bank name alone isn't enough", /bank name alone/.test(evText), evText);
  chk("…and suggests no account", (await d.getByTestId("last-four-suggestions").count()) === 0);
  chk("…and selects none", /Select an account or card/.test(await d.getByRole("combobox").nth(1).innerText()));
  await closeDrawer(page, d);

  // 4. A matched candidate.
  d = await openDrawerFor(page, "Swiggy");
  chk("a matched candidate states Android's match", /Android matched this to QA Bank/.test(await d.getByTestId("account-match-evidence").innerText()));
  chk("the status explanation is shown", (await d.getByTestId("status-explanation").count()) === 1);
  await closeDrawer(page, d);

  // 5. Duplicate comparison.
  const listRowText = await rowOf(page, "QA groceries").innerText();
  chk("the list row's duplicate reason shows no internal id", !/txn_|[0-9a-f]{8}-[0-9a-f]{4}/i.test(listRowText), listRowText.replace(/\s+/g, " ").slice(0, 160));
  d = await openDrawerFor(page, "QA groceries");
  const cmp = d.getByTestId("duplicate-comparison");
  await cmp.waitFor({ timeout: 10000 });
  const cmpText = await cmp.innerText();
  chk("the comparison lists amount, date, merchant, account and direction", ["Amount", "Date", "Merchant", "Account / card", "Direction"].every((f) => cmpText.includes(f)), cmpText.replace(/\s+/g, " ").slice(0, 200));
  chk("it marks what matches in text (Same)", /Same/.test(cmpText));
  chk("it shows both records' values (₹850.00 twice)", (cmpText.match(/₹850\.00/g) ?? []).length >= 2);
  chk("it shows NO internal transaction id", !/txn_|[0-9a-f]{8}-[0-9a-f]{4}|[A-Za-z0-9]{20,}/.test(cmpText));
  chk("it says nothing was imported, merged or dismissed", /Nothing has been imported, merged or dismissed/.test(cmpText));
  await h.shot(page, "sms-11-duplicate-comparison");
  chk("viewing a duplicate wrote nothing and kept the candidate", (await h.list("transactions")).length === txnsBefore && (await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsTransactionCandidates/sms-ev-dup000001`, { headers: OWNER })).ok);
  await closeDrawer(page, d);

  // 6. Category suggestions come from the user's own earlier imports of the same merchant, and are never applied automatically.
  await putCandidate(uid, { id: "sms-cat-000001", amount: 61, merchant: "Chaayos", accountId: bank, daysAgo: 5 });
  await putCandidate(uid, { id: "sms-cat-000002", amount: 62, merchant: "Chaayos", accountId: bank, daysAgo: 6 });
  await page.getByText("Chaayos").first().waitFor({ timeout: 20000 });
  for (const [amountText, label] of [["₹61", "first"], ["₹62", "second"]]) {
    await rowsLocator(page).filter({ hasText: "Chaayos" }).filter({ hasText: amountText }).first().getByRole("button", { name: /^Review/ }).click();
    const dd = page.getByRole("dialog").first();
    await dd.getByText("Transaction Details").first().waitFor({ timeout: 20000 });
    await dd.getByRole("combobox").nth(0).click();
    await page.getByRole("option", { name: "Food" }).click();
    await dd.getByRole("button", { name: /Import as Transaction/ }).click();
    await dd.waitFor({ state: "detached", timeout: 30000 });
    chk(`the ${label} Chaayos import completed`, true);
  }
  await putCandidate(uid, { id: "sms-cat-000003", amount: 63, merchant: "Chaayos", accountId: bank, daysAgo: 7 });
  await page.getByText("Chaayos").first().waitFor({ timeout: 20000 });
  d = await openDrawerFor(page, "Chaayos");
  const cs = d.getByTestId("category-suggestions");
  await cs.waitFor({ timeout: 10000 });
  chk("the earlier choice is suggested with how often it was used", /Food/.test(await cs.innerText()) && /used 2 of 2 earlier/.test(await cs.innerText()), await cs.innerText());
  chk("it is NOT applied automatically: the Category field still shows its placeholder", /Select a category/.test(await d.getByRole("combobox").nth(0).innerText()));
  await h.shot(page, "sms-11-category-suggestion");
  await cs.getByRole("button", { name: /Food/ }).click();
  chk("clicking the suggestion applies it", /Food/.test(await d.getByRole("combobox").nth(0).innerText()));
});

scenario("sms-12-bulk-needs-reliable-account", "Bulk: candidates without a reliable account cannot be selected or imported in bulk; individual review still works", async ({ page }, chk) => {
  const uid = await h.authUid();
  const bank = (await h.accountBalance("QA Bank")).id;
  // Newest first, so the FIRST visible row is an unresolved one (select-all must still pick only the safe rows).
  await putCandidate(uid, { id: "sms-blk2-nolast01", amount: 311, merchant: "Rapido", accountId: null, rawLastFour: null, daysAgo: 0, confidenceLevel: "low", needsReview: true });
  await putCandidate(uid, { id: "sms-blk2-last4001", amount: 312, merchant: "Ola", accountId: null, rawLastFour: "7743", daysAgo: 1, confidenceLevel: "low", needsReview: true });
  await putCandidate(uid, { id: "sms-blk2-deleted01", amount: 313, merchant: "Meru", accountId: "deleted-account-0001", daysAgo: 2 });
  await putCandidate(uid, { id: "sms-blk2-matched01", amount: 314, merchant: "Swiggy", accountId: bank, daysAgo: 3 });
  await putCandidate(uid, { id: "sms-blk2-matched02", amount: 315, merchant: "Zomato", accountId: bank, daysAgo: 4 });
  await openList(page);
  await page.getByText("Swiggy").first().waitFor({ timeout: 40000 });
  await page.waitForTimeout(600);
  const txnsBefore = (await h.list("transactions")).length;

  for (const merchant of ["Rapido", "Ola", "Meru"]) {
    const box = page.getByRole("checkbox", { name: new RegExp(`^Select ${merchant}`) });
    chk(`${merchant} (no reliable account) cannot be selected`, await box.isDisabled());
    chk(`${merchant}'s row says it needs individual review`, /Review individually/.test(await rowOf(page, merchant).innerText()));
  }
  chk("the matched rows can be selected", (await page.getByRole("checkbox", { name: /^Select Swiggy/ }).isEnabled()) && (await page.getByRole("checkbox", { name: /^Select Zomato/ }).isEnabled()));

  // Select-all with an unresolved row first in the list picks only the reliable rows.
  await page.getByRole("checkbox", { name: /Select all visible/ }).click();
  await page.getByText("2 selected").waitFor({ timeout: 10000 });
  chk("select-all picked exactly the 2 reliable rows (not the unresolved first row)", !(await page.getByRole("checkbox", { name: /^Select Rapido/ }).isChecked()));
  await h.shot(page, "sms-12-bulk-restricted");
  await page.getByRole("button", { name: /Import selected \(2\)/ }).click();
  const dialog = page.getByRole("dialog").first();
  await dialog.getByText(/Import 2 transactions/).waitFor({ timeout: 20000 });
  const rows = await dialog.getByTestId("bulk-import-rows").innerText();
  chk("the import dialog lists only Swiggy and Zomato", /Swiggy/.test(rows) && /Zomato/.test(rows) && !/Rapido|Ola|Meru/.test(rows), rows.replace(/\s+/g, " "));
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "detached", timeout: 10000 });
  await page.getByRole("button", { name: "Clear selection" }).click();
  chk("nothing was written by selecting and cancelling", (await h.list("transactions")).length === txnsBefore);

  // Individual review still works for an unresolved candidate: the reviewer picks the account explicitly.
  const d = page.getByRole("dialog").first();
  await openRow(page, "Rapido");
  await d.getByText("Transaction Details").first().waitFor({ timeout: 20000 });
  await pickFirstOption(page, d.getByRole("combobox").nth(0));
  await d.getByRole("combobox").nth(1).click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await d.getByRole("button", { name: /Import as Transaction/ }).click();
  await d.waitFor({ state: "detached", timeout: 30000 });
  const sms = (await h.list("transactions")).filter((t) => t.source === "sms");
  chk("the individually reviewed candidate imported exactly once, to the account the reviewer chose", sms.length === 1 && sms[0].description === "Rapido" && sms[0].accountId === bank, JSON.stringify(sms.map((t) => [t.description, t.accountId])));
  await sleep(300);
});
