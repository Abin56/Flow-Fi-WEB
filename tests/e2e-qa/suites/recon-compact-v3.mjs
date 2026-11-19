/**
 * Review & Import V3 (2026-11-18) — compact Excel-style workspace + approximate-amount and account-missing matching.
 * Local emulator + synthetic pasted rows only.
 *
 *  - recon-v3-matching: ₹298 vs ₹300 and ₹300.01 vs ₹300.00 are POSSIBLE matches shown across both tables with the
 *    difference; an approx amount with nothing else agreeing is no match; a debit never matches a credit; Keep existing
 *    on the ₹298 writes nothing.
 *  - recon-v3-account: with no account chosen, rows say "Account missing", the FlowFi side lists similar transactions
 *    as "Account not verified", and "Use account" (the user's click) recalculates real matches.
 *  - recon-v3-layout: rows visible at 1920×1080 / 1366×768, one-line toolbar, compact strip, no overflow, divider drag
 *    + double-click 50/50, Focus Mode shows more rows. Every scenario proves the review itself wrote nothing.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
import { choose, menuItem, openImportConfirm, pressOnGrid } from "../lib/recon.mjs";

const ddmmyyyy = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};
const box = async (page, testId) => page.getByTestId(testId).first().boundingBox();
const CARD = /QA Credit Card •••• 4242/;

async function paste(page, text) {
  await page.evaluate(() => window.next.router.push("/reconciliation"));
  await page.getByRole("textbox", { name: "Statement rows" }).waitFor({ timeout: 240000 });
  await page.getByRole("textbox", { name: "Statement rows" }).fill(text);
  await page.getByRole("button", { name: "Compare rows" }).click();
  await page.getByTestId("recon-row").first().waitFor({ timeout: 60000 });
}

async function chooseCard(page) {
  await page.getByRole("button", { name: /(Choose|Change) statement account/ }).click();
  await page.getByRole("option", { name: CARD }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-row"]')].every((r) => r.getAttribute("data-state") !== "pending"), null, { timeout: 60000 });
  await page.waitForTimeout(400);
}

async function discard(page) {
  // A closing dialog swallows clicks — wait until it has gone.
  await page.getByTestId("approval-dialog").waitFor({ state: "detached", timeout: 15000 }).catch(() => undefined);
  if (await page.getByRole("button", { name: "Discard this review" }).count()) {
    await page.getByRole("button", { name: "Discard this review" }).click();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
  }
  await page.getByRole("textbox", { name: "Statement rows" }).waitFor();
}

/** "Typed by hand" FlowFi transactions on the card, written through the real approval (keyed, balance once). */
async function seedTyped(page, lines) {
  const expense = (await h.list("categories")).find((c) => c.type === "expense" || c.type === "both")?.name;
  await paste(page, lines.join("\n"));
  await chooseCard(page);
  await page.evaluate((cat) => {
    const key = Object.keys(sessionStorage).find((k) => k.startsWith("flowfi.reconcile.v1."));
    const draft = JSON.parse(sessionStorage.getItem(key));
    const base = { kind: "import_new", linkedRecordId: null, notSameAck: true, rejectedRecordIds: [], category: cat, notes: "", bulkId: null, creditAs: null, notOwnTransferAck: true };
    for (const row of draft.rows) draft.decisions[row.id] = { ...base, creditAs: row.direction === "credit" ? "income" : null };
    sessionStorage.setItem(key, JSON.stringify(draft));
  }, expense);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Restored your review").waitFor({ timeout: 120000 });
  await page.waitForFunction(() => document.querySelector('[data-row-id="r1"]')?.getAttribute("data-state") !== "pending", null, { timeout: 60000 });
  await page.getByTestId("open-approval").click();
  const dlg = page.getByTestId("approval-dialog");
  await dlg.getByTestId("approval-confirm").click();
  // Same-day, same-amount seed rows trip the engine's amount+date repeat check — acknowledge it for the seed.
  if (await dlg.getByTestId("approval-repeats").count()) await dlg.getByTestId("approval-repeats").getByRole("checkbox").click().catch(() => dlg.getByTestId("approval-repeats").click());
  await dlg.getByTestId("approval-submit").click();
  await dlg.getByTestId("approval-result").waitFor({ timeout: 90000 });
  await dlg.getByRole("button", { name: /Clear this review|Start a new review|Done/ }).first().click().catch(() => page.keyboard.press("Escape"));
  await discard(page);
}

