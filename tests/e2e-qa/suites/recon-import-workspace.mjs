/**
 * Review & Import workspace (2026-11-25) — the statement from the user's screenshots, against the local emulator only.
 *
 *   01 Oct  UPI/627481159639/CR/MOH AN /BKID/mohankoda/UPI   +₹2,000   (credit, OCR split "MOH AN")
 *   01 Oct  UPI/664081439342/CR/MOH AN /BKID/mohankoda/UPI   +₹2,000   (credit, a DIFFERENT reference — a second real receipt)
 *   03 Oct  UPI1/627632125367/DR/Jio Pr/YESB/paytm-jio/UPI   −₹299     (debit)
 *
 * Dated relative to today (inside the seeded QA Bank's history). Rows are pasted (the OCR + column-mapping stages are
 * untouched by this work and have their own suites). Every scenario reads the persisted documents back from the
 * emulator, so it asserts stored money, not only what the screen says.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const ddmmyyyy = (offset) => {
  const d = new Date(Date.now() + offset * 86400000);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};
const STATEMENT = [
  `${ddmmyyyy(-5)}\tUP1/627481159639/CR/MOH AN /BKID/mohankoda/UPI\t2,000.00 Cr`,
  `${ddmmyyyy(-5)}\tUP1/664081439342/CR/MOH AN /BKID/mohankoda/UPI\t2,000.00 Cr`,
  `${ddmmyyyy(-3)}\tUPI1/627632125367/DR/Jio Pr/YESB/paytm-jio/UPI\t299.00 Dr`,
].join("\n");

const row = (page, which) => page.locator(`[data-testid="recon-row"]:nth-child(${which})`);
const rows = (page) => page.getByTestId("recon-row");
const byRef = (page, ref) => page.locator(`[data-testid="recon-row"][data-description*="${ref}"]`);
const bank = async () => (await h.accountBalance("QA Bank")).currentBalance;
const imported = async () => (await h.list("transactions")).filter((t) => !t.deletedAt && /Bank narration: UP/.test(t.notes ?? ""));

async function open(page, text = STATEMENT) {
  await page.evaluate(() => window.next.router.push("/reconciliation"));
  await page.getByRole("heading", { name: /Review & Import/ }).waitFor({ timeout: 240000 });
  if ((await page.getByRole("textbox", { name: "Statement rows" }).count()) === 0) {
    // A review is already open in this tab: discard it (draft only) to start from a fresh paste.
    await page.evaluate(() => sessionStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /Review & Import/ }).waitFor({ timeout: 120000 });
  }
  await page.getByRole("textbox", { name: "Statement rows" }).fill(text);
  await page.getByRole("button", { name: "Compare rows" }).click();
  await page.getByTestId("choose-account").waitFor();
  await page.getByRole("button", { name: /(Choose|Change) statement account/ }).click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-row"]')].every((r) => r.getAttribute("data-state") !== "pending"), null, { timeout: 90000 });
  await page.waitForTimeout(600);
}

scenario("rimport-screenshots", "The screenshot statement: clean descriptions, reliable category, credits ask what they are, two Mohan credits stay separate", async ({ page }, chk, notes) => {
  await open(page);
  const read = () => rows(page).evaluateAll((els) => els.map((e) => ({ status: e.dataset.status, shown: e.dataset.displayDescription, raw: e.dataset.description, category: e.querySelector('[data-testid="row-category"]')?.value ?? null, state: e.dataset.state })));
  const r = await read();
  notes.push(JSON.stringify(r));
  chk("three rows, in statement order", r.length === 3, `${r.length}`);
  chk("Mohan's credit reads 'Received from Mohan · UPI' (OCR split repaired, nothing invented)", r[0].shown === "Received from Mohan · UPI" && r[1].shown === "Received from Mohan · UPI", `${r[0].shown} | ${r[1].shown}`);
  chk("the bank narration is kept on the row for matching and verification", /627481159639/.test(r[0].raw) && /664081439342/.test(r[1].raw));
  chk("Jio reads 'Jio Mobile Recharge · UPI'", r[2].shown === "Jio Mobile Recharge · UPI", r[2].shown);
  chk("Jio's category is selected automatically and is a real category", !!r[2].category, `${r[2].category}`);
  chk("Jio is Ready; the credits are NOT (a credit is never assumed income or a refund)", r[2].status === "ready" && r[0].status === "fix" && r[1].status === "fix", JSON.stringify(r.map((x) => x.status)));
  chk("equal amount + day + payee is NOT a duplicate: the two credits are not matched to each other", r[0].state === "no_match" && r[1].state === "no_match");
  chk("no row shows a repeat warning (different references)", (await page.getByTestId("row-fix").allInnerTexts()).every((t) => !/repeat/i.test(t)));
  chk("the credits' next step is the Credit type picker", (await page.getByTestId("row-credit-type").count()) === 2);
  chk("the bottom action names ONE count", /^Import 1 transaction$/.test((await page.getByTestId("open-approval").innerText()).trim()));
  await h.shot(page, "rimport-screenshots");
});

scenario("rimport-edit-no-reconfirm", "Editing a row accepts the value at once — description edits survive, no 'confirm the amount' after an unrelated edit", async ({ page }, chk) => {
  await open(page);
  const jio = byRef(page, "627632125367");
  await jio.getByTestId("row-edit").click();
  const panel = page.getByTestId("row-editor-panel");
  await panel.waitFor();
  const desc = panel.getByLabel("Description", { exact: true });
  chk("the description is already filled in (no suggestion click needed)", (await desc.inputValue()) === "Jio Mobile Recharge · UPI");
  await desc.fill("Jio recharge — my number");
  await desc.press("Enter");
  const amount = panel.getByLabel("Amount", { exact: true });
  await amount.fill("349");
  await amount.press("Enter");
  chk("no 'edited — confirm values' prompt appears after typing the amount", (await panel.getByTestId("confirm-row").count()) === 0 && (await panel.getByText(/confirm the values/i).count()) === 0);
  chk("the row is still Ready after the edit", (await jio.getAttribute("data-status")) === "ready");
  await panel.getByLabel("Notes", { exact: true }).fill("checked").catch(() => undefined);
  await panel.getByTestId("editor-close").click();
  chk("the custom description is kept after closing (not overwritten by the suggestion)", (await jio.getAttribute("data-display-description")) === "Jio recharge — my number");
  chk("closing returns to the same row (still selected)", (await jio.getAttribute("aria-selected")) === "true");
  await h.shot(page, "rimport-edit");
});

scenario("rimport-import-rows", "Row Import and Import N write exactly the right transactions, once; balances move once", async ({ page }, chk, notes) => {
  const before = await bank();
  const txnsBefore = (await h.list("transactions")).length;
  await open(page);
  // Row 1: choose what the credit is, a category, then import it from its own row.
  const m1 = byRef(page, "627481159639");
  const m2 = byRef(page, "664081439342");
  for (const m of [m1, m2]) {
    await m.getByTestId("row-credit-type").click();
    await page.getByTestId("row-credit-type-income").click();
    await page.waitForTimeout(150);
    // UPI credit needs "from someone else" — Income already says so; then a category.
    const cat = m.getByTestId("row-category");
    const options = await cat.locator("option").allInnerTexts();
    await cat.selectOption({ index: Math.max(1, options.findIndex((o) => /salary|income|other|gift/i.test(o))) });
    await page.waitForTimeout(150);
  }
  chk("both credits are Ready once typed + categorised", (await m1.getAttribute("data-status")) === "ready" && (await m2.getAttribute("data-status")) === "ready", `${await m1.getAttribute("data-status")} / ${await m2.getAttribute("data-status")}`);
  await m1.getByTestId("row-import").dblclick(); // a double click is still ONE import
  await m1.locator('[data-status="imported"]').waitFor({ timeout: 60000 }).catch(() => undefined);
  await page.waitForFunction(() => document.querySelector('[data-testid="recon-row"][data-description*="627481159639"]')?.getAttribute("data-status") === "imported", null, { timeout: 60000 });
  chk("row 1 reads Imported at once", (await m1.getAttribute("data-status")) === "imported");
  chk("rows 2 and 3 were NOT imported by row 1's button", (await m2.getAttribute("data-status")) === "ready");
  let created = await imported();
  chk("exactly one transaction exists after row 1's Import (and a double click)", created.length === 1, `${created.length}`);
  chk("row 1 credited +₹2,000 once", (await bank()) === before + 2000, `${before} → ${await bank()}`);
  // The global action imports the rest of the Ready rows: row 2 (credit) and Jio.
  const label = (await page.getByTestId("open-approval").innerText()).trim();
  chk("global action now says 'Import 2 transactions'", label === "Import 2 transactions", label);
  await page.getByTestId("open-approval").click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-row"]')].every((r) => r.getAttribute("data-status") === "imported"), null, { timeout: 90000 });
  created = await imported();
  notes.push(JSON.stringify(created.map((t) => [t.description, t.amount, t.type, t.categoryId])));
  chk("three transactions exist, one per row", created.length === 3 && (await h.list("transactions")).length === txnsBefore + 3, `${created.length}`);
  chk("descriptions saved as approved", created.filter((t) => t.description === "Received from Mohan · UPI").length === 2 && created.some((t) => t.description === "Jio Mobile Recharge · UPI"));
  chk("the bank narration + RRN are kept in the notes of each", created.every((t) => /Bank narration: UP/.test(t.notes)) && created.some((t) => /664081439342/.test(t.notes)) && created.some((t) => /627481159639/.test(t.notes)));
  chk("credits are income, the debit is an expense, amounts exact", created.filter((t) => t.type === "income").length === 2 && created.filter((t) => t.type === "expense").length === 1 && created.some((t) => t.amount === 299));
  chk("bank balance moved exactly once: +2000 +2000 −299", (await bank()) === before + 2000 + 2000 - 299, `${before} → ${await bank()}`);
  chk("a compact summary was shown (no result dialog)", (await page.getByTestId("approval-dialog").count()) === 0);
  await h.shot(page, "rimport-after-import");
  // Reload: nothing is written twice by a replay.
  const total = (await h.list("transactions")).length;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: /Review & Import/ }).waitFor({ timeout: 120000 });
  await page.waitForTimeout(2000);
  if (await page.getByTestId("open-approval").isEnabled().catch(() => false)) await page.getByTestId("open-approval").click().catch(() => undefined);
  await page.waitForTimeout(1500);
  chk("a replay after reload writes nothing more", (await h.list("transactions")).length === total && (await bank()) === before + 3701, `${(await h.list("transactions")).length} vs ${total}`);
});

scenario("rimport-possible-match", "₹299 vs ₹300 shows a possible match with the difference; Already recorded skips; Import as new / Keep both import", async ({ page }, chk) => {
  const accounts = await h.list("accounts");
  const bankAcc = accounts.find((a) => a.name === "QA Bank");
  const cat = (await h.list("categories")).find((c) => c.type === "expense" && !c.deletedAt && c.isActive !== false);
  const day = (o) => new Date(Date.now() + o * 86400000);
  await h.createDocUnderUser("transactions/qa_manual_jio", { type: "expense", amount: 300, dateTime: day(-3), accountId: bankAcc.id, categoryId: cat.id, description: "Jio recharge", notes: "", status: "posted", source: "manual", createdAt: day(-3), deletedAt: null, excludeFromCalculations: false, editHistory: [] });
  const before = await bank();
  await open(page);
  const jio = byRef(page, "627632125367");
  chk("₹299 vs the existing ₹300 is a Possible match — not decided, not merged", (await jio.getAttribute("data-status")) === "duplicate" && (await jio.getAttribute("data-decision")) === "", `${await jio.getAttribute("data-status")}`);
  chk("the two Mohan credits are not each other's match", (await byRef(page, "627481159639").getAttribute("data-state")) === "no_match");
  await jio.getByTestId("row-review").click();
  const review = page.getByTestId("inline-review");
  await review.waitFor();
  const amount = review.locator('[data-field="amount"]');
  chk("the comparison shows both amounts and the ₹1.00 difference, inside the scroll body", /₹300\.00/.test(await amount.innerText()) && /₹299\.00/.test(await amount.innerText()) && /₹1\.00/.test(await amount.innerText()));
  // Review panel fully visible: its decision buttons are inside the table's scroll body and in the viewport.
  const visible = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="inline-decisions"]').getBoundingClientRect();
    const body = document.querySelector('[data-testid="recon-grid-body"]').getBoundingClientRect();
    return p.top >= body.top - 1 && p.bottom <= body.bottom + 1 && p.bottom <= window.innerHeight;
  });
  chk("the expanded comparison is not clipped (its decisions are visible)", visible);
  await review.getByTestId("inline-keep-existing").click();
  chk("Already recorded: the row is skipped and nothing is imported", (await jio.getAttribute("data-status")) === "skipped" && (await bank()) === before);
  // Change of mind: clear, then Import as new.
  await jio.getByTestId("quick-decide").click();
  await page.getByTestId("resolve-clear").click();
  await jio.getByTestId("row-review").click();
  await page.getByTestId("inline-review").getByTestId("inline-import").click();
  await page.waitForTimeout(400);
  chk("Import as new sets the match aside — the row is Ready (reliable category)", (await jio.getAttribute("data-status")) === "ready", `${await jio.getAttribute("data-status")}`);
  chk("a decision is kept after closing the editor", (await jio.getAttribute("data-state")) === "no_match");
  await jio.getByTestId("row-import").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="recon-row"][data-description*="627632125367"]')?.getAttribute("data-status") === "imported", null, { timeout: 60000 });
  chk("exactly ₹299 left the account, once; the existing ₹300 untouched", (await bank()) === before - 299 && (await h.list("transactions")).filter((t) => t.id === "qa_manual_jio" && !t.deletedAt && t.amount === 300).length === 1, `${before} → ${await bank()}`);
  await h.shot(page, "rimport-possible-match");
});

scenario("rimport-scroll-and-credit-types", "The last row stays reachable; credit types People/Transfer skip (nothing written); layout has no overflow", async ({ page }, chk) => {
  const many = Array.from({ length: 40 }, (_, i) => `${ddmmyyyy(-2 - (i % 5))}\tUPI/6${String(10000000000 + i * 7919).slice(0, 11)}/DR/SHOP ${i + 1}/SBIN/shop${i}/UPI\t${(100 + i).toFixed(2)} Dr`).join("\n");
  await open(page, many);
  const body = page.getByTestId("recon-grid-body");
  await body.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.waitForTimeout(200);
  chk("the final row and the end-of-statement line are reachable", await page.getByTestId("statement-end").isVisible());
  chk("the global Import stays visible while scrolled", await page.getByTestId("open-approval").isVisible());
  chk("no horizontal page overflow", (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0);
  const before = (await h.list("transactions")).length;
  await open(page, `${ddmmyyyy(-2)}\tUP1/627481159639/CR/MOH AN /BKID/mohankoda/UPI\t2,000.00 Cr`);
  const m = byRef(page, "627481159639");
  await m.getByTestId("row-credit-type").click();
  await page.getByTestId("row-credit-type-people").click();
  chk("'From a person I lent to' skips the row — recorded in People, not imported here", (await m.getAttribute("data-status")) === "skipped" && /People/.test(await m.getByTestId("decision-chip").innerText()));
  chk("nothing was written", (await h.list("transactions")).length === before);
  await h.shot(page, "rimport-credit-people");
});
