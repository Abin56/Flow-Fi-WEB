/**
 * SMS candidates workspace — browser verification of the idempotency / loading / error / bulk-duplicate work.
 * Local emulator only (see tests/e2e-qa/README.md): synthetic candidates are written to the Firestore EMULATOR through
 * its owner bypass; the UI is then driven like a user would. Nothing here can reach live Firebase.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
import { BASE_URL, FIRESTORE_DOCS, HOST, PORTS, PROJECT_ID } from "../lib/env.mjs";

const OWNER = { Authorization: "Bearer owner", "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400000;

const s = (v) => ({ stringValue: v });
const n = (v) => ({ doubleValue: v });
const nul = { nullValue: null };

/** Writes one synthetic candidate document in Android's shape to the emulator. */
async function putCandidate(
  uid,
  { id, amount, merchant, accountId, daysAgo, dateIso, direction = "debit", eventType = "upiPayment", rawLastFour = null, confidenceLevel = "high", needsReview = false, reasons = [] },
) {
  const when = dateIso ?? new Date(Date.now() - daysAgo * DAY).toISOString();
  const fields = {
    amount: n(amount),
    direction: s(direction),
    eventType: s(eventType),
    transactionDate: { timestampValue: when },
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
  if (!r.ok) throw new Error(`seed candidate ${id}: ${r.status} ${await r.text()}`);
}
async function deleteCandidate(uid, id) {
  await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsTransactionCandidates/${id}`, { method: "DELETE", headers: OWNER });
}

/** Replaces the emulator's security rules (emulator REST). */
async function setRules(content) {
  const r = await fetch(`http://${HOST}:${PORTS.firestore}/emulator/v1/projects/${PROJECT_ID}:securityRules`, {
    method: "PUT",
    body: JSON.stringify({ rules: { files: [{ name: "firestore.rules", content }] } }),
  });
  if (!r.ok) throw new Error(`setRules: ${r.status} ${await r.text()}`);
}
const DENY_CANDIDATES = `rules_version = '2';
service cloud.firestore { match /databases/{database}/documents {
  match /users/{uid}/{col}/{d=**} { allow read, write: if request.auth != null && col != 'smsTransactionCandidates'; }
} }`;
const ALLOW_ALL = `rules_version = '2';
service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if request.auth != null; } } }`;

/** Records the sequence of states the candidates area renders: skeleton / empty / rows / error. */
const WATCH_STATES = () => {
  window.__states = [];
  const push = (st) => {
    if (window.__states[window.__states.length - 1] !== st) window.__states.push(st);
  };
  const scan = () => {
    const t = document.body ? document.body.innerText : "";
    if (document.querySelector('[data-testid="candidates-loading"]')) push("skeleton");
    else if (/Couldn.t load your SMS candidates/.test(t)) push("error");
    else if (/No SMS candidates/.test(t)) push("empty");
    else if (/Swiggy|Zomato|Uber/.test(t)) push("rows");
  };
  new MutationObserver(scan).observe(document, { subtree: true, childList: true, characterData: true });
};

