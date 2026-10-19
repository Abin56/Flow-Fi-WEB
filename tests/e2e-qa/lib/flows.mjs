/** Reusable UI flows + persisted-state readers shared by the reversal / editing scenarios. Local emulator only. */
import { BASE_URL } from "./env.mjs";
import * as h from "./harness.mjs";

export const commits = (page) => page.evaluate(() => window.__ev.filter((e) => e.n === "commitStart").length);
export const bal = async (name) => (await h.accountBalance(name)).currentBalance;
export const close2 = (a, b, eps = 0.005) => Math.abs(a - b) < eps;
export const flat = async (loc) => (await loc.innerText()).split("\n").join(" | ");

/** A second tab in the same browser context (shares sign-in), landed on `path` after a fresh load. */
export async function secondTab(ctx, path) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  await page.goto(`${BASE_URL}${path}`, { waitUntil: "domcontentloaded" });
  return page;
}

/* ───────────── People Ledger ───────────── */

export async function openPerson(page, name) {
  if (!/\/people(\?|$)/.test(page.url())) await h.go(page, "/people");
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: new RegExp(`Open ${name}`) }).click();
  await page.waitForTimeout(2000);
}

/** From a person's page: open Record payment on the "money received" side. */
export async function openRecord(page, { paid = false } = {}) {
  await page.getByRole("button", { name: "Record payment" }).first().click();
  await page.getByText(/Amount received|Amount paid/).first().waitFor();
  if (paid) await page.getByText(/^Paid to /).first().click();
  await page.waitForTimeout(500);
}

export const amountField = (page) => page.locator("input[inputmode='decimal'], input[inputmode='numeric']").first();

export async function pickAccountIn(page, accountName) {
  await page.getByText(/Select account/).first().click();
  await page.getByRole("option", { name: new RegExp(accountName) }).click();
}

/** Opens the row's expanded details (revert / edit live there). */
export async function expandRow(page, text) {
  await page.getByText(text).filter({ visible: true }).first().click();
  await page.waitForTimeout(900);
}

export async function confirmRevert(page, { double = false } = {}) {
  const revert = page.getByTitle("Revert this payment").filter({ visible: true }).first();
  await revert.scrollIntoViewIfNeeded();
  await revert.click();
  const dlg = page.getByRole("dialog").last();
  await dlg.getByText("Revert payment?").waitFor();
  const text = await flat(dlg);
  const btn = dlg.getByRole("button", { name: "Revert payment" });
  if (double) await btn.evaluate((b) => { b.click(); b.click(); });
  else await btn.click();
  return text;
}

/** Persisted: active (non-deleted) transactions matching a predicate. */
export async function txns(predicate) {
  return (await h.list("transactions")).filter((t) => !t.deletedAt && predicate(t));
}

/** Persisted installment totals of an EMI/loan schedule: [{seq, amountDue, amountPaid}] oldest first. */
export async function scheduleState(kind, name) {
  const docs = (await h.list(kind === "emi" ? "emis" : "loans")).filter((d) => d.name === name && !d.deletedAt);
  if (docs.length === 0) throw new Error(`no ${kind} named ${name}`);
  const inst = await h.list(`paymentSchedules/${docs[0].scheduleId}/installments`);
  return inst.filter((i) => !i.deletedAt).sort((a, b) => a.sequenceNumber - b.sequenceNumber).map((i) => ({ id: i.id, seq: i.sequenceNumber, amountDue: i.amountDue, amountPaid: i.amountPaid }));
}
export const paidTotal = (state) => state.reduce((t, i) => t + i.amountPaid, 0);

/* ───────────── Accounts statement ───────────── */

const rupees = (text) => Number(String(text).replace(/[₹,\s+−-]/g, "")) * (/^[−-]/.test(String(text).trim()) ? -1 : 1);

/**
 * Parses the statement rows currently in the DOM (newest first). Desktop lays each row out as date · time · description ·
 * debit · credit · balance; mobile as description · "date, time" · balance · "Debit ₹x" / "Credit ₹x".
 */
export function parseStatementText(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const desktop = lines.includes("DEBIT");
  const start = lines.indexOf("BALANCE") + 1;
  const end = lines.findIndex((l) => l === "Opening balance");
  const body = lines.slice(start, end >= 0 ? end : lines.length);
  const rows = [];
  if (desktop) {
    for (let i = 0; i < body.length; ) {
      if (!/^\d{1,2} \w{3,4} \d{4}$/.test(body[i] ?? "") || body[i + 5] == null) { i++; continue; }
      rows.push({ desc: body[i + 2], debit: body[i + 3] === "—" ? 0 : rupees(body[i + 3]), credit: body[i + 4] === "—" ? 0 : rupees(body[i + 4]), balance: rupees(body[i + 5]) });
      i += 6;
    }
  } else {
    for (let i = 0; i + 3 < body.length; ) {
      if (!/^\d{1,2} \w{3,4} \d{4}, /.test(body[i + 1] ?? "") || !/^(Debit|Credit) /.test(body[i + 3] ?? "")) { i++; continue; }
      const amount = rupees(body[i + 3].replace(/^(Debit|Credit) /, ""));
      rows.push({ desc: body[i], debit: body[i + 3].startsWith("Debit") ? amount : 0, credit: body[i + 3].startsWith("Credit") ? amount : 0, balance: rupees(body[i + 2]) });
      i += 4;
    }
  }
  return { rows, opening: end >= 0 ? rupees(lines[end + 1] ?? "0") : null };
}

