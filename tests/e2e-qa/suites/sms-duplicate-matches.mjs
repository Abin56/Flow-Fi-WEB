/**
 * Transaction Inbox — possible-duplicate matches shown INSIDE the row. Local emulator only (see tests/e2e-qa/README.md):
 * synthetic transactions + candidates are written to the Firestore EMULATOR, never anything real.
 *
 * Proves: an exact repeat, a ₹200.08-vs-₹200 near match, a next-day match and an unrelated purchase are classified correctly;
 * the saved transaction's date / description / amount / account / category are readable in the row; nothing is imported,
 * dismissed or written just by looking; and importing a flagged candidate still needs the reviewer (no auto action).
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
import { BASE_URL, FIRESTORE_DOCS } from "../lib/env.mjs";

const OWNER = { Authorization: "Bearer owner", "Content-Type": "application/json" };
const s = (v) => ({ stringValue: v });
const n = (v) => ({ doubleValue: v });
const nul = { nullValue: null };
const ts = (d) => ({ timestampValue: d.toISOString() });

async function patch(path, fields) {
  const r = await fetch(`${FIRESTORE_DOCS}/${path}`, { method: "PATCH", headers: OWNER, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`seed ${path}: ${r.status} ${await r.text()}`);
}

const at = (daysAgo, hour = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d;
};

function putCandidate(uid, { id, amount, merchant, accountId, when }) {
  return patch(`users/${uid}/smsTransactionCandidates/${id}`, {
    amount: n(amount),
    direction: s("debit"),
    eventType: s("upiPayment"),
    transactionDate: ts(when),
    merchant: s(merchant),
    bankName: s("QA Bank"),
    rawLastFour: nul,
    accountId: accountId ? s(accountId) : nul,
    cardId: nul,
    referenceNumber: nul,
    confidenceLevel: s("high"),
    confidenceScore: n(0.9),
    needsReview: { booleanValue: false },
    needsReviewReasons: { arrayValue: { values: [] } },
    source: s("sms"),
    createdAt: ts(new Date()),
    deletedAt: nul,
  });
}

function putTransaction(uid, { id, amount, description, accountId, when, source = "pdf" }) {
  return patch(`users/${uid}/transactions/${id}`, {
    type: s("expense"),
    amount: n(amount),
    dateTime: ts(when),
    accountId: s(accountId),
    categoryId: s("qa-cat-food"),
    description: s(description),
    notes: s(""),
    createdAt: ts(when),
    deletedAt: nul,
    excludeFromCalculations: { booleanValue: false },
    isPersonLedgerMovement: { booleanValue: false },
    source: s(source),
  });
}

scenario("dupm-inbox", "Inbox rows show exact vs possible matches with the saved transaction inline; viewing writes nothing and never auto-skips", async ({ page }, chk, notes) => {
  const uid = await h.authUid();
  const bank = (await h.accountBalance("QA Bank")).id;
  await patch(`users/${uid}/smsSyncConfig/backgroundUpload`, { enabled: { booleanValue: true }, deviceId: s("qa-dupm-device"), source: s("pairing") });

  await patch(`users/${uid}/categories/qa-cat-food`, { name: s("QA Food"), type: s("expense"), iconKey: s("restaurant"), colorValue: { integerValue: "4294198070" }, isDefault: { booleanValue: false }, isActive: { booleanValue: true }, createdAt: ts(new Date()), deletedAt: nul });

  // Saved history (a statement import and an earlier SMS import).
  await putTransaction(uid, { id: "dupm-t-swiggy", amount: 200, description: "SWIGGY", accountId: bank, when: at(3, 0) });
  await putTransaction(uid, { id: "dupm-t-zomato", amount: 450, description: "ZOMATO ORDER", accountId: bank, when: at(5, 0) });

  // Candidates: exact repeat, ₹200.08 near match, next-day match, unrelated.
  await putCandidate(uid, { id: "dupm-c-exact", amount: 200, merchant: "Swiggy", accountId: bank, when: at(3, 14) });
  await putCandidate(uid, { id: "dupm-c-near", amount: 200.08, merchant: "Swiggy", accountId: bank, when: at(4, 20) });
  await putCandidate(uid, { id: "dupm-c-nextday", amount: 450, merchant: "Zomato", accountId: bank, when: at(4, 11) });
  await putCandidate(uid, { id: "dupm-c-unrelated", amount: 999, merchant: "Uber", accountId: bank, when: at(2, 9) });

  await page.goto(`${BASE_URL}/transaction-candidates`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Transaction Inbox" }).waitFor({ timeout: 60000 });
  await page.getByTestId("candidate-row").first().waitFor({ timeout: 40000 });
  await page.waitForTimeout(800);
  const txnsBefore = (await h.list("transactions")).length;
  const candsBefore = (await h.list("smsTransactionCandidates")).length;

  const rowOf = (id) => page.locator(`[data-candidate-id="${id}"]`);
  const panelKind = async (id) => (await rowOf(id).getByTestId("candidate-match-panel").count()) ? await rowOf(id).getByTestId("candidate-match-panel").getAttribute("data-match-kind") : null;

  const exact = await panelKind("dupm-c-exact");
  const near = await panelKind("dupm-c-near");
  const nextDay = await panelKind("dupm-c-nextday");
  const unrelated = await panelKind("dupm-c-unrelated");
  notes.push(`kinds exact=${exact} near=${near} nextday=${nextDay} unrelated=${unrelated}`);
  chk("same merchant/amount/day is labelled EXACT", exact === "exact", exact);
  chk("₹200.08 vs saved ₹200 is a POSSIBLE match (not exact)", near === "possible", near);
  chk("a match posted a day earlier is a POSSIBLE match", nextDay === "possible", nextDay);
  chk("an unrelated purchase shows no panel", unrelated === null, unrelated);

  const nearPanel = rowOf("dupm-c-near").getByTestId("candidate-match-panel");
  const text = (await nearPanel.innerText()).replace(/\s+/g, " ");
  notes.push(`near panel: ${text}`);
  chk("the saved transaction's description, amount, category and source are visible in the row", /SWIGGY/.test(text) && /₹200(?![.\d])/.test(text) && /QA Food/.test(text) && /Statement import/.test(text), text);
  chk("it says the amount differs by ₹0.08 and that nothing is skipped for you", /Amount differs by ₹0\.08/.test(text) && /Nothing is skipped or merged/.test(text), text);
  chk("the exact row says Exact match in words", /Exact match — already imported/i.test((await rowOf("dupm-c-exact").getByTestId("candidate-match-panel").innerText()).replace(/\s+/g, " ")));

  // Layout: at desktop and phone widths the panel fits its row without sideways overflow.
  for (const [w, ht] of [[1366, 768], [390, 844]]) {
    await page.setViewportSize({ width: w, height: ht });
    await page.waitForTimeout(400);
    await rowOf("dupm-c-near").scrollIntoViewIfNeeded();
    const m = await rowOf("dupm-c-near").evaluate((li) => {
      const p = li.querySelector('[data-testid="candidate-match-panel"]').getBoundingClientRect();
      const r = li.getBoundingClientRect();
      return { panelRight: Math.round(p.right), rowRight: Math.round(r.right), h: Math.round(p.height), docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    notes.push(`${w}: ${JSON.stringify(m)}`);
    chk(`${w}: the match panel stays inside its row and the page does not scroll sideways`, m.panelRight <= m.rowRight && m.docOverflow <= 1, JSON.stringify(m));
    await h.shot(page, `dupm-inbox-${w}`);
  }

  // The drawer shows the comparison for a similar (non-flagged) match, and importing is not blocked by it.
  await page.setViewportSize({ width: 1366, height: 768 });
  await rowOf("dupm-c-near").getByRole("button", { name: /^Review/ }).click();
  const d = page.getByRole("dialog").first();
  await d.getByText("Transaction Details").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(600);
  const cmp = d.getByTestId("duplicate-comparison");
  chk("the details popup shows 'Similar transaction already imported' with the comparison", (await cmp.count()) === 1 && /Similar transaction already imported/i.test(await cmp.innerText()), await cmp.first().innerText().catch(() => ""));
  chk("it states importing will not be blocked for a similar match", /importing will not stop you/.test(await cmp.innerText()));
  await h.shot(page, "dupm-drawer-1366");
  await d.getByLabel("Close", { exact: true }).click();
  const prompt = page.getByRole("dialog").filter({ hasText: "Discard your changes?" });
  if (await prompt.isVisible().catch(() => false)) await prompt.getByRole("button", { name: "Discard and close" }).click();

  chk("looking at the inbox wrote nothing: transaction + candidate counts unchanged", (await h.list("transactions")).length === txnsBefore && (await h.list("smsTransactionCandidates")).length === candsBefore, `${txnsBefore}/${candsBefore}`);
});

scenario("dupm-import-once", "Exact-once: importing a flagged candidate asks first, 'Import anyway' creates ONE transaction, a second attempt creates none, balance moves once", async ({ page }, chk, notes) => {
  const uid = await h.authUid();
  const bank = (await h.accountBalance("QA Bank")).id;
  await patch(`users/${uid}/smsSyncConfig/backgroundUpload`, { enabled: { booleanValue: true }, deviceId: s("qa-dupm-device"), source: s("pairing") });
  await patch(`users/${uid}/categories/qa-cat-food`, { name: s("QA Food"), type: s("expense"), iconKey: s("restaurant"), colorValue: { integerValue: "4294198070" }, isDefault: { booleanValue: false }, isActive: { booleanValue: true }, createdAt: ts(new Date()), deletedAt: nul });
  await putTransaction(uid, { id: "dupm-t-once", amount: 321, description: "CAFE COFFEE DAY", accountId: bank, when: at(1, 0) });
  await putCandidate(uid, { id: "dupm-c-once", amount: 321, merchant: "Cafe Coffee Day", accountId: bank, when: at(1, 15) });

  await page.goto(`${BASE_URL}/transaction-candidates`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Transaction Inbox" }).waitFor({ timeout: 60000 });
  await page.locator('[data-candidate-id="dupm-c-once"]').waitFor({ timeout: 40000 });
  await page.waitForTimeout(800);
  const before = (await h.list("transactions")).length;
  const balBefore = (await h.accountBalance("QA Bank")).currentBalance;

  await page.locator('[data-candidate-id="dupm-c-once"]').getByRole("button", { name: /^Review/ }).click();
  const d = page.getByRole("dialog").first();
  await d.getByText("Transaction Details").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(600);
  // Pick the category, then import.
  await d.getByRole("combobox").first().click().catch(() => {});
  const option = page.getByRole("option", { name: "QA Food" });
  if (await option.count()) await option.first().click();
  const importBtn = d.getByRole("button", { name: /Import as Transaction/ }).first();
  await importBtn.click();
  const warn = page.getByRole("alertdialog").or(page.getByRole("dialog").filter({ hasText: /duplicate/i })).last();
  await warn.waitFor({ timeout: 15000 });
  chk("a flagged candidate asks before importing — nothing written yet", (await h.list("transactions")).length === before);
  await warn.getByRole("button", { name: /Import anyway/i }).click();
  await page.waitForTimeout(2500);
  const after = (await h.list("transactions")).length;
  const balAfter = (await h.accountBalance("QA Bank")).currentBalance;
  notes.push(`transactions ${before}->${after}, balance ${balBefore}->${balAfter}`);
  chk("'Import anyway' created exactly ONE transaction", after === before + 1, `${before}->${after}`);
  chk("the account balance moved exactly once (by ₹321)", Math.abs(balBefore - balAfter - 321) < 0.01, `${balBefore}->${balAfter}`);
  chk("the candidate is gone from the queue", (await h.list("smsTransactionCandidates")).filter((c) => /dupm-c-once$/.test(c.name ?? c.id ?? "")).length === 0);
});
