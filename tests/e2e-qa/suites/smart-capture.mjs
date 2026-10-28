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
  await page.getByLabel("Choose screenshot").setInputFiles({ name, mimeType: "image/png", buffer });
  await page.getByTestId("crop-area").waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="crop-area"] img')?.complete);
}

/** Rows in review, from each row's data-* attributes (works collapsed or expanded). */
async function reviewRows(page) {
  return page.getByTestId("review-row").evaluateAll((lis) =>
    lis.map((li) => ({
      id: li.dataset.rowId,
      date: li.dataset.date ?? "",
      desc: li.dataset.description ?? "",
      amount: li.dataset.amount ?? "",
      dir: li.dataset.direction === "credit" ? "Credit" : li.dataset.direction === "debit" ? "Charge" : "",
      status: li.dataset.status,
    })),
  );
}

/** Where `main` (the app shell's scroll container) is scrolled to the very end. */
async function scrollToEnd(page) {
  await page.evaluate(() => {
    const m = document.querySelector("main");
    if (m) m.scrollTop = m.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
  });
  await page.waitForTimeout(350);
}

function score(rows) {
  const iso = (d) => d.split("/").reverse().join("-");
  let dates = 0;
  let amounts = 0;
  let dirs = 0;
  let descs = 0;
  const wrongAmounts = [];
  for (const t of TRUTH) {
    const r = rows.find((x) => x.desc.replace(/\s+/g, " ").toUpperCase().includes(t.desc.split(" ")[0]));
    if (!r) continue;
    if (r.date === iso(t.date)) dates++;
    if (Number(r.amount) === toNumber(t.amount)) amounts++;
    else wrongAmounts.push({ expected: t.amount, read: r.amount, status: r.status });
    if (r.dir === (t.dir === "Cr" ? "Credit" : "Charge")) dirs++;
    if (r.desc.replace(/\s+/g, " ").trim().toUpperCase() === t.desc) descs++;
  }
  return { found: rows.length, expected: TRUTH.length, dates, amounts, dirs, descs, wrongAmounts, toFix: rows.filter((r) => r.status === "fix").length };
}

async function readAndTime(page) {
  const t0 = Date.now();
  await page.getByRole("button", { name: /Read (text|selected area)|Try again/ }).click();
  await page.getByTestId("progress-ready").waitFor({ timeout: 120000 });
  return Date.now() - t0;
}

const progress = (page, id) => page.getByTestId(id).locator("p").nth(1).innerText();

const ddmmyyyy = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};

async function snapshotWrites() {
  const [txns, accounts, imports] = await Promise.all([h.list("transactions"), h.list("accounts"), h.list("documentImports")]);
  return JSON.stringify({ txns: txns.length, balances: accounts.map((a) => `${a.name}:${a.currentBalance}`).sort(), imports: imports.length });
}

const reconRow = (page, desc) => page.locator('[data-testid="recon-row"]').filter({ hasText: desc }).first();

