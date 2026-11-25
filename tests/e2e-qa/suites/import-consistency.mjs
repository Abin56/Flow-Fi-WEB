/**
 * Cross-module import consistency in the browser (local emulator only): one Smart Capture row and one SMS candidate,
 * each paid for a person, must read the same description in Import Review, Transactions and the People ledger —
 * never the bank narration — and be labelled "For <person>", while stored money moves exactly once.
 */
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from "pdf-lib";
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
import * as f from "../lib/flows.mjs";
import { sameDayIso } from "../lib/inbox-days.mjs";
import { BASE_URL, FIRESTORE_DOCS } from "../lib/env.mjs";

const RAW = "UPI1/627632125367/DR/Jio Pr/YESB/paytm-jio/UPI";
const today = new Date();
const ddmmyyyy = `${String(today.getDate()).padStart(2, "0")}/${String(today.getMonth() + 1).padStart(2, "0")}/${today.getFullYear()}`;
const bank = async () => (await h.accountBalance("QA Bank")).currentBalance;
const text = async (locator) => (await locator.allInnerTexts()).join("\n").replace(/[ \t]+/g, " ");

/** The Transactions row for `description`, and the People "Money in & out" row + its details for the same record. */
async function viewBoth(page, chk, label, description, personName, shot) {
  await h.go(page, "/transactions");
  const txnRow = page.locator("tr, article, li").filter({ hasText: description }).first();
  await txnRow.waitFor({ timeout: 60000 });
  const shown = await text(txnRow);
  chk(`${label} · Transactions shows the approved description`, shown.includes(description), shown);
  chk(`${label} · Transactions labels it For ${personName}, not Split`, shown.includes(`For ${personName}`) && !/\bSplit\b/.test(shown), shown);
  await h.shot(page, `${shot}-transactions`);

  await f.openPerson(page, personName);
  const moneyRow = page.getByTestId("money-row").filter({ hasText: description }).first();
  await moneyRow.waitFor({ timeout: 60000 }).catch(() => undefined);
  const all = await text(page.getByTestId("money-in-out-list"));
  chk(`${label} · People Transactions shows the approved description`, all.includes(description), all.slice(0, 600));
  chk(`${label} · People Transactions shows no bank narration or import marker`, !/Bank narration|Imported via|627632125367/.test(all), all.slice(0, 600));
  await moneyRow.getByTestId("money-details").click();
  const details = await text(page.getByTestId("money-details-panel"));
  chk(`${label} · People row details read the same description`, details.includes(description) && !/Bank narration|Imported via/.test(details), details);
  chk(`${label} · People row details show no Split table for a paid-for-them item`, (await page.getByTestId("money-split").count()) === 0);
  await h.shot(page, `${shot}-people`);

  await f.showPersonTab(page, "Overview");
  const overview = await text(page.locator("main"));
  chk(`${label} · Open items says "You paid for", not "Money I Gave"`, (await text(page.getByTestId("open-items"))).includes("You paid for") && !(await text(page.getByTestId("open-items"))).includes("Money I Gave"));
  chk(`${label} · People Overview shows it, without the narration`, overview.includes(description) && !/Bank narration|Imported via|627632125367/.test(overview), overview.slice(0, 900));
  await h.shot(page, `${shot}-overview`);

  await page.getByRole("button", { name: /^Share/ }).filter({ visible: true }).first().click();
  await page.waitForTimeout(2500);
  const share = await text(page.locator("body"));
  chk(`${label} · Share Statement shows the description, tagged For you, without the narration`, share.includes(description) && /For you/i.test(share) && !/Bank narration|627632125367/.test(share), share.slice(0, 900));
  await h.shot(page, `${shot}-share`);
}