async function nothingWritten(chk, before) {
  const after = await Promise.all([h.list("transactions"), h.list("accounts")]);
  chk("nothing written: transactions unchanged", after[0].length === before[0].length, `${before[0].length} → ${after[0].length}`);
  chk("nothing written: balances unchanged", JSON.stringify(after[1].map((a) => a.currentBalance).sort()) === JSON.stringify(before[1].map((a) => a.currentBalance).sort()));
}

const rowByDesc = (page, re) => page.locator('[data-testid="recon-row"]').filter({ hasText: re }).first();

scenario("recon-v3-matching", "₹298 vs ₹300 and ₹300.01 vs ₹300 are possible matches with the difference shown across both tables; approx without evidence, debit vs credit → no match; Keep existing writes nothing", async ({ page }, chk) => {
  const d = ddmmyyyy(-4);
  await seedTyped(page, [`${d}\tDINNER SHARE RAHUL\t300.00 Dr`, `${d}\tPETROL BUNK\t300.00 Dr`, `${d}\tREFUND STORE\t300.00 Cr`]);
  const before = await Promise.all([h.list("transactions"), h.list("accounts")]);

  await paste(page, [`${d}\tUPI/628323405861/DR/RAHUL/SBIN/rahul@oksbi DINNER\t298.00 Dr`, `${d}\tPETROL BUNK\t300.01 Dr`, `${ddmmyyyy(-1)}\tAMAZON MARKETPLACE\t298.50 Dr`, `${d}\tSTORE PURCHASE\t310.00 Dr`].join("\n"));
  await page.setViewportSize({ width: 1920, height: 1080 });
  await chooseCard(page);
  const states = await page.$$eval('[data-testid="recon-row"]', (rows) => rows.map((r) => [r.getAttribute("data-description"), r.getAttribute("data-state")]));
  const stateOf = (re) => states.find(([desc]) => re.test(desc))?.[1];
  chk("₹298 vs a hand-typed ₹300 (same day) → possible match", ["near_amount", "same_merchant_date", "multiple"].includes(stateOf(/DINNER/)), JSON.stringify(states));
  chk("₹300.01 vs ₹300.00 → possible match, not exact", ["near_amount", "same_merchant_date", "multiple"].includes(stateOf(/PETROL/)), JSON.stringify(states));
  chk("₹298.50 three days off with a different merchant → no match", stateOf(/AMAZON/) === "no_match", JSON.stringify(states));
  chk("₹310 (more than 2% away) → no match", stateOf(/STORE PURCHASE/) === "no_match", JSON.stringify(states));

  // Select the ₹298 row: the FlowFi side highlights the ₹300 with the difference and the reasons.
  await rowByDesc(page, /DINNER/).click();
  await page.waitForTimeout(300);
  const existing = page.locator('[data-testid="existing-row"]').filter({ hasText: /DINNER SHARE RAHUL/ }).first();
  chk("FlowFi ₹300 listed as a possible match for the ₹298 row", (await existing.count()) === 1 && /suggested|candidate/.test((await existing.getAttribute("data-role")) ?? ""));
  chk("difference column says ₹2.00 more · Same day", /₹2\.00 more · Same day/.test(await existing.getByTestId("existing-difference").innerText()), await existing.getByTestId("existing-difference").innerText());
  chk("the credit ₹300 is never offered for a debit row", (await page.locator('[data-testid="existing-row"]').filter({ hasText: /REFUND STORE/ }).count()) === 0);
  chk("the right side is a compact list: no explanation block, one Possible match mark", (await page.getByTestId("existing-evidence").count()) === 0 && /Possible match/.test(await existing.innerText()));
  chk("nothing is pre-decided", (await rowByDesc(page, /DINNER/).locator('[data-pending="true"]').count()) > 0);
  chk("the ⋯ menu offers Import as transaction and Keep existing", (await (await menuItem(page, "import")).isEnabled()) && (await page.getByTestId("resolve-keep_existing").isEnabled()));
  await page.keyboard.press("Escape");
  await h.shot(page, "v3-matching-298-vs-300");

  // Keep existing on the ₹298 → finish → nothing written; FlowFi keeps ₹300 and says so.
  await choose(page, "keep_existing");
  chk("Keep existing recorded for the ₹298 row (draft only)", (await rowByDesc(page, /DINNER/).getAttribute("data-decision")) === "link");
  for (const re of [/PETROL/, /AMAZON/, /STORE PURCHASE/]) {
    await rowByDesc(page, re).click();
    await pressOnGrid(page, "i");
  }
  await page.getByTestId("open-approval").click();
  const dlg = page.getByTestId("approval-dialog");
  // Nothing to import: the dialog says so (no import confirmation needed).
  await dlg.getByTestId("approval-counts").waitFor();
  chk("final approval: 1 kept existing, 3 skipped, nothing to import (no Import button)", (await dlg.getByTestId("approval-nothing").count()) === 1 && (await dlg.getByTestId("approval-submit").count()) === 0);
  await nothingWritten(chk, before);
  await dlg.getByRole("button", { name: "Back to review" }).click();
  await discard(page);
});