scenario("scap-paste", "Smart Capture: Continue hands verified rows to Reconciliation (no import path); Back restores; re-Continue merges; refresh; zero writes", async ({ page }, chk) => {
  const before = await snapshotWrites();
  await openCapture(page);
  // Synthetic rows lined up with the seeded QA Bank: ₹850 "QA groceries" 2 days ago, ₹40,000 "QA salary" 6 days ago.
  const text = [`${ddmmyyyy(-2)}\tQA GROCERIES\t850.00 Dr`, `${ddmmyyyy(-6)}\tSALARY CREDIT\t40,000.00 Cr`, `${ddmmyyyy(-1)}\tCAFE NEW\t210.00 Dr`].join("\n");
  await page.getByLabel("Pasted statement text").fill(`${text}\nTotal Amount Due\t1,26,750.00`);
  await page.getByRole("button", { name: /Extract transactions/ }).click();
  await page.getByTestId("progress-ready").waitFor();
  chk("3 rows extracted, total ignored", (await reviewRows(page)).length === 3);
  chk("the retired Approve step is not offered", (await page.getByText(/Approve & Import/).count()) === 0);
  await page.getByTestId("review-row").nth(2).getByRole("checkbox").first().click(); // exclude CAFE NEW
  await page.getByRole("button", { name: /Next: Check duplicates/ }).click();

  await page.waitForFunction(() => location.pathname.replace(/[/]$/, "") === "/reconciliation", null, { timeout: 240000 });
  await page.getByTestId("handoff-notice").waitFor({ timeout: 240000 });
  chk("handoff notice counts the 2 included rows", /2 verified rows arrived/.test(await page.getByTestId("handoff-notice").innerText()));
  await page.getByRole("button", { name: /(Choose|Change) statement account/ }).click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-row"]')].every((r) => r.getAttribute("data-state") !== "pending"), null, { timeout: 60000 });
  chk("existing groceries expense is an exact candidate", (await reconRow(page, "QA GROCERIES").getAttribute("data-state")) === "exact_candidate");
  chk("existing salary is an exact candidate", (await reconRow(page, "SALARY CREDIT").getAttribute("data-state")) === "exact_candidate");
  chk("the row excluded in Smart Capture stays excluded", (await reconRow(page, "CAFE NEW").getAttribute("data-state")) === "excluded");
  await reconRow(page, "QA GROCERIES").click();
  // Dual-Sheet UI: the comparison dock compares the row with the existing groceries expense; Keep existing = the old
  // "Already recorded — skip import" (a draft Link, never a write).
  const dock = page.getByTestId("resolution-dock");
  chk("the dock compares the groceries row with an existing FlowFi transaction", (await dock.getAttribute("data-record-id")) != null);
  await dock.getByTestId("resolve-keep_existing").click();
  chk("Keep existing recorded as the draft decision", (await reconRow(page, "QA GROCERIES").innerText()).includes("Keep existing"));
  await h.shot(page, "scap-handoff-reconciliation");

  // Back → Smart Capture reopens the capture from memory.
  await page.getByTestId("back-to-capture").click();
  await page.getByText(/Back from Check duplicates/).waitFor({ timeout: 60000 });
  chk("Back restores the reviewed rows", (await reviewRows(page)).length === 3);
  chk("…with the exclusion intact", (await page.getByTestId("review-row").nth(2).getAttribute("data-status")) === "excluded");
  await page.getByRole("button", { name: /Next: Check duplicates/ }).click();
  await page.getByTestId("handoff-notice").filter({ hasText: /nothing changed, your decisions are kept/ }).waitFor({ timeout: 60000 });
  chk("re-Continue of the same capture keeps the link", (await reconRow(page, "QA GROCERIES").innerText()).includes("Keep existing"));

  // Refresh: the review survives from the tab draft.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Restored your review").waitFor({ timeout: 120000 });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-row"]')].some((r) => r.getAttribute("data-state") === "exact_candidate"), null, { timeout: 60000 });
  chk("refresh keeps the review and the link", (await reconRow(page, "QA GROCERIES").innerText()).includes("Keep existing"));
  chk("NOTHING was written", (await snapshotWrites()) === before, `${before} → ${await snapshotWrites()}`);

  // Final approval of a review whose rows are all already in FlowFi: the summary says nothing will be imported, offers
  // no import action at all, and FlowFi stays exactly as it is.
  await reconRow(page, "SALARY CREDIT").click();
  await page.getByTestId("resolution-dock").getByTestId("resolve-keep_existing").click();
  chk("every included row decided", (await page.getByTestId("progress-count").innerText()).trim() === "2/2");
  await page.getByTestId("open-approval").click();
  const dlg = page.getByTestId("approval-dialog");
  await dlg.getByTestId("approval-nothing").waitFor({ timeout: 60000 });
  chk("approval summary: nothing will be imported", /Nothing will be imported/.test(await dlg.getByTestId("approval-nothing").innerText()));
  chk("…and no import / approve action is offered", (await dlg.getByTestId("approval-submit").count()) === 0 && (await dlg.getByTestId("approval-confirm").count()) === 0);
  await h.shot(page, "scap-handoff-approval");
  chk("final approval of kept-existing rows wrote NOTHING", (await snapshotWrites()) === before, `${before} → ${await snapshotWrites()}`);
});

