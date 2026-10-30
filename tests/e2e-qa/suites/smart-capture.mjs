/**
 * Smart Capture (/smart-capture) — paste + screenshot OCR, against the local emulator only.
 *
 * Screenshots are SYNTHETIC: an HTML statement table rendered in a scratch tab and captured with Playwright, so the
 * ground truth is known exactly and no real statement is involved. The harness aborts every non-localhost request,
 * which also proves the OCR worker / WASM / language data are served from this app's own /ocr/ folder.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const TRUTH = [
  { date: "05/09/2026", desc: "SWIGGY BANGALORE", amount: "452.00", dir: "Dr" },
  { date: "06/09/2026", desc: "AMAZON PAY INDIA PRIVATE", amount: "1,24,999.00", dir: "Dr" },
  { date: "07/09/2026", desc: "REFUND MYNTRA DESIGNS", amount: "1,299.00", dir: "Cr" },
  { date: "10/09/2026", desc: "UBER INDIA SYSTEMS", amount: "389.50", dir: "Dr" },
  { date: "12/09/2026", desc: "BIGBASKET SUPERMARKET", amount: "2,812.75", dir: "Dr" },
  { date: "15/09/2026", desc: "FINANCE CHARGES", amount: "312.40", dir: "Dr" },
  { date: "15/09/2026", desc: "IGST ON FINANCE CHARGES", amount: "56.23", dir: "Dr" },
  { date: "18/09/2026", desc: "CASHBACK CREDIT", amount: "150.00", dir: "Cr" },
];
const toNumber = (s) => Number(s.replace(/,/g, ""));

/** Variants model real screenshots: crisp desktop PDF view, small mono net-banking text, low-contrast phone grab. */
const VARIANTS = {
  crisp: { font: "Arial, sans-serif", size: 16, color: "#111", bg: "#fff", pad: 8 },
  small: { font: "Consolas, 'Courier New', monospace", size: 12, color: "#222", bg: "#fff", pad: 4 },
  lowContrast: { font: "Georgia, serif", size: 13, color: "#777", bg: "#f2f2f2", pad: 5 },
};

function statementHtml(v) {
  const rows = TRUTH.map((r) => `<tr><td>${r.date}</td><td>${r.desc}</td><td class="a">${r.amount} ${r.dir}</td></tr>`).join("");
  return `<html><body style="margin:0;background:${v.bg}"><div id="s" style="display:inline-block;padding:24px;background:${v.bg};font-family:${v.font};font-size:${v.size}px;color:${v.color}">
    <div style="font-weight:bold;margin-bottom:12px">QA SYNTHETIC CARD — STATEMENT FOR SEP 2026</div>
    <table style="border-collapse:collapse"><thead><tr><th style="text-align:left;padding:${v.pad}px 24px ${v.pad}px 0">Date</th><th style="text-align:left;padding:${v.pad}px 24px">Transaction Details</th><th style="text-align:right;padding:${v.pad}px 0">Amount (Rs.)</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div style="margin-top:12px">Total Amount Due &nbsp;&nbsp; 1,29,000.00</div><div>Credit Limit &nbsp;&nbsp; 3,00,000.00</div>
    <style>td{padding:${v.pad}px 24px ${v.pad}px 0} td+td{padding-left:24px} td.a{text-align:right;padding-right:0}</style></div></body></html>`;
}

async function renderStatement(ctx, variant) {
  const scratch = await ctx.newPage();
  await scratch.setViewportSize({ width: 1100, height: 700 });
  await scratch.setContent(statementHtml(VARIANTS[variant]));
  const buffer = await scratch.locator("#s").screenshot();
  await scratch.close();
  return buffer;
}

async function openCapture(page) {
  // Not in run.mjs's warm-up list, so the first dev compile of this route can exceed h.go's 30s wait.
  await page.evaluate(() => window.next.router.push("/smart-capture"));
  await page.getByRole("heading", { name: "Smart Capture" }).waitFor({ timeout: 240000 });
}