scenario("recon-v3-account", "Account missing: rows say so, FlowFi side shows similar transactions as 'Account not verified', the suggestion/Use account is the user's choice and recalculates — zero writes", async ({ page }, chk) => {
  const d = ddmmyyyy(-5);
  await seedTyped(page, [`${d}\tCAFE COFFEE DAY\t240.00 Dr`, `${d}\tBOOK HOUSE\t799.00 Dr`]);
  const before = await Promise.all([h.list("transactions"), h.list("accounts")]);
  await page.setViewportSize({ width: 1600, height: 900 });
  await paste(page, [`${d}\tCAFE COFFEE DAY\t240.00 Dr`, `${d}\tBOOK HOUSE BLR\t800.00 Dr`, `${d}\tNEW SHOP\t55.00 Dr`].join("\n"));
  await page.waitForFunction(() => document.querySelector('[data-testid="recon-row"]')?.getAttribute("data-account-missing") === "true", null, { timeout: 60000 });
  chk("toolbar says Account not matched", /Account not matched/.test(await page.getByTestId("choose-account").innerText()));
  const marks = await page.$$eval('[data-testid="recon-row"]', (rows) => rows.map((r) => [r.getAttribute("data-account-missing"), r.innerText]));
  chk("every row: Account missing (nothing compared)", marks.every(([m, t]) => m === "true" && /Account missing|No account/.test(t)), JSON.stringify(marks));
  chk("evidence: similar on the card", /similar on QA Credit Card/.test(marks[0][1]) && /Nothing similar in any account/.test(marks[2][1]), JSON.stringify(marks.map((m) => m[1].replace(/\s+/g, " ").slice(0, 120))));
  chk("no decisions possible yet (no row menus)", (await page.getByTestId("quick-decide").count()) === 0);
  const suggestion = page.getByTestId("account-suggestion");
  chk("account suggested from evidence (2 of 3 rows), not selected", (await suggestion.count()) === 1 && /2\/3/.test(await suggestion.innerText()) && (await page.getByTestId("account-bar").getAttribute("data-selected")) === "false");
  await page.getByTestId("recon-row").nth(1).click();
  chk("FlowFi side: Account not verified + the ₹799 hint", /Account not verified/.test(await page.getByTestId("existing-hints-note").innerText()) && (await page.locator('[data-testid="existing-hint-row"]').filter({ hasText: /BOOK HOUSE/ }).count()) === 1);
  await h.shot(page, "v3-account-missing");
  await page.getByTestId("use-hint-account").first().click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-row"]')].every((r) => r.getAttribute("data-state") !== "pending"), null, { timeout: 60000 });
  chk("Use account selects it", /QA Credit Card/.test(await page.getByTestId("selected-account").innerText()));
  const after = await page.$$eval('[data-testid="recon-row"]', (rows) => rows.map((r) => r.getAttribute("data-state")));
  chk("recalculated: exact · possible (₹800 vs ₹799) · no match", after[0] === "exact_candidate" && ["near_amount", "same_merchant_date"].includes(after[1]) && after[2] === "no_match", JSON.stringify(after));
  await nothingWritten(chk, before);
  await discard(page);
});

