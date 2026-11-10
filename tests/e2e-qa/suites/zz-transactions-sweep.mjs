/**
 * Transactions sweep (testing-phase check): the page renders, no console/page errors, no layout overflow, the figures on the
 * page agree with what is persisted, and every control (search, date, filters, chips, views, full screen, paging, row
 * actions, Add menu, Split dialog) does what its label says. Local emulator only. The only writes are the explicit
 * "add a split expense" flow in the last scenario (through the page's own form), checked against the stored documents.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const IGNORED = /Select is changing|status of 400|React DevTools|Download the React/;
const flat = (s) => String(s).replace(/\s+/g, " ").trim();
/** "−₹1,234.50" / "-₹1,234" / "₹1,23,456" → number. */
const num = (s) => {
  const neg = /^[\s]*[-−]/.test(s);
  const n = Number(String(s).replace(/[^0-9.]/g, "")) || 0;
  return neg ? -n : n;
};
const r2 = (n) => Math.round(n * 100) / 100;
const LEDGER = 'section[aria-label="Transactions"]';

async function openTx(page, search = "") {
  await h.go(page, `/transactions${search}`);
  await page.getByRole("heading", { level: 1, name: "Transactions" }).waitFor({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('main [class*="animate-pulse"]').length === 0, null, { timeout: 60000 });
  await page.waitForTimeout(900);
}

/** The listed (primary) rows of the List view, as plain text per cell. */
const tableRows = (page) =>
  page.locator(`${LEDGER} tbody tr[aria-expanded]`).evaluateAll((trs) =>
    trs.map((tr) => {
      const tds = [...tr.querySelectorAll(":scope > td")];
      const cell = (i) => (tds[i]?.innerText ?? "").replace(/\s+/g, " ").trim();
      return { n: cell(0), date: cell(1), desc: (tds[2]?.querySelector("p")?.innerText ?? "").trim(), meta: cell(2), type: cell(3), account: cell(4), amount: cell(5), expanded: tr.getAttribute("aria-expanded") === "true" };
    }),
  );

/** { "money in": {value, meta}, … } from the "This view" tiles. */
async function tiles(page) {
  const out = {};
  for (const el of await page.locator('section[aria-label="This view"] > div').all()) {
    const lines = (await el.innerText()).split("\n").map((l) => l.trim()).filter(Boolean);
    out[lines[0].toLowerCase().replace(/\s*·\s*in this view.*$/, "")] = { value: lines[1] ?? "", meta: lines[2] ?? "" };
  }
  return out;
}
/** "Showing 21–40 of 41" → { from, to, of } (null when there is no footer). */
async function footer(page) {
  const m = /Showing (\d+)–(\d+) of (\d+)/.exec(flat(await page.locator(LEDGER).innerText().catch(() => "")));
  return m ? { from: Number(m[1]), to: Number(m[2]), of: Number(m[3]) } : null;
}
const countText = async (page) => (await footer(page))?.of ?? 0;

/** Independent oracle: the page's own flow classification applied to the stored documents. */
const flowOf = (t) => (t.transferId ? "transfer" : (t.loanId != null && t.paymentAllocationType === "additionalDisbursement") || t.isPersonLedgerMovement ? "debt" : t.type === "income" ? "in" : "out");
const methodOf = (t, account) => (t.transferId ? "Internal Transfer" : t.type === "income" ? "Bank Transfer" : !account ? "Card Payment" : ({ cash: "Cash", wallet: "UPI", card: "Credit Card", business: "Bank Transfer" })[account.type] ?? "Debit Card");
async function stored() {
  const accounts = await h.list("accounts");
  const txns = (await h.list("transactions")).filter((t) => !t.deletedAt);
  const acctById = new Map(accounts.map((a) => [a.id, a]));
  return { accounts, txns, acctById };
}
function totals(txns) {
  let inn = 0, out = 0, transfers = 0, other = 0;
  for (const t of txns) {
    if (t.excludeFromCalculations) continue;
    const f = flowOf(t);
    if (f === "in") inn += t.amount;
    else if (f === "out") out += t.amount;
    else if (f === "transfer") transfers += 1;
    else other += 1;
  }
  return { inn: r2(inn), out: r2(out), transfers, other, n: txns.length };
}

const overflow = (page) => page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: document.querySelector("main").scrollWidth - document.querySelector("main").clientWidth }));
const dateBtn = (page) => page.getByRole("button", { name: /^(Date|From |Until |\d{1,2}\s\w{3}\s–)/ }).first();
const filterBtn = (page, name) => page.locator("main").getByRole("button", { name: new RegExp(`^${name}`) }).first();
async function pickFilter(page, name, item) {
  await filterBtn(page, name).click();
  await page.getByRole("menuitem", { name: item }).first().click();
  await page.waitForTimeout(1200);
}
async function setRows(page, n) {
  await page.getByRole("button", { name: /^Rows\s*\d+/ }).click();
  await page.getByRole("menuitem", { name: String(n), exact: true }).click();
  await page.waitForTimeout(500);
}
const commits = (page) => page.evaluate(() => window.__ev.filter((e) => e.n === "commitStart").length);

