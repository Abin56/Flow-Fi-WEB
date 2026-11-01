/**
 * Smart Capture column mapping ("Match your columns") — against the local emulator only.
 *
 * Synthetic data only. A bank-style statement (Date · Narration · Chq/Ref · Value Dt · Withdrawal · Deposit · Balance)
 * is pasted, and also rendered to a screenshot and read by the real OCR: the mapping step must detect the columns,
 * show them without horizontal page overflow on phones, let the user correct a role, and then hand the right
 * amounts and Charge/Credit directions to Review & Import — with the Balance column never imported as an amount.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const ddmmyy = (offset) => {
  const d = new Date(Date.now() + offset * 86400000);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getFullYear()).slice(2)}`;
};

// Opening balance 50,000.00 — every balance follows from the row above it.
const ROWS = [
  { offset: -6, desc: "UPI SWIGGY BANGALORE", ref: "0000427412345", debit: "450.00", credit: "", balance: "49,550.00" },
  { offset: -5, desc: "SALARY ACME PRIVATE", ref: "0000427499999", debit: "", credit: "1,00,000.00", balance: "1,49,550.00" },
  { offset: -4, desc: "ATM WDL MG ROAD", ref: "0000427455555", debit: "10,000.00", credit: "", balance: "1,39,550.00" },
  { offset: -3, desc: "UPI ZOMATO ORDER", ref: "0000427400001", debit: "310.50", credit: "", balance: "1,39,239.50" },
];

const HEADER = ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"];
const pasted = () => [HEADER, ...ROWS.map((r) => [ddmmyy(r.offset), r.desc, r.ref, ddmmyy(r.offset), r.debit, r.credit, r.balance])].map((c) => c.join("\t")).join("\n");

function screenshotHtml() {
  const cell = (v, right) => `<td${right ? ' class="a"' : ""}>${v}</td>`;
  const body = ROWS.map((r) => `<tr>${cell(ddmmyy(r.offset))}${cell(r.desc)}${cell(r.debit, true)}${cell(r.credit, true)}${cell(r.balance, true)}</tr>`).join("");
  return `<html><body style="margin:0;background:#fff"><div id="s" style="display:inline-block;padding:20px;background:#fff;font-family:Arial,sans-serif;font-size:16px;color:#111">
  <table style="border-collapse:collapse"><thead><tr><th style="text-align:left">Date</th><th style="text-align:left">Narration</th><th style="text-align:right">Withdrawal</th><th style="text-align:right">Deposit</th><th style="text-align:right">Balance</th></tr></thead><tbody>${body}</tbody></table>
  <style>td,th{padding:8px 30px 8px 0} td.a,th:nth-child(n+3){text-align:right;padding-left:50px;padding-right:0}</style></div></body></html>`;
}

async function openCapture(page) {
  await page.evaluate(() => window.next.router.push("/smart-capture"));
  await page.getByRole("heading", { name: "Smart Capture" }).waitFor({ timeout: 240000 });
}

const roleOf = (page, i) => page.getByTestId(`column-role-${i}`).inputValue();
const atRecon = (page) => page.waitForFunction(() => location.pathname.replace(/[/]$/, "") === "/reconciliation", null, { timeout: 300000 });
const pageOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function chooseAccount(page, name) {
  await page.getByRole("button", { name: /(Choose|Change) statement account/ }).click();
  await page.getByRole("option", { name: new RegExp(name) }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="recon-row"]')].every((r) => r.getAttribute("data-state") !== "pending"), null, { timeout: 90000 });
}

const reconRows = (page) =>
  page.getByTestId("recon-row").evaluateAll((els) => els.map((e) => ({ amount: e.dataset.amount === "" ? null : Number(e.dataset.amount), dir: e.dataset.direction, desc: e.dataset.description, check: e.querySelector('[data-testid="row-check-label"]')?.textContent ?? null })));

async function txnCount() {
  return (await h.list("transactions")).filter((t) => !t.deletedAt).length;
}

scenario("colmap-paste", "Column mapping (paste): bank columns detected, readable on phones, correctable, Debit/Credit right in Review & Import, Balance never imported", async ({ page }, chk, notes) => {
  const before = await txnCount();
  await openCapture(page);
  await page.getByLabel("Pasted statement text").fill(pasted());
  await page.getByRole("button", { name: /Extract transactions/ }).click();
  await page.getByTestId("column-mapping").waitFor();
  await page.getByTestId("mapping-confirm").waitFor();

  const roles = [];
  for (let i = 0; i < HEADER.length; i++) roles.push(await roleOf(page, i));
  notes.push(`roles: ${roles.join(" | ")}`);
  chk("columns detected from the headers", roles.join() === "date,description,reference,ignore,debit,credit,balance", roles.join());
  chk("nothing is handed over before the user confirms", new URL(page.url()).pathname.replace(/[/]$/, "") === "/smart-capture");
  chk("preview shows the debit/credit split and the balance check", /Charges/.test(await page.getByTestId("mapping-result").innerText()) && /Balance checks out on 3 of 3/.test(await page.getByTestId("mapping-result-note").innerText()), await page.getByTestId("mapping-result-note").innerText());
  await h.shot(page, "colmap-paste-desktop");

  for (const vp of [{ width: 390, height: 844 }, { width: 360, height: 780 }]) {
    await page.setViewportSize(vp);
    await page.waitForTimeout(400);
    chk(`${vp.width}px: no horizontal page scroll (the table scrolls inside its own box)`, (await pageOverflow(page)) <= 0, `${await pageOverflow(page)}`);
    chk(`${vp.width}px: role pickers and Confirm stay reachable`, (await page.getByTestId("column-role-4").isVisible()) && (await page.getByTestId("mapping-confirm").isVisible()));
    await h.shot(page, `colmap-paste-${vp.width}`);
  }
  await page.setViewportSize({ width: 1280, height: 800 });

  // Correcting a role: ignoring the Date blocks Confirm until it is chosen again.
  await page.getByTestId("column-role-0").selectOption("ignore");
  chk("no Date column → Confirm disabled with a plain reason", (await page.getByTestId("mapping-confirm").isDisabled()) && /Date/.test(await page.getByTestId("mapping-error").first().innerText()));
  await page.getByTestId("column-role-0").selectOption("date");
  chk("choosing it again re-enables Confirm", await page.getByTestId("mapping-confirm").isEnabled());
  // Swapping Debit/Credit is noticed by the balance and offered back.
  await page.getByTestId("column-role-4").selectOption("credit");
  await page.getByTestId("column-role-5").selectOption("debit");
  chk("swapped Debit/Credit: the balance flags it and offers the swap", (await page.getByTestId("mapping-swap").count()) === 1);
  await page.getByTestId("mapping-swap").click();
  chk("swap restores Withdrawal → Debit", (await roleOf(page, 4)) === "debit" && (await roleOf(page, 5)) === "credit");

  await page.getByTestId("mapping-confirm").click();
  await atRecon(page);
  await page.getByRole("heading", { name: "Review & Import" }).waitFor({ timeout: 240000 });
  await chooseAccount(page, "QA Bank");
  const rows = await reconRows(page);
  notes.push(`rows: ${JSON.stringify(rows)}`);
  chk("4 rows, none for the balance", rows.length === 4, `${rows.length}`);
  chk(
    "amounts and Charge/Credit follow the Withdrawal / Deposit columns",
    ROWS.every((t, i) => rows[i] && rows[i].amount === Number((t.debit || t.credit).replace(/,/g, "")) && rows[i].dir === (t.debit ? "debit" : "credit")),
    JSON.stringify(rows.map((r) => [r.amount, r.dir])),
  );
  chk("clean pasted rows need no individual check", rows.every((r) => !r.check), JSON.stringify(rows.map((r) => r.check)));
  chk("NOTHING written while mapping and reviewing", (await txnCount()) === before);
});

scenario("colmap-ocr", "Column mapping (screenshot): columns found by position from the real OCR, blank cells keep their column, Balance not judged", async ({ page, ctx }, chk, notes) => {
  const scratch = await ctx.newPage();
  await scratch.setViewportSize({ width: 1100, height: 700 });
  await scratch.setContent(screenshotHtml());
  const buffer = await scratch.locator("#s").screenshot();
  await scratch.close();

  const before = await txnCount();
  await openCapture(page);
  await page.getByRole("tab", { name: /Screenshot/ }).click();
  await page.getByLabel("Choose screenshot").setInputFiles({ name: "bank.png", mimeType: "image/png", buffer });
  await page.getByTestId("crop-area").waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="crop-area"] img')?.complete);
  await page.getByRole("button", { name: /Read text/ }).click();
  await page.getByTestId("column-mapping").waitFor({ timeout: 300000 });

  const count = await page.locator('[data-testid^="column-role-"]').count();
  const roles = [];
  for (let i = 0; i < count; i++) roles.push(await roleOf(page, i));
  notes.push(`roles: ${roles.join(" | ")}`);
  chk("5 columns found by position, roles from the headers", roles.join() === "date,description,debit,credit,balance", roles.join());
  await h.shot(page, "colmap-ocr-desktop");
  await page.getByTestId("mapping-confirm").click();
  await atRecon(page);
  await page.getByRole("heading", { name: "Review & Import" }).waitFor({ timeout: 240000 });
  await chooseAccount(page, "QA Bank");
  const rows = await reconRows(page);
  notes.push(`rows: ${JSON.stringify(rows)}`);
  chk("4 rows", rows.length === 4, `${rows.length}`);
  // Each row is right, or carries a check — never a wrong amount/direction that looks fine.
  const unsafe = ROWS.flatMap((t, i) => {
    const r = rows[i];
    const wantAmount = Number((t.debit || t.credit).replace(/,/g, ""));
    const wantDir = t.debit ? "debit" : "credit";
    return r && (r.amount !== wantAmount || r.dir !== wantDir) && !r.check ? [`${t.desc}: ${r.amount} ${r.dir}`] : [];
  });
  chk("no wrong amount or direction without a check", unsafe.length === 0, unsafe.join("; "));
  chk("directions come from the Withdrawal / Deposit columns", ROWS.every((t, i) => rows[i]?.dir === (t.debit ? "debit" : "credit")), JSON.stringify(rows.map((r) => r.dir)));
  chk("NOTHING written", (await txnCount()) === before);
});
