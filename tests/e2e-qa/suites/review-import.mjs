/**
 * Smart Capture two-step flow — Capture → Review & Import — against the local emulator only.
 *
 * Screenshots are SYNTHETIC (an HTML statement rendered in a scratch tab), so the ground truth is known exactly. Covers:
 * extraction landing straight on Review & Import; OCR rows read clearly needing no click; genuine ambiguities staying
 * reviewable (never Ready with a wrong amount); one confirmation per row; an exact duplicate, a near match
 * (₹100.00 vs ₹100.70) and a legitimate repeated pair; money totals vs. truth and after include/exclude; the bulk
 * "Import new rows" with history-suggested categories; the final summary + one explicit confirmation; exact writes,
 * a replay that writes nothing more; zero writes during review; 20- and 100-row statements; 1280 / 390 / 360 layouts.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const day = (offset) => new Date(Date.now() + offset * 86400000);
const ddmmyyyy = (offset) => {
  const d = day(offset);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};
const fmt = (n) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const paise = (n) => Math.round(n * 100);

function statementHtml(rows, { size = 15, pad = 6 } = {}) {
  const tr = rows.map((r) => `<tr><td>${ddmmyyyy(r.offset)}</td><td>${r.desc}</td><td class="a">${fmt(r.amount)} ${r.dir}</td></tr>`).join("");
  return `<html><body style="margin:0;background:#fff"><div id="s" style="display:inline-block;padding:20px;background:#fff;font-family:Arial,sans-serif;font-size:${size}px;color:#111">
  <table style="border-collapse:collapse"><thead><tr><th style="text-align:left">Date</th><th style="text-align:left">Transaction Details</th><th style="text-align:right">Amount (Rs.)</th></tr></thead>
  <tbody>${tr}</tbody></table>
  <style>td,th{padding:${pad}px 28px ${pad}px 0} td.a,th:last-child{text-align:right;padding-right:0}</style></div></body></html>`;
}

async function screenshotOf(ctx, rows, opts) {
  const scratch = await ctx.newPage();
  await scratch.setViewportSize({ width: 1100, height: 800 });
  await scratch.setContent(statementHtml(rows, opts));
  const buffer = await scratch.locator("#s").screenshot();
  await scratch.close();
  return buffer;
}

async function openCapture(page) {
  await page.evaluate(() => window.next.router.push("/smart-capture"));
  await page.getByRole("heading", { name: "Smart Capture" }).waitFor({ timeout: 240000 });
}

/** Screenshot → OCR → lands on Review & Import (no review step in between). Returns the OCR+handoff time. */
async function captureScreenshot(page, buffer) {
  await page.getByRole("tab", { name: /Screenshot/ }).click();
  await page.getByLabel("Choose screenshot").setInputFiles({ name: "statement.png", mimeType: "image/png", buffer });
  await page.getByTestId("crop-area").waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="crop-area"] img')?.complete);
  const t0 = Date.now();
  await page.getByRole("button", { name: /Read text/ }).click();
  await page.waitForFunction(() => location.pathname.replace(/[/]$/, "") === "/reconciliation", null, { timeout: 300000 });
  await page.getByRole("heading", { name: "Review & Import" }).waitFor({ timeout: 240000 });
  return Date.now() - t0;
}