scenario("impc-smart-capture", "Smart Capture paid-for-someone: same description everywhere, never the narration", async ({ page }, chk, notes) => {
  const before = await bank();
  const txnsBefore = (await h.list("transactions")).length;
  await page.evaluate(() => window.next.router.push("/reconciliation"));
  await page.getByRole("heading", { name: /Review & Import/ }).waitFor({ timeout: 240000 }); // first compile is slow
  // The second row stays in the review: with nothing left, the screen would leave before the row reads Imported.
  await page.getByRole("textbox", { name: "Statement rows" }).fill(`${ddmmyyyy}\t${RAW}\t299.00 Dr\n${ddmmyyyy}\tSECOND ROW LEFT IN REVIEW\t11.00 Dr`);
  await page.getByRole("button", { name: "Compare rows" }).click();
  await page.getByRole("button", { name: /(Choose|Change) statement account/ }).click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  const row = page.getByTestId("recon-row").first();
  await page.waitForFunction(() => document.querySelector('[data-testid="recon-row"]')?.getAttribute("data-state") !== "pending", null, { timeout: 90000 });
  await page.waitForTimeout(600);
  const approved = await row.getAttribute("data-display-description");
  notes.push(`approved=${approved}`);
  chk("Import Review shows the clean description", approved === "Jio Mobile Recharge · UPI", approved);
  const unknown = page.getByTestId("recon-row").nth(1);
  chk("unknown payee: no category is guessed and the row is not Ready", (await unknown.getByTestId("row-category").inputValue()) === "" && (await unknown.getAttribute("data-status")) !== "ready", await unknown.getAttribute("data-status"));
  await row.getByTestId("row-edit").click();
  const panel = page.getByTestId("row-editor-panel");
  await panel.getByRole("radio", { name: "Someone else's expense" }).click();
  await panel.getByTestId("ownership-person").getByRole("combobox", { name: "Person" }).click();
  await page.getByRole("option", { name: /QA Ravi/ }).click();
  await panel.getByTestId("editor-close").click();
  await page.waitForTimeout(600);
  await row.getByTestId("row-import").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="recon-row"]')?.getAttribute("data-status") === "imported", null, { timeout: 90000 });

  const made = (await h.list("transactions")).filter((t) => !t.deletedAt && /627632125367/.test(t.notes ?? ""));
  chk("one new transaction", made.length === 1 && (await h.list("transactions")).length === txnsBefore + 1, `${made.length}`);
  const t = made[0];
  const cats = await h.list("categories");
  notes.push(JSON.stringify({ description: t.description, amount: t.amount, type: t.type, category: cats.find((c) => c.id === t.categoryId)?.name, notes: t.notes }));
  chk("stored description / amount / direction = approved", t.description === approved && t.amount === 299 && t.type === "expense", JSON.stringify(t));
  chk("stored category = the automatically selected one", /Bills/.test(cats.find((c) => c.id === t.categoryId)?.name ?? ""), t.categoryId);
  const expense = (await h.list("expenses")).find((e) => e.transactionId === t.id);
  chk("the Expense carries the same description and category; my share is ₹0", expense?.description === approved && expense?.categoryId === t.categoryId && expense.participants.filter((p) => p.isMe).every((p) => p.share === 0), JSON.stringify(expense));
  chk("bank debited exactly once", before - (await bank()) === 299, `${before} → ${await bank()}`);

  const afterImport = await bank();
  await viewBoth(page, chk, "Smart Capture", approved, "QA Ravi", "impc-sc");
  chk("viewing moved no money and added no transaction", (await bank()) === afterImport && (await h.list("transactions")).length === txnsBefore + 1);

  await h.go(page, "/month-cycle");
  await page.locator('section[aria-label="Cycle summary"]').getByRole("button", { name: "View list" }).click({ timeout: 180000 });
  await page.getByRole("dialog").getByRole("radio", { name: "Combined" }).click();
  const spendRow = page.getByRole("dialog").locator("tr").filter({ hasText: approved }).first();
  await spendRow.waitFor({ state: "attached", timeout: 120000 }).catch(() => undefined);
  const spend = (await spendRow.count()) ? await spendRow.innerText() : "(row not found)";
  chk("Month Cycle badge reads For QA Ravi, not Split", spend.includes("For QA Ravi") && !/Split/.test(spend), spend);

  await h.go(page, "/history");
  await page.getByText("For QA Ravi").first().waitFor({ timeout: 120000 }).catch(() => undefined);
  const history = await text(page.locator("main"));
  chk("History labels it Paid for someone / For QA Ravi", history.includes("Paid for someone") && history.includes("For QA Ravi"), history.slice(0, 900));
  chk("History shows the description, never the narration", history.includes(approved) && !/Bank narration|627632125367/.test(history), history.slice(0, 900));
  chk("History still calls the real split a shared expense", history.includes("Shared expenses"), history.slice(0, 900));
  await h.shot(page, "impc-history");

  // A rename that reaches only the transaction (what the Statement Review edit path does).
  const renamed = "Jio recharge renamed later";
  const patch = await fetch(`${FIRESTORE_DOCS}/users/${await h.authUid()}/transactions/${t.id}?updateMask.fieldPaths=description`, { method: "PATCH", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" }, body: JSON.stringify({ fields: { description: { stringValue: renamed } } }) });
  if (!patch.ok) throw new Error(`rename: ${patch.status}`);
  const entriesBefore = JSON.stringify(await h.list("expenses"));
  await f.openPerson(page, "QA Ravi", { tab: "Overview" });
  await page.getByText(renamed).first().waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: /^Share/ }).filter({ visible: true }).first().click();
  await page.waitForTimeout(2500);
  for (const name of ["Full PDF", "Monthly PDF"]) {
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 90000 }), page.getByRole("button", { name }).click()]);
    const drawn = await pdfText(await download.path());
    chk(`downloaded ${name}: drawn with the embedded Inter face`, /Inter/.test(drawn.fonts), drawn.fonts);
    chk(`downloaded ${name}: renamed description, no old wording or narration`, drawn.text.includes("Jio recharge renamed later") && !/Jio Mobile Recharge|627632125367|Bank narration/.test(drawn.text), drawn.text.slice(0, 900));
    await page.waitForTimeout(800);
  }
  await page.keyboard.press("Escape");
  await h.go(page, "/history");
  await page.getByText(renamed).first().waitFor({ timeout: 90000 }).catch(() => undefined);
  const after = await text(page.locator("main"));
  chk("History after the rename shows the new wording, same Paid for someone label", after.includes(renamed) && after.includes("Paid for someone") && !after.includes("Jio Mobile Recharge"), after.slice(0, 700));
  chk("rename + PDF moved no money and rewrote no Expense", (await bank()) === afterImport && JSON.stringify(await h.list("expenses")) === entriesBefore);
});