async function loadImage(page, buffer, name = "synthetic-statement.png") {
  await page.getByRole("tab", { name: /Screenshot/ }).click();
  const imgSrc = () => page.evaluate(() => document.querySelector('[data-testid="crop-area"] img')?.src ?? null);
  const previous = await imgSrc();
  await page.getByLabel("Choose screenshot").setInputFiles({ name, mimeType: "image/png", buffer });
  if (previous) {
    // A review from an earlier read is restored when returning to Smart Capture: replacing its source screenshot asks
    // first (a deliberate guard — the rows were read from the old image).
    const replace = page.locator('[role="alertdialog"], [role="dialog"]').getByRole("button", { name: /^Replace screenshot$/ });
    await replace.waitFor({ timeout: 15000 });
    await replace.click();
  }
  await page.waitForFunction(
    (old) => {
      const box = document.querySelector('[data-testid="crop-area"]');
      const img = box?.querySelector("img");
      return !!box && box.getBoundingClientRect().height > 0 && !!img?.complete && img.src !== old;
    },
    previous,
    { timeout: 60000 },
  );
}

const ddmmyyyy = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};

async function snapshotWrites() {
  const [txns, accounts, imports] = await Promise.all([h.list("transactions"), h.list("accounts"), h.list("documentImports")]);
  return JSON.stringify({ txns: txns.length, balances: accounts.map((a) => `${a.name}:${a.currentBalance}`).sort(), imports: imports.length });
}

// ---- Two-step flow helpers: Capture → Review & Import (/reconciliation). The old third "review" step is gone. ----

const reconRow = (page, desc) => page.locator('[data-testid="recon-row"]').filter({ hasText: desc }).first();
const atRecon = (page, timeout = 300000) => page.waitForFunction(() => location.pathname.replace(/[/]$/, "") === "/reconciliation", null, { timeout });
const onCapture = (page) => new URL(page.url()).pathname.replace(/[/]$/, "") === "/smart-capture";

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

/** Extract (paste) or Read (screenshot) lands straight on Review & Import; waits for it and returns the elapsed ms. */
async function landOnReview(page, t0 = Date.now()) {
  await atRecon(page);
  await page.getByRole("heading", { name: "Review & Import" }).waitFor({ timeout: 240000 });
  await page.getByTestId("handoff-notice").waitFor({ timeout: 240000 });
  return Date.now() - t0;
}

