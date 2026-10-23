/**
 * SMS candidates — a People/Split step that fails AFTER the transaction was created.
 * Local emulator only (see tests/e2e-qa/README.md). The failure is injected by swapping the EMULATOR's security rules so
 * writes to everything except transactions / accounts / smsTransactionCandidates are refused: the import's transaction
 * write succeeds, the person assignment (People ledger / schedule writes) is denied. Nothing here can reach live Firebase.
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

async function putCandidate(uid, { id, amount, merchant, accountId, daysAgo }) {
  const fields = {
    amount: n(amount),
    direction: s("debit"),
    eventType: s("upiPayment"),
    transactionDate: { timestampValue: new Date(Date.now() - daysAgo * DAY).toISOString() },
    merchant: s(merchant),
    bankName: s("QA Bank"),
    rawLastFour: nul,
    accountId: s(accountId),
    cardId: nul,
    referenceNumber: nul,
    confidenceLevel: s("high"),
    confidenceScore: n(0.9),
    needsReview: { booleanValue: false },
    needsReviewReasons: { arrayValue: { values: [] } },
    source: s("sms"),
    createdAt: { timestampValue: new Date().toISOString() },
    deletedAt: nul,
  };
  const r = await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsTransactionCandidates/${id}`, { method: "PATCH", headers: OWNER, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`seed ${id}: ${r.status} ${await r.text()}`);
}

const openReview = (page, text) => page.getByTestId("candidate-row").filter({ hasText: text }).first().getByRole("button", { name: /^Review/ }).click();

async function setRules(content) {
  const r = await fetch(`http://${HOST}:${PORTS.firestore}/emulator/v1/projects/${PROJECT_ID}:securityRules`, { method: "PUT", body: JSON.stringify({ rules: { files: [{ name: "firestore.rules", content }] } }) });
  if (!r.ok) throw new Error(`setRules: ${r.status} ${await r.text()}`);
}
const ONLY_TRANSACTION_WRITES = `rules_version = '2';
service cloud.firestore { match /databases/{database}/documents {
  match /users/{uid}/{col}/{d=**} {
    allow read: if request.auth != null;
    allow write: if request.auth != null && (col == 'transactions' || col == 'accounts' || col == 'smsTransactionCandidates');
  }
} }`;
const ALLOW_ALL = `rules_version = '2';
service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if request.auth != null; } } }`;

scenario("sms-9-split-fails-after-import", "Person/Split fails after the transaction exists: the UI says so, nothing is retried, a later re-import creates nothing new", async ({ page }, check) => {
  const uid = await h.authUid();
  const bank = await h.accountBalance("QA Bank");
  await putCandidate(uid, { id: "sms-spl-fail-001", amount: 640, merchant: "Dominos", accountId: bank.id, daysAgo: 1 });
  await page.goto(`${BASE_URL}/transaction-candidates`, { waitUntil: "domcontentloaded" });
  await page.getByText("Dominos").first().waitFor({ timeout: 60000 });
  const txnsBefore = (await h.list("transactions")).length;
  const expensesBefore = (await h.list("expenses")).length;
  const balBefore = (await h.accountBalance("QA Bank")).currentBalance;

  try {
    await setRules(ONLY_TRANSACTION_WRITES);
    await openReview(page, "Dominos");
    const d = page.getByRole("dialog").first();
    await d.getByText("Transaction Details").first().waitFor({ timeout: 20000 });
    await d.getByRole("combobox").nth(0).click();
    await page.getByRole("option").first().click();
    await d.getByRole("combobox").nth(2).click();
    await page.getByRole("option", { name: /QA Priya/ }).click();
    await d.getByRole("switch").click();
    await h.shot(page, "sms-9-before-import");
    await d.getByRole("button", { name: /Import as Transaction/ }).click();

    // A PERSISTENT, accessible disclosure inside the drawer — not a disappearing toast.
    const notice = d.getByTestId("drawer-partial-notice");
    await notice.waitFor({ timeout: 30000 });
    check("a persistent alert in the drawer says the person/split was not applied", (await notice.getAttribute("role")) === "alert" && /person[/]split was not applied/.test(await notice.innerText()));
    const text = await notice.innerText();
    check("it states the transaction already exists as a plain expense and the balance is updated", /already exists as a plain expense/.test(text) && /balance is already updated/.test(text), text.slice(0, 220));
    check("it explains nothing was retried or recreated", /Nothing was retried and nothing was recreated/.test(text));
    check("it gives safe next steps (open Transactions, then clear the leftover)", /Open Transactions/.test(text) && /remove the leftover message/.test(text));
    const body = await page.locator("body").innerText();
    check("NO raw Firestore / permission text is shown anywhere", !/PERMISSION_DENIED|FirebaseError|Missing or insufficient|false for 'create'/i.test(body));
    check("the form is locked: the Import buttons are gone so it can't be imported twice", (await d.getByRole("button", { name: /Import as Transaction/ }).count()) === 0);
    await h.shot(page, "sms-9-partial-drawer");
    await sleep(7000); // longer than any toast lifetime
    check("the alert is still there after the toast window", await notice.isVisible());
    await d.getByRole("button", { name: "Close", exact: true }).first().click();
    await d.waitFor({ state: "detached", timeout: 10000 });
    const banner = page.getByTestId("partial-import-notices");
    await banner.waitFor({ timeout: 10000 });
    check("after closing the drawer a persistent notice stays on the list page", (await banner.getByRole("alert").count()) === 1);
    check("the list notice links to Transactions and offers 'Remove from queue'", (await banner.getByRole("link", { name: "Open Transactions" }).count()) === 1 && (await banner.getByRole("button", { name: "Remove from queue" }).count()) === 1);
    check("the list notice also shows no raw error text", !/PERMISSION_DENIED|FirebaseError/i.test(await banner.innerText()));
    await h.shot(page, "sms-9-partial-banner");

    const sms = (await h.list("transactions")).filter((t) => t.source === "sms");
    check("exactly ONE SMS transaction exists (created as a plain expense)", sms.length === 1 && sms[0].type === "expense", sms.length);
    check("it has no person link and no 'owes me' flag (the assignment did not partially apply)", sms[0] && !sms[0].linkedPersonId && !sms[0].owesPersonToggle, JSON.stringify({ p: sms[0]?.linkedPersonId, o: sms[0]?.owesPersonToggle }));
    check("its id is the deterministic idempotency key id", sms[0]?.id === "txn_sms_sms-spl-fail-001", sms[0]?.id);
    check("QA Bank was debited exactly once (₹640)", Math.abs(balBefore - (await h.accountBalance("QA Bank")).currentBalance - 640) < 0.01, balBefore - (await h.accountBalance("QA Bank")).currentBalance);
    check("no expense / split record was left behind", (await h.list("expenses")).length === expensesBefore, (await h.list("expenses")).length - expensesBefore);
    const candidateStill = await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsTransactionCandidates/sms-spl-fail-001`, { headers: OWNER });
    check("the candidate document was NOT deleted (nothing was retried or cleaned up automatically)", candidateStill.ok);
    await sleep(2500);
    check("no automatic retry: still exactly one new transaction after waiting", (await h.list("transactions")).length === txnsBefore + 1);

    // The user resolves it deliberately: the candidate now reads as a possible duplicate of the new transaction; confirming
    // past the warning goes through the idempotent path — "Already imported", nothing new, no balance change.
    await setRules(ALLOW_ALL);
    await page.getByText("Dominos", { exact: true }).first().waitFor({ timeout: 20000 });
    check("the leftover candidate is flagged as a possible duplicate of the new transaction", await page.getByText(/Possible duplicate/i).filter({ visible: true }).first().isVisible().catch(() => false));
    await openReview(page, "Dominos");
    const d2 = page.getByRole("dialog").first();
    await d2.getByText("Transaction Details").first().waitFor({ timeout: 20000 });
    await d2.getByRole("combobox").nth(0).click();
    await page.getByRole("option").first().click();
    await d2.getByRole("button", { name: /Import as Transaction/ }).click();
    await page.getByRole("button", { name: "Import anyway" }).click();
    await page.getByText("Already imported").first().waitFor({ timeout: 30000 });
    check("re-import after the failure reports 'Already imported'", true);
    const after = (await h.list("transactions")).filter((t) => t.source === "sms");
    check("still exactly one SMS transaction", after.length === 1, after.length);
    check("balance unchanged by the re-import", Math.abs(balBefore - (await h.accountBalance("QA Bank")).currentBalance - 640) < 0.01);
    check("the person/split was NOT silently re-applied", !after[0]?.linkedPersonId && (await h.list("expenses")).length === expensesBefore);
    await h.shot(page, "sms-9-reimport");
  } finally {
    await setRules(ALLOW_ALL).catch(() => {});
  }
});

scenario("sms-13-bulk-split-fails-after-import", "Bulk import where the People/Split step fails for every row: transactions exist once each, each row gets a persistent notice, nothing is retried", async ({ page }, check) => {
  const uid = await h.authUid();
  const bank = await h.accountBalance("QA Bank");
  await putCandidate(uid, { id: "sms-blk-spl-0001", amount: 211, merchant: "Chaayos", accountId: bank.id, daysAgo: 1 });
  await putCandidate(uid, { id: "sms-blk-spl-0002", amount: 212, merchant: "Dunzo", accountId: bank.id, daysAgo: 2 });
  await page.goto(`${BASE_URL}/transaction-candidates`, { waitUntil: "domcontentloaded" });
  await page.getByText("Chaayos").first().waitFor({ timeout: 60000 });
  const txnsBefore = (await h.list("transactions")).length;
  const expensesBefore = (await h.list("expenses")).length;
  const balBefore = (await h.accountBalance("QA Bank")).currentBalance;
  try {
    await setRules(ONLY_TRANSACTION_WRITES);
    await page.getByRole("checkbox", { name: /Select all visible/ }).click();
    await page.getByRole("button", { name: /Import selected \(2\)/ }).click();
    const dialog = page.getByRole("dialog").first();
    await dialog.getByText(/Import 2 transactions/).waitFor({ timeout: 20000 });
    await dialog.getByRole("combobox").nth(0).click();
    await page.getByRole("option").first().click();
    await dialog.getByRole("combobox").nth(2).click();
    await page.getByRole("option", { name: /QA Priya/ }).click();
    await dialog.getByRole("switch").click();
    await dialog.getByRole("button", { name: /^Import 2/ }).click();

    const banner = page.getByTestId("partial-import-notices");
    await banner.waitFor({ timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="partial-import-notices"] [role="alert"]').length === 2, null, { timeout: 30000 });
    check("each row gets its own persistent notice (2)", (await banner.getByRole("alert").count()) === 2);
    const text = await banner.innerText();
    check("the notices say the transactions already exist as plain expenses and the balance is updated", /already exists as a plain expense/.test(text) && /balance is already updated/.test(text));
    check("they name the merchants", /Chaayos/.test(text) && /Dunzo/.test(text));
    check("NO raw Firestore / permission text appears", !/PERMISSION_DENIED|FirebaseError|Missing or insufficient/i.test(await page.locator("body").innerText()));
    const sms = (await h.list("transactions")).filter((t) => t.source === "sms");
    check("exactly one transaction per row, none duplicated", sms.length === 2 && new Set(sms.map((t) => t.id)).size === 2 && (await h.list("transactions")).length === txnsBefore + 2, sms.length);
    check("balance debited once for each (₹211 + ₹212)", Math.abs(balBefore - (await h.accountBalance("QA Bank")).currentBalance - 423) < 0.01);
    check("no expense / split record was left behind", (await h.list("expenses")).length === expensesBefore);
    check("neither candidate was deleted or retried", (await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsTransactionCandidates/sms-blk-spl-0001`, { headers: OWNER })).ok && (await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsTransactionCandidates/sms-blk-spl-0002`, { headers: OWNER })).ok);
    check("the rows left the selection, so a second click can't re-run them blindly", (await page.getByRole("region", { name: "Bulk actions" }).count()) === 0);
    await sleep(7000);
    check("the notices are still there after the toast window", (await banner.getByRole("alert").count()) === 2);
    await h.shot(page, "sms-13-bulk-partial");
    await banner.getByRole("button", { name: /Close notice for Chaayos/ }).click();
    check("a notice can be closed by the reviewer, one at a time", (await banner.getByRole("alert").count()) === 1);
  } finally {
    await setRules(ALLOW_ALL).catch(() => {});
  }
});