/** The text a PDF draws, decoded through each font's own ToUnicode map (so the embedded Inter face reads too). */
async function pdfText(file) {
  const doc = await PDFDocument.load(readFileSync(file));
  const open = (stream) => { try { return inflateSync(Buffer.from(stream.contents)).toString("latin1"); } catch { return Buffer.from(stream.contents).toString("latin1"); } };
  const out = [];
  const embedded = new Set();
  for (const page of doc.getPages()) {
    const maps = new Map();
    const fonts = page.node.Resources()?.lookup(PDFName.of("Font"), PDFDict);
    for (const [name, ref] of fonts?.entries() ?? []) {
      const font = doc.context.lookup(ref, PDFDict);
      embedded.add(String(font.get(PDFName.of("BaseFont"))));
      const cmap = font.get(PDFName.of("ToUnicode"));
      if (!cmap) continue;
      const glyphs = new Map();
      for (const block of open(doc.context.lookup(cmap)).matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
        for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) glyphs.set(parseInt(m[1], 16), String.fromCharCode(...m[2].match(/.{4}/g).map((h) => parseInt(h, 16))));
      maps.set(name.asString().slice(1), glyphs);
    }
    const contents = page.node.Contents();
    const body = (contents instanceof PDFArray ? contents.asArray() : [contents]).map((r) => open(r instanceof PDFRef ? doc.context.lookup(r) : r)).join("\n");
    let glyphs;
    for (const m of body.matchAll(/\/([^\s/]+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]*)>\s*Tj/g)) {
      if (m[1] != null) glyphs = maps.get(m[1]);
      else out.push(glyphs ? (m[2].match(/.{4}/g) ?? []).map((h) => glyphs.get(parseInt(h, 16)) ?? "?").join("") : Buffer.from(m[2], "hex").toString("latin1"));
    }
  }
  return { text: out.join(" "), fonts: [...embedded].join(" ") };
}

