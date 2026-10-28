/**
 * Reconciliation Studio — Phase 4 final approval. Local emulator + synthetic rows only.
 *
 * Unlike the Phase 2/3 scenarios (reconciliation.mjs) these DO write — that is the point of the approval — so every
 * scenario reads the persisted documents back from the emulator and asserts exact money. Rows are dated relative to
 * "today" so they line up with the seeded QA Credit Card (•••• 4242, statement day 1) carrying a ₹12,000 "QA card
 * purchase" 12 days ago.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const ddmmyyyy = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};
/** Keeps every row inside the card's OPEN bill even when the suite runs in the first days of a statement cycle. */
const safeOffset = (n) => (new Date().getDate() <= 3 ? 0 : n);

const overflowX = (page) => page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: document.querySelector("main").scrollWidth - document.querySelector("main").clientWidth }));
const stateOf = (page, testId, id) => page.locator(`[data-testid="${testId}"][data-row-id="${id}"]`).getAttribute("data-state");

function approvalStatement() {
  return [
    `${ddmmyyyy(-12)}\tQA CARD PURCHASE BLR\t12,000.00 Dr`, // r1: exists on the card → Link
    `${ddmmyyyy(safeOffset(-1))}\tZZ NEW CAFE KOCHI\t452.00 Dr`, // r2: nothing on the card → Import as new (expense)
    `${ddmmyyyy(safeOffset(-2))}\tZZ AMAZON REFUND\t300.00 Cr`, // r3: a credit → Import as new, explicitly a refund
    `${ddmmyyyy(safeOffset(-2))}\tZZ NOISE CHARGE\t11.00 Dr`, // r4: Ignore
  ].join("\n");
}

const cardTxns = async () => (await h.list("transactions")).filter((t) => t.description && /ZZ /.test(t.description));
const cardBalance = async () => (await h.accountBalance("QA Credit Card")).currentBalance;

async function openStudio(page) {
  await page.evaluate(() => window.next.router.push("/reconciliation"));
  await page.getByRole("heading", { name: "Reconciliation" }).waitFor({ timeout: 240000 });
}

async function pasteApprovalRows(page) {
  await page.getByRole("textbox", { name: "Statement rows" }).fill(approvalStatement());
  await page.getByRole("button", { name: "Compare rows" }).click();
  await page.getByTestId("choose-account").waitFor();
  await page.getByRole("button", { name: /(Choose|Change) statement account/ }).click();
  await page.getByRole("option", { name: /QA Credit Card •••• 4242/ }).click();
  await page.waitForFunction(() => document.querySelector('[data-row-id="r1"]')?.getAttribute("data-state") !== "pending", null, { timeout: 60000 });
  await page.waitForTimeout(800);
}