scenario("recon-v3-layout", "Compact workspace: many rows visible, one-line toolbar, slim strip, no overflow at 1920/1366, divider drag + double-click 50/50, Focus Mode shows more rows — zero writes", async ({ page }, chk) => {
  const before = await Promise.all([h.list("transactions"), h.list("accounts")]);
  const text = Array.from({ length: 40 }, (_, i) => `${ddmmyyyy(-2 - (i % 6))}\tUPI/62${String(7000000000 + i)}/DR/MERCHANT ${String(i + 1).padStart(2, "0")}/HDFC/m${i}@okaxis\t${(150 + i * 13.75).toFixed(2)} Dr`).join("\n");
  await paste(page, text);
  await chooseCard(page);
  const visibleRows = () =>
    page.evaluate(() => {
      const body = document.querySelector('[data-testid="recon-grid-body"]').getBoundingClientRect();
      return [...document.querySelectorAll('[data-testid="recon-row"]')].filter((r) => {
        const b = r.getBoundingClientRect();
        return b.top >= body.top - 1 && b.bottom <= body.bottom + 1;
      }).length;
    });
  const overflow = () =>
    page.evaluate(() => ({
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      inner: ["statement-sheet", "existing-sheet", "workspace-header", "status-bar"].map((id) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        return el ? el.scrollWidth - el.clientWidth : 0;
      }),
    }));

  for (const [vp, minRows, minFocus] of [
    [{ width: 1920, height: 1080 }, 16, 20],
    [{ width: 1366, height: 768 }, 8, 12],
  ]) {
    const tag = `${vp.width}×${vp.height}`;
    await page.setViewportSize(vp);
    await page.waitForTimeout(500);
    await page.getByTestId("recon-row").first().click();
    await page.waitForTimeout(250);
    const rowH = (await box(page, "recon-row")).height;
    chk(`${tag}: rows are 36px`, Math.round(rowH) === 36, rowH);
    const n = await visibleRows();
    chk(`${tag}: ≥ ${minRows} statement rows visible`, n >= minRows, n);
    const header = await box(page, "workspace-header");
    chk(`${tag}: toolbar ≤ 2 lines (≤ 76px)${vp.width >= 1900 ? " — one line (≤ 42px)" : ""}`, header.height <= (vp.width >= 1900 ? 42 : 76), header.height);
    const bar = await box(page, "status-bar");
    chk(`${tag}: footer one line, on screen`, bar.height <= 40 && bar.y + bar.height <= vp.height + 1, JSON.stringify(bar));
    const ov = await overflow();
    chk(`${tag}: no horizontal overflow`, ov.doc <= 1 && ov.inner.every((o) => o <= 1), JSON.stringify(ov));
    await h.shot(page, `v3-${vp.width}-normal`);

    // Divider: drag right, then double-click returns to 50/50.
    const sep = page.getByRole("separator", { name: "Resize the sheets" });
    const sb = await sep.boundingBox();
    const leftBefore = (await box(page, "statement-sheet")).width;
    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
    await page.mouse.down();
    await page.mouse.move(sb.x + sb.width / 2 + 160, sb.y + sb.height / 2, { steps: 8 });
    await page.mouse.up();
    const leftDragged = (await box(page, "statement-sheet")).width;
    chk(`${tag}: dragging the divider widens the statement`, leftDragged > leftBefore + 60, JSON.stringify({ leftBefore, leftDragged }));
    await sep.dblclick();
    await page.waitForTimeout(150);
    chk(`${tag}: double-click → 50/50`, (await sep.getAttribute("aria-valuenow")) === "50", await sep.getAttribute("aria-valuenow"));

    // Focus Mode: more rows.
    await page.getByTestId("focus-mode-toggle").click();
    await page.waitForTimeout(450);
    const nf = await visibleRows();
    chk(`${tag}: Focus Mode shows ≥ ${minFocus} rows (more than normal)`, nf >= minFocus && nf > n, JSON.stringify({ normal: n, focus: nf }));
    const ovf = await overflow();
    chk(`${tag}: Focus Mode: no overflow`, ovf.doc <= 1 && ovf.inner.every((o) => o <= 1), JSON.stringify(ovf));
    await h.shot(page, `v3-${vp.width}-focus`);
    await page.getByTestId("focus-mode-toggle").click();
    await page.waitForTimeout(300);
  }
  await nothingWritten(chk, before);
  await discard(page);
});

