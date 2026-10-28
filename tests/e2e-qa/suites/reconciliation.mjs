/**
 * Reconciliation Studio (/reconciliation) — Phase 2, read-only. Local emulator + synthetic rows only.
 *
 * The pasted rows are synthetic and dated relative to "today" so they line up with the seeded fixtures: the QA Credit
 * Card (•••• 4242, statement day 1) carries a ₹12,000 "QA card purchase" 12 days ago, and QA Bank carries ₹850 "QA
 * groceries" 2 days ago. Every scenario also proves the page wrote NOTHING: transactions, accounts and import
 * staging are read back from the emulator before and after.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const ddmmyyyy = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};

function statementText() {
  const lines = [
    `${ddmmyyyy(-12)}  QA CARD PURCHASE BLR        12,000.00`, // r1: same as the seeded card purchase
    `${ddmmyyyy(-12)}  QA CARD PURCHASE BLR        12,000.00`, // r2: identical twin → genuine-repeat handling
    `${ddmmyyyy(-1)}  SWIGGY BANGALORE              452.00`, // r3: nothing on the card → no match, open cycle
    `${ddmmyyyy(-40)}  OLD CAFE KOCHI                210.00`, // r4: closed card cycle → import blocked (D10)
    `${ddmmyyyy(-2)}  QA GROCERIES                  850.00`, // r5: exists only on QA Bank → note, never a match
  ];
  for (let i = 1; i <= 18; i++) lines.push(`${ddmmyyyy(-3)}  FILLER STORE ${String(i).padStart(2, "0")}        ${(100 + i * 7).toFixed(2)}`);
  return lines.join("\n");
}

async function snapshot() {
  const [txns, accounts, imports, docs] = await Promise.all([h.list("transactions"), h.list("accounts"), h.list("documentImports"), h.list("financialDocuments")]);
  return { txns: txns.length, balances: accounts.map((a) => `${a.name}:${a.currentBalance}`).sort().join("|"), imports: imports.length, docs: docs.length };
}

const overflowX = (page) => page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: document.querySelector("main").scrollWidth - document.querySelector("main").clientWidth }));

async function openStudio(page) {
  // New route: the first dev compile can exceed h.go's 30s wait.
  await page.evaluate(() => window.next.router.push("/reconciliation"));
  await page.getByRole("heading", { name: "Reconciliation" }).waitFor({ timeout: 240000 });
}

async function pasteAndChooseCard(page) {
  await page.getByRole("textbox", { name: "Statement rows" }).fill(statementText());
  await page.getByRole("button", { name: "Compare rows" }).click();
  await page.getByTestId("choose-account").waitFor();
  await page.getByRole("button", { name: /(Choose|Change) statement account/ }).click();
  await page.getByRole("option", { name: /QA Credit Card •••• 4242/ }).click();
  await page.waitForFunction(() => document.querySelector('[data-row-id="r1"]')?.getAttribute("data-state") !== "pending");
  await page.waitForTimeout(800); // live data settles
}

const stateOf = (page, testId, id) => page.locator(`[data-testid="${testId}"][data-row-id="${id}"]`).getAttribute("data-state");

scenario(
  "recon-desktop",
  "Reconciliation (desktop 1600): dual sheets, advisory states, account boundary, D10 block, one-to-one keep, keyboard, refresh recovery, zero writes",
  async ({ page }, chk) => {
    const before = await snapshot();
    await openStudio(page);
    await pasteAndChooseCard(page);

    const states = {};
    for (const id of ["r1", "r2", "r3", "r4", "r5"]) states[id] = await stateOf(page, "recon-row", id);
    chk("twin rows matching one card purchase are 'multiple' — never auto-pinned", states.r1 === "multiple" && states.r2 === "multiple", JSON.stringify(states));
    chk("a row with nothing on the card is 'no match'", states.r3 === "no_match", states.r3);
    chk("the bank's ₹850 groceries is NOT matched across accounts", states.r5 === "no_match", states.r5);
    const mainText = await page.locator("main").evaluate((m) => { const c = m.cloneNode(true); c.querySelectorAll("header").forEach((h) => h.remove()); return c.textContent ?? ""; });
    chk("no 'duplicate' wording outside the step header", !/duplicate/i.test(mainText), (mainText.match(/.{0,60}duplicate.{0,40}/i) ?? [""])[0]);
    chk("bulk Link offers nothing when the only exact match has a twin", await page.getByRole("button", { name: /Keep existing for exact matches \(0\)/ }).isDisabled());

    // Dual sheets: New statement beside Existing FlowFi, each its own scroll region.
    chk("both sheets side by side", (await page.getByTestId("statement-sheet").isVisible()) && (await page.getByTestId("existing-sheet").isVisible()));
    const left = await page.getByTestId("statement-sheet").boundingBox();
    const right = await page.getByTestId("existing-sheet").boundingBox();
    chk("statement on the left, FlowFi on the right, same height band", left && right && left.x + left.width <= right.x + 1 && Math.abs(left.y - right.y) <= 2, JSON.stringify({ left, right }));

    // r5's comparison: the other account never appears in the FlowFi sheet — only as a dock note.
    await page.locator('[data-testid="recon-row"][data-row-id="r5"]').click();
    await page.getByTestId("existing-mode-ledger").click();
    chk("the bank's transaction is never in the card's FlowFi sheet", !/QA BANK GROCERIES/i.test(await page.getByTestId("existing-sheet").innerText()));
    await page.getByTestId("existing-mode-matches").click();
    await page.getByTestId("dock-notes").click();
    chk("other-account look-alike shown as a note", /QA Bank.*a different account/.test(await page.locator("[data-radix-popper-content-wrapper]").innerText()));
    await page.keyboard.press("Escape");

    // D10: the closed-cycle row can't be imported.
    await page.locator('[data-testid="recon-row"][data-row-id="r4"]').click();
    chk("closed card bill blocks Import new (D10)", (await page.getByTestId("resolve-import_new").isDisabled()) && /already closed/.test(await page.getByTestId("dock-import-blocked").innerText()));

    // Multiple: r1's FlowFi sheet lists the candidate; Replace/Merge are previews only.
    await page.locator('[data-testid="recon-row"][data-row-id="r1"]').click();
    await page.getByTestId("resolve-merge_details").click();
    const preview = page.getByTestId("resolution-preview");
    chk("Merge details is a preview with commit disabled", (await preview.getByTestId("preview-commit").isDisabled()) && /can't do/.test(await preview.getByTestId("preview-unsupported").innerText()));
    await h.shot(page, "recon-desktop-merge-preview");
    await preview.getByRole("button", { name: "Close preview" }).click();

    // One-to-one: keep r1's match, then r2 can't keep the same purchase.
    await page.getByTestId("resolve-keep_existing").click();
    chk("r1 kept in the draft", (await page.locator('[data-testid="recon-row"][data-row-id="r1"]').innerText()).includes("Keep existing"));
    chk("r2 can no longer take the same transaction", (await stateOf(page, "recon-row", "r2")) === "conflict");
    await page.locator('[data-testid="recon-row"][data-row-id="r2"]').click();
    chk("…its Keep existing is disabled with the reason", (await page.getByTestId("resolve-keep_existing").isDisabled()) && /Already kept by row 1/.test((await page.getByTestId("resolve-keep_existing").getAttribute("title")) ?? ""));
    await h.shot(page, "recon-desktop-dual");

    // Keyboard: J moves, I ignores (start from row 1 — the steps above left row 2 selected).
    await page.locator('[data-testid="recon-row"][data-row-id="r1"]').click();
    await page.getByRole("grid", { name: "Statement rows" }).focus();
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    await page.keyboard.press("i");
    chk("keyboard J/J/I ignores row 3", (await page.locator('[data-testid="recon-row"][data-row-id="r3"]').innerText()).includes("Skipped"));
    await page.keyboard.press("z");
    chk("Z undoes the last draft decision", (await page.locator('[data-testid="recon-row"][data-row-id="r3"]').innerText()).includes("Undecided"));
    await page.keyboard.press("i");
    await page.keyboard.press("ArrowRight");
    chk("→ moves focus into the Existing FlowFi sheet", await page.getByRole("grid", { name: "Existing FlowFi transactions" }).evaluate((g) => g === document.activeElement));
    await page.keyboard.press("ArrowLeft");

    // Layout: no sideways overflow; the sticky header never sits on top of the sticky status bar.
    const ov = await overflowX(page);
    chk("no horizontal overflow (page or main)", ov.doc <= 1 && ov.main <= 1, JSON.stringify(ov));
    await page.locator("main").evaluate((m) => m.scrollTo(0, m.scrollHeight / 2));
    await page.waitForTimeout(300);
    const header = await page.locator('[data-testid="recon-grid"] > [role="row"]').first().boundingBox();
    const bar = await page.getByTestId("status-bar").boundingBox();
    chk("sticky grid header and status bar don't overlap", header && bar && header.y + header.height <= bar.y, JSON.stringify({ header, bar }));
    await h.shot(page, "recon-desktop-mid");
    await page.locator("main").evaluate((m) => m.scrollTo(0, 0));

    // Refresh: the draft comes back (rows + decisions) from this tab only.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Reconciliation" }).waitFor({ timeout: 120000 });
    await page.getByText("Restored your review").waitFor({ timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('[data-row-id="r1"]')?.getAttribute("data-state") !== "pending");
    chk("refresh restores decisions", (await page.locator('[data-testid="recon-row"][data-row-id="r1"]').innerText()).includes("Keep existing"));
    const stored = await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("flowfi.reconcile.v1.")).map((k) => sessionStorage.getItem(k)).join(""));
    chk("draft keeps no raw pasted line", stored.length > 0 && !stored.includes("QA CARD PURCHASE BLR        12,000.00") && !stored.includes("sourceText"));
    chk("privacy notice states the 12-hour, tab-only scope", /12 hours at most/.test(await page.getByTestId("privacy-notice").innerText()));
    await h.shot(page, "recon-desktop-restored");

    const after = await snapshot();
    chk("NOTHING was written (transactions, balances, import staging)", JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  },
  { viewport: { width: 1600, height: 1000 } },
);

scenario(
  "recon-laptop",
  "Reconciliation (laptop 1280): dual sheets fit, full comparison opens in a drawer, expandable editor, edit → re-confirm, no overflow",
  async ({ page }, chk) => {
    const before = await snapshot();
    await openStudio(page);
    await pasteAndChooseCard(page);
    chk("both sheets render at 1280", (await page.getByTestId("statement-sheet").isVisible()) && (await page.getByTestId("existing-sheet").isVisible()));
    await page.locator('[data-testid="recon-row"][data-row-id="r3"]').click();
    await page.getByTestId("dock-details").click();
    const drawer = page.getByRole("dialog");
    await drawer.getByTestId("match-panel").waitFor();
    await page.waitForTimeout(500); // let the slide-in finish before measuring
    const box = await drawer.boundingBox();
    chk("the full comparison is a full-width top sheet that fits the viewport", box && Math.round(box.x) === 0 && Math.round(box.width) === 1280 && Math.round(box.y) === 0 && box.height < 800, JSON.stringify(box));
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Expand row 3" }).click();
    const amount = page.getByLabel("Amount");
    await amount.fill("452.50");
    await amount.press("Enter");
    chk("edited row asks to re-confirm (D6)", (await page.locator('[data-testid="recon-row"][data-row-id="r3"]').innerText()).includes("Edited — confirm values"));
    await page.getByRole("button", { name: /Values are correct/ }).click();
    chk("re-confirmation clears it", !(await page.locator('[data-testid="recon-row"][data-row-id="r3"]').innerText()).includes("Edited — confirm values"));
    const ov = await overflowX(page);
    chk("no horizontal overflow", ov.doc <= 1 && ov.main <= 1, JSON.stringify(ov));
    await h.shot(page, "recon-laptop-editor");
    chk("NOTHING was written", JSON.stringify(before) === JSON.stringify(await snapshot()));
  },
  { viewport: { width: 1280, height: 800 } },
);

scenario(
  "recon-mobile",
  "Reconciliation (mobile 390): compact cards, match sheet, no horizontal overflow",
  async ({ page }, chk) => {
    const before = await snapshot();
    await openStudio(page);
    await pasteAndChooseCard(page);
    chk("no desktop grid on mobile", (await page.getByRole("grid").count()) === 0);
    chk("compact cards render", (await page.getByTestId("recon-card").count()) === 23);
    const ov = await overflowX(page);
    chk("no horizontal overflow", ov.doc <= 1 && ov.main <= 1, JSON.stringify(ov));
    await h.shot(page, "recon-mobile-list");
    await page.locator('[data-testid="recon-card"][data-row-id="r3"]').click();
    const sheet = page.getByTestId("mobile-sheet");
    await sheet.getByTestId("match-panel").waitFor();
    const box = await sheet.boundingBox();
    chk("sheet fits the viewport width", box && box.x >= 0 && box.x + box.width <= 391, JSON.stringify(box));
    const sheetOverflow = await sheet.evaluate((s) => s.scrollWidth - s.clientWidth);
    chk("sheet has no sideways scroll", sheetOverflow <= 1, `${sheetOverflow}px`);
    await sheet.getByRole("button", { name: "Skip this transaction" }).click();
    await h.shot(page, "recon-mobile-sheet");
    await page.keyboard.press("Escape");
    chk("decision shows on the card", (await page.locator('[data-testid="recon-card"][data-row-id="r3"]').innerText()).includes("Skipped"));
    // The FlowFi tab keeps the selected row pinned.
    await page.getByTestId("mobile-tab-existing").click();
    chk("FlowFi tab pins the selected row", /Row 3/.test(await page.getByTestId("mobile-context").innerText()));
    const ov2 = await overflowX(page);
    chk("FlowFi tab has no horizontal overflow", ov2.doc <= 1 && ov2.main <= 1, JSON.stringify(ov2));
    await h.shot(page, "recon-mobile-flowfi-tab");
    await page.getByTestId("mobile-tab-statement").click();
    chk("NOTHING was written", JSON.stringify(before) === JSON.stringify(await snapshot()));
  },
  { viewport: { width: 390, height: 844 } },
);

scenario(
  "recon-handoff-mobile",
  "Smart Capture → Reconciliation on mobile 390: Continue hands over, loading then states, sheet fits, Back restores, zero writes",
  async ({ page }, chk) => {
    const before = await snapshot();
    await page.evaluate(() => window.next.router.push("/smart-capture"));
    await page.getByRole("heading", { name: "Smart Capture" }).waitFor({ timeout: 240000 });
    await page.getByLabel("Pasted statement text").fill(`${ddmmyyyy(-12)}\tQA CARD PURCHASE BLR\t12,000.00 Dr\n${ddmmyyyy(-1)}\tSWIGGY BANGALORE\t452.00 Dr`);
    await page.getByRole("button", { name: /Extract transactions/ }).click();
    await page.getByTestId("progress-ready").waitFor();
    await page.getByRole("button", { name: /Next: Check duplicates/ }).last().click();

    await page.waitForFunction(() => location.pathname.replace(/[/]$/, "") === "/reconciliation", null, { timeout: 240000 });
    await page.getByTestId("handoff-notice").waitFor({ timeout: 240000 });
    await page.getByRole("button", { name: /(Choose|Change) statement account/ }).click();
    await page.getByRole("option", { name: /QA Credit Card •••• 4242/ }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-card"]')].every((r) => r.getAttribute("data-state") !== "pending"), null, { timeout: 60000 });
    chk("handed-over purchase matches the existing card transaction", (await stateOf(page, "recon-card", "r1")) === "exact_candidate");
    chk("no 'No match' shown before loading finished (states are final now)", (await stateOf(page, "recon-card", "r2")) === "no_match");
    const ov = await overflowX(page);
    chk("no horizontal overflow", ov.doc <= 1 && ov.main <= 1, JSON.stringify(ov));
    await page.locator('[data-testid="recon-card"][data-row-id="r1"]').click();
    const sheet = page.getByTestId("mobile-sheet");
    await sheet.getByTestId("match-panel").waitFor();
    const box = await sheet.boundingBox();
    chk("match sheet fits the phone width", box && box.x >= 0 && box.x + box.width <= 391, JSON.stringify(box));
    await h.shot(page, "recon-handoff-mobile-sheet");
    await page.keyboard.press("Escape");

    await page.getByTestId("back-to-capture").click();
    await page.getByText(/Back from Check duplicates/).waitFor({ timeout: 60000 });
    chk("Back restores both rows in Smart Capture", (await page.getByTestId("review-row").count()) === 2);
    chk("NOTHING was written", JSON.stringify(before) === JSON.stringify(await snapshot()));
  },
  { viewport: { width: 390, height: 844 } },
);