scenario("impc-sms", "SMS candidate with a typed description, paid for someone: same description everywhere", async ({ page }, chk) => {
  const uid = await h.authUid();
  const account = await h.accountBalance("QA Bank");
  const before = account.currentBalance;
  const txnsBefore = (await h.list("transactions")).length;
  await h.seedSmsPaired();
  const s = (v) => ({ stringValue: v });
  const nul = { nullValue: null };
  const fields = {
    amount: { doubleValue: 239 }, direction: s("debit"), eventType: s("upiPayment"), transactionDate: { timestampValue: sameDayIso(10) },
    merchant: s("JIO PREPAID"), bankName: s("QA Bank"), rawLastFour: nul, accountId: s(account.id), cardId: nul, referenceNumber: nul,
    confidenceLevel: s("high"), confidenceScore: { doubleValue: 0.9 }, needsReview: { booleanValue: false }, needsReviewReasons: { arrayValue: { values: [] } },
    source: s("sms"), createdAt: { timestampValue: new Date().toISOString() }, deletedAt: nul, originalMessage: s("Rs.239 paid to JIO PREPAID RECHARGE via UPI"),
  };
  const put = await fetch(`${FIRESTORE_DOCS}/users/${uid}/smsTransactionCandidates/impc-jio`, { method: "PATCH", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" }, body: JSON.stringify({ fields }) });
  if (!put.ok) throw new Error(`seed: ${put.status}`);
  await page.goto(`${BASE_URL}/transaction-candidates`, { waitUntil: "domcontentloaded", timeout: 240000 });
  const candidate = page.getByTestId("candidate-row").filter({ hasText: "JIO" }).first();
  await candidate.getByRole("button", { name: /^Review/ }).click({ timeout: 60000 });
  const dialog = page.getByRole("dialog").first();
  const approved = "Amma's Jio recharge";
  await dialog.getByTestId("candidate-description").fill(approved);
  const categoryBox = dialog.getByRole("combobox").nth(0);
  await categoryBox.click();
  await page.getByRole("option", { name: /Shopping/ }).first().click();
  await dialog.getByRole("radio", { name: "Someone else's expense" }).click();
  await dialog.getByRole("combobox", { name: "Assign to a person" }).click();
  await page.getByRole("option", { name: /QA Priya/ }).click();
  await dialog.getByRole("switch").first().click(); // "This person owes me this expense" is off by default
  await dialog.getByRole("button", { name: "Import as Transaction" }).click();
  await candidate.waitFor({ state: "detached", timeout: 60000 });
  await page.waitForTimeout(1500);

  const made = (await h.list("transactions")).filter((t) => !t.deletedAt && t.description === approved);
  chk("one new transaction with the typed description", made.length === 1 && (await h.list("transactions")).length === txnsBefore + 1, `${made.length}`);
  const t = made[0];
  const cats = await h.list("categories");
  chk("amount 239, expense, manual category Shopping kept", t.amount === 239 && t.type === "expense" && cats.find((c) => c.id === t.categoryId)?.name === "Shopping", JSON.stringify(t));
  const expense = (await h.list("expenses")).find((e) => e.transactionId === t.id);
  chk("Expense: same description; Priya owes 239, my share ₹0", expense?.description === approved && expense.participants.filter((p) => !p.isMe).map((p) => p.share).join() === "239" && expense.participants.filter((p) => p.isMe).every((p) => p.share === 0), JSON.stringify(expense));
  chk("bank debited exactly once", before - (await bank()) === 239, `${before} → ${await bank()}`);

  const afterImport = await bank();
  await viewBoth(page, chk, "SMS", approved, "QA Priya", "impc-sms");
  chk("viewing moved no money and added no transaction", (await bank()) === afterImport && (await h.list("transactions")).length === txnsBefore + 1);
});

scenario("impc-studio-category", "Statement Review: editing an imported row's category picks the expense one of two namesakes, on the same transaction", async ({ page }, chk) => {
  // The income namesake sorts first, which is what a name-only lookup would take.
  for (const [id, type] of [["aa-gifts-income", "income"], ["zz-gifts-expense", "expense"]]) {
    await h.createDocUnderUser(`categories/${id}`, { id, name: "Gifts", type, iconKey: "other", colorValue: 0, createdAt: new Date(), isDefault: false, isActive: true, deletedAt: null, lastEditedAt: null, editHistory: [] });
  }
  const txn = (await h.list("transactions")).find((t) => !t.deletedAt && t.type === "expense" && t.amount === 850);
  const cats = await h.list("categories");
  const card = (await h.list("creditCards"))[0];
  const when = new Date(txn.dateTime);
  await h.createDocUnderUser("financialDocuments/docimpc", { userId: "x", documentType: "credit_card_statement", accountId: card.id, fileHash: "h-impc", storagePath: "users/x/documents/credit_card_statement/impc.pdf", uploadedAt: new Date(), status: "parsed", bank: "HDFC", requiresPassword: false });
  await h.createDocUnderUser("documentImports/docimpc", { userId: "x", documentId: "docimpc", accountId: card.id, status: "draft", metadata: {}, summary: {}, createdAt: new Date() });
  await h.createDocUnderUser("documentImports/docimpc/records/r1", {
    recordType: "transaction", rawText: "IMPCROW", date: when, counterpartyRaw: "IMPCROW", counterpartyNormalized: txn.description, amount: txn.amount, direction: "debit", referenceNumber: null, currency: "INR",
    category: cats.find((c) => c.id === txn.categoryId)?.name ?? null, subcategory: null, confidenceScores: {}, sourcePage: 1, sourceLineIndex: 1, splitParentId: null, mergedInto: null, userEdited: false, lastEditedAt: null, lastEditedBy: null, tags: [], notes: txn.notes ?? "",
    duplicateOfTransactionId: null, include: true, flowType: "expense", ownership: "mine", modifiers: { business: false, recurring: false, splitByCategory: false }, actionDetail: null, committedTransactionId: txn.id,
    excludeFromCalculations: false, accountingMonth: null, suggestedCategory: null, suggestedAccount: null, suggestedPerson: null, suggestedTags: [], expenseType: null, transferDetected: false, recurringDetected: false, subscriptionDetected: false, duplicateCandidateOf: null, needsReview: false,
  });
  const before = { bank: await bank(), count: (await h.list("transactions")).length };

  await page.goto(`${BASE_URL}/statement-review/docimpc`, { waitUntil: "domcontentloaded", timeout: 240000 });
  await page.getByText(txn.description).first().waitFor({ timeout: 180000 });
  await page.waitForTimeout(2500);
  await h.shot(page, "impc-studio");
  const rowBox = await page.getByText("IMPCROW").first().boundingBox();
  const buttons = page.locator("button:has(svg)");
  // The row's own Action button: the one on the same line as the row.
  for (let i = 0; i < (await buttons.count()); i++) {
    const b = await buttons.nth(i).boundingBox();
    if (b && b.x > rowBox.x + 400 && Math.abs(b.y + b.height / 2 - (rowBox.y + rowBox.height / 2)) < 14) { await buttons.nth(i).click(); break; }
  }
  const dialog = page.getByRole("dialog").last();
  await dialog.getByRole("button", { name: "Save changes" }).waitFor({ timeout: 45000 });
  await page.waitForTimeout(1500);
  await dialog.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Gifts", exact: true }).first().click();
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await page.waitForTimeout(4000);
  const saved = (await h.list("transactions")).find((t) => t.id === txn.id);
  chk("the expense Gifts id is saved, not the income one", saved.categoryId === "zz-gifts-expense", saved.categoryId);
  chk("same transaction: amount, date, account, type and description unchanged", ["amount", "dateTime", "accountId", "type", "description"].every((k) => saved[k] === txn[k]), JSON.stringify([txn, saved]));
  chk("no new transaction and no balance change", (await h.list("transactions")).length === before.count && (await bank()) === before.bank, `${before.bank} → ${await bank()}`);
});