async function chooseAccount(page, name) {
  await page.getByRole("button", { name: /(Choose|Change) statement account/ }).click();
  await page.getByRole("option", { name: new RegExp(name) }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-row"]')].every((r) => r.getAttribute("data-state") !== "pending"), null, { timeout: 90000 });
  await page.getByTestId("import-summary").waitFor({ timeout: 60000 });
}

const reconRows = (page) =>
  page.getByTestId("recon-row").evaluateAll((els) =>
    els.map((e) => ({
      id: e.dataset.rowId,
      state: e.dataset.state,
      amount: e.dataset.amount === "" ? null : Number(e.dataset.amount),
      dir: e.dataset.direction,
      desc: e.dataset.description,
      decision: e.dataset.decision,
      check: e.querySelector('[data-testid="row-check-label"]')?.textContent ?? null,
    })),
  );
const figure = async (page, id) => Number(await page.getByTestId(id).getAttribute("data-value"));
const countOf = async (page, id) => Number(await page.getByTestId(id).locator("dd").innerText());

async function writesSnapshot() {
  const [txns, accounts] = await Promise.all([h.list("transactions"), h.list("accounts")]);
  return { txns: txns.filter((t) => !t.deletedAt).length, ids: new Set(txns.map((t) => t.id)), balances: accounts.map((a) => `${a.name}:${a.currentBalance}`).sort().join("|") };
}

/** Match each truth row to the screen row in statement order (OCR may misread a description, never reorder). */
function pairUp(truth, rows) {
  return truth.map((t, i) => ({ t, r: rows[i] ?? null }));
}

/** Settles every row's OCR check with its ONE action; a "Fix" row (a value to correct) gets the true amount typed. */
async function settleChecks(page, truth, notes) {
  const counts = { confirmed: 0, corrected: 0, clicksPerRow: [] };
  for (let guard = 0; guard < 120; guard++) {
    const rows = await reconRows(page);
    const pending = rows.find((r) => r.check);
    if (!pending) break;
    await page.getByTestId("next-check").click();
    const editor = page.getByTestId("row-editor");
    await editor.waitFor();
    const buttons = await editor.getByRole("button", { name: /^(Confirm|Row matches|Values are correct)/ }).count();
    counts.clicksPerRow.push(buttons);
    if (/^Fix/.test(pending.check)) {
      const idx = rows.findIndex((r) => r.id === pending.id);
      const t = truth[idx];
      notes.push(`fix row ${idx + 1} "${pending.desc}" (${pending.check}) read ${pending.amount} → truth ${t?.amount}`);
      if (t) {
        const amount = editor.getByLabel("Amount", { exact: true });
        await amount.fill(String(t.amount));
        await amount.press("Enter");
        if (pending.dir !== (t.dir === "Cr" ? "credit" : "debit")) await editor.getByRole("radio", { name: t.dir === "Cr" ? "Credit" : "Charge" }).click();
      }
      counts.corrected++;
    }
    const confirm = editor.getByTestId("confirm-row");
    if (await confirm.count()) {
      await confirm.click();
      counts.confirmed++;
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    const after = (await reconRows(page)).find((r) => r.id === pending.id);
    if (after?.check) {
      notes.push(`row "${pending.desc}" still "${after.check}" after its action — excluding it`);
      await page.getByTestId("next-check").click();
      await page.getByRole("switch", { name: "Include this row" }).click();
      await page.keyboard.press("Escape");
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------------------------------------------

const FLOW = [
  { offset: -2, desc: "QA GROCERIES", amount: 850, dir: "Dr" }, // exact duplicate of the seeded QA groceries
  { offset: -3, desc: "QA CAFE", amount: 100, dir: "Dr" }, // near match: FlowFi has ₹100.70 that day
  { offset: -4, desc: "QA TEA STALL", amount: 80, dir: "Dr" }, // legitimate repeated pair …
  { offset: -4, desc: "QA TEA STALL", amount: 80, dir: "Dr" }, // … both real
  { offset: -5, desc: "QA BOOKSTORE", amount: 499, dir: "Dr" }, // history says "Food"-style category
  { offset: -5, desc: "QA PHARMACY", amount: 1234.56, dir: "Dr" }, // clean, no history
  { offset: -1, desc: "QA REFUND SHOP", amount: 299, dir: "Cr" }, // a credit — never bulk
];

scenario("rimp-flow", "Capture → Review & Import: OCR checks, exact/near/repeat duplicates, totals, bulk import, final import, replay", async ({ page, ctx }, chk, notes) => {
  const accounts = await h.list("accounts");
  const bank = accounts.find((a) => a.name === "QA Bank");
  const categories = await h.list("categories");
  const expenseCat = categories.find((c) => c.type === "expense" && !c.deletedAt && c.isActive !== false);
  // Synthetic FlowFi records: the near match, and two earlier bookstore expenses (category history, too old to match).
  const raw = (id, desc, amount, offset) =>
    h.createDocUnderUser(`transactions/${id}`, { type: "expense", amount, dateTime: day(offset), accountId: bank.id, categoryId: expenseCat.id, description: desc, notes: "", status: "posted", source: "manual", createdAt: day(offset), deletedAt: null, excludeFromCalculations: false, editHistory: [] });
  await raw("qa_near_cafe", "QA CAFE", 100.7, -3);
  await raw("qa_hist_book1", "QA BOOKSTORE", 350, -40);
  await raw("qa_hist_book2", "QA BOOKSTORE", 420, -55);

  const start = await writesSnapshot();
  await openCapture(page);
  const ms = await captureScreenshot(page, await screenshotOf(ctx, FLOW));
  notes.push(`OCR + handoff ${ms} ms`);
  chk("extraction lands straight on Review & Import (two steps, no review step)", (await page.getByRole("list", { name: "Progress" }).innerText()).includes("Review & Import"));
  chk("handoff notice", /rows? arrived from Smart Capture/.test(await page.getByTestId("handoff-notice").innerText()));
  await chooseAccount(page, "QA Bank");

  let rows = await reconRows(page);
  notes.push(`rows: ${JSON.stringify(rows.map((r) => [r.desc, r.amount, r.dir, r.state, r.check]))}`);
  chk("every statement row is its own row (nothing merged or dropped)", rows.length === FLOW.length, `${rows.length}`);
  const pairs = pairUp(FLOW, rows);
  const unsafe = pairs.filter(({ t, r }) => r && !r.check && (paise(r.amount ?? -1) !== paise(t.amount) || r.dir !== (t.dir === "Cr" ? "credit" : "debit")));
  chk("no misread amount or direction is ever unflagged", unsafe.length === 0, JSON.stringify(unsafe));
  const readyNoClick = rows.filter((r) => !r.check).length;
  notes.push(`ready with no click: ${readyNoClick}/${rows.length}`);
  chk("most clearly-read rows need no click", readyNoClick >= FLOW.length - 3, `${readyNoClick}`);
  chk("the legitimate repeated pair is kept as two rows, each flagged for one look", pairs.filter(({ t }) => t.desc === "QA TEA STALL").every(({ r }) => r && /repeat|Check|Fix/.test(r.check ?? "")));

  // Settle OCR checks with the one action per row.
  const settled = await settleChecks(page, FLOW, notes);
  notes.push(`checks: ${JSON.stringify(settled)}`);
  chk("never more than one confirmation button per row", settled.clicksPerRow.every((n) => n <= 1), JSON.stringify(settled.clicksPerRow));
  rows = await reconRows(page);
  chk("no row left to check", rows.every((r) => !r.check));

  // Totals = included rows' current values, to the paisa.
  const truthDebits = FLOW.filter((r) => r.dir === "Dr").reduce((s, r) => s + paise(r.amount), 0) / 100;
  const truthCredits = FLOW.filter((r) => r.dir === "Cr").reduce((s, r) => s + paise(r.amount), 0) / 100;
  chk("debits total matches the statement", (await figure(page, "total-debits")) === truthDebits, `${await figure(page, "total-debits")} vs ${truthDebits}`);
  chk("credits total matches the statement", (await figure(page, "total-credits")) === truthCredits);
  chk("net = credits − debits", (await figure(page, "total-net")) === Math.round((truthCredits - truthDebits) * 100) / 100);
  const dupCount = await countOf(page, "summary-duplicates");
  chk("possible duplicates counted (exact groceries + near cafe at least)", dupCount >= 2, `${dupCount}`);
  // Exclude / include the pharmacy row: totals follow immediately.
  const pharmacy = page.locator('[data-testid="recon-row"][data-description*="PHARMACY"]').first();
  await pharmacy.dblclick();
  await page.getByRole("switch", { name: "Include this row" }).click();
  chk("excluding a row drops it from the totals", (await figure(page, "total-debits")) === Math.round((truthDebits - 1234.56) * 100) / 100);
  await page.getByRole("switch", { name: "Include this row" }).click();
  chk("including it again restores the totals", (await figure(page, "total-debits")) === truthDebits);
  await page.keyboard.press("Escape");

  // Exact + near: both shown as possible matches, never decided automatically.
  const grocery = (await reconRows(page)).find((r) => /GROCER/.test(r.desc));
  const cafe = (await reconRows(page)).find((r) => /CAFE/.test(r.desc));
  chk("exact duplicate offered as an exact candidate", grocery?.state === "exact_candidate", grocery?.state);
  chk("₹100.00 vs ₹100.70 is a possible match, not a confirmed duplicate", cafe && cafe.state !== "exact_candidate" && cafe.state !== "no_match" && cafe.decision === "", cafe?.state);
  chk("nothing was decided automatically", (await reconRows(page)).every((r) => r.decision === ""));
  // Near match: the user decides — Same transaction (Keep existing → skipped at import), side by side in the dock.
  await page.locator(`[data-testid="recon-row"][data-row-id="${cafe.id}"]`).click();
  const dock = page.getByTestId("resolution-dock");
  chk("the dock compares the cafe row with FlowFi's ₹100.70 side by side", /100\.70/.test(await dock.innerText()));
  await dock.getByTestId("resolve-keep_existing").click();
  // Exact: bulk Keep existing (confirmed).
  await page.getByRole("button", { name: /Keep existing for exact matches/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Keep existing" }).click().catch(async () => page.getByRole("dialog").getByRole("button", { name: "Keep existing" }).click());

  // Bulk Import new rows: clean unmatched charges only.
  await page.getByTestId("bulk-import-open").click();
  const bulk = page.getByTestId("bulk-import-dialog");
  const bulkRows = await bulk.getByTestId("bulk-import-row").allInnerTexts();
  notes.push(`bulk rows: ${JSON.stringify(bulkRows.map((t) => t.split("\n")[0]))}`);
  chk("bulk never offers the refund credit, the exact or the near match", !bulkRows.some((t) => /REFUND|GROCER|CAFE/.test(t)));
  chk("bulk offers the bookstore, pharmacy and both tea rows", ["BOOKSTORE", "PHARMACY"].every((d) => bulkRows.some((t) => t.includes(d))) && bulkRows.filter((t) => t.includes("TEA")).length === 2, `${bulkRows.length}`);
  const bookSelect = bulk.getByLabel(/Category for QA BOOKSTORE/);
  chk("bookstore's category suggested from history", (await bookSelect.inputValue()) === expenseCat.name, await bookSelect.inputValue());
  await bulk.getByTestId("bulk-fill-all").selectOption(expenseCat.name);
  await h.shot(page, "rimp-bulk-dialog");
  await bulk.getByTestId("bulk-import-apply").click();

  // The credit: its own decision (Skip here — a credit is never bulk-imported or assumed).
  const refund = (await reconRows(page)).find((r) => /REFUND/.test(r.desc));
  await page.locator(`[data-testid="recon-row"][data-row-id="${refund.id}"]`).click();
  await page.getByTestId("resolution-dock").getByTestId("resolve-skip").click();

  rows = await reconRows(page);
  notes.push(`decisions: ${JSON.stringify(rows.map((r) => [r.desc, r.decision]))}`);
  chk("every row decided", rows.every((r) => r.decision !== ""));
  const willImport = await countOf(page, "summary-will-import");
  chk("final button names the import count", (await page.getByTestId("open-approval").innerText()).includes(`Import ${willImport} transaction`));
  const mid = await writesSnapshot();
  chk("NOTHING written during review", mid.txns === start.txns && mid.balances === start.balances, `${start.txns} → ${mid.txns}`);
  await h.shot(page, "rimp-before-import");

  // Final summary + one explicit confirmation.
  const before = await writesSnapshot();
  await page.getByTestId("open-approval").click();
  const dlg = page.getByTestId("approval-dialog");
  await dlg.getByTestId("count-new").waitFor({ timeout: 60000 });
  const newCount = Number((await dlg.getByTestId("count-new").innerText()).match(/\d+/)[0]);
  chk("final summary: new / kept existing / skipped / excluded all shown", (await dlg.getByTestId("count-linked").count()) === 1 && (await dlg.getByTestId("count-ignored").count()) === 1 && (await dlg.getByTestId("count-excluded").count()) === 1);
  chk("summary count = Will import", newCount === willImport, `${newCount} vs ${willImport}`);
  if (await dlg.getByTestId("approval-repeats").count()) await dlg.getByTestId("approval-repeats").getByRole("checkbox").click();
  chk("import needs the explicit confirmation", await dlg.getByTestId("approval-submit").isDisabled());
  await dlg.getByTestId("approval-confirm").click();
  await h.shot(page, "rimp-final-summary");
  await dlg.getByTestId("approval-submit").dblclick(); // a double click is still ONE import
  await dlg.getByTestId("approval-result").waitFor({ timeout: 90000 });
  chk("import complete", (await dlg.getByTestId("approval-result").getAttribute("data-status")) === "complete");
  const after = await writesSnapshot();
  chk("exactly the announced number of transactions written", after.txns === before.txns + newCount, `${before.txns} → ${after.txns} (expected +${newCount})`);
  const created = (await h.list("transactions")).filter((t) => !before.ids.has(t.id));
  const createdTotal = created.reduce((s, t) => s + paise(t.amount), 0) / 100;
  notes.push(`created: ${JSON.stringify(created.map((t) => [t.description, t.amount]))}`);
  chk("both legitimate tea purchases imported", created.filter((t) => /TEA/.test(t.description)).length === 2);
  chk("no duplicate of the groceries or cafe, no refund", !created.some((t) => /GROCER|CAFE|REFUND/.test(t.description)));
  chk("written amounts = the rows marked for import", createdTotal === 80 + 80 + 499 + 1234.56, `${createdTotal}`);

  // Replay: reload and approve again — idempotent, nothing more written.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Review & Import" }).waitFor({ timeout: 120000 });
  await page.waitForTimeout(1500);
  if (await page.getByTestId("open-approval").isEnabled().catch(() => false)) {
    await page.getByTestId("open-approval").click();
    const again = page.getByTestId("approval-dialog");
    await again.waitFor();
    if (await again.getByTestId("approval-confirm").count()) {
      await again.getByTestId("approval-confirm").click();
      await again.getByTestId("approval-submit").click();
      await again.getByTestId("approval-result").waitFor({ timeout: 90000 });
    }
  }
  chk("a replay writes nothing more", (await writesSnapshot()).txns === after.txns);
});

// ---------------------------------------------------------------------------------------------------------------

const MERCHANTS = ["SWIGGY", "ZOMATO", "UBER INDIA", "BIGBASKET", "AMAZON PAY", "FLIPKART", "BOOKMYSHOW", "RELIANCE FRESH", "HP PETROL", "APOLLO PHARMACY", "DMART", "MYNTRA", "OLA CABS", "IRCTC", "AIRTEL"];
function synthetic(n, seed) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  return Array.from({ length: n }, (_, i) => {
    const credit = i % 9 === 4;
    const amount = Math.round((credit ? 50 + rnd() * 2000 : 20 + rnd() * (i % 7 === 0 ? 120000 : 4000)) * 100) / 100;
    return { offset: -2 - (i % 6), desc: `${MERCHANTS[i % MERCHANTS.length]} ${String(i + 1).padStart(3, "0")}`, amount, dir: credit ? "Cr" : "Dr" };
  });
}

for (const n of [5, 20, 100]) {
  scenario(`rimp-scale-${n}`, `Review & Import with a ${n}-row synthetic screenshot: readiness, safety, totals, bulk eligibility, zero writes`, async ({ page, ctx }, chk, notes) => {
    const truth = synthetic(n, n * 7919);
    const start = await writesSnapshot();
    await openCapture(page);
    const ms = await captureScreenshot(page, await screenshotOf(ctx, truth, { size: n === 100 ? 13 : 15, pad: n === 100 ? 3 : 6 }));
    await chooseAccount(page, "QA Bank");
    const rows = await reconRows(page);
    const pairs = pairUp(truth, rows);
    const wrong = pairs.filter(({ t, r }) => !r || paise(r.amount ?? -1) !== paise(t.amount));
    const unsafe = pairs.filter(({ t, r }) => r && !r.check && (paise(r.amount ?? -1) !== paise(t.amount) || r.dir !== (t.dir === "Cr" ? "credit" : "debit")));
    const ready = rows.filter((r) => !r.check).length;
    notes.push(`n=${n} OCR+handoff ${ms} ms · rows ${rows.length} · ready with no click ${ready} · to check ${rows.length - ready} · misread ${wrong.length}`);
    if (wrong.length) notes.push(`misreads: ${JSON.stringify(wrong.slice(0, 8).map(({ t, r }) => [t.amount, r?.amount, r?.check]))}`);
    chk(`${n}: every row found`, rows.length === n, `${rows.length}`);
    chk(`${n}: no misread amount/direction is ever unflagged`, unsafe.length === 0, JSON.stringify(unsafe.slice(0, 5)));
    chk(`${n}: at least 80% of rows Ready with no click`, ready >= Math.floor(n * 0.8), `${ready}/${n}`);
    // Totals = the included rows as currently shown (to the paisa).
    const shownDebits = rows.filter((r) => r.dir === "debit" && r.amount != null).reduce((s, r) => s + paise(r.amount), 0) / 100;
    chk(`${n}: debits total = sum of the rows shown`, (await figure(page, "total-debits")) === shownDebits, `${await figure(page, "total-debits")} vs ${shownDebits}`);
    if (wrong.length === 0) chk(`${n}: debits total = the statement's`, shownDebits === truth.filter((t) => t.dir === "Dr").reduce((s, t) => s + paise(t.amount), 0) / 100);
    const bulkBtn = page.getByTestId("bulk-import-open");
    const bulkN = (await bulkBtn.count()) ? Number((await bulkBtn.innerText()).match(/\((\d+)\)/)[1]) : 0;
    const expectedBulk = rows.filter((r) => !r.check && r.dir === "debit" && r.state === "no_match").length;
    chk(`${n}: bulk offers exactly the clean, unmatched charges`, bulkN === expectedBulk, `${bulkN} vs ${expectedBulk}`);
    await h.shot(page, `rimp-scale-${n}`);
    chk(`${n}: NOTHING written`, (await writesSnapshot()).txns === start.txns);
  });
}

// ---------------------------------------------------------------------------------------------------------------

scenario("rimp-responsive", "Smart Capture + Review & Import at 1280 desktop and 390 / 360 phones: no overflow, long amounts never clipped", async ({ page, ctx }, chk, notes) => {
  const truth = [
    { offset: -2, desc: "QA LONG AMOUNT MERCHANT WITH A VERY LONG NAME", amount: 12345678.9, dir: "Dr" },
    { offset: -3, desc: "QA SMALL", amount: 99.5, dir: "Dr" },
    { offset: -3, desc: "QA BIG CREDIT", amount: 9876543.21, dir: "Cr" },
  ];
  await openCapture(page);
  await captureScreenshot(page, await screenshotOf(ctx, truth));
  await chooseAccount(page, "QA Bank");
  const overflow = () =>
    page.evaluate(() => {
      const clipped = [...document.querySelectorAll('[data-testid="import-summary"] dd, [data-testid="recon-row"] .tabular-nums, [data-testid="recon-card"] .tabular-nums')].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent);
      return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, clipped };
    });
  for (const vp of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 360, height: 780 }]) {
    await page.setViewportSize(vp);
    await page.waitForTimeout(600);
    const o = await overflow();
    notes.push(`${vp.width}: ${JSON.stringify(o)}`);
    chk(`${vp.width}px: no horizontal page scroll`, o.page <= 0, `${o.page}`);
    chk(`${vp.width}px: no clipped amounts`, o.clipped.length === 0, o.clipped.join(" | "));
    await h.shot(page, `rimp-responsive-${vp.width}`);
  }
  // The row editor on a phone: the long amount fits its field.
  await page.locator('[data-testid="recon-card"]').first().click();
  await page.getByRole("tab", { name: "Details" }).click();
  const field = page.getByLabel("Amount", { exact: true });
  const fits = await field.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  chk("360px: the editor's amount field shows the whole figure", fits);
  await h.shot(page, "rimp-responsive-360-editor");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 360, height: 780 });
  await openCapture(page);
  chk("360px: Smart Capture has no horizontal page scroll", (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0);
});