scenario("scap-ocr", "Smart Capture: screenshot OCR — self-hosted assets, timing, accuracy, bulk + individual gates", async ({ page, ctx }, chk, notes) => {
  const ocrRequests = [];
  page.on("response", async (r) => {
    if (r.url().includes("/ocr/")) ocrRequests.push({ url: new URL(r.url()).pathname, status: r.status(), bytes: Number(r.headers()["content-length"] ?? 0) });
  });
  await openCapture(page);
  chk("no OCR asset requested before reading", ocrRequests.length === 0);

  const timings = {};
  const accuracy = {};
  for (const variant of ["crisp", "small", "lowContrast"]) {
    await loadImage(page, await renderStatement(ctx, variant), `${variant}.png`);
    timings[variant] = await readAndTime(page);
    accuracy[variant] = score(await reviewRows(page));
    await h.shot(page, `scap-ocr-review-${variant}`);
    if (variant !== "lowContrast") await page.getByRole("button", { name: /^Back/ }).click();
  }
  await page.getByRole("button", { name: /^Back/ }).click();
  await loadImage(page, await renderStatement(ctx, "crisp"), "crisp-again.png");
  timings.crispWarm = await readAndTime(page);

  notes.push(`timings ms: ${JSON.stringify(timings)}`);
  notes.push(`accuracy: ${JSON.stringify(accuracy)}`);
  chk("OCR assets came only from /ocr/ on this origin", ocrRequests.length > 0 && ocrRequests.every((r) => r.url.startsWith("/ocr/")) && h.egressViolations.length === 0, h.egressViolations.join(","));
  chk("crisp screenshot: every row found", accuracy.crisp.found === TRUTH.length, JSON.stringify(accuracy.crisp));
  const misreads = Object.values(accuracy).flatMap((a) => a.wrongAmounts);
  chk("no misread amount is ever 'ready' without the user (fix or image check pending)", misreads.every((w) => w.status !== "ready"), JSON.stringify(misreads));
  {
    // Documented limitation: OCR can misread with HIGH confidence; such a row is only caught by the row's image check.
    const confident = misreads.filter((w) => w.status !== "fix");
    chk.finding("OCR-CONFIDENT-MISREAD", "every misread amount is also flagged as needing correction", confident.length === 0, JSON.stringify(confident));
  }

  const cont = page.getByRole("button", { name: /Next: Check duplicates/ });
  chk("OCR rows block continuing", !(await cont.isEnabled()));
  chk("list starts compact (no editors open)", (await page.getByLabel("Amount", { exact: true }).count()) === 0);
  chk("source image shown with a highlight", (await page.getByTestId("ocr-source").count()) === 1 && (await page.getByTestId("ocr-highlight").count()) === 1);

  // Bulk confirm: one explicit confirmation, only eligible rows, undoable.
  const bulkBtn = page.getByRole("button", { name: /Confirm all reviewed rows/ });
  const bulkLabel = await bulkBtn.innerText();
  const eligible = Number(bulkLabel.match(/\((\d+)\)/)?.[1] ?? 0);
  const toFixBefore = (await reviewRows(page)).filter((r) => r.status === "fix").length;
  await bulkBtn.click();
  const dialog = page.getByRole("dialog");
  chk("bulk dialog lists exactly the eligible rows", (await dialog.getByTestId("bulk-list").locator("li").count()) === eligible, `${eligible}`);
  await h.shot(page, "scap-bulk-dialog");
  await dialog.getByRole("button", { name: /^Confirm \d+ rows?$/ }).click();
  const afterBulk = await reviewRows(page);
  chk("bulk never resolves 'fix' rows", afterBulk.filter((r) => r.status === "fix").length === toFixBefore, `${toFixBefore}`);
  chk("verified count rose by the bulk count", (await progress(page, "progress-verified")).startsWith(String(eligible)));
  await page.getByRole("button", { name: /Undo bulk confirmation/ }).click();
  chk("undo returns to zero verified", (await progress(page, "progress-verified")).startsWith("0"));
  await bulkBtn.click();
  await page.getByRole("dialog").getByRole("button", { name: /^Confirm \d+ rows?$/ }).click();

  // Remaining rows individually: "Fix …" expands the row; confirm each flagged field as read, then the row.
  for (let guard = 0; guard < 30; guard++) {
    const pending = page.getByTestId("review-row").filter({ has: page.getByTestId("row-status") });
    if ((await pending.count()) === 0) break;
    const id = await pending.first().getAttribute("data-row-id");
    const li = page.locator(`[data-testid="review-row"][data-row-id="${id}"]`);
    await li.getByTestId("row-status").click();
    const confirmField = li.getByRole("button", { name: /^Confirm (₹|date|Charge)/ });
    while ((await confirmField.count()) > 0 && (await confirmField.first().isEnabled())) await confirmField.first().click();
    const rowCheck = li.getByRole("button", { name: "Row matches the image" });
    if ((await rowCheck.count()) > 0 && (await rowCheck.isEnabled())) await rowCheck.click();
    // A row OCR left incomplete is excluded rather than guessed.
    if ((await li.getAttribute("data-status")) === "fix") await li.getByRole("checkbox").first().click();
  }
  chk("after explicit confirmation, continue is allowed", await cont.isEnabled());
  await h.shot(page, "scap-ocr-confirmed");
  const before = await snapshotWrites();
  await cont.click();

  // Reconciliation: the verified OCR rows arrive with the screenshot for side-by-side comparison.
  await page.waitForFunction(() => location.pathname.replace(/[/]$/, "") === "/reconciliation", null, { timeout: 240000 });
  await page.getByTestId("handoff-notice").waitFor({ timeout: 240000 });
  await page.getByRole("button", { name: /(Choose|Change) statement account/ }).click();
  await page.getByRole("option", { name: /QA Credit Card/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-row"]')].every((r) => r.getAttribute("data-state") !== "pending"), null, { timeout: 60000 });
  // Dual-Sheet UI: the full comparison (with the row's screenshot strip) opens from the dock's "Full details".
  await page.getByTestId("dock-details").click();
  const aside = page.getByRole("dialog");
  const zoomImg = aside.getByTestId("row-zoom").locator("img");
  await zoomImg.waitFor({ timeout: 30000 });
  chk("the row's strip of the screenshot is shown beside the comparison", /^blob:/.test((await zoomImg.getAttribute("src")) ?? ""));
  chk("the screenshot image actually loaded (URL not revoked by Smart Capture)", await zoomImg.evaluate((img) => img.complete && img.naturalWidth > 0));
  chk("rows verified in Smart Capture are not re-flagged", (await page.getByText("Check flagged values").count()) === 0);
  chk("no import or approve action exists", (await page.getByRole("button", { name: /Approve|Import \(/ }).count()) === 0);
  await h.shot(page, "scap-ocr-reconciliation");

  // After a refresh the screenshot is gone (never stored) — and the page says so.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Restored your review").waitFor({ timeout: 120000 });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-row"]')].every((r) => r.getAttribute("data-state") !== "pending"), null, { timeout: 60000 });
  await page.getByTestId("dock-details").click();
  await aside.getByTestId("screenshot-unavailable").waitFor({ timeout: 60000 });
  chk("after refresh: screenshot clearly marked unavailable", true);
  const stored = await page.evaluate(() => Object.keys(sessionStorage).map((k) => sessionStorage.getItem(k)).join(""));
  chk("no screenshot or blob URL in browser storage", !/blob:|data:image/.test(stored));
  chk("NOTHING was written", (await snapshotWrites()) === before);
});

scenario("scap-ocr-fail-cancel", "Smart Capture: OCR asset failure → retry; cancel mid-read", async ({ page, ctx }, chk) => {
  await openCapture(page);
  await loadImage(page, await renderStatement(ctx, "crisp"));
  // The worker script is fetched by the page (requests made inside the worker aren't routable), so block that.
  await page.route("**/ocr/worker.min.js", (r) => r.abort("failed"));
  await page.getByRole("button", { name: /Read text/ }).click();
  // Next's route announcer is also role="alert" — match ours by its text.
  const failure = page.getByRole("alert").filter({ hasText: /Couldn't read this screenshot/ });
  await failure.waitFor({ timeout: 60000 });
  chk("failure explained", true, await failure.innerText());
  chk("nothing extracted on failure", (await page.getByTestId("progress-ready").count()) === 0);
  await page.unroute("**/ocr/worker.min.js");
  await page.getByRole("button", { name: /Try again/ }).click();
  await page.getByTestId("progress-ready").waitFor({ timeout: 120000 });
  chk("retry succeeds", true);

  await page.getByRole("button", { name: /^Back/ }).click();
  await page.getByRole("button", { name: /Read text/ }).click();
  await page.getByRole("button", { name: "Cancel" }).click({ timeout: 10000 });
  await page.getByText(/Reading cancelled/).waitFor({ timeout: 15000 });
  chk("cancel stops reading and extracts nothing", (await page.getByTestId("progress-ready").count()) === 0);
});

scenario("scap-refresh", "Smart Capture: refresh keeps decisions only; same paste restores; new capture replaces quietly", async ({ page }, chk) => {
  await openCapture(page);
  const text = TRUTH.slice(0, 4)
    .map((t) => `${t.date}\t${t.desc}\t${t.amount} ${t.dir}`)
    .join("\n");
  await page.getByLabel("Pasted statement text").fill(text);
  await page.getByRole("button", { name: /Extract transactions/ }).click();
  await page.getByTestId("review-row").nth(1).getByRole("checkbox").click(); // exclude Amazon
  await page.waitForTimeout(300);
  const stored = await page.evaluate(() => sessionStorage.getItem("flowfi.smartCapture.draft.v1"));
  chk("draft holds no statement content", stored && !/SWIGGY|AMAZON|452|1,24,999|124999/.test(stored), stored?.slice(0, 120));

  await page.reload();
  await page.getByText(/Unfinished capture/).waitFor({ timeout: 60000 });
  chk("refresh offers recovery", true);
  await page.getByLabel("Pasted statement text").fill(text);
  await page.getByRole("button", { name: /Extract transactions/ }).click();
  await page.getByText(/Restored your decisions on 4 rows/).waitFor();
  chk("exclusion restored", (await page.getByTestId("review-row").nth(1).getAttribute("data-status")) === "excluded");

  // An intentional, different capture replaces the draft with no confusing mismatch message.
  await page.reload();
  await page.getByText(/Unfinished capture/).waitFor({ timeout: 60000 });
  await page.getByLabel("Pasted statement text").fill("01/10/2026\tSOMETHING ELSE\t10.00 Dr");
  await page.getByRole("button", { name: /Extract transactions/ }).click();
  await page.getByTestId("progress-ready").waitFor();
  chk("no mismatch message on a new capture", (await page.getByText(/doesn.t match|started fresh/).count()) === 0);
  await page.getByTestId("clear-capture").click();
  if (await page.getByRole("dialog").count()) await page.getByRole("dialog").getByRole("button", { name: "Clear capture" }).click();
  chk("discard clears the draft", (await page.evaluate(() => sessionStorage.getItem("flowfi.smartCapture.draft.v1"))) === null);
});

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

scenario("scap-cd-regression", "Smart Capture: C/D column, IN column, sliver, genuine pair; compact list, scrolling and footer on desktop + mobile", async ({ page, ctx }, chk, notes) => {
  const scratch = await ctx.newPage();
  await scratch.setContent(cdStatementHtml());
  const buffer = await scratch.locator("#s").screenshot();
  await scratch.close();

  await openCapture(page);
  await loadImage(page, buffer, "cd-statement.png");
  await readAndTime(page);
  const rows = await reviewRows(page);
  notes.push(`rows: ${JSON.stringify(rows.map(({ date, desc, amount, dir, status }) => [date, desc, amount, dir, status]))}`);
  const norm = (s) => s.replace(/\s/g, "").toUpperCase();

  const retail = rows.filter((r) => norm(r.desc) === norm("RETAIL STORE LIMITE") && r.date === "2026-10-03");
  chk("genuine same-amount pair kept as two rows: one Charge, one Credit", retail.length === 2 && new Set(retail.map((r) => r.dir)).size === 2, JSON.stringify(retail));
  chk("'IN' column kept out of descriptions", rows.every((r) => !/\sIN$/.test(r.desc)), rows.map((r) => r.desc).join(" / "));
  // OCR noise (a misread date, a stray "~~") may stay in front of the merchant — visible, and the row is flagged.
  chk("every expected transaction is its own row (nothing merged or dropped)", CD_ROWS.every(([, d]) => rows.some((r) => norm(r.desc).includes(norm(d)))), rows.map((r) => r.desc).join(" / "));

  // Safety: each value either matches the image or its row is blocked as "fix".
  const unsafe = [];
  for (const [date, desc, , amount, cd] of CD_ROWS) {
    const candidates = rows.filter((r) => norm(r.desc).includes(norm(desc)));
    const iso = `2026-10-${date.slice(0, 2)}`;
    const match = candidates.find((r) => r.date === iso && r.dir === (cd === "C" ? "Credit" : "Charge")) ?? candidates[0];
    if (!match) continue;
    if (match.amount !== String(toNumber(amount)) && match.status !== "fix") unsafe.push(`${desc}: amount ${match.amount}`);
    if (match.date !== iso && match.status !== "fix") unsafe.push(`${desc}: date ${match.date}`);
  }
  chk("every misread date/amount is blocked as 'fix' (never silently accepted)", unsafe.length === 0, unsafe.join("; "));
  chk("sliver never becomes an included row", !rows.some((r) => r.date === "2026-10-02" && r.status !== "excluded"), JSON.stringify(rows.filter((r) => r.date === "2026-10-02")));

  // Dropped decimal → candidates, not auto-selected, explicit confirm.
  const dec = page.getByTestId("review-row").filter({ hasText: /TELECOM/ }).first();
  if ((await dec.getAttribute("data-amount")) === "") {
    await dec.getByTestId("row-status").click();
    const cands = dec.getByRole("group", { name: "Amount candidates" });
    chk("missing decimal: candidates shown, none pre-selected", (await cands.getByRole("button", { pressed: true }).count()) === 0 && (await cands.getByRole("button").count()) >= 2);
    await cands.getByRole("button", { name: "₹434.61" }).click();
    chk("picking a candidate doesn't resolve it on its own", (await dec.getAttribute("data-status")) === "fix");
    await dec.getByRole("button", { name: "Confirm ₹434.61" }).click();
    notes.push(`TELECOM after confirm: ${await dec.getAttribute("data-status")}`);
  } else notes.push(`TELECOM amount read directly: ${await dec.getAttribute("data-amount")}`);
  await h.shot(page, "scap-cd-review-desktop");

  // Desktop layout: list is a bounded scroll region; the action bar sits below it and is on screen.
  await page.evaluate(() => {
    const m = document.querySelector("main");
    if (m) m.scrollTop = 0;
  });
  await page.getByTestId("review-list").scrollIntoViewIfNeeded();
  const list = await page.getByTestId("review-list").boundingBox();
  const footer = await page.getByTestId("review-footer").boundingBox();
  const vh = page.viewportSize().height;
  const listScrolls = await page.getByTestId("review-list").evaluate((el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === "auto");
  notes.push(`desktop list ${JSON.stringify(list)} footer ${JSON.stringify(footer)} listScrolls ${listScrolls}`);
  chk("desktop: action bar is below the list, never over it", footer.y >= list.y + list.height - 1);
  await scrollToEnd(page);
  const footerEnd = await page.getByTestId("review-footer").boundingBox();
  chk("desktop: action bar visible once the review is in view", footerEnd.y + footerEnd.height <= vh + 1, JSON.stringify(footerEnd));
  // Last row reachable inside the list region and fully above the action bar.
  await page.getByTestId("review-row").last().scrollIntoViewIfNeeded();
  const lastRow = await page.getByTestId("review-row").last().boundingBox();
  const footerNow = await page.getByTestId("review-footer").boundingBox();
  chk("desktop: last row fully above the action bar", lastRow.y + lastRow.height <= footerNow.y + 1, JSON.stringify({ lastRow, footerNow }));

  // Highlight follows focus.
  const tops = [];
  for (const i of [1, 2]) {
    await page.getByRole("button", { name: /^Expand / }).nth(i).click();
    tops.push(await page.getByTestId("ocr-highlight").evaluate((el) => el.style.top));
  }
  chk("source highlight moves with the focused row", tops[0] !== tops[1], tops.join(" → "));

  // Mobile: one page scroll, no horizontal overflow, screenshot in a viewer, action bar never hides the last row.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  chk("mobile: no horizontal page scroll", overflow <= 0, overflow);
  chk("mobile: list has no inner scroll region", await page.getByTestId("review-list").evaluate((el) => getComputedStyle(el).overflowY !== "auto"));
  await page.getByRole("button", { name: /Screenshot/ }).first().click();
  chk("mobile: screenshot opens in a viewer", (await page.getByTestId("screenshot-viewer").count()) === 1);
  await page.keyboard.press("Escape");
  await page.getByTestId("review-row").first().scrollIntoViewIfNeeded();
  await h.shot(page, "scap-cd-review-mobile");
  await page.getByTestId("review-row").last().scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const lastM = await page.getByTestId("review-row").last().boundingBox();
  const footerM = await page.getByTestId("review-footer").boundingBox();
  chk("mobile: last row fully visible above the sticky action bar", lastM.y + lastM.height <= footerM.y + 1, JSON.stringify({ lastM, footerM }));
  await scrollToEnd(page);
  const lastEnd = await page.getByTestId("review-row").last().boundingBox();
  const footerEndM = await page.getByTestId("review-footer").boundingBox();
  chk("mobile: at the end of the page the action bar sits below the last row", lastEnd.y + lastEnd.height <= footerEndM.y + 1, JSON.stringify({ lastEnd, footerEndM }));
  await h.shot(page, "scap-cd-review-mobile-end");
  chk("continuing still blocked until rows are verified", !(await page.getByRole("button", { name: /Next: Check duplicates/ }).isEnabled()));
});