scenario("txn-sweep-render", "Transactions sweep: the page renders every section, no console errors, no overflow (desktop / laptop / tablet / mobile, light + dark)", async ({ page, logs }, chk) => {
  await openTx(page);
  const main = flat(await page.locator("main").innerText());
  await h.shot(page, "txn-sweep-desktop-light");

  chk("title 'Transactions' + subtitle", /All your money activity in one place\./.test(main));
  const importBtn = page.getByRole("button", { name: /Import statement/ });
  const exportBtn = page.getByRole("button", { name: /Export/ });
  chk("'Import statement' is disabled, marked Soon (not a fake action)", (await importBtn.isDisabled()) && /soon/i.test(await importBtn.innerText()));
  chk("'Export' is disabled, marked Soon (not a fake action)", (await exportBtn.isDisabled()) && /soon/i.test(await exportBtn.innerText()));
  chk("'Add Transaction' is enabled", await page.getByRole("button", { name: /Add Transaction/ }).first().isEnabled());
  const t = await tiles(page);
  chk("four summary tiles: Money in / Money out / Net / Transactions", ["money in", "money out", "net", "transactions"].every((k) => k in t), Object.keys(t).join(","));
  chk("search box, Date, Account, Category, Type, Payment method controls present", (await page.getByLabel("Search transactions").count()) === 1 && (await dateBtn(page).count()) === 1 && (await Promise.all(["Account", "Category", "Type", "Payment method"].map((n) => filterBtn(page, n).count()))).every((c) => c === 1));
  chk("three view radios (List / Grid / Statement), List selected", (await page.getByRole("radio").count()) === 3 && (await page.getByRole("radio", { name: "List view" }).getAttribute("aria-checked")) === "true");
  chk("Full screen button present", (await page.getByRole("button", { name: "Full screen" }).count()) === 1);
  const heads = (await page.locator(`${LEDGER} thead th`).allInnerTexts()).map((x) => x.trim().toLowerCase());
  chk("ledger columns: Date, Description, Type, Account, Amount, Actions", ["date", "description", "type", "account", "amount", "actions"].every((c) => heads.includes(c)), heads.join(","));
  const f = await footer(page);
  chk("pagination footer 'Showing 1–N of M'", f != null && f.from === 1 && f.to <= f.of, JSON.stringify(f));
  chk("no 'NaN' / 'undefined' / 'Infinity' / '[object' text", !/NaN|undefined|Infinity|\[object/.test(main), (main.match(/.{0,30}(NaN|undefined|Infinity|\[object).{0,30}/) || [""])[0]);
  chk("no skeleton left after load", (await page.locator('main [class*="animate-pulse"]').count()) === 0);

  for (const [name, vp] of [["desktop", { width: 1920, height: 1080 }], ["laptop", { width: 1366, height: 768 }], ["tablet", { width: 768, height: 1024 }], ["mobile", { width: 390, height: 844 }]]) {
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize(vp);
      await page.waitForTimeout(900);
      const o = await overflow(page);
      const culprits = o.main > 1 || o.doc > 1
        ? await page.evaluate(() => {
            const m = document.querySelector("main");
            const right = m.getBoundingClientRect().right;
            const clipped = (el) => { for (let n = el.parentElement; n && n !== m; n = n.parentElement) { const ox = getComputedStyle(n).overflowX; if (ox !== "visible") return true; } return false; };
            return [...m.querySelectorAll("*")]
              .filter((el) => el.getBoundingClientRect().right > right + 1 && el.getBoundingClientRect().width > 0 && !clipped(el))
              .slice(0, 8)
              .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 4).join(".")} right+${Math.round(el.getBoundingClientRect().right - right)} "${el.innerText.slice(0, 30).replace(/\s+/g, " ")}"`);
          })
        : [];
      chk(`${name} ${vp.width}px ${scheme}: no horizontal overflow (page + main)`, o.doc <= 1 && o.main <= 1, JSON.stringify(o) + (culprits.length ? ` culprits: ${culprits.join(" | ")}` : ""));
      chk(`${name} ${vp.width}px ${scheme}: every row has a description and an amount`, (await tableRows(page)).every((r) => r.desc.length > 0 && /₹/.test(r.amount)));
      await h.shot(page, `txn-sweep-${name}-${scheme}`);
    }
  }

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1366, height: 768 });
  const before = flat(await page.locator('section[aria-label="This view"]').innerText());
  await page.reload();
  await page.getByRole("heading", { level: 1, name: "Transactions" }).waitFor({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('main [class*="animate-pulse"]').length === 0, null, { timeout: 60000 });
  await page.waitForTimeout(900);
  chk("hard reload: summary figures unchanged", flat(await page.locator('section[aria-label="This view"]').innerText()) === before);
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / warnings / page errors while on Transactions", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("txn-sweep-figures", "Transactions sweep: the list, the tiles and the paging footer all agree with the stored transactions", async ({ page, logs }, chk, notes) => {
  await h.addFixture(page, "history"); // +36 statement-history transactions so there is more than one page
  await openTx(page);
  await setRows(page, 100);
  const { accounts, txns } = await stored();
  const o = totals(txns);
  const rows = await tableRows(page);
  const t = await tiles(page);
  const f = await footer(page);

  chk(`row count in the list == stored active transactions (${o.n})`, rows.length === o.n, `${rows.length} rows vs ${o.n} stored`);
  chk("'Transactions' tile == stored count", num(t["transactions"]?.value) === o.n, t["transactions"]?.value);
  chk("footer 'of N' == stored count and range is 1–N", f?.of === o.n && f?.from === 1 && f?.to === o.n, JSON.stringify(f));
  chk(`'Money in' tile == Σ stored income rows (${o.inn})`, Math.abs(num(t["money in"]?.value) - o.inn) <= 0.5, `${t["money in"]?.value} vs ${o.inn}`);
  chk(`'Money out' tile == Σ stored expense rows (${o.out})`, Math.abs(num(t["money out"]?.value) - o.out) <= 0.5, `${t["money out"]?.value} vs ${o.out}`);
  const netShown = num(t["net"]?.value);
  chk("'Net' tile == Money in − Money out (sign and value)", Math.abs(netShown - r2(o.inn - o.out)) <= 1, `${t["net"]?.value} vs ${r2(o.inn - o.out)}`);
  const meta = t["transactions"]?.meta ?? "";
  chk("Transactions tile meta names transfers / loan-people rows when there are some", (o.transfers === 0 || new RegExp(`${o.transfers} transfers?`).test(meta)) && (o.other === 0 || new RegExp(`${o.other} loan/people`).test(meta)), meta);
  // The list formats money in whole rupees (formatCurrency, the app-wide default); the drawer / statement show paise.
  const shownAmounts = rows.map((r) => Math.abs(num(r.amount.split(" ")[0]))).sort((a, b) => a - b);
  const storedAmounts = txns.map((x) => Math.round(x.amount)).sort((a, b) => a - b);
  chk("every listed amount equals a stored amount to the whole rupee (same multiset, nothing dropped / invented)", JSON.stringify(shownAmounts) === JSON.stringify(storedAmounts), `${shownAmounts.length} vs ${storedAmounts.length}; first differences: ${JSON.stringify(storedAmounts.map((a, i) => [a, shownAmounts[i]]).filter(([a, b]) => a !== b).slice(0, 6))}`);
  const withPaise = txns.filter((x) => Math.round(x.amount * 100) % 100 !== 0);
  if (withPaise.length > 0) notes.push(`list shows whole rupees; ${withPaise.length} stored amount(s) carry paise (e.g. ${withPaise[0].amount} is listed as ₹${Math.round(withPaise[0].amount).toLocaleString("en-IN")}) — the Edit drawer and Statement view show the exact paise`);

  // Newest first, month headings contiguous and matching their rows.
  const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Sept: 8, Oct: 9, Nov: 10, Dec: 11 };
  const day = (s) => { const m = /(\d{2}) (\w{3,4}) (\d{4})/.exec(s); return m ? new Date(Number(m[3]), MON[m[2]], Number(m[1])).getTime() : NaN; };
  const days = rows.map((r) => day(r.date));
  chk("rows are sorted newest first", days.every((d, i) => i === 0 || days[i - 1] >= d) && days.every((d) => !Number.isNaN(d)), rows.slice(0, 4).map((r) => r.date).join(" | "));
  const groups = await page.locator(`${LEDGER} tbody tr:not([aria-expanded]) td[colspan="7"]`).allInnerTexts();
  const heads = groups.map((g) => g.trim()).filter(Boolean);
  chk("each month appears as one heading only (groups are contiguous)", new Set(heads.map((x) => x.toLowerCase())).size === heads.length, heads.join(" | "));

  // Known fixture rows.
  const byDesc = (d) => rows.find((r) => r.desc === d);
  const salary = byDesc("QA salary");
  chk("QA salary: +₹40,000, on QA Bank", !!salary && num(salary.amount.split(" ")[0]) === 40000 && /^\+/.test(salary.amount) && /QA Bank/.test(salary.account), salary && `${salary.amount} / ${salary.account}`);
  const groceries = byDesc("QA groceries");
  chk("QA groceries: −₹850, on QA Bank", !!groceries && /^[−-]/.test(groceries.amount) && num(groceries.amount.split(" ")[0]) === -850 && /QA Bank/.test(groceries.account), groceries && `${groceries.amount} / ${groceries.account}`);
  const card = byDesc("QA card purchase");
  chk("QA card purchase: −₹12,000, on QA Credit Card", !!card && num(card.amount.split(" ")[0]) === -12000 && /QA Credit Card/.test(card.account), card && `${card.amount} / ${card.account}`);
  const dinner = byDesc("QA team dinner");
  chk("QA team dinner shows the 'Split' badge", !!dinner && /Split/.test(dinner.meta), dinner?.meta);
  chk("a row's account column names a real stored account", rows.every((r) => accounts.some((a) => r.account.includes(a.name)) || /Unknown|Cash|Person/.test(r.account)), rows.filter((r) => !accounts.some((a) => r.account.includes(a.name))).slice(0, 3).map((r) => r.account).join(","));

  // Expanded details of the salary row agree with it.
  await page.locator(`${LEDGER} tbody tr[aria-expanded]`).filter({ hasText: "QA salary" }).first().click();
  await page.waitForTimeout(500);
  const det = flat(await page.locator(`${LEDGER}`).innerText());
  chk("expanded salary row: Money in, +₹40,000, Income / QA Bank / category / Bank Transfer", /MONEY IN/i.test(det) && /\+₹40,000/.test(det) && /Bank Transfer/.test(det) && /TYPE\s*Income/i.test(det), det.slice(det.indexOf("QA salary"), det.indexOf("QA salary") + 200));
  const expandedCount = (await tableRows(page)).filter((r) => r.expanded).length;
  chk("exactly one row expanded", expandedCount === 1, expandedCount);
  await h.shot(page, "txn-sweep-expanded-row");

  // Rows per page — the footer and the list agree for every size.
  for (const n of [10, 20, 50]) {
    await setRows(page, n);
    const ff = await footer(page);
    const rr = await tableRows(page);
    chk(`Rows ${n}: list shows min(${n}, ${o.n}) rows and the footer agrees`, rr.length === Math.min(n, o.n) && ff?.from === 1 && ff?.to === Math.min(n, o.n) && ff?.of === o.n, `${rr.length} rows, ${JSON.stringify(ff)}`);
  }

  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors while reading the list", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("txn-sweep-controls", "Transactions sweep: search, date, every filter, chips, views, full screen and paging all respond and match the stored data", async ({ page, logs }, chk, notes) => {
  await h.addFixture(page, "history");
  await openTx(page);
  const { accounts, txns, acctById } = await stored();
  const total = txns.length;

  // ── Search ──
  const search = page.getByLabel("Search transactions");
  await search.fill("groceries");
  await page.waitForTimeout(700);
  chk("search 'groceries' → only matching rows", (await tableRows(page)).length === txns.filter((x) => /groceries/i.test(x.description)).length && (await tableRows(page)).every((r) => /groceries/i.test(r.desc)), (await tableRows(page)).map((r) => r.desc).join(","));
  chk("search chip shown with a Remove button", (await page.getByRole("button", { name: /^Remove “groceries”/ }).count()) === 1);
  const tn = await tiles(page);
  chk("tiles recompute for the search (Transactions tile == rows)", num(tn["transactions"].value) === (await tableRows(page)).length, tn["transactions"].value);
  await page.getByRole("button", { name: "Clear search" }).click();
  await page.waitForTimeout(600);
  chk("'Clear search' (x in the box) empties it and restores the list", (await search.inputValue()) === "" && (await countText(page)) === total, `${await countText(page)} of ${total}`);

  for (const [q, test, label] of [
    [">10000", (a) => a > 10000, "amount > 10000"],
    ["100-1000", (a) => a >= 100 && a <= 1000, "amount 100–1000 inclusive"],
    ["<=850", (a) => a <= 850, "amount ≤ 850"],
    ["=3000", (a) => a === 3000, "amount = 3000 exactly"],
    ["₹40,000", (a) => a >= 40000 && a <= 40000.99, "bare ₹40,000 amount"],
  ]) {
    await search.fill(q);
    await page.waitForTimeout(700);
    const want = txns.filter((x) => test(x.amount) || (!/^[<>=]|-/.test(q) && x.description.toLowerCase().includes(q.toLowerCase()))).length;
    chk(`search "${q}" (${label}) → ${want} stored match${want === 1 ? "" : "es"}`, (await countText(page)) === want, `${await countText(page)} vs ${want}`);
  }
  await search.fill("zzz-no-such-thing");
  await page.waitForTimeout(700);
  chk("no match → 'No transactions match these filters.' with a working Clear filters", /No transactions match these filters\./.test(await page.locator(LEDGER).innerText()));
  await page.locator(LEDGER).getByRole("button", { name: "Clear filters" }).click();
  await page.waitForTimeout(600);
  chk("Clear filters in the empty state restores everything", (await countText(page)) === total && (await search.inputValue()) === "", `${await countText(page)} of ${total}`);

  // ── Type filter ──
  await pickFilter(page, "Type", "Income");
  const incomeN = txns.filter((x) => x.type === "income").length;
  chk(`Type: Income → ${incomeN} rows, chip shown, Money out tile ₹0`, (await countText(page)) === incomeN && (await page.getByRole("button", { name: "Remove Type: Income" }).count()) === 1 && num((await tiles(page))["money out"].value) === r2(totals(txns.filter((x) => x.type === "income")).out), `${await countText(page)} vs ${incomeN}`);
  await pickFilter(page, "Type", "Expense");
  const expN = txns.filter((x) => x.type === "expense").length;
  chk(`Type: Expense → ${expN} rows`, (await countText(page)) === expN, await countText(page));
  await filterBtn(page, "Type").click();
  await page.getByRole("menuitem", { name: "All Types" }).click();
  await page.waitForTimeout(500);
  chk("Type: 'All Types' resets", (await countText(page)) === total && (await page.getByRole("button", { name: /^Remove Type/ }).count()) === 0);

  // ── Category filter (the category of QA groceries) ──
  const groc = txns.find((x) => x.description === "QA groceries");
  await filterBtn(page, "Category").click();
  const catItems = await page.getByRole("menuitem").allInnerTexts();
  chk("Category menu lists 'All Categories' + real categories", catItems.length > 3 && /All Categories/.test(catItems[0]), catItems.slice(0, 5).join(","));
  const categoryName = await (async () => {
    // Pick whichever category the first stored expense row shows in its details line.
    await page.keyboard.press("Escape");
    const r = (await tableRows(page)).find((x) => x.desc === "QA groceries");
    return r ? r.meta.slice(r.desc.length).trim() : "";
  })();
  await pickFilter(page, "Category", categoryName);
  const catN = txns.filter((x) => x.categoryId === groc.categoryId).length;
  chk(`Category: ${categoryName} → ${catN} rows (stored count for that category)`, (await countText(page)) === catN && (await tableRows(page)).every((r) => r.meta.includes(categoryName)), `${await countText(page)} vs ${catN}`);
  await page.getByRole("button", { name: `Remove Category: ${categoryName}` }).click();
  await page.waitForTimeout(500);
  chk("removing the category chip restores the list", (await countText(page)) === total);

  // ── Account filter ──
  await pickFilter(page, "Account", /QA Bank/);
  const bank = accounts.find((a) => a.name === "QA Bank");
  const bankN = txns.filter((x) => x.accountId === bank.id).length;
  chk(`Account: QA Bank → ${bankN} rows, every row on QA Bank`, (await countText(page)) === bankN && (await tableRows(page)).every((r) => /QA Bank/.test(r.account)), `${await countText(page)} vs ${bankN}`);
  chk("account filter is in the URL (?account=<id>)", new URL(page.url()).searchParams.get("account") === bank.id, page.url());
  chk("account chip reads 'Account: QA Bank'", (await page.getByRole("button", { name: "Remove Account: QA Bank" }).count()) === 1);
  await pickFilter(page, "Account", /QA Credit Card/);
  const cardAcct = accounts.find((a) => a.name === "QA Credit Card");
  chk("Account: QA Credit Card → its rows; chip says 'Card:'", (await countText(page)) === txns.filter((x) => x.accountId === cardAcct.id).length && (await page.getByRole("button", { name: /^Remove Card: QA Credit Card/ }).count()) === 1, `${await countText(page)}`);
  await filterBtn(page, "Account").click();
  await page.getByRole("menuitem", { name: "All Accounts" }).click();
  await page.waitForTimeout(500);
  chk("Account: 'All Accounts' resets and drops ?account from the URL", (await countText(page)) === total && !new URL(page.url()).searchParams.has("account"), page.url());

  // ── Payment method filter ──
  const methods = [...new Set(txns.map((x) => methodOf(x, acctById.get(x.accountId))))].sort();
  await filterBtn(page, "Payment method").click();
  const mItems = (await page.getByRole("menuitem").allInnerTexts()).map((x) => x.trim());
  chk(`Payment method menu lists exactly the methods in use (${methods.join(", ")})`, JSON.stringify(mItems.slice(1).sort()) === JSON.stringify(methods), mItems.join(","));
  await page.keyboard.press("Escape");
  for (const m of methods) {
    await pickFilter(page, "Payment method", m);
    const want = txns.filter((x) => methodOf(x, acctById.get(x.accountId)) === m).length;
    chk(`Payment method: ${m} → ${want} rows`, (await countText(page)) === want, `${await countText(page)} vs ${want}`);
  }
  await page.locator("main").getByRole("button", { name: "Clear filters" }).click();
  await page.waitForTimeout(500);
  chk("'Clear filters' (chip row) removes every chip and restores the list", (await countText(page)) === total && (await page.getByRole("button", { name: /^Remove / }).count()) === 0);

  // ── Combined filters ──
  await pickFilter(page, "Account", /QA Bank/);
  await pickFilter(page, "Type", "Expense");
  await search.fill("QA");
  await page.waitForTimeout(700);
  chk("Account + Type + search combine (AND)", (await countText(page)) === txns.filter((x) => x.accountId === bank.id && x.type === "expense" && /qa/i.test(x.description)).length, `${await countText(page)}`);
  chk("three chips shown", (await page.getByRole("button", { name: /^Remove / }).count()) === 3, await page.getByRole("button", { name: /^Remove / }).count());
  await page.locator("main").getByRole("button", { name: "Clear filters" }).click();
  await page.waitForTimeout(500);

  // ── Date filter ──
  await dateBtn(page).click();
  const inputs = page.locator('input[placeholder="dd/mm/yyyy"]');
  await inputs.first().waitFor();
  await page.getByRole("button", { name: "This month" }).click();
  await page.waitForTimeout(500);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const wantFrom = `01/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
  const wantTo = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
  const gotFrom = await inputs.nth(0).inputValue();
  const gotTo = await inputs.nth(1).inputValue();
  chk(`'This month' From is the 1st of this month (${wantFrom})`, gotFrom === wantFrom, `shows ${gotFrom}`);
  chk(`'This month' To is today (${wantTo})`, gotTo === wantTo, `shows ${gotTo}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const inMonth = txns.filter((x) => { const d = new Date(x.dateTime); return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d <= new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999); }).length;
  chk(`'This month' lists exactly this month's transactions (${inMonth})`, (await countText(page)) === inMonth, `${await countText(page)} vs ${inMonth}`);
  const monthHeads = (await page.locator(`${LEDGER} tbody tr:not([aria-expanded]) td[colspan="7"]`).allInnerTexts()).map((x) => x.trim()).filter(Boolean);
  chk("'This month' shows only the current month's heading", monthHeads.length <= 1 && monthHeads.every((x) => x.toLowerCase().startsWith(now.toLocaleDateString("en-IN", { month: "long" }).toLowerCase())), monthHeads.join(" | "));
  chk("date chip is shown and removable", (await page.getByRole("button", { name: /^Remove \d{1,2} \w{3} – \d{1,2} \w{3}/ }).count()) === 1);
  await page.getByRole("button", { name: /^Remove \d{1,2} \w{3} – \d{1,2} \w{3}/ }).click();
  await page.waitForTimeout(500);
  chk("removing the date chip restores the list", (await countText(page)) === total);
  // A typed range.
  const d1 = new Date(now.getTime() - 5 * 86400000);
  const d2 = new Date(now.getTime() - 1 * 86400000);
  const fmt = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  await dateBtn(page).click();
  await inputs.nth(0).fill("");
  await inputs.nth(0).pressSequentially(fmt(d1).replace(/\//g, ""));
  await inputs.nth(1).fill("");
  await inputs.nth(1).pressSequentially(fmt(d2).replace(/\//g, ""));
  await page.waitForTimeout(600);
  const localDay = (x) => { const d = new Date(x.dateTime); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const fromMs = new Date(d1.getFullYear(), d1.getMonth(), d1.getDate()).getTime();
  const toMs = new Date(d2.getFullYear(), d2.getMonth(), d2.getDate()).getTime();
  const rangeN = txns.filter((x) => localDay(x) >= fromMs && localDay(x) <= toMs).length;
  chk(`typed range ${fmt(d1)} → ${fmt(d2)} lists ${rangeN} stored rows`, (await countText(page)) === rangeN, `${await countText(page)} vs ${rangeN}`);
  await page.getByRole("button", { name: "Clear dates" }).click();
  await page.waitForTimeout(500);
  chk("'Clear dates' clears both and restores the list", (await countText(page)) === total && (await inputs.nth(0).inputValue()) === "");
  await page.keyboard.press("Escape");

  // ── Views ──
  await page.getByRole("radio", { name: "Grid view" }).click();
  await page.waitForTimeout(600);
  const cards = await page.locator(`${LEDGER} button.rounded-\\[8px\\]`).count();
  chk("Grid view: one card per listed row (first page)", cards === Math.min(20, total), `${cards} cards`);
  chk("Grid view: radio checked, table gone", (await page.getByRole("radio", { name: "Grid view" }).getAttribute("aria-checked")) === "true" && (await page.locator(`${LEDGER} table`).count()) === 0);
  await h.shot(page, "txn-sweep-grid");
  await page.locator(`${LEDGER} button.rounded-\\[8px\\]`).first().click();
  await page.getByRole("dialog").waitFor();
  chk("clicking a grid card opens 'Transaction Details'", /Transaction Details/.test(await page.getByRole("dialog").innerText()));
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("radio", { name: "Statement view" }).click();
  await page.waitForTimeout(600);
  chk("Statement view with no account asks for one (no fake running balance)", (await page.getByTestId("statement-needs-account").count()) === 1 && (await page.getByTestId("statement-row").count()) === 0, flat(await page.locator(LEDGER).innerText()).slice(0, 120));
  await h.shot(page, "txn-sweep-statement-needs-account");
  await page.getByTestId("statement-needs-account").getByRole("button", { name: /QA Bank/ }).click();
  await page.waitForTimeout(700);
  chk("picking an account in the prompt filters to it and shows its statement (header + rows)", (await page.getByTestId("statement-header").count()) === 1 && (await page.getByTestId("statement-row").count()) > 0 && /QA Bank/.test(await page.getByTestId("statement-header").innerText()) && new URL(page.url()).searchParams.get("account") === bank.id, page.url());
  await page.getByRole("radio", { name: "List view" }).click();
  await page.waitForTimeout(500);
  await page.locator("main").getByRole("button", { name: "Clear filters" }).click();
  await page.waitForTimeout(500);
  chk("back to List view: the full table again", (await tableRows(page)).length === Math.min(20, total) && (await countText(page)) === total);

  // ── Full screen ──
  const fixedNow = () => page.evaluate(() => getComputedStyle(document.querySelector("main h1").closest("div.flex-col")).position === "fixed");
  chk("not full screen at first", !(await fixedNow()));
  await page.getByRole("button", { name: "Full screen" }).click();
  await page.waitForTimeout(500);
  chk("Full screen → page covers the viewport, button becomes 'Exit full screen'", (await fixedNow()) && (await page.getByRole("button", { name: "Exit full screen" }).count()) === 1);
  await h.shot(page, "txn-sweep-fullscreen");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  chk("Escape leaves full screen", !(await fixedNow()));
  await page.getByRole("button", { name: "Full screen" }).click();
  await page.getByRole("button", { name: "Exit full screen" }).click();
  await page.waitForTimeout(400);
  chk("the Exit button leaves full screen", !(await fixedNow()));

  // ── Paging ──
  const pages = Math.ceil(total / 20);
  notes.push(`stored transactions ${total} → ${pages} pages at 20 per page`);
  chk("Previous is disabled on page 1", await page.getByRole("button", { name: "Previous page" }).isDisabled());
  await page.getByRole("button", { name: "Next page" }).click();
  await page.waitForTimeout(500);
  let ff = await footer(page);
  chk("Next → page 2: 'Showing 21–40' and the # column continues at 21", ff?.from === 21 && ff?.to === Math.min(40, total) && (await tableRows(page))[0].n === "21", `${JSON.stringify(ff)} first # ${(await tableRows(page))[0]?.n}`);
  chk("page 2 button is the current page (aria-current)", (await page.locator(`${LEDGER} button[aria-current="page"]`).innerText()) === "2");
  await page.getByRole("button", { name: String(pages), exact: true }).click();
  await page.waitForTimeout(500);
  ff = await footer(page);
  chk(`last page (${pages}) → Next disabled, range ends at ${total}`, (await page.getByRole("button", { name: "Next page" }).isDisabled()) && ff?.to === total, JSON.stringify(ff));
  await page.getByRole("button", { name: "Previous page" }).click();
  await page.waitForTimeout(500);
  chk("Previous steps back one page", (await footer(page))?.from === (pages - 2) * 20 + 1, JSON.stringify(await footer(page)));
  await page.getByRole("button", { name: "Next page" }).click();
  await search.fill("QA");
  await page.waitForTimeout(700);
  chk("changing the search returns to page 1", (await footer(page))?.from === 1, JSON.stringify(await footer(page)));
  await search.fill("");
  await setRows(page, 10);
  chk("Rows 10 → 10 rows per page and back on page 1", (await tableRows(page)).length === 10 && (await footer(page))?.from === 1);

  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors during the control sweep", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("txn-sweep-rows", "Transactions sweep: row expand / collapse, Edit, Delete (cancelled) and the Add menu respond — and write nothing", async ({ page, logs }, chk, notes) => {
  await openTx(page);
  const before = JSON.stringify((await h.list("transactions")).map((x) => [x.id, x.amount, x.deletedAt ?? null]));
  const row = (desc) => page.locator(`${LEDGER} tbody tr[aria-expanded]`).filter({ hasText: desc }).first();
  await page.evaluate(() => window.__reset());

  // Expand / collapse
  await row("QA groceries").click();
  await page.waitForTimeout(400);
  chk("clicking a row expands it (aria-expanded)", (await row("QA groceries").getAttribute("aria-expanded")) === "true");
  const detail = flat(await page.locator(`${LEDGER}`).innerText());
  chk("expanded details show Type / Account / Category / Payment method", ["Type", "Account", "Category", "Payment method"].every((k) => new RegExp(k, "i").test(detail)));
  await page.getByRole("button", { name: "Collapse details" }).click();
  await page.waitForTimeout(400);
  chk("the chevron collapses it again", (await row("QA groceries").getAttribute("aria-expanded")) === "false");
  await row("QA groceries").click();
  await row("QA salary").click();
  await page.waitForTimeout(400);
  chk("expanding another row collapses the first (one open at a time)", (await row("QA groceries").getAttribute("aria-expanded")) === "false" && (await row("QA salary").getAttribute("aria-expanded")) === "true");
  await page.getByRole("button", { name: "Expand details" }).first().click();
  await page.waitForTimeout(300);
  await row("QA salary").click();
  await page.waitForTimeout(300);

  // Edit (pencil) opens the details drawer with the row's values; Escape closes with no write
  await row("QA groceries").getByRole("button", { name: "Edit transaction" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.waitFor();
  await page.waitForTimeout(600);
  chk("Edit opens 'Transaction Details' with the row's amount and description", /Transaction Details/.test(await dlg.innerText()) && (await dlg.locator('input[placeholder="0.00"]').first().inputValue()) === "850" && (await dlg.locator("input").evaluateAll((els) => els.some((e) => e.value === "QA groceries"))));
  await h.shot(page, "txn-sweep-edit-drawer");
  await page.keyboard.press("Escape");
  await dlg.waitFor({ state: "hidden" });
  chk("Escape closes the drawer", (await page.getByRole("dialog").count()) === 0);
  await row("QA groceries").getByRole("button", { name: "Edit transaction" }).click();
  await dlg.waitFor();
  await dlg.getByRole("button", { name: "Cancel", exact: true }).click();
  await dlg.waitFor({ state: "hidden" });
  chk("the drawer's Cancel closes it", (await page.getByRole("dialog").count()) === 0);
  await row("QA groceries").click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await dlg.waitFor();
  chk("the expanded row's Edit button opens the same drawer", /Transaction Details/.test(await dlg.innerText()));
  await page.keyboard.press("Escape");
  await dlg.waitFor({ state: "hidden" });

  // Delete → confirm → Cancel (nothing deleted)
  await row("QA groceries").getByRole("button", { name: "Delete transaction" }).click();
  const confirm = page.getByRole("dialog");
  await confirm.waitFor();
  chk("Delete asks first: 'Delete transaction?' with Cancel + Delete", /Delete transaction\?/.test(await confirm.innerText()) && (await confirm.getByRole("button", { name: "Cancel" }).count()) === 1 && (await confirm.getByRole("button", { name: "Delete" }).count()) >= 1, flat(await confirm.innerText()));
  await h.shot(page, "txn-sweep-delete-confirm");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await confirm.waitFor({ state: "hidden" });
  chk("Cancel keeps the transaction listed", (await row("QA groceries").count()) === 1);
  if ((await row("QA groceries").getAttribute("aria-expanded")) !== "true") await row("QA groceries").click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Delete", exact: true }).first().click();
  await confirm.waitFor();
  await page.keyboard.press("Escape");
  await confirm.waitFor({ state: "hidden" });
  chk("Escape also dismisses the delete confirmation", (await row("QA groceries").count()) === 1);

  // Add menu: each entry opens the right form and Cancel closes it
  const addBtn = () => page.locator("button:visible", { hasText: "Add Transaction" }).first();
  for (const [item, title] of [["Expense", "Add Expense"], ["Income", "Add Income"], ["Transfer to my account", "Add Transfer"]]) {
    await addBtn().click();
    await page.getByRole("menuitem", { name: item, exact: true }).click();
    await dlg.waitFor();
    const heading = flat(await dlg.getByRole("heading").first().innerText().catch(async () => await dlg.innerText()));
    chk(`Add menu → ${item} opens "${title}"`, heading.includes(title) || flat(await dlg.innerText()).includes(title), heading);
    if (item === "Transfer to my account") notes.push(`transfer form: ${flat(await dlg.innerText()).slice(0, 400)}`);
    await h.shot(page, `txn-sweep-add-${item.split(" ")[0].toLowerCase()}`);
    await dlg.getByRole("button", { name: "Cancel", exact: true }).click();
    await dlg.waitFor({ state: "hidden" });
  }
  // Speed keys inside the Add drawer
  await addBtn().click();
  await page.getByRole("menuitem", { name: "Expense", exact: true }).click();
  await dlg.waitFor();
  await page.keyboard.press("Alt+Digit2");
  await page.waitForTimeout(400);
  chk("Alt+2 switches the drawer to Income", /Add Income/.test(await dlg.innerText()));
  await page.keyboard.press("Alt+Digit3");
  await page.waitForTimeout(400);
  chk("Alt+3 switches the drawer to Transfer", /Add Transfer/.test(await dlg.innerText()));
  await page.keyboard.press("Alt+Digit1");
  await page.waitForTimeout(400);
  chk("Alt+1 switches back to Expense", /Add Expense/.test(await dlg.innerText()));
  await page.keyboard.press("Escape");
  await dlg.waitFor({ state: "hidden" });
  // Empty-state of the empty form: submit is gated with 'Still needed' (already covered by txn-validation) — just confirm the footer.
  await addBtn().click();
  await page.getByRole("menuitem", { name: "Expense", exact: true }).click();
  await dlg.waitFor();
  chk("an empty Add form lists what is still needed", /Still needed/.test(await dlg.innerText()));
  await page.keyboard.press("Escape");
  await dlg.waitFor({ state: "hidden" });

  chk("none of this wrote anything (zero commits; stored transactions unchanged)", (await commits(page)) === 0 && JSON.stringify((await h.list("transactions")).map((x) => [x.id, x.amount, x.deletedAt ?? null])) === before, `commits ${await commits(page)}`);
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("txn-sweep-split", "Transactions sweep: the Split Expense dialog validates every field, then saves one split once (double-click) and shows it", async ({ page, logs }, chk, notes) => {
  await openTx(page);
  const bankBefore = (await h.accountBalance("QA Bank")).currentBalance;
  const before = (await h.list("transactions")).filter((x) => !x.deletedAt).length;
  const addBtn = page.locator("button:visible", { hasText: "Add Transaction" }).first();
  await addBtn.click();
  await page.getByRole("menuitem", { name: "Split Expense", exact: true }).click();
  const dlg = page.getByRole("dialog");
  await dlg.waitFor();
  const body = flat(await dlg.innerText());
  chk("Split Expense dialog opens with its fields", ["Description", "Total Amount", "Account", "Category", "Date", "Split Type", "Include my own share", "Split With"].every((k) => body.includes(k)), body.slice(0, 200));
  await h.shot(page, "txn-sweep-split-empty");
  const save = dlg.getByRole("button", { name: "Save Split" });
  const err = async () => flat(await dlg.locator("p.text-expense").innerText().catch(() => ""));

  // Validation, in order
  await save.click();
  await page.waitForTimeout(300);
  chk("empty → 'Description is required.'", (await err()) === "Description is required.", await err());
  await dlg.getByPlaceholder("e.g. Dinner at Cafe").fill("QA sweep split");
  await save.click();
  await page.waitForTimeout(300);
  chk("then → 'Enter an amount greater than 0.'", (await err()) === "Enter an amount greater than 0.", await err());
  await dlg.getByPlaceholder("0.00").fill("600");
  await save.click();
  await page.waitForTimeout(300);
  chk("then → account required ('Select an account.')", /^Select an account\./.test(await err()), await err());
  const acctTrigger = dlg.locator("label", { hasText: /^Account/ }).getByRole("combobox");
  await acctTrigger.click();
  await page.getByRole("option", { name: /QA Bank/ }).first().click();
  await save.click();
  await page.waitForTimeout(300);
  chk("then → category required or people required", /Select a category\.|Add at least one person to share with\./.test(await err()), await err());
  const catTrigger = dlg.locator("label", { hasText: /^Category/ }).getByRole("combobox");
  if (/Select a category\./.test(await err())) {
    await catTrigger.click();
    await page.getByRole("option").first().click();
    await save.click();
    await page.waitForTimeout(300);
  }
  chk("then → 'Add at least one person to share with.'", (await err()) === "Add at least one person to share with.", await err());

  // Custom amounts need a value per person
  await dlg.locator("label", { hasText: /^Split Type/ }).getByRole("combobox").click();
  await page.getByRole("option", { name: "Custom amounts" }).click();
  await page.waitForTimeout(300);
  const amtFields = await dlg.locator('input[placeholder="Amount"]').count();
  chk("Custom amounts → an Amount field appears per person", amtFields === 1, `${amtFields} Amount fields; inputs: ${(await dlg.locator("input").evaluateAll((els) => els.map((e) => e.placeholder || e.type))).join(",")}`);
  await dlg.getByPlaceholder("Name").fill("Sweep Friend");
  await save.click();
  await page.waitForTimeout(300);
  chk("custom with no value → 'Enter a valid amount for Sweep Friend.'", (await err()) === "Enter a valid amount for Sweep Friend.", await err());
  await dlg.locator("label", { hasText: /^Split Type/ }).getByRole("combobox").click();
  await page.getByRole("option", { name: "By percentage" }).click();
  await page.waitForTimeout(300);
  const pctFields = await dlg.locator('input[placeholder="%"]').count();
  chk("By percentage → the field switches to '%'", pctFields === 1, `${pctFields} % fields`);
  await dlg.locator("label", { hasText: /^Split Type/ }).getByRole("combobox").click();
  await page.getByRole("option", { name: "Split equally" }).click();
  chk("Split equally → no per-person value field", (await dlg.getByPlaceholder("Amount").count()) === 0 && (await dlg.getByPlaceholder("%").count()) === 0);

  // Add / remove people
  await dlg.getByRole("button", { name: "Add person" }).click();
  chk("'Add person' adds a row", (await dlg.getByRole("button", { name: "Remove participant" }).count()) === 2);
  await dlg.getByRole("button", { name: "Remove participant" }).last().click();
  chk("remove participant (trash) removes it", (await dlg.getByRole("button", { name: "Remove participant" }).count()) === 1);
  const checkbox = dlg.getByRole("checkbox");
  chk("'Include my own share' is on by default and toggles", (await checkbox.isChecked()) && !(await checkbox.uncheck().then(() => checkbox.isChecked())));
  await checkbox.check();
  chk("nothing was written by failed validation", (await h.list("transactions")).filter((x) => !x.deletedAt).length === before);

  // Valid save, double-clicked
  await page.evaluate(() => window.__reset());
  await save.evaluate((b) => { b.click(); b.click(); });
  await dlg.waitFor({ state: "hidden", timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const stored = (await h.list("transactions")).filter((x) => !x.deletedAt && x.description === "QA sweep split");
  chk("the split was saved exactly once despite a double-click", stored.length === 1, `${stored.length} transactions`);
  chk("dialog closed after saving", (await page.getByRole("dialog").count()) === 0);
  const bankAfter = (await h.accountBalance("QA Bank")).currentBalance;
  chk("QA Bank debited the full ₹600 once (persisted)", Math.abs(bankBefore - bankAfter - 600) < 0.01, `${bankBefore} → ${bankAfter}`);
  const expenses = (await h.list("expenses")).filter((e) => e.description === "QA sweep split");
  chk("one matching shared-expense record exists", expenses.length === 1, expenses.length);
  notes.push(`split expense doc: ${JSON.stringify(expenses[0] ?? null).slice(0, 300)}`);
  await page.getByLabel("Search transactions").fill("QA sweep split");
  await page.waitForTimeout(700);
  const rows = await tableRows(page);
  chk("the new row is listed with a 'Split' badge and −₹600", rows.length === 1 && /Split/.test(rows[0].meta) && num(rows[0].amount.split(" ")[0]) === -600, rows[0] && `${rows[0].meta} / ${rows[0].amount}`);
  await h.shot(page, "txn-sweep-split-saved");

  // Clean up through the page's own delete (also proves delete restores the balance for a split)
  await page.locator(`${LEDGER} tbody tr[aria-expanded]`).first().getByRole("button", { name: "Delete transaction" }).click();
  const confirm = page.getByRole("dialog");
  await confirm.waitFor();
  await confirm.getByRole("button", { name: "Delete" }).last().click();
  await page.waitForTimeout(3500);
  const bankEnd = (await h.accountBalance("QA Bank")).currentBalance;
  chk("deleting the split restores QA Bank to its original balance", Math.abs(bankEnd - bankBefore) < 0.01, `${bankAfter} → ${bankEnd} (start ${bankBefore})`);
  chk("deleted split no longer listed", (await page.getByText("QA sweep split").count()) === 0 || (await tableRows(page)).length === 0);

  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("txn-sweep-late-night", "Transactions sweep: just after midnight in India (02:30 IST) the page's own date defaults are still today's local date", async ({ page, logs }, chk) => {
  await openTx(page);
  // 21:00 UTC == 02:30 the next day in India. Anything derived from the UTC day (toISOString) is a day behind here.
  const fake = new Date();
  fake.setUTCHours(21, 0, 0, 0);
  await page.clock.setFixedTime(fake);
  const local = new Date(fake.getTime());
  const pad = (n) => String(n).padStart(2, "0");
  const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const localToday = `${pad(local.getDate())}/${pad(local.getMonth() + 1)}/${local.getFullYear()}`;
  const localFirst = `01/${pad(local.getMonth() + 1)}/${local.getFullYear()}`;
  const utcToday = `${pad(fake.getUTCDate())}/${pad(fake.getUTCMonth() + 1)}/${fake.getUTCFullYear()}`;
  const nowInPage = await page.evaluate(() => new Date().toString());
  chk(`the page's clock reads the faked time (${nowInPage})`, new Date(nowInPage).getTime() === fake.getTime() || Math.abs(new Date(nowInPage).getTime() - fake.getTime()) < 60000, nowInPage);

  await page.locator("button:visible", { hasText: "Add Transaction" }).first().click();
  await page.getByRole("menuitem", { name: "Split Expense", exact: true }).click();
  const dlg = page.getByRole("dialog");
  await dlg.waitFor();
  const splitDate = await dlg.locator('input[placeholder="dd/mm/yyyy"]').inputValue();
  chk(`Split Expense default date is today's local date (${localToday}) — timezone ${tz}`, splitDate === localToday, `shows ${splitDate}${splitDate === utcToday && utcToday !== localToday ? " (the UTC date — a day behind)" : ""}`);
  await page.keyboard.press("Escape");
  await dlg.waitFor({ state: "hidden" });

  await dateBtn(page).click();
  const inputs = page.locator('input[placeholder="dd/mm/yyyy"]');
  await inputs.first().waitFor();
  await page.getByRole("button", { name: "This month" }).click();
  await page.waitForTimeout(400);
  chk(`'This month' From is the 1st of the local month (${localFirst})`, (await inputs.nth(0).inputValue()) === localFirst, `shows ${await inputs.nth(0).inputValue()}`);
  chk(`'This month' To is today's local date (${localToday})`, (await inputs.nth(1).inputValue()) === localToday, `shows ${await inputs.nth(1).inputValue()}`);
  await page.keyboard.press("Escape");

  // The main Add drawer (already local-date aware) agrees with the same day.
  await page.locator("button:visible", { hasText: "Add Transaction" }).first().click();
  await page.getByRole("menuitem", { name: "Expense", exact: true }).click();
  await dlg.waitFor();
  const addDate = await dlg.locator('input[placeholder="dd/mm/yyyy"]').first().inputValue();
  chk(`Add Expense drawer default date is today's local date (${localToday})`, addDate === localToday, `shows ${addDate}`);
  await page.keyboard.press("Escape");
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

/* ───────────────────────── Add / Edit drawer ───────────────────────── */

const drawerOf = (page) => page.locator('[role="dialog"]').first();
async function openAddDrawer(page, item) {
  await page.locator("button:visible", { hasText: "Add Transaction" }).first().click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
  await drawerOf(page).waitFor();
  await page.waitForTimeout(500);
}
async function pickIn(page, labelRe, optionRe) {
  await page.getByText(labelRe).first().locator("xpath=following::button[1]").click();
  await page.getByRole("option", { name: optionRe }).first().click();
  await page.waitForTimeout(300);
}
const amountInput = (page) => page.locator("#txn-amount");
const descField = (page) => drawerOf(page).locator('input[placeholder^="e.g."]').first();

scenario("txn-sweep-drawer", "Transactions sweep: the Add drawer's quick amounts, input filtering, validation, More options, notes and Ctrl+Enter all respond and persist correctly", async ({ page, logs }, chk, notes) => {
  await openTx(page);
  const bankBefore = (await h.accountBalance("QA Bank")).currentBalance;
  await openAddDrawer(page, "Expense");
  const d = drawerOf(page);
  const amt = amountInput(page);

  // Quick-add chips fill the amount only; nothing is saved
  await page.evaluate(() => window.__reset());
  await d.getByRole("button", { name: /^\+₹500$/ }).click();
  await d.getByRole("button", { name: /^\+₹100$/ }).click();
  chk("quick chips +₹500 then +₹100 add up in the amount field (600)", (await amt.inputValue()) === "600", await amt.inputValue());
  await d.getByRole("button", { name: /^\+₹1,000$/ }).click();
  await d.getByRole("button", { name: /^\+₹5,000$/ }).click();
  chk("+₹1,000 and +₹5,000 chips keep adding (6600)", (await amt.inputValue()) === "6600", await amt.inputValue());
  chk("quick chips wrote nothing", (await commits(page)) === 0);
  await amt.fill("");
  await amt.pressSequentially("1a2.5b");
  chk("the amount field only accepts digits and a decimal point ('1a2.5b' → 12.5)", (await amt.inputValue()) === "12.5", await amt.inputValue());

  // Mode switch
  notes.push(`drawer mode switch: ${await d.getByRole("radio").count()} radios, ${await d.getByRole("tab").count()} tabs`);
  const mode = (name) => d.getByRole("radio", { name }).or(d.getByRole("tab", { name })).or(d.getByRole("button", { name, exact: true })).first();
  await mode("Income").click();
  await page.waitForTimeout(300);
  chk("clicking the Income mode switches the drawer to Add Income", /Add Income/.test(await d.innerText()));
  await mode("Expense").click();
  await page.waitForTimeout(300);
  chk("clicking the Expense mode switches back", /Add Expense/.test(await d.innerText()));

  // Validation: too many decimals, then a future date
  await descField(page).fill("QA sweep decimals");
  await pickIn(page, /^Account\s?\*$/, /QA Bank/);
  await amt.fill("12.345");
  await d.getByRole("button", { name: "Add Expense" }).click();
  await page.waitForTimeout(500);
  chk("3 decimal places → 'Amounts can have at most 2 decimal places.' and nothing is written", /at most 2 decimal places/.test(await d.innerText()) && (await commits(page)) === 0, flat(await d.innerText()).match(/Amounts can have[^.]*\./)?.[0]);
  await amt.fill("12");
  const tomorrow = new Date(Date.now() + 86400000);
  const pad = (n) => String(n).padStart(2, "0");
  const dateField = d.locator('input[placeholder="dd/mm/yyyy"]').first();
  await dateField.fill("");
  await dateField.pressSequentially(`${pad(tomorrow.getDate())}${pad(tomorrow.getMonth() + 1)}${tomorrow.getFullYear()}`);
  await d.getByRole("button", { name: "Add Expense" }).click();
  await page.waitForTimeout(500);
  chk("a future date → 'Date can't be in the future.' and nothing is written", /Date can.t be in the future/.test(await d.innerText()) && (await commits(page)) === 0);
  const today = new Date();
  await dateField.fill("");
  await dateField.pressSequentially(`${pad(today.getDate())}${pad(today.getMonth() + 1)}${today.getFullYear()}`);

  // More options: Esc closes only the flyout; "Don't count" persists and keeps the row out of the totals
  await d.getByRole("button", { name: /^More options/ }).click();
  const fly = page.getByRole("dialog", { name: "More options" });
  await fly.waitFor();
  chk("More options opens its flyout with both switches", (await fly.getByRole("switch").count()) === 2, await fly.getByRole("switch").count());
  await fly.getByRole("switch").first().click();
  await page.keyboard.press("Escape");
  await fly.waitFor({ state: "hidden" });
  chk("Escape closes only the flyout — the drawer stays open", (await d.count()) === 1 && /Add Expense/.test(await d.innerText()));
  chk("the collapsed row now says 'Hidden from totals'", /Hidden from totals/.test(await d.innerText()));
  await d.getByLabel("Notes").fill("sweep note");

  const tilesBefore = await tiles(page);
  await page.evaluate(() => window.__reset());
  await d.getByRole("button", { name: "Add Expense" }).click();
  await page.waitForFunction(() => (document.querySelector("#txn-amount") || { value: "x" }).value === "", null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const saved = (await h.list("transactions")).filter((x) => !x.deletedAt && x.description === "QA sweep decimals");
  chk("saved once with excludeFromCalculations on and the note kept", saved.length === 1 && saved[0].excludeFromCalculations === true && saved[0].notes === "sweep note" && saved[0].amount === 12, JSON.stringify(saved[0] && { amount: saved[0].amount, ex: saved[0].excludeFromCalculations, notes: saved[0].notes }));
  const bankAfter = (await h.accountBalance("QA Bank")).currentBalance;
  notes.push(`'Don't count' expense ₹12: QA Bank ${bankBefore} → ${bankAfter} (balance ${Math.abs(bankBefore - bankAfter - 12) < 0.01 ? "was" : "was not"} debited)`);
  await d.getByRole("button", { name: "Cancel", exact: true }).click();
  await d.waitFor({ state: "hidden" });
  await page.waitForTimeout(500);
  const tilesAfter = await tiles(page);
  chk("the hidden-from-totals expense is listed but excluded from the Money out tile", num(tilesAfter["money out"].value) === num(tilesBefore["money out"].value) && num(tilesAfter["transactions"].value) === num(tilesBefore["transactions"].value) + 1, `${tilesBefore["money out"].value} → ${tilesAfter["money out"].value}; count ${tilesBefore["transactions"].value} → ${tilesAfter["transactions"].value}`);
  const row = page.locator(`${LEDGER} tbody tr[aria-expanded]`).filter({ hasText: "QA sweep decimals" }).first();
  chk("the row carries a 'not counted' marker", /not counted|excluded|hidden/i.test(await row.innerText()), flat(await row.innerText()));
  await row.click();
  await page.waitForTimeout(400);
  chk("the expanded row shows the note", /sweep note/.test(await page.locator(LEDGER).innerText()));
  await h.shot(page, "txn-sweep-excluded-row");

  // Ctrl+Enter saves an Income
  await openAddDrawer(page, "Income");
  await amountInput(page).fill("321");
  await descField(page).fill("QA sweep ctrl-enter");
  await pickIn(page, /^(Received in|Account|Deposit to)\s?\*$/, /QA Bank/);
  await page.evaluate(() => window.__reset());
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => (document.querySelector("#txn-amount") || { value: "x" }).value === "", null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const inc = (await h.list("transactions")).filter((x) => !x.deletedAt && x.description === "QA sweep ctrl-enter");
  chk("Ctrl+Enter saves the income exactly once (₹321)", inc.length === 1 && inc[0].amount === 321 && inc[0].type === "income", inc.length);
  const stillOpen = (await page.locator('[role="dialog"]').count()) > 0;
  notes.push(`after Ctrl+Enter the drawer ${stillOpen ? "stays open (save-and-add-another)" : "closes"}`);
  if (stillOpen) {
    await h.shot(page, "txn-sweep-after-ctrl-enter");
    notes.push(`drawer after Ctrl+Enter: ${flat(await drawerOf(page).innerText()).slice(0, 300)} || buttons: ${(await drawerOf(page).getByRole("button").allInnerTexts()).map(flat).join(",")}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
  }

  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("txn-sweep-transfer", "Transactions sweep: a transfer between own accounts creates two linked legs, locks them on edit, and deleting it restores both balances", async ({ page, logs }, chk) => {
  await openTx(page);
  const bank0 = (await h.accountBalance("QA Bank")).currentBalance;
  const cash0 = (await h.accountBalance("QA Cash")).currentBalance;
  const tilesBefore = await tiles(page);
  await openAddDrawer(page, "Transfer to my account");
  const d = drawerOf(page);
  await amountInput(page).fill("500");
  await descField(page).fill("QA sweep transfer");
  await pickIn(page, /^From Account\s?\*$/, /QA Bank/);
  await page.evaluate(() => window.__reset());
  await d.getByRole("button", { name: /^Add Transfer$/ }).click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(600);
  chk("no destination chosen → nothing is written", (await commits(page)) === 0, `${await commits(page)} commits`);
  await pickIn(page, /^To Account\s?\*$/, /QA Cash/);
  await h.shot(page, "txn-sweep-transfer-form");
  await page.evaluate(() => window.__reset());
  await d.getByRole("button", { name: /^Add Transfer$/ }).evaluate((b) => { b.click(); b.click(); });
  await page.waitForFunction(() => (document.querySelector("#txn-amount") || { value: "x" }).value === "", null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const legs = (await h.list("transactions")).filter((x) => !x.deletedAt && x.description.includes("QA sweep transfer"));
  chk("exactly two linked legs were created (double-click guarded)", legs.length === 2 && !!legs[0].transferId && legs[0].transferId === legs[1].transferId, legs.length);
  const bank1 = (await h.accountBalance("QA Bank")).currentBalance;
  const cash1 = (await h.accountBalance("QA Cash")).currentBalance;
  chk("QA Bank −₹500 and QA Cash +₹500 (persisted)", Math.abs(bank0 - bank1 - 500) < 0.01 && Math.abs(cash1 - cash0 - 500) < 0.01, `bank ${bank0}→${bank1}, cash ${cash0}→${cash1}`);
  await d.getByRole("button", { name: "Cancel", exact: true }).click();
  await d.waitFor({ state: "hidden" });
  await page.waitForTimeout(600);
  const t1 = await tiles(page);
  chk("transfers never count as money in / out (tiles unchanged); the Transactions tile gains 2 rows and counts them as transfers (one per leg)", t1["money in"].value === tilesBefore["money in"].value && t1["money out"].value === tilesBefore["money out"].value && num(t1["transactions"].value) === num(tilesBefore["transactions"].value) + 2 && /2 transfers/.test(t1["transactions"].meta), `${t1["money out"].value} / ${t1["transactions"].value} / ${t1["transactions"].meta}`);
  const rows = (await tableRows(page)).filter((r) => /QA sweep transfer/.test(r.desc));
  chk("both legs are listed with the linked-transfer marker", rows.length === 2 && (await page.locator(LEDGER).innerText()).toLowerCase().includes("one linked movement"), rows.map((r) => r.desc).join(" | "));
  await h.shot(page, "txn-sweep-transfer-listed");

  // Editing a leg: amount / account / date are locked, with the explanation
  await page.locator(`${LEDGER} tbody tr[aria-expanded]`).filter({ hasText: "QA sweep transfer" }).first().getByRole("button", { name: "Edit transaction" }).click();
  await d.waitFor();
  await page.waitForTimeout(700);
  chk("a transfer leg opens locked: 'This is one leg of a transfer…' and a disabled amount", /one leg of a transfer/.test(await d.innerText()) && (await amountInput(page).isDisabled()));
  chk("the drawer offers 'Delete Transfer' for the pair", (await d.getByRole("button", { name: "Delete Transfer" }).count()) === 1);
  await h.shot(page, "txn-sweep-transfer-edit");
  await page.keyboard.press("Escape");
  await d.waitFor({ state: "hidden" });

  // Delete from the list: the confirmation names both legs, then both balances are restored
  await page.locator(`${LEDGER} tbody tr[aria-expanded]`).filter({ hasText: "QA sweep transfer" }).first().getByRole("button", { name: "Delete transaction" }).click();
  const confirm = page.getByRole("dialog");
  await confirm.waitFor();
  chk("delete says 'Delete this transfer?' and that both legs go", /Delete this transfer\?/.test(await confirm.innerText()) && /both linked transactions/.test(await confirm.innerText()), flat(await confirm.innerText()));
  await confirm.getByRole("button", { name: "Delete" }).last().click();
  await page.waitForTimeout(3500);
  const bank2 = (await h.accountBalance("QA Bank")).currentBalance;
  const cash2 = (await h.accountBalance("QA Cash")).currentBalance;
  chk("both balances are restored (persisted)", Math.abs(bank2 - bank0) < 0.01 && Math.abs(cash2 - cash0) < 0.01, `bank ${bank2} (start ${bank0}), cash ${cash2} (start ${cash0})`);
  chk("both legs are gone from the stored active transactions and from the list", (await h.list("transactions")).filter((x) => !x.deletedAt && x.description.includes("QA sweep transfer")).length === 0 && (await page.getByText("QA sweep transfer").count()) === 0);
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("txn-sweep-edit", "Transactions sweep: editing description and notes from the list persists; the drawer's own Delete asks first and then restores the balance", async ({ page, logs }, chk) => {
  await openTx(page);
  const bank0 = (await h.accountBalance("QA Bank")).currentBalance;
  const row = (desc) => page.locator(`${LEDGER} tbody tr[aria-expanded]`).filter({ hasText: desc }).first();
  await row("QA groceries").getByRole("button", { name: "Edit transaction" }).click();
  const d = drawerOf(page);
  await d.waitFor();
  await page.waitForTimeout(700);
  await descField(page).fill("QA groceries edited");
  await d.getByLabel("Notes").fill("edited via sweep");
  await page.evaluate(() => window.__reset());
  await d.getByRole("button", { name: /^(Save|Update)/ }).first().click();
  await page.waitForTimeout(3000);
  const stored = (await h.list("transactions")).filter((x) => !x.deletedAt && x.description === "QA groceries edited");
  chk("the edit persisted (description + note), amount untouched", stored.length === 1 && stored[0].notes === "edited via sweep" && stored[0].amount === 850, JSON.stringify(stored[0] && { d: stored[0].description, n: stored[0].notes, a: stored[0].amount }));
  chk("no new transaction was created by the edit", (await h.list("transactions")).filter((x) => !x.deletedAt && /QA groceries/.test(x.description)).length === 1);
  chk("balance unchanged by a text-only edit", Math.abs((await h.accountBalance("QA Bank")).currentBalance - bank0) < 0.01);
  if ((await page.locator('[role="dialog"]').count()) > 0) {
    await page.keyboard.press("Escape");
    await page.locator('[role="dialog"]').first().waitFor({ state: "hidden" }).catch(() => {});
  }
  chk("the list shows the edited description", (await row("QA groceries edited").count()) === 1);

  // The drawer's own Delete: asks first, Cancel keeps it, Delete removes it and restores the balance
  await row("QA groceries edited").getByRole("button", { name: "Edit transaction" }).click();
  await d.waitFor();
  await page.waitForTimeout(600);
  await d.getByRole("button", { name: /^Delete$/ }).click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
  await page.waitForTimeout(500);
  chk("Cancel on the drawer's delete confirmation keeps the transaction", (await h.list("transactions")).filter((x) => !x.deletedAt && x.description === "QA groceries edited").length === 1);
  await d.getByRole("button", { name: /^Delete$/ }).click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Delete transaction", exact: true }).last().click();
  await page.waitForTimeout(3500);
  const bankNow = (await h.accountBalance("QA Bank")).currentBalance;
  chk("Delete removes it and restores the balance (+₹850 back)", Math.abs(bankNow - (bank0 + 850)) < 0.01 && (await h.list("transactions")).filter((x) => !x.deletedAt && x.description === "QA groceries edited").length === 0, `${bankNow} vs ${bank0 + 850}`);
  chk("the row is gone from the list", (await page.getByText("QA groceries edited").count()) === 0);
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("txn-sweep-handoff", "Transactions sweep: a ?transaction=<id> deep link opens that transaction once; an unknown id is harmless", async ({ page, logs }, chk) => {
  await openTx(page);
  const salary = (await h.list("transactions")).find((x) => !x.deletedAt && x.description === "QA salary");
  await h.go(page, "/dashboard"); // the link seeds its state on a fresh mount, as when arriving from People
  await page.waitForTimeout(1500);
  await h.go(page, `/transactions?transaction=${salary.id}`);
  const d = drawerOf(page);
  await d.waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
  chk("the deep link opens the transaction's details drawer", /Transaction Details/.test(await d.innerText()) && (await amountInput(page).inputValue()) === "40000", flat(await d.innerText()).slice(0, 80));
  chk("it shows the right transaction (description QA salary)", await d.locator("input").evaluateAll((els) => els.some((e) => e.value === "QA salary")));
  await page.keyboard.press("Escape");
  await d.waitFor({ state: "hidden" });
  await page.waitForTimeout(700);
  chk("closing it does not re-open it", (await page.locator('[role="dialog"]').count()) === 0);
  await h.go(page, "/dashboard");
  await page.waitForTimeout(1500);
  await h.go(page, "/transactions?transaction=does-not-exist");
  await page.getByRole("heading", { level: 1, name: "Transactions" }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500);
  chk("an unknown id opens nothing and the page still lists transactions", (await page.locator('[role="dialog"]').count()) === 0 && (await tableRows(page)).length > 0);
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});