async function chooseAccount(page, name) {
  await page.getByRole("button", { name: /(Choose|Change) statement account/ }).click();
  await page.getByRole("option", { name: new RegExp(name) }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-row"]')].every((r) => r.getAttribute("data-state") !== "pending"), null, { timeout: 90000 });
  await page.getByTestId("import-summary").waitFor({ timeout: 60000 });
}

/** Score OCR output (Review & Import rows, in statement order) against the known truth. */
function score(rows) {
  let amounts = 0;
  let dirs = 0;
  const wrongAmounts = [];
  TRUTH.forEach((t, i) => {
    const r = rows[i];
    if (!r) return;
    if (r.amount === toNumber(t.amount)) amounts++;
    else wrongAmounts.push({ expected: t.amount, read: r.amount, check: r.check });
    if (r.dir === (t.dir === "Cr" ? "credit" : "debit")) dirs++;
  });
  return { found: rows.length, expected: TRUTH.length, amounts, dirs, wrongAmounts, readyNoClick: rows.filter((r) => !r.check).length };
}

scenario("scap-paste", "Smart Capture (paste): Extract lands on Review & Import; exact duplicates, exclude, category, final import, no early writes", async ({ page }, chk) => {
  const bank = (await h.list("accounts")).find((a) => a.name === "QA Bank");
  const expenseCat = (await h.list("categories")).find((c) => c.type === "expense" && !c.deletedAt && c.isActive !== false);
  const before = await snapshotWrites();
  const txnsBefore = (await h.list("transactions")).filter((t) => !t.deletedAt).length;
  const bankBefore = Number(bank.currentBalance);

  await openCapture(page);
  // Synthetic rows lined up with the seeded QA Bank: ₹850 "QA groceries" 2 days ago, ₹40,000 "QA salary" 6 days ago.
  const text = [`${ddmmyyyy(-2)}\tQA GROCERIES\t850.00 Dr`, `${ddmmyyyy(-6)}\tSALARY CREDIT\t40,000.00 Cr`, `${ddmmyyyy(-1)}\tCAFE NEW\t210.00 Dr`, `${ddmmyyyy(-1)}\tSKIP ME SHOP\t55.00 Dr`].join("\n");
  await page.getByLabel("Pasted statement text").fill(`${text}\nTotal Amount Due\t1,26,750.00`);
  await page.getByRole("button", { name: /Extract transactions/ }).click();
  await landOnReview(page);
  chk("two steps: straight to Review & Import", (await page.getByRole("list", { name: "Progress" }).innerText()).includes("Review & Import") && (await page.getByText(/Next: Check duplicates|Approve & Import/).count()) === 0);
  chk("handoff notice counts the 4 rows", /4 .*rows? arrived/.test(await page.getByTestId("handoff-notice").innerText()), await page.getByTestId("handoff-notice").innerText());
  await chooseAccount(page, "QA Bank");

  const rows = await reconRows(page);
  chk("4 rows, the statement total ignored", rows.length === 4, `${rows.length}`);
  chk("reliable pasted rows need no individual confirmation", rows.every((r) => !r.check), JSON.stringify(rows.map((r) => r.check)));
  chk("existing groceries expense is an exact candidate", (await reconRow(page, "QA GROCERIES").getAttribute("data-state")) === "exact_candidate");
  chk("existing salary is an exact candidate", (await reconRow(page, "SALARY CREDIT").getAttribute("data-state")) === "exact_candidate");
  chk("a new charge is no_match", (await reconRow(page, "CAFE NEW").getAttribute("data-state")) === "no_match");
  chk("nothing decided automatically", rows.every((r) => r.decision === ""));

  // Exclude one row in Review & Import (it must never import).
  await reconRow(page, "SKIP ME SHOP").dblclick();
  await page.getByRole("switch", { name: "Include this row" }).click();
  await page.keyboard.press("Escape");
  chk("the excluded row is excluded", (await reconRow(page, "SKIP ME SHOP").getAttribute("data-state")) === "excluded");

  // Duplicates: comparison dock → Keep existing for both exact matches; nothing written.
  await reconRow(page, "QA GROCERIES").click();
  const dock = page.getByTestId("resolution-dock");
  chk("the dock compares the groceries row with an existing FlowFi transaction", (await dock.getAttribute("data-record-id")) != null);
  await dock.getByTestId("resolve-keep_existing").click();
  chk("Keep existing recorded as the draft decision", (await reconRow(page, "QA GROCERIES").innerText()).includes("Keep existing"));
  await reconRow(page, "SALARY CREDIT").click();
  await page.getByTestId("resolution-dock").getByTestId("resolve-keep_existing").click();
  await h.shot(page, "scap-paste-review");

  // The new charge: Import new via the bulk dialog, with a category.
  await page.getByTestId("bulk-import-open").click();
  const bulk = page.getByTestId("bulk-import-dialog");
  const bulkRows = await bulk.getByTestId("bulk-import-row").allInnerTexts();
  chk("bulk offers only the new charge (not the exact matches, the credit or the excluded row)", bulkRows.length === 1 && /CAFE NEW/.test(bulkRows[0]), JSON.stringify(bulkRows.map((t) => t.split("\n")[0])));
  await bulk.getByTestId("bulk-fill-all").selectOption(expenseCat.name);
  await bulk.getByTestId("bulk-import-apply").click();
  chk("CAFE NEW decided as Import new", (await reconRow(page, "CAFE NEW").getAttribute("data-decision")) === "import_new");

  // Refresh keeps the review and the decisions.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Restored your review").waitFor({ timeout: 120000 });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-row"]')].some((r) => r.getAttribute("data-state") === "exact_candidate"), null, { timeout: 60000 });
  chk("refresh keeps the review and the decisions", (await reconRow(page, "QA GROCERIES").innerText()).includes("Keep existing") && (await reconRow(page, "CAFE NEW").getAttribute("data-decision")) === "import_new");
  chk("NOTHING written during Capture or Review", (await snapshotWrites()) === before, `${before} → ${await snapshotWrites()}`);

  // Final import: summary, explicit confirmation, a double click is still ONE import.
  await page.getByTestId("open-approval").click();
  const dlg = page.getByTestId("approval-dialog");
  await dlg.getByTestId("count-new").waitFor({ timeout: 60000 });
  chk("summary: 1 to import", /\b1\b/.test(await dlg.getByTestId("count-new").innerText()), await dlg.getByTestId("count-new").innerText());
  chk("import needs the explicit confirmation", await dlg.getByTestId("approval-submit").isDisabled());
  await dlg.getByTestId("approval-confirm").click();
  await dlg.getByTestId("approval-submit").dblclick();
  await dlg.getByTestId("approval-result").waitFor({ timeout: 90000 });
  chk("import complete", (await dlg.getByTestId("approval-result").getAttribute("data-status")) === "complete");
  const txns = (await h.list("transactions")).filter((t) => !t.deletedAt);
  chk("exactly one transaction written (double click = one import)", txns.length === txnsBefore + 1, `${txnsBefore} → ${txns.length}`);
  const created = txns.find((t) => /CAFE NEW/.test(t.description));
  chk("posted as a ₹210 expense on QA Bank, in the chosen category", !!created && created.type === "expense" && created.amount === 210 && created.accountId === bank.id && created.categoryId === expenseCat.id, JSON.stringify(created && [created.type, created.amount, created.accountId === bank.id, created.categoryId === expenseCat.id]));
  const bankAfter = Number((await h.list("accounts")).find((a) => a.id === bank.id).currentBalance);
  chk("QA Bank balance reduced by exactly ₹210", Math.round((bankBefore - bankAfter) * 100) === 21000, `${bankBefore} → ${bankAfter}`);
  chk("nothing created for the salary or the excluded row", !txns.some((t) => /SKIP ME/.test(t.description)) && txns.filter((t) => /SALARY CREDIT/.test(t.description)).length === 0);
});

// One browser per image quality: a different capture arriving while a review is open deliberately waits for the user's
// choice (handoffConflict), so reads are never stacked in one session.
for (const variant of ["crisp", "small", "lowContrast"]) {
  scenario(`scap-ocr-${variant}`, `Smart Capture (screenshot, ${variant}): self-hosted OCR, flagged vs ready rows, ${variant === "crisp" ? "screenshot strip, refresh, " : ""}zero writes`, async ({ page, ctx }, chk, notes) => {
    const ocrRequests = [];
    page.on("response", (r) => {
      if (r.url().includes("/ocr/")) ocrRequests.push({ url: new URL(r.url()).pathname, status: r.status() });
    });
    await openCapture(page);
    chk("no OCR asset requested before reading", ocrRequests.length === 0);
    const before = await snapshotWrites();

    await loadImage(page, await renderStatement(ctx, variant), `${variant}.png`);
    const t0 = Date.now();
    await page.getByRole("button", { name: /Read (text|selected area)|Try again/ }).click();
    const ms = await landOnReview(page, t0);
    await chooseAccount(page, "QA Credit Card");
    const acc = score(await reconRows(page));
    notes.push(`OCR + handoff ${ms} ms; accuracy ${JSON.stringify(acc)}`);
    await h.shot(page, `scap-ocr-review-${variant}`);
    chk("OCR assets came only from /ocr/ on this origin", ocrRequests.length > 0 && ocrRequests.every((r) => r.url.startsWith("/ocr/")) && h.egressViolations.length === 0, h.egressViolations.join(","));
    chk("no misread amount is ever Ready without a check", acc.wrongAmounts.every((w) => w.check), JSON.stringify(acc.wrongAmounts));
    if (variant !== "crisp") {
      chk("rows were found", acc.found > 0, JSON.stringify(acc));
      chk("NOTHING written", (await snapshotWrites()) === before);
      return;
    }
    chk("every row found", acc.found === TRUTH.length, JSON.stringify(acc));
    chk("reliable rows are Ready — no per-row confirmation needed", acc.readyNoClick >= TRUTH.length - 3, `${acc.readyNoClick}/${TRUTH.length}`);

    // The row's strip of the screenshot is shown beside the comparison, from memory only.
    await reconRow(page, TRUTH[0].desc.split(" ")[0]).click();
    await page.getByTestId("dock-details").click();
    const zoomImg = page.getByRole("dialog").getByTestId("row-zoom").locator("img");
    await zoomImg.waitFor({ timeout: 30000 });
    chk("the row's strip of the screenshot is shown beside the comparison", /^blob:/.test((await zoomImg.getAttribute("src")) ?? ""));
    chk("the screenshot image actually loaded (URL not revoked by Smart Capture)", await zoomImg.evaluate((img) => img.complete && img.naturalWidth > 0));
    await page.keyboard.press("Escape");

    // After a refresh the screenshot is gone (never stored) — and the page says so.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("Restored your review").waitFor({ timeout: 120000 });
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-row"]')].every((r) => r.getAttribute("data-state") !== "pending"), null, { timeout: 60000 });
    await reconRow(page, TRUTH[0].desc.split(" ")[0]).click();
    await page.getByTestId("dock-details").click();
    await page.getByRole("dialog").getByTestId("screenshot-unavailable").waitFor({ timeout: 60000 });
    chk("after refresh: screenshot clearly marked unavailable", true);
    const stored = await page.evaluate(() => Object.keys(sessionStorage).map((k) => sessionStorage.getItem(k)).join(""));
    chk("no screenshot or blob URL in browser storage", !/blob:|data:image/.test(stored));
    chk("NOTHING written (read, review, refresh)", (await snapshotWrites()) === before);
  });
}

scenario("scap-ocr-fail-cancel", "Smart Capture: OCR asset failure → retry lands on Review & Import; cancel mid-read", async ({ page, ctx }, chk) => {
  await openCapture(page);
  await loadImage(page, await renderStatement(ctx, "crisp"));
  // The worker script is fetched by the page (requests made inside the worker aren't routable), so block that.
  await page.route("**/ocr/worker.min.js", (r) => r.abort("failed"));
  await page.getByRole("button", { name: /Read text/ }).click();
  // Next's route announcer is also role="alert" — match ours by its text.
  const failure = page.getByRole("alert").filter({ hasText: /Couldn't read this screenshot/ });
  await failure.waitFor({ timeout: 60000 });
  chk("failure explained", true, await failure.innerText());
  chk("nothing handed over on failure (still on Smart Capture)", onCapture(page) && (await page.getByTestId("recon-row").count()) === 0);
  await page.unroute("**/ocr/worker.min.js");
  await page.getByRole("button", { name: /Try again/ }).click();
  await landOnReview(page);
  chk("retry succeeds and lands on Review & Import", (await page.getByTestId("recon-row").count()) > 0);

  await openCapture(page);
  await loadImage(page, await renderStatement(ctx, "crisp"));
  await page.getByRole("button", { name: /Read text/ }).click();
  await page.getByRole("button", { name: "Cancel" }).click({ timeout: 10000 });
  await page.getByText(/Reading cancelled/).waitFor({ timeout: 15000 });
  chk("cancel stops reading and hands nothing over", onCapture(page));
});

// scap-refresh retired 2026-10-30: it drove the removed review step's draft and row exclusion. Refresh/restore of the
// review is covered by scap-paste and scap-ocr ("Restored your review").

/**
 * Regression for a real card-statement screenshot (2026-10-26), REDACTED to synthetic data with the same layout:
 * Date | Details | narrow country column ("IN") | Amount | separate single-letter C/D column, plus a row sliver cut off
 * under the table header, and a genuine same-amount Charge/Credit pair.
 */
const CD_ROWS = [
  ["03 Oct 26", "RETAIL STORE LIMITE", "IN", "101.00", "D"],
  ["03 Oct 26", "RETAIL STORE LIMITE", "IN", "101.00", "C"],
  ["06 Oct 26", "TELECOM SELFCARE", "IN", "434.61", "D"],
  ["06 Oct 26", "UPI-PERSON D", "", "100.00", "D"],
  ["07 Oct 26", "BROADBAND PROVIDER BA", "IN", "504.17", "D"],
  ["09 Oct 26", "MOBILE PAYMENTS", "IN", "399.00", "D"],
  ["10 Oct 26", "UPI-SHOP ONE", "", "480.00", "D"],
  ["11 Oct 26", "CINEMA TICKETS", "IN", "550.80", "D"],
  ["12 Oct 26", "MOBILE TOPUP", "IN", "470.00", "D"],
  ["14 Oct 26", "PETROL STATION", "", "111.30", "D"],
  ["14 Oct 26", "UPI-TEA SHOP", "", "80.00", "D"],
  ["15 Oct 26", "UPI-TEA SHOP", "", "72.00", "D"],
  ["16 Oct 26", "ASTRO SERVICES PRI", "IN", "118.00", "D"],
];

function cdStatementHtml() {
  const cells = (r) => r.map((c, i) => `<td class="c${i}">${c}</td>`).join("");
  const sliver = ["02 Oct 26", "RETAIL STORE LIMITE", "IN", "101.00", "D"];
  return `<html><body style="margin:0;background:#fff"><div id="s" style="display:inline-block;padding:16px;font-family:Arial,sans-serif;font-size:13px;color:#111;background:#fff">
  <style>table{border-collapse:collapse;width:640px} td,th{padding:4px 8px;text-align:left;white-space:nowrap} .c0{width:80px}.c1{width:300px}.c2{width:40px}.c3{width:100px;text-align:right}.c4{width:20px} th{border-bottom:1px solid #999}</style>
  <table><tr><th class="c0">Date</th><th class="c1">Transaction Details</th><th class="c2"></th><th class="c3">Amount (Rs.)</th><th class="c4"></th></tr></table>
  <div style="height:7px;overflow:hidden;position:relative"><table style="position:absolute;bottom:0"><tr>${cells(sliver)}</tr></table></div>
  <table>${CD_ROWS.map((r) => `<tr>${cells(r)}</tr>`).join("")}</table></div></body></html>`;
}


scenario("scap-cd-regression", "Smart Capture: C/D column, IN column, sliver, genuine pair → Review & Import rows are right or flagged; credit classification; zero writes", async ({ page, ctx }, chk, notes) => {
  const scratch = await ctx.newPage();
  await scratch.setContent(cdStatementHtml());
  const buffer = await scratch.locator("#s").screenshot();
  await scratch.close();

  const before = await snapshotWrites();
  await openCapture(page);
  await loadImage(page, buffer, "cd-statement.png");
  await page.getByRole("button", { name: /Read (text|selected area)/ }).click();
  await landOnReview(page);
  await chooseAccount(page, "QA Credit Card");
  const rows = await reconRows(page);
  notes.push(`rows: ${JSON.stringify(rows.map(({ desc, amount, dir, check }) => [desc, amount, dir, check]))}`);
  const norm = (s) => s.replace(/\s/g, "").toUpperCase();

  const retail = rows.filter((r) => norm(r.desc).includes(norm("RETAIL STORE LIMITE")) && r.amount === 101);
  chk("genuine same-amount pair kept as two rows: one charge, one credit", retail.length >= 2 && new Set(retail.map((r) => r.dir)).size === 2, JSON.stringify(retail));
  chk("'IN' column kept out of descriptions", rows.every((r) => !/\sIN$/.test(r.desc)), rows.map((r) => r.desc).join(" / "));
  // OCR noise (a misread date, a stray "~~") may stay in front of the merchant — visible, and the row is flagged.
  chk("every expected transaction is its own row (nothing merged or dropped)", CD_ROWS.every(([, d]) => rows.some((r) => norm(r.desc).includes(norm(d)))), rows.map((r) => r.desc).join(" / "));

  // Safety: each amount/direction either matches the image or its row carries a check (never silently Ready).
  const unsafe = [];
  for (const [, desc, , amount, cd] of CD_ROWS) {
    const candidates = rows.filter((r) => norm(r.desc).includes(norm(desc)));
    const match = candidates.find((r) => r.dir === (cd === "C" ? "credit" : "debit")) ?? candidates[0];
    if (!match) continue;
    if (match.amount !== toNumber(amount) && !match.check) unsafe.push(`${desc}: amount ${match.amount}`);
    if (match.dir !== (cd === "C" ? "credit" : "debit") && !match.check) unsafe.push(`${desc}: direction ${match.dir}`);
  }
  chk("every misread amount/direction carries a check (never silently Ready)", unsafe.length === 0, unsafe.join("; "));
  const credits = rows.filter((r) => r.dir === "credit");
  chk("credit classification: only the C-marked row is a credit", credits.length === 1 && norm(credits[0].desc).includes("RETAILSTORE"), JSON.stringify(credits.map((r) => [r.desc, r.amount])));
  chk("the cut-off sliver never becomes an extra included row", rows.filter((r) => norm(r.desc).includes("RETAILSTORE")).length <= 2, `${rows.filter((r) => norm(r.desc).includes("RETAILSTORE")).length}`);
  await h.shot(page, "scap-cd-review");
  chk("NOTHING written", (await snapshotWrites()) === before);
});