/**
 * The statement is virtualised (only on-screen rows are in the DOM), so reading "all rows" means scrolling the sheet
 * top to bottom and merging what each screen shows, in order (newest first). Returns { rows, opening }.
 */
export async function collectStatementRows(dlg) {
  const page = dlg.page();
  const box = await dlg.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height * 0.6;
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -100000); // back to the top
  await page.waitForTimeout(300);
  const seen = new Set();
  const rows = [];
  let opening = null;
  let idle = 0;
  const absorb = async () => {
    const parsed = parseStatementText(await dlg.innerText());
    if (parsed.opening != null) opening = parsed.opening;
    let added = 0;
    for (const r of parsed.rows) {
      const key = `${r.desc}|${r.balance}`;
      if (!seen.has(key)) {
        seen.add(key);
        rows.push(r);
        added++;
      }
    }
    return added;
  };
  for (let i = 0; i < 150 && idle < 4; i++) {
    const added = await absorb();
    idle = added === 0 ? idle + 1 : 0;
    await page.mouse.wheel(0, 380);
    await page.waitForTimeout(180);
  }
  await absorb();
  return { rows, opening };
}

/**
 * Rebuilds an account's statement from the persisted transactions ALONE (not using the app's statement code):
 * counted = active, not excluded from calculations, not person-funded; income +, expense −; oldest first by date,
 * then time added, then id; whole-paise arithmetic. Returns newest-first rows with their running balances.
 */
export async function reconstructStatement(accountName) {
  const acct = await h.accountBalance(accountName);
  const txs = (await h.list("transactions")).filter((t) => t.accountId === acct.id && !t.deletedAt && !t.excludeFromCalculations && !t.fundedByPersonId);
  const paise = (n) => Math.round(n * 100);
  const when = (iso) => new Date(iso).getTime();
  txs.sort((a, b) => when(a.dateTime) - when(b.dateTime) || when(a.createdAt) - when(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let running = paise(acct.openingBalance);
  const oldestFirst = txs.map((t) => {
    const effect = t.type === "income" ? paise(t.amount) : -paise(t.amount);
    running += effect;
    return { id: t.id, desc: String(t.description).trim(), debit: effect < 0 ? -effect / 100 : 0, credit: effect > 0 ? effect / 100 : 0, balance: running / 100 };
  });
  return { opening: acct.openingBalance, current: acct.currentBalance, derived: running / 100, rows: oldestFirst.slice().reverse() };
}

/** Opens Accounts → QA Bank's balance breakdown sheet and returns its dialog locator. */
export async function openBreakdown(page, name = "QA Bank") {
  if (/\/accounts/.test(page.url())) await h.go(page, "/dashboard"); // a sheet from an earlier read may still be open
  await h.go(page, "/accounts");
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: `View ${name} balance breakdown` }).click();
  const dlg = page.getByRole("dialog").last();
  await dlg.getByText("TRANSACTION HISTORY").waitFor();
  await page.waitForTimeout(800);
  return dlg;
}

/** Clicks "Show N more" until every row is loaded; returns how many times it was clicked. */
export async function showAll(dlg) {
  let clicks = 0;
  for (let i = 0; i < 10; i++) {
    const more = dlg.getByRole("button", { name: /Show \d+ more/ });
    if ((await more.count()) === 0) break;
    await more.first().click();
    clicks++;
    await dlg.page().waitForTimeout(500);
  }
  return clicks;
}

/** Compares displayed rows (newest first) with the reconstruction. Returns a list of human-readable differences. */
export function diffStatement(displayed, expected) {
  const out = [];
  if (displayed.length !== expected.length) out.push(`row count: displayed ${displayed.length} vs reconstructed ${expected.length}`);
  const n = Math.min(displayed.length, expected.length);
  for (let i = 0; i < n; i++) {
    const d = displayed[i];
    const e = expected[i];
    if (d.desc !== e.desc || !close2(d.debit, e.debit) || !close2(d.credit, e.credit) || !close2(d.balance, e.balance)) {
      out.push(`row ${i + 1}: displayed [${d.desc} −${d.debit} +${d.credit} =${d.balance}] vs reconstructed [${e.desc} −${e.debit} +${e.credit} =${e.balance}]`);
      if (out.length >= 4) break;
    }
  }
  return out;
}
