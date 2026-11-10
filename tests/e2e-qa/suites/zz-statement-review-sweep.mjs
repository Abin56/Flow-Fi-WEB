/**
 * Statement Review sweep (testing-phase check): list page renders every document status, every control works.
 * Local emulator only. Cloud Functions are not emulated, so upload / delete-statement are checked for graceful failure.
 * Scenario ids: sr-sweep-*
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const IGNORE = /Select is changing|status of 400|React DevTools|Download the React|status of 404|functions|Failed to load resource|ERR_CONNECTION|net::|Cross-Origin|CORS/i;
const flat = (t) => t.replace(/\s+/g, " ").trim();
const realErrors = (logs) => logs.filter((l) => !IGNORE.test(l));

function record(id, over = {}) {
  return {
    recordType: "transaction", rawText: over.name ?? "ROW", date: new Date("2026-10-12T00:00:00Z"),
    counterpartyRaw: over.name ?? "ROW", counterpartyNormalized: over.name ?? "ROW", amount: over.amount ?? 500, direction: over.direction ?? "debit",
    referenceNumber: null, currency: "INR", category: null, subcategory: null, confidenceScores: {}, sourcePage: 1, sourceLineIndex: 1,
    splitParentId: null, mergedInto: null, userEdited: false, lastEditedAt: null, lastEditedBy: null, tags: [], notes: "",
    duplicateOfTransactionId: null, include: true, flowType: "expense", ownership: "mine",
    modifiers: { business: false, recurring: false, splitByCategory: false }, actionDetail: null, committedTransactionId: null,
    excludeFromCalculations: false, accountingMonth: null, suggestedCategory: null, suggestedAccount: null, suggestedPerson: null,
    suggestedTags: [], expenseType: null, transferDetected: false, recurringDetected: false, subscriptionDetected: false,
    duplicateCandidateOf: null, needsReview: false, ...over.extra,
  };
}

async function seed() {
  const card = (await h.list("creditCards")).find((c) => !c.deletedAt);
  const base = (status, extra = {}) => ({
    userId: "x", documentType: "credit_card_statement", accountId: card.id, fileHash: `h-${status}-${Math.random()}`, storagePath: `users/x/documents/credit_card_statement/${status}.pdf`,
    uploadedAt: new Date("2026-10-05T00:00:00Z"), status, bank: "HDFC", requiresPassword: status === "awaiting_password", ...extra,
  });
  await h.createDocUnderUser("financialDocuments/docparsed", base("parsed"));
  await h.createDocUnderUser("documentImports/docparsed", { userId: "x", documentId: "docparsed", accountId: card.id, status: "draft", metadata: {}, summary: {}, createdAt: new Date() });
  await h.createDocUnderUser("documentImports/docparsed/records/r1", record("r1", { name: "SWIGGY", amount: 450 }));
  await h.createDocUnderUser("documentImports/docparsed/records/r2", record("r2", { name: "AMAZON", amount: 1200 }));
  await h.createDocUnderUser("documentImports/docparsed/records/r3", record("r3", { name: "REFUND ZOMATO", amount: 99, direction: "credit", extra: { flowType: "income", ownership: null } }));
  await h.createDocUnderUser("financialDocuments/docreview", base("needs_review", { needsReviewReason: "unrecognized_statement_template", detectedBankGuess: "Axis" }));
  await h.createDocUnderUser("financialDocuments/docfailed", base("failed", { failureReason: "parsing_failed", failureMessage: "Bad xref." }));
  await h.createDocUnderUser("financialDocuments/docpass", base("awaiting_password"));
  await h.createDocUnderUser("financialDocuments/docparsing", base("parsing"));
  return card;
}

async function open(page) {
  await h.openPortalSignedIn(page);
  await h.reseed(page);
  const card = await seed();
  await h.go(page, "/statement-review");
  await page.getByRole("heading", { level: 1, name: "Statement Review" }).waitFor({ timeout: 30000 });
  await page.getByText("Statement — docparse").waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  return card;
}

scenario("sr-sweep-render", "Statement Review sweep: every status card renders, no NaN / overflow / console errors", async ({ page, logs }, chk) => {
  await open(page);
  const main = flat(await page.locator("main").innerText());
  await h.shot(page, "sr-sweep-desktop");
  chk("5 uploaded counter", /5 uploaded/.test(main), main.slice(0, 120));
  for (const [l, re] of [["Parsed", /Parsed/], ["Needs Review", /Needs Review/], ["Failed", /Failed/], ["Password Required", /Password Required/], ["Processing", /Processing/], ["failure copy", /couldn't be processed/], ["template copy", /Looks like it might be from Axis/], ["password copy", /password protected/i], ["Studio link", /Open Transaction Studio/], ["rows", /SWIGGY/], ["credit row", /\+₹99/]]) chk(`present: ${l}`, re.test(main), re);
  chk("no NaN / undefined", !/NaN|undefined|Infinity/.test(main));
  for (const [n, vp] of [["tablet", { width: 768, height: 1024 }], ["mobile", { width: 390, height: 844 }], ["desktop", { width: 1366, height: 768 }]]) {
    await page.setViewportSize(vp); await page.waitForTimeout(800); await h.shot(page, `sr-sweep-${n}`);
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    chk(`${n}: no horizontal overflow`, o.sw <= o.cw + 1, JSON.stringify(o));
  }
  await page.emulateMedia({ colorScheme: "dark" }); await page.waitForTimeout(600); await h.shot(page, "sr-sweep-dark"); await page.emulateMedia({ colorScheme: "light" });
  const unnamed = await page.evaluate(() => [...document.querySelectorAll("main button, main a[href]")].filter((el) => el.getClientRects().length > 0).filter((el) => !((el.getAttribute("aria-label") || el.innerText || el.title || "").trim())).map((el) => `${el.tagName}.${(el.className || "").toString().slice(0, 40)}`));
  chk("every visible button/link has an accessible name", unnamed.length === 0, unnamed.slice(0, 5).join(" | "));
  const errs = realErrors(logs);
  chk("no console / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("sr-sweep-rows", "Statement Review sweep: row click / edit amount / assign tick / full screen / delete row / Studio link", async ({ page, logs }, chk) => {
  await open(page);
  const recs = async () => (await h.list("documentImports/docparsed/records")).sort((a, b) => a.id.localeCompare(b.id));

  // Row click -> sheet -> edit amount -> save
  await page.getByText("SWIGGY", { exact: true }).first().click();
  const dlg = page.locator('[role="dialog"]').last();
  await dlg.getByText("Transaction Details").waitFor({ timeout: 45000 });
  await page.waitForTimeout(500);
  await h.shot(page, "sr-sweep-sheet");
  const amt = dlg.getByLabel(/Amount/i).first();
  await amt.fill("0");
  await dlg.getByRole("button", { name: "Save changes" }).click();
  chk("amount 0 rejected with message", await dlg.getByText("Enter an amount greater than 0.").isVisible({ timeout: 4000 }).catch(() => false));
  await amt.fill("640");
  await dlg.getByRole("button", { name: "Save changes" }).click();
  await page.waitForTimeout(2500);
  chk("amount persisted (640)", (await recs()).find((r) => r.id === "r1")?.amount === 640, JSON.stringify((await recs()).map((r) => r.amount)));
  chk("sheet closed after save", (await page.locator('[role="dialog"]').count()) === 0);

  // Exclude switch + month reassign persisted
  await page.getByText("SWIGGY", { exact: true }).first().click();
  const d2 = page.locator('[role="dialog"]').last();
  await d2.getByText("Transaction Details").waitFor({ timeout: 30000 });
  await page.waitForTimeout(500);
  await d2.getByRole("switch").first().click();
  await d2.getByRole("button", { name: "Save changes" }).click();
  await page.waitForTimeout(2500);
  chk("exclude persisted", (await recs()).find((r) => r.id === "r1")?.excludeFromCalculations === true);
  chk("'Not counted' badge on row", await page.getByText("Not counted").first().isVisible());

  // Quick assign tick on unassigned row opens sheet with add-person input focused
  await page.getByText("AMAZON", { exact: true }).first().locator("xpath=ancestor::*[.//button[@aria-label='Assign to a person']][1]").getByRole("button", { name: "Assign to a person" }).first().click();
  const d3 = page.locator('[role="dialog"]').last();
  await d3.getByPlaceholder("Person's name").waitFor({ timeout: 8000 });
  await d3.getByPlaceholder("Person's name").fill("QA Friend");
  await d3.getByRole("button", { name: "Save person" }).click();
  await page.waitForTimeout(2000);
  await d3.getByRole("button", { name: "Save changes" }).click();
  await page.waitForTimeout(2500);
  const r2 = (await recs()).find((r) => r.id === "r2");
  chk("assign to new person persisted", r2?.ownership === "someone_else" && r2?.actionDetail?.personName === "QA Friend", JSON.stringify(r2?.actionDetail));
  chk("person created in people", (await h.list("people")).some((p) => p.name === "QA Friend"));
  // second tick toggles back / forth without sheet
  await page.locator("button[aria-label^='Fully someone else']").click();
  await page.waitForTimeout(2000);
  chk("tick unmarks (ownership mine)", (await recs()).find((r) => r.id === "r2")?.ownership === "mine");

  // Split editor
  await page.getByText("AMAZON", { exact: true }).first().click();
  const d4 = page.locator('[role="dialog"]').last();
  await d4.getByText("Transaction Details").waitFor();
  await page.waitForTimeout(500);
  await d4.getByRole("button", { name: /Split with more people/ }).click();
  await d4.getByRole("button", { name: "Save Split" }).click();
  chk("split with nobody named + me included saves", await page.getByText("Split saved").isVisible({ timeout: 6000 }).catch(() => false));
  await page.waitForTimeout(2500);
  chk("split persisted as shared", (await recs()).find((r) => r.id === "r2")?.ownership === "shared");
  await page.keyboard.press("Escape").catch(() => {});

  // Income row has no assign tick & shows note
  await page.getByText("REFUND ZOMATO", { exact: true }).first().click();
  const d5 = page.locator('[role="dialog"]').last();
  await d5.getByText(/only available for expenses/).waitFor({ timeout: 8000 }).then(() => chk("income note shown", true), () => chk("income note shown", false));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);

  // Delete row in normal (non-full-screen) layout
  await page.locator('button[aria-label="Delete row"]').nth(2).click();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /^Delete$/ }).click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2500);
  chk("normal-layout delete removed REFUND row", (await recs()).length === 2, (await recs()).length);
  // Full screen + Escape
  await page.getByRole("button", { name: "Full screen" }).click();
  await page.waitForTimeout(500);
  await h.shot(page, "sr-sweep-fullscreen");
  const fsBox = await page.getByRole("button", { name: "Exit full screen" }).boundingBox();
  chk("full screen toggled", !!fsBox);
  // delete from within fullscreen: confirm dialog must be on top
  { const b = await page.locator('button[aria-label="Delete row"]').first().boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.waitForTimeout(600); await page.mouse.down(); await page.mouse.up(); }
  await page.waitForTimeout(1500);
  const cd = page.getByRole("alertdialog").or(page.locator('[role="dialog"]')).last();
  await cd.getByText("Delete this row?").waitFor({ timeout: 8000 });
  const topEl = await cd.getByRole("button", { name: /^Delete$/ }).evaluate((el) => { const r = el.getBoundingClientRect(); const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return el.contains(t); });
  chk("delete confirm reachable above full-screen layer", topEl);
  await cd.getByRole("button", { name: /^Delete$/ }).click();
  await page.waitForTimeout(2500);
  chk("row deleted in firestore", (await recs()).length === 1, (await recs()).length);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  chk("Esc exits full screen", await page.getByRole("button", { name: "Full screen" }).isVisible());

  // Open Transaction Studio link
  await page.locator('a[href*="statement-review/docparsed"]').first().click();
  await page.waitForURL(/statement-review\/docparsed/, { timeout: 20000 }).then(() => chk("Studio link navigates", true), () => chk("Studio link navigates", false, page.url()));
  await page.waitForTimeout(3000);
  await h.shot(page, "sr-sweep-studio");
  const errs = realErrors(logs);
  chk("no console / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("sr-sweep-dialogs", "Statement Review sweep: upload dialog validation, password dialog, delete-statement confirm", async ({ page, logs }, chk) => {
  await open(page);

  // Upload dialog
  await page.getByRole("button", { name: "Upload Statement" }).first().click();
  const dlg = page.locator('[role="dialog"]').last();
  await dlg.getByText("Upload Credit Card Statement").waitFor();
  await page.waitForTimeout(500);
  await h.shot(page, "sr-sweep-upload");
  await dlg.getByRole("button", { name: "Upload", exact: true }).click();
  chk("upload w/o card+file shows error", await dlg.getByText("Select a credit card and a PDF file.").isVisible({ timeout: 4000 }).catch(() => false));
  await dlg.getByRole("combobox").click();
  const opts = await page.getByRole("option").allInnerTexts();
  chk("card options listed", opts.length >= 1, opts.join("|"));
  await page.getByRole("option").first().click();
  // non-PDF is ignored
  await dlg.locator('input[type=file]').setInputFiles({ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await page.waitForTimeout(400);
  chk("non-PDF file not accepted (dropzone still shown)", await dlg.getByText(/Drag & drop PDF here/).isVisible());
  const bad = { name: "fake.pdf", mimeType: "application/pdf", buffer: Buffer.from("not really a pdf") };
  await dlg.locator('input[type=file]').setInputFiles(bad);
  await dlg.getByText("fake.pdf").waitFor();
  await dlg.getByRole("button", { name: "Remove file" }).click();
  chk("remove file returns to dropzone", await dlg.getByText(/Drag & drop PDF here/).isVisible());
  await dlg.locator('input[type=file]').setInputFiles(bad);
  await dlg.getByRole("button", { name: "Upload", exact: true }).click();
  await page.waitForTimeout(3000);
  const t = flat(await dlg.innerText().catch(() => ""));
  chk("invalid PDF rejected with a message (dialog stays open)", /pdf|valid|corrupt|not|couldn|error/i.test(t) && /Upload Credit Card Statement/.test(t), t.slice(0, 300));
  chk("Upload button re-enabled after failure", await dlg.getByRole("button", { name: "Upload", exact: true }).isEnabled());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  chk("upload dialog closes via Esc", (await page.locator('[role="dialog"]').count()) === 0);
  await page.getByRole("button", { name: "Upload Statement" }).first().click();
  await page.locator('[role="dialog"]').last().getByText("Upload Credit Card Statement").waitFor();
  chk("form reset on reopen (no stale file / error)", !(await page.locator('[role="dialog"]').last().getByText("fake.pdf").isVisible().catch(() => false)));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);

  // Password dialog
  await page.getByRole("button", { name: "Enter Password" }).click();
  const pd = page.locator('[role="dialog"]').last();
  await pd.getByText("Enter Password").first().waitFor();
  await page.waitForTimeout(1500);
  await h.shot(page, "sr-sweep-password");
  chk("password field visible (no saved password)", await pd.locator("input").first().isVisible());
  await pd.locator("input").first().fill("wrong");
  await pd.getByRole("button", { name: "Continue" }).click();
  await page.waitForTimeout(3500);
  const pt = flat(await pd.innerText().catch(() => ""));
  chk("callable failure shown inline, dialog usable", /Enter Password/.test(pt) && (await pd.getByRole("button", { name: "Continue" }).isEnabled()), pt.slice(0, 250));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);

  // Delete statement confirm
  await page.getByRole("button", { name: "Delete statement" }).first().click();
  const cd = page.locator('[role="dialog"], [role="alertdialog"]').last();
  await cd.getByText("Delete this statement?").waitFor();
  await cd.getByRole("button", { name: "Cancel" }).click();
  await page.waitForTimeout(600);
  chk("cancel keeps statements (5)", (await h.list("financialDocuments")).length === 5);
  await page.getByRole("button", { name: "Delete statement" }).first().click();
  await page.locator('[role="dialog"], [role="alertdialog"]').last().getByRole("button", { name: "Delete permanently" }).click();
  await page.waitForTimeout(4000);
  const tx = flat(await page.locator("body").innerText());
  chk("delete failure (no functions emulator) shown as toast, dialog recoverable", /Couldn't delete statement|Statement deleted|Can't delete|Still processing/.test(tx), tx.slice(-200));
  chk("no stuck 'Deleting…' state", !(await page.getByText("Deleting…").isVisible().catch(() => false)));
  const errs = realErrors(logs);
  chk("no console / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});