scenario("recon-v3-decide", "Select → possible matches → compare → decide: ₹299 exact, no-match row lists rows that match, Ignore match, Keep existing, Import as new imported exactly once (balance once), re-approval writes nothing", async ({ page }, chk) => {
  const d = ddmmyyyy(-6);
  await seedTyped(page, [`${d}\tJIO RECHARGE\t299.00 Dr`, `${d}\tCAFE BLR\t298.00 Dr`]);
  const before = await Promise.all([h.list("transactions"), h.list("accounts")]);
  const cardBefore = (await h.accountBalance("QA Credit Card")).currentBalance;
  const statement = [`${d}\tUPI/664081439342/CR/MOHAN /BKID/mohankoda/UPI\t2000.00 Cr`, `${d}\tUPI/627632125367/DR/JIO/HDFC/jio@okhdfcbank\t299.00 Dr`, `${d}\tCAFE BLR\t300.00 Dr`].join("\n");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await paste(page, statement);
  await chooseCard(page);
  const comparing = () => page.getByTestId("existing-comparing").getAttribute("data-row-id");

  // Row 1 (₹2,000 credit): no match — the FlowFi side says so for THIS row and lists the rows that do match.
  await page.getByTestId("recon-row").nth(0).click();
  chk("FlowFi side compares the selected row (row 1)", (await comparing()) === "r1");
  chk("row 1: no possible match", /No match for Row/.test(await page.getByTestId("existing-empty").innerText()));
  const others = await page.getByTestId("existing-other-row").allInnerTexts();
  chk("…and it lists rows 2 (exact) and 3 (possible)", others.length === 2 && /Possible match/.test(others[0]) && /Possible match/.test(others[1]), JSON.stringify(others));
  await page.getByTestId("existing-other-rows").getByRole("button", { name: "Compare row 2" }).click();
  await page.waitForTimeout(200);
  chk("one click compares row 2", (await comparing()) === "r2" && (await page.locator('[data-testid="recon-row"][aria-selected="true"]').getAttribute("data-row-id")) === "r2");
  const jio = page.locator('[data-testid="existing-row"]').filter({ hasText: /JIO RECHARGE/ });
  chk("₹299 / same day → the FlowFi ₹299 is the Possible match on the right", (await jio.count()) === 1 && /Possible match/.test(await jio.innerText()));
  chk("the right sheet names the account and has no explanation block", /QA Credit Card/.test(await page.getByTestId("existing-sheet").innerText()) && (await page.getByTestId("existing-evidence").count()) === 0);
  await choose(page, "keep_existing");
  chk("Keep existing recorded (draft)", (await page.locator('[data-testid="recon-row"][data-row-id="r2"]').getAttribute("data-decision")) === "link");

  // Row 3 (₹300 vs hand-typed ₹298): Ignore match drops the suggestion; Undo restores it; then Import as new (keep both).
  await page.locator('[data-testid="recon-row"][data-row-id="r3"]').click();
  chk("row 3: ₹300 vs ₹298 is a possible match", ["near_amount", "same_merchant_date"].includes(await page.locator('[data-testid="recon-row"][data-row-id="r3"]').getAttribute("data-state")));
  chk("difference shown: ₹2.00", /₹2\.00/.test(await page.getByTestId("existing-difference").first().innerText()));
  const cafe = () => page.locator('[data-testid="existing-row"]').filter({ hasText: /CAFE BLR/ }).count();
  chk("the hand-typed ₹298 is row 3's suggestion", (await cafe()) === 1);
  await choose(page, "ignore_match");
  await page.waitForTimeout(200);
  // Only THAT suggestion is dropped (row 3 is also ₹1 from the ₹299 row 2 already keeps) — nothing decided or dismissed.
  chk("Ignore match drops the ₹298 suggestion; row 3 stays undecided", (await cafe()) === 0 && (await page.locator('[data-testid="recon-row"][data-row-id="r3"]').getAttribute("data-decision")) === "");
  await page.getByTestId("undo-decision").click();
  chk("Undo brings the suggestion back", ["near_amount", "same_merchant_date"].includes(await page.locator('[data-testid="recon-row"][data-row-id="r3"]').getAttribute("data-state")));
  await openImportConfirm(page);
  const confirm = page.getByTestId("import-confirm");
  await confirm.getByRole("checkbox", { name: "These are separate transactions" }).click();
  const category = await confirm.getByLabel("Category for import").locator("option").nth(1).getAttribute("value");
  await confirm.getByLabel("Category for import").selectOption(category);
  await page.getByTestId("import-confirm-submit").click();
  chk("Import as new recorded (draft, Keep both)", (await page.locator('[data-testid="recon-row"][data-row-id="r3"]').getAttribute("data-decision")) === "import_new");

  // Row 1: skip. Approve: exactly one new transaction, balance moves once.
  await page.locator('[data-testid="recon-row"][data-row-id="r1"]').click();
  await pressOnGrid(page, "i");
  await nothingWritten(chk, before); // deciding writes nothing
  await page.getByTestId("open-approval").click();
  let dlg = page.getByTestId("approval-dialog");
  await dlg.getByTestId("approval-confirm").click();
  if (await dlg.getByTestId("approval-repeats").count()) await dlg.getByTestId("approval-repeats").getByRole("checkbox").click();
  await dlg.getByTestId("approval-submit").click();
  await dlg.getByTestId("approval-result").waitFor({ timeout: 90000 });
  const after = await h.list("transactions");
  chk("approval imported exactly one transaction (the ₹300)", after.length === before[0].length + 1 && after.filter((t) => t.amount === 300).length === 1, `${before[0].length} → ${after.length}`);
  const cardAfter = (await h.accountBalance("QA Credit Card")).currentBalance;
  chk("card balance moved by exactly ₹300", Math.round((cardBefore - cardAfter) * 100) === 30000, `${cardBefore} → ${cardAfter}`);
  await dlg.getByRole("button", { name: /Clear this review|Start a new review|Done/ }).first().click().catch(() => page.keyboard.press("Escape"));
  await discard(page);

  // Same statement again: row 3 is recognised as imported; nothing more can be written.
  await paste(page, statement);
  await chooseCard(page);
  chk("re-review: row 3 shows Imported", (await page.locator('[data-testid="recon-row"][data-row-id="r3"]').getAttribute("data-state")) === "already_imported");
  chk("re-review: no second import possible", (await h.list("transactions")).length === after.length && Math.round(((await h.accountBalance("QA Credit Card")).currentBalance) * 100) === Math.round(cardAfter * 100));
  await h.shot(page, "v3-decide-rereview");
  await discard(page);
});