/** Second-viewport shortcut: write the decisions into this tab's draft (the same JSON the UI saves) and reload. */
async function injectDecisions(page, decisions) {
  await page.evaluate((d) => {
    const key = Object.keys(sessionStorage).find((k) => k.startsWith("flowfi.reconcile.v1."));
    const draft = JSON.parse(sessionStorage.getItem(key));
    const base = { kind: null, linkedRecordId: null, notSameAck: false, rejectedRecordIds: [], category: null, notes: "", bulkId: null, creditAs: null };
    for (const [id, v] of Object.entries(d)) draft.decisions[id] = { ...base, ...v };
    sessionStorage.setItem(key, JSON.stringify(draft));
  }, decisions);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Reconciliation" }).waitFor({ timeout: 120000 });
  await page.getByText("Restored your review").waitFor({ timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('[data-row-id="r1"]')?.getAttribute("data-state") !== "pending", null, { timeout: 60000 });
  await page.waitForTimeout(800);
}

async function categoryNames() {
  const all = await h.list("categories");
  return {
    expense: all.find((c) => c.type === "expense" || c.type === "both")?.name,
    income: all.find((c) => c.type === "income" || c.type === "both")?.name,
  };
}

async function openApproval(page) {
  await page.getByTestId("open-approval").click();
  const dlg = page.getByTestId("approval-dialog");
  await dlg.getByTestId("approval-counts").or(dlg.getByTestId("approval-nothing")).first().waitFor();
  return dlg;
}

async function viewportFit(dlg, width, height) {
  const box = await dlg.boundingBox();
  const overflow = await dlg.evaluate((d) => d.scrollWidth - d.clientWidth);
  return { ok: !!box && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= height + 1 && overflow <= 1, box, overflow };
}

scenario(
  "recon-approve-desktop",
  "Reconciliation final approval (desktop 1600): summary, explicit confirmation, exact-once import, per-row outcomes, repeat/refresh/double-click write nothing more",
  async ({ page }, chk) => {
    const cats = await categoryNames();
    const txnsBefore = (await h.list("transactions")).length;
    const bankBefore = (await h.accountBalance("QA Bank")).currentBalance;
    const cardBefore = await cardBalance();
    await openStudio(page);
    await pasteApprovalRows(page);

    chk("Reconciliation never imports by itself — nothing written after opening and comparing", (await h.list("transactions")).length === txnsBefore);
    chk("Review & approve is disabled while rows are undecided", await page.getByTestId("open-approval").isDisabled());

    const rowBtn = (id) => page.locator(`[data-testid="recon-row"][data-row-id="${id}"]`);
    /** Keep both (a match exists — acknowledged explicitly) or Import new, from the comparison dock. */
    const importVia = async (id, category, creditAs) => {
      await rowBtn(id).click();
      const both = page.getByTestId("resolve-keep_both");
      await ((await both.isEnabled()) ? both : page.getByTestId("resolve-import_new")).click();
      const pop = page.getByTestId("import-confirm");
      const ack = pop.getByRole("checkbox", { name: "These are separate transactions" });
      if (await ack.count()) await ack.check();
      await pop.getByLabel("Category for import").selectOption({ label: category });
      if (creditAs) {
        chk("a credit asks whether it is a refund or income — never assumed", (await pop.getByTestId("import-confirm-submit").isDisabled()) && (await pop.getByRole("radiogroup", { name: "What is this credit?" }).isVisible()));
        await pop.getByRole("radio", { name: creditAs }).click();
      }
      await pop.getByTestId("import-confirm-submit").click();
    };
    await rowBtn("r1").click();
    await page.getByTestId("resolve-keep_existing").click();
    await rowBtn("r4").click();
    await page.getByTestId("resolve-skip").click();
    await importVia("r2", cats.expense);
    await importVia("r3", cats.income, "Refund");
    await h.shot(page, "recon-approve-decided");

    const dlg = await openApproval(page);
    const text = (id) => dlg.getByTestId(id).innerText();
    chk("summary: 4 captured / 2 new / 1 linked / 1 ignored / 0 unresolved", /^4/.test(await text("count-captured")) && /^2/.test(await text("count-new")) && /^1/.test(await text("count-linked")) && /^1/.test(await text("count-ignored")) && /^0/.test(await text("count-unresolved")));
    chk("names the receiving card", /QA Credit Card •••• 4242/.test(await text("approval-account")) && /credit card/.test(await text("approval-account")));
    chk("charges ₹452.00, credits ₹300.00, card owed rises ₹152.00", /452\.00/.test(await text("approval-charges")) && /300\.00/.test(await text("approval-credits")) && /rises by ₹152\.00/.test(await text("approval-effect-text")));
    chk("approval is blocked until the explicit confirmation", await dlg.getByTestId("approval-submit").isDisabled());
    chk("opening the approval wrote nothing", (await h.list("transactions")).length === txnsBefore);
    const fit = await viewportFit(dlg, 1600, 1000);
    chk("dialog fits the viewport, no sideways scroll", fit.ok, JSON.stringify(fit));
    await h.shot(page, "recon-approve-desktop-review");

    await dlg.getByTestId("approval-confirm").click();
    await dlg.getByTestId("approval-submit").dblclick(); // a double click must still be ONE approval
    await dlg.getByTestId("approval-result").waitFor({ timeout: 60000 });
    chk("complete: every row resolved", (await dlg.getByTestId("approval-result").getAttribute("data-status")) === "complete");
    const outcomes = await dlg.getByTestId("approval-outcome").evaluateAll((els) => els.map((e) => `${e.dataset.rowId}:${e.dataset.outcome}`));
    chk("per-row outcomes are precise", JSON.stringify(outcomes) === JSON.stringify(["r1:linked", "r2:imported", "r3:imported", "r4:ignored"]), outcomes.join(","));
    await h.shot(page, "recon-approve-desktop-result");

    const written = await cardTxns();
    chk("exactly 2 transactions written (the double click did not double-write)", written.length === 2 && (await h.list("transactions")).length === txnsBefore + 2, `${written.length}`);
    chk("expense −452 and refund +300 recorded on the card", Math.abs((await cardBalance()) - (cardBefore - 452 + 300)) < 0.01, `${cardBefore} → ${await cardBalance()}`);
    chk("QA Bank untouched", (await h.accountBalance("QA Bank")).currentBalance === bankBefore);
    chk("deterministic import keys + provenance note", written.every((t) => t.id.startsWith("txn_imp_") && /Imported via Reconciliation/.test(t.notes)), written.map((t) => t.id).join(","));

    // Repeated approval after success: nothing left to import.
    await dlg.getByRole("button", { name: "Back to reconciliation" }).click();
    await page.waitForTimeout(800);
    const again = await openApproval(page);
    chk("re-opening the approval finds everything already imported — nothing to write", (await again.getByTestId("approval-nothing").count()) === 1);
    await again.getByRole("button", { name: "Back to reconciliation" }).click();

    // Refresh: draft restored, rows now detected as already imported through their deterministic keys.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Reconciliation" }).waitFor({ timeout: 120000 });
    await page.getByText("Restored your review").waitFor({ timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('[data-row-id="r2"]')?.getAttribute("data-state") !== "pending", null, { timeout: 60000 });
    await page.waitForTimeout(800);
    chk("after refresh the imported rows show 'already imported'", (await stateOf(page, "recon-row", "r2")) === "already_imported" && (await stateOf(page, "recon-row", "r3")) === "already_imported");
    const third = await openApproval(page);
    chk("after refresh there is still nothing to import", (await third.getByTestId("approval-nothing").count()) === 1);
    await third.getByRole("button", { name: "Back to reconciliation" }).click();
    chk("repeat/refresh never wrote again", (await cardTxns()).length === 2 && Math.abs((await cardBalance()) - (cardBefore - 152)) < 0.01);
    const ov = await overflowX(page);
    chk("no horizontal overflow", ov.doc <= 1 && ov.main <= 1, JSON.stringify(ov));
  },
  { viewport: { width: 1600, height: 1000 } },
);

scenario(
  "recon-approve-mobile",
  "Reconciliation final approval (mobile 390): dialog fits, confirmation required, result list readable, exact money",
  async ({ page }, chk) => {
    const cats = await categoryNames();
    const txnsBefore = (await h.list("transactions")).length;
    const cardBefore = await cardBalance();
    await openStudio(page);
    await pasteApprovalRows(page);
    const existing = (await h.list("transactions")).find((t) => t.description === "QA card purchase");
    await injectDecisions(page, {
      r1: { kind: "link", linkedRecordId: existing.id },
      r2: { kind: "import_new", category: cats.expense },
      r3: { kind: "import_new", category: cats.income, creditAs: "refund" },
      r4: { kind: "ignore" },
    });
    chk("the status bar offers the approval only now", await page.getByTestId("open-approval").isEnabled());
    const dlg = await openApproval(page);
    const fit = await viewportFit(dlg, 390, 844);
    chk("dialog fits the phone viewport", fit.ok, JSON.stringify(fit));
    chk("submit stays disabled until confirmation", await dlg.getByTestId("approval-submit").isDisabled());
    await h.shot(page, "recon-approve-mobile-review");
    await dlg.getByTestId("approval-confirm").click();
    await dlg.getByTestId("approval-submit").scrollIntoViewIfNeeded();
    chk("submit enabled after confirmation", await dlg.getByTestId("approval-submit").isEnabled());
    await dlg.getByTestId("approval-submit").click();
    await dlg.getByTestId("approval-result").waitFor({ timeout: 60000 });
    chk("complete", (await dlg.getByTestId("approval-result").getAttribute("data-status")) === "complete");
    chk("result list fits without sideways scroll", (await viewportFit(dlg, 390, 844)).ok);
    await h.shot(page, "recon-approve-mobile-result");
    chk("2 transactions, exact card balance", (await cardTxns()).length === 2 && (await h.list("transactions")).length === txnsBefore + 2 && Math.abs((await cardBalance()) - (cardBefore - 152)) < 0.01);
    const ov = await overflowX(page);
    chk("no horizontal overflow", ov.doc <= 1 && ov.main <= 1, JSON.stringify(ov));
  },
  { viewport: { width: 390, height: 844 } },
);

scenario(
  "recon-approve-offline",
  "Reconciliation final approval (laptop 1280): if FlowFi can't be re-read from the server the approval stops and writes nothing",
  async ({ page }, chk) => {
    const cats = await categoryNames();
    const txnsBefore = (await h.list("transactions")).length;
    await openStudio(page);
    await pasteApprovalRows(page);
    const existing = (await h.list("transactions")).find((t) => t.description === "QA card purchase");
    await injectDecisions(page, {
      r1: { kind: "link", linkedRecordId: existing.id },
      r2: { kind: "import_new", category: cats.expense },
      r3: { kind: "import_new", category: cats.income, creditAs: "refund" },
      r4: { kind: "ignore" },
    });
    const dlg = await openApproval(page);
    await dlg.getByTestId("approval-confirm").click();
    await page.context().setOffline(true);
    await dlg.getByTestId("approval-submit").click();
    await dlg.getByTestId("approval-unavailable").waitFor({ timeout: 90000 });
    await page.context().setOffline(false);
    chk("says nothing was imported and offers Try again", /Nothing was imported/.test(await dlg.getByTestId("approval-unavailable").innerText()) && (await dlg.getByRole("button", { name: "Try again" }).count()) === 1);
    chk("nothing written", (await h.list("transactions")).length === txnsBefore);
    await h.shot(page, "recon-approve-offline");
  },
  { viewport: { width: 1280, height: 800 } },
);