async function openCandidates(page) {
  await page.goto(`${BASE_URL}/transaction-candidates`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Transaction Inbox" }).waitFor({ timeout: 60000 });
}

async function pickFirstOption(page, trigger) {
  await trigger.click();
  await page.getByRole("option").first().click();
}

async function qaBank() {
  const acc = await h.accountBalance("QA Bank");
  return acc;
}

scenario("sms-1-loading", "Initial loading skeleton, then rows (no empty-state flash); then a genuinely empty inbox", async ({ page }, check) => {
  const uid = await h.authUid();
  const bank = await qaBank();
  await putCandidate(uid, { id: "sms-load-0001", amount: 321, merchant: "Swiggy", accountId: bank.id, daysAgo: 1 });

  await page.addInitScript(WATCH_STATES);
  // Hold back the first Firestore listen so the loading window is observable and deterministic.
  await page.route(/google\.firestore\.v1\.Firestore\/Listen\/channel/, async (route) => {
    await sleep(3000);
    await route.continue().catch(() => {});
  });
  await openCandidates(page);
  await page.getByTestId("candidates-loading").waitFor({ timeout: 20000 }).catch(() => {});
  const sawSkeleton = await page.getByTestId("candidates-loading").isVisible().catch(() => false);
  check("skeleton is shown while the first snapshot is pending", sawSkeleton);
  check("'No SMS candidates' is NOT shown while loading", !(await page.getByText("No SMS candidates").isVisible().catch(() => false)));
  await h.shot(page, "sms-1-loading");

  await page.getByText("Swiggy").first().waitFor({ timeout: 40000 });
  const states = await page.evaluate(() => window.__states);
  check("state sequence is skeleton -> rows, never empty", JSON.stringify(states.filter((x) => x !== "error")) === JSON.stringify(["skeleton", "rows"]), JSON.stringify(states));
  await h.shot(page, "sms-1-rows");

  // Genuinely empty inbox: empty state appears only after the snapshot.
  await deleteCandidate(uid, "sms-load-0001");
  await page.getByText("No SMS candidates").waitFor({ timeout: 20000 });
  check("a real empty inbox shows the empty state after a snapshot", true);
  await page.unroute(/google\.firestore\.v1\.Firestore\/Listen\/channel/);
});

scenario("sms-2-error-retry", "Inline listener error, failed Retry, then successful Retry", async ({ page }, check) => {
  const uid = await h.authUid();
  const bank = await qaBank();
  await putCandidate(uid, { id: "sms-err-0001", amount: 150, merchant: "Zomato", accountId: bank.id, daysAgo: 1 });
  await setRules(DENY_CANDIDATES);
  try {
    await page.addInitScript(WATCH_STATES);
    await openCandidates(page);
    await page.getByText("Couldn't load your SMS candidates.").waitFor({ timeout: 40000 });
    check("inline error is shown when the listener is denied", true);
    check("empty state is NOT shown on error", !(await page.getByText("No SMS candidates").isVisible().catch(() => false)));
    check("the app-wide banner is also present (global handling preserved)", await page.getByText(/Couldn.t load some of your data/).first().isVisible().catch(() => false));
    await h.shot(page, "sms-2-error");

    // Failed retry: still denied -> error again.
    await page.getByRole("button", { name: "Retry" }).first().click();
    await page.getByText("Couldn't load your SMS candidates.").waitFor({ timeout: 30000 });
    check("a failed Retry shows the error again", true);

    // Fix the cause, then Retry for real.
    await setRules(ALLOW_ALL);
    await page.getByRole("button", { name: "Retry" }).first().click();
    await page.getByText("Zomato").first().waitFor({ timeout: 30000 });
    check("Retry succeeds and the candidates appear", true);
    check("inline error is gone after recovery", !(await page.getByText("Couldn't load your SMS candidates.").isVisible().catch(() => false)));
    await h.shot(page, "sms-2-recovered");
  } finally {
    await setRules(ALLOW_ALL).catch(() => {});
  }
});

scenario("sms-3-already-imported", "Import once, candidate resurrects, 'Import anyway' => 'Already imported' toast and no second transaction", async ({ page }, check) => {
  const uid = await h.authUid();
  const bank = await qaBank();
  const cand = { id: "sms-once-0001", amount: 777, merchant: "Swiggy", accountId: bank.id, dateIso: new Date(Date.now() - DAY).toISOString() };
  await putCandidate(uid, cand);
  await openCandidates(page);
  const before = (await h.list("transactions")).length;
  const balBefore = (await qaBank()).currentBalance;

  async function importViaModal() {
    await openRow(page, "Swiggy");
    const dialog = page.getByRole("dialog").first();
    await dialog.getByText("Transaction Details").first().waitFor({ timeout: 20000 });
    await pickFirstOption(page, dialog.getByRole("combobox").nth(0));
    await dialog.getByRole("button", { name: "Import as Transaction" }).click();
  }

  await importViaModal();
  await page.getByText("Imported", { exact: true }).first().waitFor({ timeout: 20000 });
  check("first import shows the 'Imported' toast", true);
  await page.getByText("No SMS candidates").waitFor({ timeout: 20000 });
  const afterFirst = (await h.list("transactions")).filter((t) => t.source === "sms");
  check("exactly one SMS transaction created", afterFirst.length === 1, afterFirst.length);
  check("its id is the deterministic key id", afterFirst[0]?.id === "txn_sms_sms-once-0001", afterFirst[0]?.id);
  const balAfterFirst = (await qaBank()).currentBalance;
  check("account debited once", Math.abs(balBefore - balAfterFirst - 777) < 0.01, balBefore - balAfterFirst);

  // Android re-syncs the same candidate (resurrection).
  await putCandidate(uid, cand);
  await page.getByText("Swiggy").first().waitFor({ timeout: 20000 });
  await h.shot(page, "sms-3-resurrected");
  await importViaModal();
  await page.getByRole("button", { name: "Import anyway" }).waitFor({ timeout: 20000 });
  check("duplicate warning still appears first (existing guard preserved)", true);
  await h.shot(page, "sms-3-dup-warning");
  await page.getByRole("button", { name: "Import anyway" }).click();
  await page.getByText("Already imported").first().waitFor({ timeout: 20000 });
  check("'Already imported' toast is shown", true);
  await h.shot(page, "sms-3-already-imported");

  const txns = (await h.list("transactions")).filter((t) => t.source === "sms");
  check("still exactly one SMS transaction", txns.length === 1, txns.length);
  check("balance unchanged by the second attempt", Math.abs((await qaBank()).currentBalance - balAfterFirst) < 0.01);
  check("resurrected candidate removed from the queue", await page.getByText("No SMS candidates").isVisible().catch(() => false));
  check("no unrelated new transactions", (await h.list("transactions")).length === before + 1);
});

scenario("sms-4-bulk-duplicates", "Bulk import: lookalike is held for review, repeat on another day imports, 'Import anyway' resolves it", async ({ page }, check) => {
  const uid = await h.authUid();
  const bank = await qaBank();
  await putCandidate(uid, { id: "sms-bulk-bank1", amount: 410, merchant: "Swiggy", accountId: bank.id, daysAgo: 2 });
  await putCandidate(uid, { id: "sms-bulk-upi01", amount: 410, merchant: "Uber", accountId: bank.id, daysAgo: 2 });
  await putCandidate(uid, { id: "sms-bulk-next1", amount: 410, merchant: "Zomato", accountId: bank.id, daysAgo: 9 });
  await openCandidates(page);
  await page.getByText("Swiggy").first().waitFor({ timeout: 30000 });
  const balBefore = (await qaBank()).currentBalance;

  await page.getByRole("checkbox", { name: "Select all visible candidates" }).click();
  await page.getByRole("button", { name: /Import selected \(3\)/ }).click();
  const dialog = page.getByRole("dialog").first();
  await dialog.getByText(/Import 3 transactions/).waitFor({ timeout: 20000 });
  await pickFirstOption(page, dialog.getByRole("combobox").nth(0));
  check("destination is pre-filled from Android's own match (QA Bank), not left for a blind pick", /QA Bank/.test(await dialog.getByRole("combobox").nth(1).innerText()));
  await dialog.getByRole("button", { name: /^Import 3/ }).click();

  await page.getByRole("button", { name: "Import anyway" }).waitFor({ timeout: 30000 });
  check("a duplicate confirmation dialog appears for the flagged row(s)", true);
  await h.shot(page, "sms-4-bulk-dup-dialog");
  const imported = (await h.list("transactions")).filter((t) => t.source === "sms");
  check("only the non-flagged rows were written before confirmation", imported.length >= 1 && imported.length < 3, imported.length);
  const debited = balBefore - (await qaBank()).currentBalance;
  check("balance reflects only the written rows", Math.abs(debited - imported.length * 410) < 0.01, debited);

  // Cancel: the flagged candidate must stay pending and nothing more is written.
  await page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Import anyway" }) }).getByRole("button", { name: "Cancel" }).click();
  await sleep(1000);
  const afterCancel = (await h.list("transactions")).filter((t) => t.source === "sms").length;
  check("Cancel writes nothing more", afterCancel === imported.length, afterCancel);
  const stillPending = await page.getByText(/Swiggy|Uber|Zomato/).count();
  check("the flagged candidate is still pending in the list", stillPending >= 1, stillPending);
  await h.shot(page, "sms-4-after-cancel");

  // Confirm the remaining flagged row explicitly.
  const remaining = ["Swiggy", "Uber", "Zomato"].filter(async () => true);
  void remaining;
  // The flagged row is still selected after Cancel (only succeeded rows leave the selection).
  check("selection kept the flagged row for a retry", await page.getByRole("button", { name: /Import selected \(1\)/ }).isVisible().catch(() => false));
  await page.getByRole("button", { name: /Import selected/ }).click();
  const dialog2 = page.getByRole("dialog").first();
  await pickFirstOption(page, dialog2.getByRole("combobox").nth(0));
  await dialog2.getByRole("button", { name: /^Import 1/ }).click();
  await page.getByRole("button", { name: "Import anyway" }).waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Import anyway" }).click();
  await page.getByText("No SMS candidates").waitFor({ timeout: 30000 });
  const all = (await h.list("transactions")).filter((t) => t.source === "sms");
  check("after explicit confirmation all three are imported, once each", all.length === 3 && new Set(all.map((t) => t.id)).size === 3, all.length);
  const totalDebit = balBefore - (await qaBank()).currentBalance;
  check("balance debited exactly 3 x 410", Math.abs(totalDebit - 1230) < 0.01, totalDebit);
  await h.shot(page, "sms-4-done");
});

/** The row (role=button) containing some text. */
const rowsLocator = (page) => page.getByTestId("candidate-row");
const rowOf = (page, text) => rowsLocator(page).filter({ hasText: text }).first();
/** Opens the review drawer the way a keyboard user does: the row's own Review button. */
const openRow = (page, text) => rowOf(page, text).getByRole("button", { name: /^Review/ }).click();
const lane = (page, name) => page.getByRole("group", { name: "Inbox views" }).getByRole("button", { name });
/** The overview band's tile for a lane (whole-queue counts, and a toggle that narrows the list to that lane). */
const tile = (page, name) => page.getByTestId("candidates-overview").getByRole("button", { name });
/** "all" / "attention" are the views' filtered counts; the four lanes are the overview's whole-queue counts. */
const laneCount = async (page, lane) => {
  const id = lane === "all" || lane === "attention" ? `lane-count-${lane}` : `overview-count-${lane}`;
  // The Duplicates tile only exists while there are duplicates, so its absence means 0.
  if (lane === "duplicate" && (await page.getByTestId(id).count()) === 0) return 0;
  return Number((await page.getByTestId(id).innerText()).trim());
};

scenario("sms-5-lanes-labels-amounts", "Exclusive lanes add up, labels are honest, paise are shown, filtered-empty offers Clear filters", async ({ page }, check) => {
  const uid = await h.authUid();
  const bank = await qaBank();
  await putCandidate(uid, { id: "sms-lane-clean1", amount: 321, merchant: "Swiggy", accountId: bank.id, daysAgo: 1 });
  await putCandidate(uid, { id: "sms-lane-review", amount: 322, merchant: "Zomato", accountId: bank.id, daysAgo: 1, confidenceLevel: "low", needsReview: true, reasons: ["Parsed by a generic, lower-confidence parser rather than a bank-specific one."] });
  await putCandidate(uid, { id: "sms-lane-nomatch", amount: 323, merchant: "Uber", accountId: null, rawLastFour: "7743", daysAgo: 1, confidenceLevel: "low", needsReview: true, reasons: ["No matching account or card found for this message."] });
  await putCandidate(uid, { id: "sms-lane-deleted", amount: 324, merchant: "Ola", accountId: "deleted-account-0001", daysAgo: 1 });
  await putCandidate(uid, { id: "sms-lane-paise01", amount: 1250.5, merchant: "Blinkit", accountId: bank.id, daysAgo: 1 });
  await putCandidate(uid, { id: "sms-lane-credit1", amount: 500, merchant: "Refundco", accountId: bank.id, daysAgo: 1, direction: "credit", eventType: "refund" });
  await openCandidates(page);
  await page.getByText("Swiggy").first().waitFor({ timeout: 40000 });
  await page.getByText("Ola").first().waitFor({ timeout: 20000 });
  await h.shot(page, "sms-5-lanes");

  const c = { all: await laneCount(page, "all"), duplicate: await laneCount(page, "duplicate"), needsAccount: await laneCount(page, "needsAccount"), needsReview: await laneCount(page, "needsReview"), noIssues: await laneCount(page, "noIssues") };
  check("lane counts are 0 / 2 / 1 / 3 and 'All' is 6", c.all === 6 && c.duplicate === 0 && c.needsAccount === 2 && c.needsReview === 1 && c.noIssues === 3, JSON.stringify(c));
  check("the four lanes add up to All (no overlap)", c.duplicate + c.needsAccount + c.needsReview + c.noIssues === c.all);
  check("'Attention needed' = every lane except clean, and Clean + Attention = All", (await laneCount(page, "attention")) === c.duplicate + c.needsAccount + c.needsReview && (await laneCount(page, "attention")) + c.noIssues === c.all);

  // Each lane shows exactly the rows its count promised.
  await tile(page, /Needs account/).click();
  await rowOf(page, "Swiggy").waitFor({ state: "hidden", timeout: 10000 }); // rows animate out — wait for it
  await sleep(400);
  const needsAccountRows = await rowsLocator(page).filter({ hasText: /Swiggy|Zomato|Blinkit|Refundco|Uber|Ola/ }).allInnerTexts();
  check("Needs account lists exactly Uber and Ola", needsAccountRows.length === 2 && needsAccountRows.some((t) => /Uber/.test(t)) && needsAccountRows.some((t) => /Ola/.test(t)), needsAccountRows.map((t) => t.replace(/\s+/g, " ").slice(0, 40)).join(" | "));
  check("Needs account shows 2 rows", (await rowsLocator(page).filter({ hasText: /Uber|Ola/ }).count()) === 2);
  check("a deleted account reads 'Account no longer exists'", await rowOf(page, "Ola").getByText(/Account no longer exists/).isVisible());
  check("an unmatched last-4 reads 'Not matched • •••• 7743'", await rowOf(page, "Uber").getByText("Not matched • •••• 7743").isVisible());
  check("unmatched rows carry a 'Needs account' action (not 'Unmatched Card')", (await rowsLocator(page).getByRole("button", { name: /Needs account/ }).count()) >= 2 && !(await page.getByText("Unmatched Card").isVisible().catch(() => false)));
  await h.shot(page, "sms-5-needs-account");

  await lane(page, /^Clean/).click();
  check("the clean view is called 'Clean' (never 'Ready to Import') and clean rows carry no 'No issues flagged' badge", !(await page.getByText(/Ready to Import/i).isVisible().catch(() => false)) && (await rowsLocator(page).getByText("No issues flagged").count()) === 0);
  check("Clean shows 3 rows", (await rowsLocator(page).filter({ hasText: /Swiggy|Blinkit|Refundco/ }).count()) === 3);
  const blinkit = await rowOf(page, "Blinkit").innerText();
  check("paise are not rounded away: ₹1,250.50", /₹1,250\.50/.test(blinkit), blinkit.replace(/\n/g, " | "));
  const swiggy = await rowOf(page, "Swiggy").innerText();
  check("whole rupees stay clean: ₹321 (no .00)", /₹321(?!\.)/.test(swiggy), swiggy.replace(/\n/g, " | "));

  // Filtered-empty state.
  await lane(page, /^All\s*\d/).click();
  await page.getByLabel("Search candidates").fill("zzzzz");
  await page.getByText("No candidates match").waitFor({ timeout: 10000 });
  check("a search with no hits says 'No candidates match', not 'No SMS candidates'", !(await page.getByText("No SMS candidates").isVisible().catch(() => false)));
  check("lane counts follow the search (All = 0)", (await laneCount(page, "all")) === 0);
  await h.shot(page, "sms-5-filtered-empty");
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  await page.getByText("Swiggy").first().waitFor({ timeout: 10000 });
  check("Clear filters restores the full list", (await laneCount(page, "all")) === 6 && (await page.getByLabel("Search candidates").inputValue()) === "");
});

scenario("sms-6-popup-destination-categories-keyboard", "Review popup: deleted account is not pre-selected, categories match direction, Enter on a row opens it, Ctrl+Enter (not Enter) imports", async ({ page }, check) => {
  const uid = await h.authUid();
  const bank = await qaBank();
  await putCandidate(uid, { id: "sms-pop-deleted", amount: 324, merchant: "Ola", accountId: "deleted-account-0001", daysAgo: 1 });
  await putCandidate(uid, { id: "sms-pop-credit1", amount: 500, merchant: "Refundco", accountId: bank.id, daysAgo: 1, direction: "credit", eventType: "refund" });
  await putCandidate(uid, { id: "sms-pop-clean01", amount: 321, merchant: "Swiggy", accountId: bank.id, daysAgo: 1 });
  await openCandidates(page);
  await page.getByText("Ola").first().waitFor({ timeout: 40000 });
  const txnsBefore = (await h.list("transactions")).length;
  const balBefore = (await qaBank()).currentBalance;

  // 1. Deleted account: nothing pre-selected, Import stays disabled even with a category.
  await openRow(page, "Ola");
  let dialog = page.getByRole("dialog").first();
  await dialog.getByText("Transaction Details").first().waitFor({ timeout: 20000 });
  const destText = await dialog.getByRole("combobox").nth(1).innerText();
  check("a deleted account is NOT pre-selected (placeholder shown)", /Select an account or card/.test(destText), destText);
  check("the popup says the account no longer exists", await dialog.getByText(/Account no longer exists/).first().isVisible());
  // Category options for an expense: no income categories.
  await dialog.getByRole("combobox").nth(0).click();
  const expenseOptions = await page.getByRole("option").allInnerTexts();
  check("an expense candidate is offered expense categories and not income ones", expenseOptions.some((t) => /Food/.test(t)) && !expenseOptions.some((t) => /Salary/.test(t)), expenseOptions.join(", "));
  await page.getByRole("option").first().click();
  check("Import stays disabled until a destination is chosen", await dialog.getByRole("button", { name: /Import as Transaction/ }).isDisabled());
  await h.shot(page, "sms-6-deleted-account");
  await page.keyboard.press("Control+Enter");
  await sleep(800);
  check("Ctrl+Enter does nothing while the form is invalid", (await h.list("transactions")).length === txnsBefore);
  // With focus on a picker, Enter belongs to the picker (it opens its list) — close it before using the popup's buttons.
  if (await page.getByRole("listbox").isVisible().catch(() => false)) await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("dialog").first().waitFor({ state: "detached", timeout: 10000 });
  await sleep(500);

  // 2. Income candidate: income categories only.
  await openRow(page, "Refundco");
  dialog = page.getByRole("dialog").first();
  await dialog.getByText("Transaction Details").first().waitFor({ timeout: 20000 });
  await dialog.getByRole("combobox").nth(0).click();
  const incomeOptions = await page.getByRole("option").allInnerTexts();
  check("an income candidate is offered income categories and not expense ones", incomeOptions.some((t) => /Salary/.test(t)) && !incomeOptions.some((t) => /Food/.test(t)), incomeOptions.join(", "));
  await page.keyboard.press("Escape"); // closes the open category list
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("dialog").first().waitFor({ state: "detached", timeout: 10000 });
  await sleep(500);

  // 3. Keyboard: a focused row opens with Enter (and Space); Esc closes.
  await rowOf(page, "Swiggy").getByRole("button", { name: /^Review/ }).focus();
  await page.keyboard.press("Enter");
  dialog = page.getByRole("dialog").first();
  await dialog.getByText("Transaction Details").first().waitFor({ timeout: 20000 });
  check("Enter on a focused Review button opens the review drawer", true);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").first().waitFor({ state: "detached", timeout: 10000 });
  check("Escape closes it again", true);
  await sleep(500);
  await rowOf(page, "Swiggy").getByRole("button", { name: /^Review/ }).focus();
  await page.keyboard.press("Space");
  await page.getByRole("dialog").first().getByText("Transaction Details").first().waitFor({ timeout: 20000 });
  check("Space on a focused Review button opens it too", true);

  // 4. Ctrl+Enter imports once a category is chosen (destination was pre-filled from Android's match).
  dialog = page.getByRole("dialog").first();
  await pickFirstOption(page, dialog.getByRole("combobox").nth(0));
  await dialog.getByRole("button", { name: /Import as Transaction/ }).waitFor();
  check("the popup advertises the Ctrl+Enter shortcut", /Ctrl/.test(await dialog.innerText()));
  await dialog.getByLabel("Close").focus();
  await page.keyboard.press("Enter"); // a bare Enter on Close just closes — it must never import
  await sleep(600);
  // The category was changed, so closing asks first — discard (still nothing imported).
  const discard = page.getByRole("dialog").filter({ hasText: "Discard your changes?" });
  if (await discard.isVisible().catch(() => false)) await discard.getByRole("button", { name: "Discard and close" }).click();
  check("a bare Enter never imports", (await h.list("transactions")).filter((t) => t.source === "sms").length === 0);
  await openRow(page, "Swiggy");
  dialog = page.getByRole("dialog").first();
  await pickFirstOption(page, dialog.getByRole("combobox").nth(0));
  await dialog.getByRole("button", { name: /^Notes/ }).click(); // folded by default
  await dialog.getByRole("textbox").first().focus();
  await page.keyboard.press("Enter");
  await sleep(600);
  check("a bare Enter in the Notes box doesn't import either", (await h.list("transactions")).filter((t) => t.source === "sms").length === 0);
  await page.keyboard.press("Control+Enter");
  await page.getByText("Imported", { exact: true }).first().waitFor({ timeout: 20000 });
  const imported = (await h.list("transactions")).filter((t) => t.source === "sms");
  check("Ctrl+Enter imported exactly one SMS transaction", imported.length === 1, imported.length);
  check("QA Bank was debited exactly once (₹321)", Math.abs(balBefore - (await qaBank()).currentBalance - 321) < 0.01, balBefore - (await qaBank()).currentBalance);
  await h.shot(page, "sms-6-imported");
});

scenario("sms-7-bulk-safety", "Bulk: mixed accounts/directions can't be combined, selection is visible-only, the dialog lists the rows, an override is flagged", async ({ page }, check) => {
  const uid = await h.authUid();
  const bank = await qaBank();
  const cash = await h.accountBalance("QA Cash");
  await putCandidate(uid, { id: "sms-blk-bank01", amount: 411, merchant: "Swiggy", accountId: bank.id, daysAgo: 3 });
  await putCandidate(uid, { id: "sms-blk-bank02", amount: 412, merchant: "Zomato", accountId: bank.id, daysAgo: 4 });
  await putCandidate(uid, { id: "sms-blk-cash01", amount: 413, merchant: "Uber", accountId: cash.id, daysAgo: 5 });
  await putCandidate(uid, { id: "sms-blk-cred01", amount: 500, merchant: "Refundco", accountId: bank.id, daysAgo: 6, direction: "credit", eventType: "refund" });
  await openCandidates(page);
  await page.getByText("Swiggy").first().waitFor({ timeout: 40000 });
  await page.getByText("Uber").first().waitFor({ timeout: 20000 });
  const txnsBefore = (await h.list("transactions")).length;
  const bankBefore = (await qaBank()).currentBalance;
  const cashBefore = (await h.accountBalance("QA Cash")).currentBalance;

  await page.getByRole("checkbox", { name: /^Select Swiggy/ }).click();
  check("a row on ANOTHER account can't join the selection", await page.getByRole("checkbox", { name: /^Select Uber/ }).isDisabled());
  check("an income row can't join an expense selection", await page.getByRole("checkbox", { name: /^Select Refundco/ }).isDisabled());
  check("a row on the SAME account still can", await page.getByRole("checkbox", { name: /^Select Zomato/ }).isEnabled());
  await h.shot(page, "sms-7-locked");

  // Select-all picks only the compatible rows.
  await page.getByRole("checkbox", { name: /Select all visible/ }).click();
  await page.getByText("2 selected").waitFor({ timeout: 10000 });
  check("select-all selects only the 2 same-account expense rows", true);

  // Changing what's on screen clears the selection — no hidden rows ride along.
  await page.getByLabel("Search candidates").fill("Swiggy");
  await sleep(500);
  check("searching clears the selection (bar gone)", !(await page.getByText(/\d+ selected/).isVisible().catch(() => false)));
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  await page.getByText("Zomato").first().waitFor();

  // Bulk dialog.
  await page.getByRole("checkbox", { name: /Select all visible/ }).click();
  await page.getByRole("button", { name: /Import selected \(2\)/ }).click();
  const dialog = page.getByRole("dialog").first();
  await dialog.getByText(/Import 2 transactions/).waitFor({ timeout: 20000 });
  const rows = await dialog.getByTestId("bulk-import-rows").innerText();
  check("the dialog lists exactly the rows being imported with their total", /Swiggy/.test(rows) && /Zomato/.test(rows) && !/Uber/.test(rows) && /₹823\.00/.test(rows), rows.replace(/\n/g, " | "));
  check("destination is pre-filled with Android's own match (QA Bank)", /QA Bank/.test(await dialog.getByRole("combobox").nth(1).innerText()));
  check("no override warning while the destination is Android's match", (await dialog.getByRole("alert").count()) === 0);
  await dialog.getByRole("combobox").nth(1).click();
  await page.getByRole("option", { name: /QA Cash/ }).click();
  check("choosing a different account flags the override", /overrides that for all 2/.test(await dialog.getByRole("alert").innerText()));
  await h.shot(page, "sms-7-override-warning");
  await dialog.getByRole("combobox").nth(1).click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  check("switching back to Android's match clears the warning", (await dialog.getByRole("alert").count()) === 0);

  // Bare Enter must not import; Ctrl+Enter is the deliberate chord.
  await pickFirstOption(page, dialog.getByRole("combobox").nth(0));
  await dialog.getByRole("combobox").nth(0).focus();
  await page.keyboard.press("Enter"); // opens the category list, never imports
  await page.keyboard.press("Escape");
  await sleep(500);
  check("bare Enter did not import", (await h.list("transactions")).length === txnsBefore);
  await dialog.getByRole("button", { name: /^Import 2/ }).click();
  await page.getByText("Import complete").first().waitFor({ timeout: 30000 });
  const sms = (await h.list("transactions")).filter((t) => t.source === "sms");
  check("exactly the 2 selected rows were imported, to QA Bank", sms.length === 2 && sms.every((t) => t.accountId === bank.id), JSON.stringify(sms.map((t) => [t.description, t.accountId])));
  check("QA Bank debited exactly 411 + 412", Math.abs(bankBefore - (await qaBank()).currentBalance - 823) < 0.01);
  check("QA Cash untouched", Math.abs((await h.accountBalance("QA Cash")).currentBalance - cashBefore) < 0.01);
  check("the other-account and income candidates are still pending", (await page.getByText("Uber").first().isVisible()) && (await page.getByText("Refundco").first().isVisible()));
  await h.shot(page, "sms-7-done");
});

scenario("sms-8-unreadable-notice", "A malformed candidate document is reported, not silently dropped; the readable ones still show", async ({ page }, check) => {
  const uid = await h.authUid();
  const bank = await qaBank();
  await putCandidate(uid, { id: "sms-unr-good01", amount: 321, merchant: "Swiggy", accountId: bank.id, daysAgo: 1 });
  // No `direction` — Android itself refuses such a document; the web must say so rather than hide it.
  const bad = { amount: n(99), eventType: s("upiPayment"), transactionDate: { timestampValue: new Date().toISOString() }, createdAt: { timestampValue: new Date().toISOString() } };
  const r = await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsTransactionCandidates/sms-unr-bad001`, { method: "PATCH", headers: OWNER, body: JSON.stringify({ fields: bad }) });
  if (!r.ok) throw new Error(`seed malformed: ${r.status}`);
  await openCandidates(page);
  await page.getByText("Swiggy").first().waitFor({ timeout: 40000 });
  const notice = page.getByTestId("unreadable-candidates-notice");
  await notice.waitFor({ timeout: 15000 });
  check("a notice reports 1 unreadable candidate", /1 candidate couldn't be read/.test(await notice.innerText()), await notice.innerText());
  check("the readable candidate is still listed", await page.getByText("Swiggy").first().isVisible());
  check("the malformed document was not deleted", (await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsTransactionCandidates/sms-unr-bad001`, { headers: OWNER })).ok);
  await h.shot(page, "sms-8-unreadable");
  await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsTransactionCandidates/sms-unr-bad001`, { method: "DELETE", headers: OWNER });
  await notice.waitFor({ state: "hidden", timeout: 15000 });
  check("the notice disappears once the bad document is gone", true);
});

/** The app shell's scrolling <main>: the inbox is a normal page that scrolls with it. */
const listScroller = (page) => page.locator("main");
const rowCount = (page) => page.getByTestId("candidate-row").count();
/** router.replace is applied asynchronously, so URL assertions poll. */
async function waitUrl(page, re, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (re.test(page.url())) return true;
    await sleep(150);
  }
  return false;
}
async function waitRowCount(page, expected, ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await rowCount(page)) === expected) return true;
    await sleep(150);
  }
  return false;
}

scenario("sms-14-advanced-filters-url-scroll", "Advanced filters AND together, show as chips, persist in the URL across a reload, and survive opening the drawer (scroll position included)", async ({ page }, check) => {
  const uid = await h.authUid();
  const bank = await qaBank();
  const seeded = [];
  const MONTHS = [9, 8, 7]; // Oct, Sep, Aug 2026 (0-based)
  for (let i = 0; i < 36; i++) {
    const month = MONTHS[i % 3];
    const day = 1 + ((i * 3) % 27);
    const c = {
      id: `sms-f14-${String(i).padStart(3, "0")}`,
      i,
      amount: 100 + i * 37,
      merchant: i % 9 === 0 ? "Swiggy" : `Merchant ${i}`,
      accountId: i % 7 === 0 ? null : bank.id,
      rawLastFour: i % 7 === 0 ? "7743" : null,
      direction: i % 6 === 0 ? "credit" : "debit",
      confidenceLevel: i % 5 === 0 ? "low" : "high",
      needsReview: i % 5 === 0,
      dateIso: new Date(2026, month, day, 12, 0).toISOString(),
    };
    seeded.push(c);
    await putCandidate(uid, c);
  }
  await openCandidates(page);
  await page.getByText("Swiggy").first().waitFor({ timeout: 40000 });
  check("all 36 candidates are listed", await waitRowCount(page, 36), String(await rowCount(page)));

  const keys = await page.getByTestId("candidate-group").evaluateAll((els) => els.map((e) => e.getAttribute("data-group-key")));
  const distinctDays = new Set(seeded.map((c) => c.dateIso.slice(0, 10))).size;
  check("grouped by transaction day, newest day first", keys.length === distinctDays && keys.every((k, n) => n === 0 || keys[n - 1] > k) && new Set(keys).size === keys.length, keys.slice(0, 4).join(","));
  const firstHeading = await page.getByTestId("candidate-group").first().locator("h2").innerText();
  check("day headings show the full date (e.g. 29 October 2026 / 30 September 2026)", /[0-9]{1,2} (August|September|October) 2026/.test(firstHeading), firstHeading);
  void distinctDays;

  // ── search is debounced, and lands in the URL ──
  const swiggy = seeded.filter((c) => c.merchant === "Swiggy").length;
  await page.getByLabel("Search candidates").fill("Swiggy");
  check("search narrows to the Swiggy rows", await waitRowCount(page, swiggy), `${await rowCount(page)} vs ${swiggy}`);
  check("the URL carries the search", await waitUrl(page, /[?&]q=Swiggy/), page.url());
  const shown = (await page.getByTestId("candidates-shown").innerText()).replace(/\s+/g, " ");
  check("the result count is distinct from the inbox total", new RegExp(`Showing\\s*${swiggy}\\s*of\\s*36`).test(shown), shown);
  await page.getByLabel("Search candidates").fill("");
  check("clearing the search restores the list", await waitRowCount(page, 36));

  // ── advanced sheet: direction + amount, applied together (AND) ──
  const wantCreditOver500 = seeded.filter((c) => c.direction === "credit" && c.amount >= 500).length;
  await page.getByTestId("open-filters").click();
  const sheet = page.getByRole("dialog", { name: "Filters" });
  await sheet.waitFor({ timeout: 5000 });
  await sheet.getByRole("button", { name: "Credit", exact: true }).click();
  await sheet.getByLabel("Minimum").fill("500");
  const applyText = await sheet.getByTestId("apply-filters").innerText();
  check("the Apply button previews the result count", applyText.includes(`Show ${wantCreditOver500} result`), applyText);
  await h.shot(page, "sms-14-sheet");
  await sheet.getByTestId("apply-filters").click();
  await sheet.waitFor({ state: "hidden", timeout: 5000 });
  check("credit AND amount >= 500 lists exactly the matching rows", await waitRowCount(page, wantCreditOver500), `${await rowCount(page)} vs ${wantCreditOver500}`);
  check("every listed row is a credit", await page.getByTestId("candidate-row").evaluateAll((els) => els.every((e) => /\+₹/.test(e.textContent ?? ""))));
  const chips = page.getByTestId("filter-chips");
  check("chips show Credit and Min ₹500", (await chips.getByText("Credit", { exact: true }).isVisible()) && (await chips.getByText(/Min ₹500/).isVisible()));
  check("the Filters button counts 2 active filters", /^2/.test((await page.getByTestId("active-filter-count").innerText()).trim()), await page.getByTestId("active-filter-count").innerText());
  check("the URL carries the filters", await waitUrl(page, /dir=credit.*min=500|min=500.*dir=credit/), page.url());
  await h.shot(page, "sms-14-chips");

  // ── a reload keeps the view ──
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Transaction Inbox" }).waitFor({ timeout: 60000 });
  check("after a reload the same rows are listed", await waitRowCount(page, wantCreditOver500, 30000), String(await rowCount(page)));
  check("after a reload the chips are still there", await page.getByTestId("filter-chips").getByText(/Min ₹500/).isVisible());

  // ── chips are removable one at a time ──
  await page.getByRole("button", { name: "Remove filter: Credit" }).click();
  const wantMin500 = seeded.filter((c) => c.amount >= 500).length;
  check("removing the Credit chip keeps the amount filter", await waitRowCount(page, wantMin500), `${await rowCount(page)} vs ${wantMin500}`);
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  check("Clear all restores everything and empties the URL query", (await waitRowCount(page, 36)) && (await waitUrl(page, /^[^?]*$/)), page.url());

  // ── unmatched is a real account option ──
  const wantUnmatched = seeded.filter((c) => c.accountId == null).length;
  await page.getByTestId("open-filters").click();
  await sheet.waitFor({ timeout: 5000 });
  await sheet.getByRole("checkbox", { name: /Unmatched/ }).click();
  await sheet.getByTestId("apply-filters").click();
  check("the Unmatched account option lists only candidates with no account", await waitRowCount(page, wantUnmatched), `${await rowCount(page)} vs ${wantUnmatched}`);
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  await waitRowCount(page, 36);

  // ── invalid ranges can't be applied ──
  await page.getByTestId("open-filters").click();
  await sheet.waitFor({ timeout: 5000 });
  await sheet.getByLabel("Minimum").fill("900");
  await sheet.getByLabel("Maximum").fill("100");
  check("min > max shows an error and disables Apply", (await sheet.getByRole("alert").isVisible()) && (await sheet.getByTestId("apply-filters").isDisabled()));
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden", timeout: 5000 });

  // ── filters + scroll position survive opening and closing the drawer ──
  await page.getByRole("group", { name: "Filter by direction" }).getByRole("button", { name: "Debit" }).click();
  const wantDebit = seeded.filter((c) => c.direction === "debit").length;
  await waitRowCount(page, wantDebit);
  const scroller = listScroller(page);
  await scroller.evaluate((el) => (el.scrollTop = 500));
  await sleep(300);
  const before = await scroller.evaluate((el) => el.scrollTop);
  const reviewId = await page.evaluate(() => {
    const vis = [...document.querySelectorAll("[data-review-id]")].find((b) => {
      const r = b.getBoundingClientRect();
      return r.top > 300 && r.bottom < window.innerHeight - 20;
    });
    return vis?.getAttribute("data-review-id") ?? null;
  });
  const stuck = await page.evaluate(() => {
    const top = document.querySelector("main").getBoundingClientRect().top;
    return [...document.querySelectorAll('[data-testid="candidate-group"] h2')].some((h) => Math.abs(h.parentElement.getBoundingClientRect().top - top) <= 2);
  });
  check("the current month heading sticks to the top while scrolling", stuck);
  check("a row was in view after scrolling", before > 100 && !!reviewId, `scrollTop ${before}, row ${reviewId}`);
  await page.locator(`[data-review-id="${reviewId}"]`).click();
  const drawer = page.getByRole("dialog").first();
  await drawer.getByText("Transaction Details").first().waitFor({ timeout: 20000 });
  await h.shot(page, "sms-14-drawer");
  const dw = await drawer.boundingBox();
  const vh = page.viewportSize().height;
  check("the editor is a full-width top sheet that leaves the list visible below it", !!dw && Math.round(dw.x) === 0 && Math.round(dw.width) === 1920 && Math.round(dw.y) === 0 && dw.height < vh * 0.7, dw ? `${Math.round(dw.width)}x${Math.round(dw.height)} at y=${Math.round(dw.y)}` : "none");
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden", timeout: 10000 });
  await sleep(300);
  const after = await scroller.evaluate((el) => el.scrollTop);
  check("the list scroll position is unchanged after closing the drawer", Math.abs(after - before) <= 2, `${before} -> ${after}`);
  check("the filters are unchanged after closing the drawer", (await rowCount(page)) === wantDebit && (await page.getByTestId("filter-chips").getByText("Debit", { exact: true }).isVisible()));

  // ── no matches: a useful empty state ──
  await page.getByLabel("Search candidates").fill("zzzzzz");
  await page.getByText("No candidates match").waitFor({ timeout: 10000 });
  await h.shot(page, "sms-14-no-results");
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  check("Clear filters in the empty state restores the inbox", await waitRowCount(page, 36));
});
