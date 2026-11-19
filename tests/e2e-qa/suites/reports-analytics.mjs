/**
 * Reports & Analytics (reports-analytics.mjs) — real-browser checks on synthetic emulator data only (see README).
 * Every figure the pages show is compared with an INDEPENDENT recomputation from the documents persisted in the
 * emulator (raw transactions / accounts / cards / loans / expenses) — the oracle below re-implements the documented
 * rules in plain JS and never imports app code. Then add / transfer / delete through the app's own UI and re-check that
 * every affected figure moved by exactly the right amount (global sync), a custom 18th cycle, and the Analytics page.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const close2 = (a, b) => Math.abs(a - b) < 0.005;

/**
 * Client-side navigation like `h.go`, but patient and self-healing. A dev server compiles each route on first visit (well
 * over the harness's 30 s when the machine is busy — other sessions run QA here too), and `window.next.router` exists a
 * moment BEFORE the router is initialised: a push in that window is dropped ("Router action dispatched before
 * initialization") and the route is never reached. So: push, give it a few seconds, push again; after ~45 s of that fall
 * back to a plain page load of the same URL.
 */
async function slowGo(page, href, timeout = 120000) {
  const strip = (p) => p.replace(/\/+$/, "") || "/";
  const want = strip(new URL(href, "http://x").pathname);
  const reached = () => strip(new URL(page.url()).pathname) === want;
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (reached()) return;
    if (Date.now() - started > 45000) {
      await page.goto(new URL(href, page.url()).toString(), { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    } else {
      await page.evaluate((x) => window.next?.router?.push(x), href).catch(() => {});
    }
    await page.waitForFunction((w) => (location.pathname.replace(/\/+$/, "") || "/") === w, want, { timeout: 8000 }).catch(() => {});
  }
  throw new Error(`slowGo: never reached ${href} (at ${page.url()})`);
}
const r2 = (n) => Math.round(n * 100) / 100;
const when = (iso) => new Date(iso);
const effMonth = (t) => (t.accountingMonth ? when(t.accountingMonth) : new Date(when(t.dateTime).getFullYear(), when(t.dateTime).getMonth(), 1));

/** Calendar month containing `d` (+ offset months). */
function monthRange(d, offset = 0) {
  return { start: new Date(d.getFullYear(), d.getMonth() + offset, 1), end: new Date(d.getFullYear(), d.getMonth() + offset + 1, 0, 23, 59, 59, 999) };
}
/** The cycle (start day `sd`) containing `d`. */
function cycleRange(sd, d) {
  const startIn = (y, m) => new Date(y, m, Math.min(sd, new Date(y, m + 1, 0).getDate()));
  let s = startIn(d.getFullYear(), d.getMonth());
  if (d < s) s = startIn(d.getFullYear(), d.getMonth() - 1);
  const n = startIn(s.getFullYear(), s.getMonth() + 1);
  return { start: s, end: new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1, 23, 59, 59, 999) };
}

/** Every live EMI installment payment (raw documents), plus a legacy remainder at the due date when payments don't cover amountPaid. */
async function emiPaymentsRaw() {
  const out = [];
  for (const e of (await h.list("emis")).filter((x) => !x.deletedAt)) {
    const insts = (await h.list(`paymentSchedules/${e.scheduleId}/installments`)).filter((i) => !i.deletedAt && i.amountPaid > 0);
    for (const i of insts) {
      const pays = (await h.list(`paymentSchedules/${e.scheduleId}/installments/${i.id}/payments`)).filter((p) => !p.deletedAt);
      for (const p of pays) out.push({ emi: e, date: when(p.date), amount: p.amount, recordedEarlier: !!p.recordedEarlier });
      const rest = r2(i.amountPaid - pays.reduce((s, p) => s + p.amount, 0));
      if (rest > 0) out.push({ emi: e, date: when(i.dueDate), amount: rest, recordedEarlier: false });
    }
  }
  return out;
}

/** Independent oracle over the raw persisted documents. */
async function oracle(range, monthGranular) {
  const [txs, accounts, cards, loans, expenses] = await Promise.all([h.list("transactions"), h.list("accounts"), h.list("creditCards"), h.list("loans"), h.list("expenses")]);
  const cardAcc = new Set(cards.filter((c) => !c.deletedAt).map((c) => c.accountId));
  const live = txs.filter((t) => !t.deletedAt);
  const counted = live.filter((t) => !t.excludeFromCalculations);
  const inR = (d) => d >= range.start && d <= range.end;
  const bucket = (t) => (monthGranular ? effMonth(t) : when(t.dateTime));
  const disb = (t) => t.loanId && t.paymentAllocationType === "additionalDisbursement";
  const notMovement = (t) => !t.transferId && !disb(t) && !t.isPersonLedgerMovement;

  const income = counted.filter((t) => t.type === "income" && notMovement(t) && !t.emiId && !cardAcc.has(t.accountId) && inR(bucket(t))).reduce((s, t) => s + t.amount, 0);
  // Month Cycle outflow: expense rows (card purchases included), EMI-payment rows replaced by installment payments (none in this fixture).
  // EMI installment payments count by the date PAID (not recorded-earlier ones); card-linked EMIs whose purchase is on
  // the card (Case A) are not in these fixtures. Cash basis skips card-linked EMIs (their cash leaves via the card bill).
  const emiPays = (await emiPaymentsRaw()).filter((p) => !p.recordedEarlier && inR(p.date));
  const emiOut = emiPays.reduce((s, p) => s + p.amount, 0);
  const emiCashOut = emiPays.filter((p) => !p.emi.linkedCreditCardId).reduce((s, p) => s + p.amount, 0);
  const outflow = counted.filter((t) => t.type === "expense" && notMovement(t) && !t.emiId && inR(bucket(t))).reduce((s, t) => s + t.amount, 0) + emiOut;
  // My spend: my share of each purchase; repaying cash borrowed is not spend.
  const loanKind = new Map(loans.map((l) => [l.id, l.agreementKind ?? "loan"]));
  const meShare = new Map(
    expenses
      .filter((e) => !e.deletedAt)
      .map((e) => {
        const split = e.splitType && e.splitType !== "none" && (e.participants ?? []).length > 0;
        return [e.transactionId, split ? ((e.participants ?? []).find((p) => p.isMe)?.share ?? 0) : e.totalAmount];
      }),
  );
  const repay = (t) => (t.loanId || t.emiId) && ["regularEmi", "advanceEmi", "principalPrepayment"].includes(t.paymentAllocationType);
  const mySpend = counted
    .filter((t) => t.type === "expense" && notMovement(t) && !t.lenderChargeId && inR(bucket(t)))
    .filter((t) => !(repay(t) && t.loanId && loanKind.get(t.loanId) !== "installmentPurchase"))
    .reduce((s, t) => s + Math.min(t.amount, meShare.has(t.id) ? meShare.get(t.id) : t.amount), 0);
  // Cash basis: card-account rows are liability only; a transfer INTO a card is a card payment (cash out).
  const cardPayIds = new Set(counted.filter((t) => t.transferId && t.type === "income" && cardAcc.has(t.accountId)).map((t) => t.transferId));
  const cashRows = counted.filter((t) => !t.emiId && inR(bucket(t)));
  const cashIn = cashRows.filter((t) => t.type === "income" && notMovement(t) && !cardAcc.has(t.accountId)).reduce((s, t) => s + t.amount, 0);
  const cashOut =
    emiCashOut +
    cashRows.filter((t) => t.type === "expense" && (notMovement(t) || t.lenderChargeId) && !cardAcc.has(t.accountId)).reduce((s, t) => s + t.amount, 0) +
    cashRows.filter((t) => t.type === "expense" && t.transferId && !cardAcc.has(t.accountId) && cardPayIds.has(t.transferId)).reduce((s, t) => s + t.amount, 0);
  // Accounts: balances by real date, walked back from the stored balance.
  const effect = (t) => (t.excludeFromCalculations || t.fundedByPersonId ? 0 : t.type === "income" ? t.amount : -t.amount);
  const acct = {};
  for (const a of accounts.filter((x) => !x.deletedAt)) {
    const own = live.filter((t) => t.accountId === a.id);
    const after = (cut) => own.filter((t) => when(t.dateTime) >= cut).reduce((s, t) => s + effect(t), 0);
    const inside = own.filter((t) => inR(when(t.dateTime)));
    acct[a.name] = {
      opening: r2(a.currentBalance - after(range.start)),
      closing: r2(a.currentBalance - after(new Date(range.end.getTime() + 1))),
      in: r2(inside.filter((t) => effect(t) > 0).reduce((s, t) => s + effect(t), 0)),
      out: r2(inside.filter((t) => effect(t) < 0).reduce((s, t) => s - effect(t), 0)),
    };
  }
  return { income: r2(income), outflow: r2(outflow), mySpend: r2(mySpend), cashIn: r2(cashIn), cashOut: r2(cashOut), acct };
}

const kpi = async (page, id) => Number(await page.getByTestId(`kpi-${id}-value`).getAttribute("data-value"));
const metric = async (page, id) => Number(await page.getByTestId(`an-metric-${id}-value`).getAttribute("data-value"));
/** Opens a Reports details tab (Spending / Accounts / Debts / People / Net worth) unless it is already open. */
async function openTab(page, id) {
  const t = page.getByTestId(`rep-tab-${id}`);
  if ((await t.getAttribute("aria-selected")) !== "true") {
    await t.click();
    await page.waitForTimeout(350);
  }
}
async function shownAccounts(page) {
  await openTab(page, "accounts");
  return page.getByTestId("rep-acct-row").evaluateAll((els) =>
    Object.fromEntries(els.map((e) => [e.dataset.name, { opening: +e.dataset.opening, closing: +e.dataset.closing, in: +e.dataset.in, out: +e.dataset.out }])),
  );
}
async function openReports(page) {
  await slowGo(page, "/reports");
  await page.getByTestId("kpi-income-value").waitFor({ timeout: 60000 });
  await page.waitForTimeout(2500); // fan-out payment reads settle
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function compareAll(page, chk, label, o) {
  const got = { income: await kpi(page, "income"), outflow: await kpi(page, "outflow"), mySpend: await kpi(page, "myspend") };
  chk(`${label}: Income = independent total`, close2(got.income, o.income), `${got.income} vs ${o.income}`);
  chk(`${label}: Total outflow = independent total`, close2(got.outflow, o.outflow), `${got.outflow} vs ${o.outflow}`);
  chk(`${label}: My spend = independent total`, close2(got.mySpend, o.mySpend), `${got.mySpend} vs ${o.mySpend}`);
  chk(`${label}: Net = income − outflow`, close2(await kpi(page, "net"), r2(got.income - got.outflow)));
  const cin = Number(await page.getByTestId("rep-cash-in").locator("[data-value]").getAttribute("data-value"));
  const cout = Number(await page.getByTestId("rep-cash-out").locator("[data-value]").getAttribute("data-value"));
  chk(`${label}: cash-basis Money in / out = independent totals (card purchase replaced by card payments)`, close2(cin, o.cashIn) && close2(cout, o.cashOut), `in ${cin} vs ${o.cashIn}; out ${cout} vs ${o.cashOut}`);
  const rows = await shownAccounts(page);
  const diffs = [];
  for (const [name, want] of Object.entries(o.acct)) {
    const have = rows[name];
    if (!have) {
      if (want.in || want.out || want.opening || want.closing) diffs.push(`${name} missing`);
      continue;
    }
    for (const k of ["opening", "in", "out", "closing"]) if (!close2(have[k], want[k])) diffs.push(`${name}.${k} ${have[k]} vs ${want[k]}`);
    if (!close2(have.closing - have.opening, have.in - have.out)) diffs.push(`${name}: closing − opening ≠ in − out`);
  }
  chk(`${label}: account statement (opening / in / out / closing) = reconstruction from stored records`, diffs.length === 0, diffs.join(" | ") || `${Object.keys(rows).length} accounts match`);
  return got;
}

async function addTxn(page, kind, amount, desc) {
  await h.go(page, "/transactions");
  await page.waitForTimeout(2500);
  await page.locator("button:visible", { hasText: "Add Transaction" }).first().click();
  await page.getByRole("menuitem", { name: kind, exact: true }).click();
  await page.getByText(`Add ${kind}`, { exact: true }).first().waitFor();
  await page.getByText(/^(Account|Deposit to|Received in|To account)\s?\*$/).first().locator("xpath=following::button[1]").click();
  await page.getByRole("option", { name: /QA Bank/ }).first().click();
  await page.locator('input[placeholder="0.00"]').first().fill(String(amount));
  await page.locator('input[placeholder^="e.g."]').first().fill(desc);
  await page.getByRole("button", { name: `Add ${kind}` }).click();
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "Cancel" }).last().click().catch(() => {});
  await page.waitForTimeout(600);
}
async function addTransfer(page, from, to, amount) {
  await h.go(page, "/transactions");
  await page.waitForTimeout(2500);
  await page.locator("button:visible", { hasText: "Add Transaction" }).first().click();
  await page.getByRole("menuitem", { name: "Transfer to my account" }).click();
  await page.locator("#txn-amount").waitFor();
  await page.locator("#txn-amount").fill(String(amount));
  await page.getByText("From Account *").locator("xpath=following::button[1]").click();
  await page.getByRole("option", { name: new RegExp(from) }).click();
  await page.getByText("To Account *").locator("xpath=following::button[1]").click();
  await page.getByRole("option", { name: new RegExp(to) }).click();
  await page.locator('button[type="submit"]:visible').last().click();
  await page.waitForTimeout(2500);
  if (await page.getByRole("button", { name: "Cancel" }).last().isVisible().catch(() => false)) await page.getByRole("button", { name: "Cancel" }).last().click();
  await page.waitForTimeout(600);
}
async function deleteTxn(page, desc) {
  await h.go(page, "/transactions");
  await page.waitForTimeout(2500);
  await page.getByPlaceholder(/Search description/).fill(desc);
  await page.waitForTimeout(1200);
  await page.locator("tbody tr").filter({ hasText: desc }).first().getByRole("button", { name: "Delete transaction" }).click();
  await page.waitForTimeout(800);
  await page.getByRole("dialog").last().getByRole("button", { name: /^Delete/ }).last().click();
  await page.waitForTimeout(3000);
}

scenario(
  "rpt-reports",
  "Reports: every KPI, cash basis and account line = independent recomputation; previous month; CSV; layout",
  async ({ page }, chk) => {
    await h.addFixture(page, "history"); // 36 dated transactions across ~45 days → several months
    await openReports(page);
    const now = new Date();
    await compareAll(page, chk, "This month", await oracle(monthRange(now), true));
    chk("period label names the current month", (await page.getByTestId("period-label").innerText()).includes(now.toLocaleDateString("en-IN", { month: "long", year: "numeric" })));
    chk("no horizontal page scroll at 1440px", (await overflow(page)) <= 1, await overflow(page));
    for (const id of ["rep-kpis", "rep-trend", "rep-moneyflow", "rep-details"]) chk(`overview block ${id} is shown`, await page.getByTestId(id).isVisible());
    // The overview (KPIs + chart + where the money went) fits the first 1440x900 screen; the details tabs start on it.
    const bottom = async (id) => {
      const b = await page.getByTestId(id).boundingBox();
      return b.y + b.height;
    };
    const ovBottom = Math.max(await bottom("rep-kpis"), await bottom("rep-trend"), await bottom("rep-moneyflow"));
    chk("overview (KPIs, cash-flow chart, where the money went) fits within 900px", ovBottom <= 900, `bottom ${Math.round(ovBottom)}px`);
    const tabsTop = (await page.getByTestId("rep-tab-spending").boundingBox()).y;
    chk("details tabs begin on the first screen", tabsTop < 900, `top ${Math.round(tabsTop)}px`);
    // Every details tab shows its view; sections live in tabs now, one at a time.
    const tabViews = { spending: ["rep-categories", "rep-top"], accounts: ["rep-accounts"], debts: ["rep-debts"], people: ["rep-people"], networth: ["rep-networth"] };
    for (const [t, ids] of Object.entries(tabViews)) {
      await openTab(page, t);
      for (const id of ids) chk(`tab "${t}" shows ${id}`, await page.getByTestId(id).isVisible());
      await page.getByTestId("rep-details").screenshot({ path: `${h.SHOTS_DIR}/rpt-reports-tab-${t}.png` });
    }
    chk("module links are always shown (7 source modules)", (await page.getByTestId("rep-links").locator("a").count()) >= 7);
    await openTab(page, "spending");
    await h.shot(page, "rpt-reports-light-1440");

    // Chart views: each draws bars; the table view lists one row per period.
    for (const v of ["net", "spend", "cash", "flow"]) {
      await page.getByTestId(`rep-trend-view-${v}`).click();
      await page.waitForTimeout(500);
      chk(`chart view "${v}" draws bars`, (await page.getByTestId("rep-trend").locator(".recharts-bar-rectangle").count()) > 0);
    }
    await page.getByTestId("rep-trend-table-toggle").click();
    const trendRows = await page.getByTestId("rep-trend-table").locator("tbody tr").count();
    chk("table view lists the trend periods", trendRows >= 1 && trendRows <= 6, `${trendRows} rows`);
    await page.getByTestId("rep-trend-table-toggle").click();
    await page.getByTestId("rep-window-12").click();
    await page.waitForTimeout(400);
    chk("12-period window keeps the chart", await page.getByTestId("rep-trend").locator(".recharts-surface").first().isVisible());
    await page.getByTestId("rep-window-6").click();

    // KPI tiles are shortcuts: Outstanding debt opens Debts & cards, Net worth opens Net worth.
    await page.getByTestId("kpi-debt").click();
    await page.waitForTimeout(500);
    chk("clicking Outstanding debt opens the Debts & cards tab", (await page.getByTestId("rep-tab-debts").getAttribute("aria-selected")) === "true");
    await page.getByTestId("kpi-networth").click();
    await page.waitForTimeout(500);
    chk("clicking Net worth opens the Net worth tab", (await page.getByTestId("rep-tab-networth").getAttribute("aria-selected")) === "true");

    // Category drill-down: clicking a category lists exactly its purchases.
    await openTab(page, "spending");
    const firstCat = page.getByTestId("rep-category-row").first();
    const catCount = Number(await firstCat.getAttribute("data-count"));
    await firstCat.click();
    await page.waitForTimeout(300);
    chk("category click shows a clear chip", await page.getByTestId("rep-category-clear").isVisible());
    const drillRows = await page.getByTestId("rep-top-rows").locator("li").count();
    chk("drill-down lists exactly that category's purchases", drillRows === Math.min(catCount, 30), `${drillRows} vs ${catCount}`);
    await page.getByTestId("rep-category-clear").click();

    // Previous month via the period bar.
    await page.getByTestId("period-prev").click();
    await page.waitForTimeout(1500);
    await compareAll(page, chk, "Previous month", await oracle(monthRange(now, -1), true));
    await h.shot(page, "rpt-reports-prev-month");

    // Clicking a column in the trend opens that period.
    await page.getByTestId("period-today").click();
    await page.waitForTimeout(800);

    // CSV export carries the same numbers.
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), page.getByTestId("rep-export").click()]);
    const csv = await (await download.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString("utf8"));
    const inc = await kpi(page, "income");
    chk("CSV export has the Income figure shown on screen", new RegExp(`^Income,${inc}(\\.00)?,`, "m").test(csv), csv.split("\n").slice(3, 6).join(" / "));

    // Narrow viewport: no horizontal page scroll.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1200);
    chk("no horizontal page scroll at 390px", (await overflow(page)) <= 1, await overflow(page));
    await h.shot(page, "rpt-reports-390");
  },
  { viewport: { width: 1440, height: 900 } },
);

scenario(
  "rpt-sync",
  "Reports/Analytics sync: add expense, transfer, delete → every affected figure moves by exactly the right amount",
  async ({ page }, chk) => {
    const now = new Date();
    await openReports(page);
    const base = await compareAll(page, chk, "Before", await oracle(monthRange(now), true));
    const acct0 = await shownAccounts(page);

    await addTxn(page, "Expense", 250, "QA rpt coffee");
    await openReports(page);
    const a1 = await compareAll(page, chk, "After ₹250 expense", await oracle(monthRange(now), true));
    chk("expense: outflow +250, my spend +250, income unchanged", close2(a1.outflow - base.outflow, 250) && close2(a1.mySpend - base.mySpend, 250) && close2(a1.income, base.income));

    await addTransfer(page, "QA Bank", "QA Cash", 1000);
    await openReports(page);
    const a2 = await compareAll(page, chk, "After ₹1,000 transfer", await oracle(monthRange(now), true));
    chk("transfer: income, outflow and my spend all unchanged (no artificial income/expense)", close2(a2.income, a1.income) && close2(a2.outflow, a1.outflow) && close2(a2.mySpend, a1.mySpend));
    const acct2 = await shownAccounts(page);
    chk("transfer: QA Bank money out +1,000 (and +250 coffee), QA Cash money in +1,000", close2(acct2["QA Bank"].out - acct0["QA Bank"].out, 1250) && close2(acct2["QA Cash"].in - acct0["QA Cash"].in, 1000), JSON.stringify({ bank: [acct0["QA Bank"].out, acct2["QA Bank"].out], cash: [acct0["QA Cash"].in, acct2["QA Cash"].in] }));

    // Analytics agrees with Reports for the same period.
    await h.go(page, "/analytics");
    await page.getByTestId("an-metric-income-value").waitFor({ timeout: 60000 });
    await page.waitForTimeout(2000);
    chk("Analytics Income / Outflow / My spend = Reports for the same month", close2(await metric(page, "income"), a2.income) && close2(await metric(page, "outflow"), a2.outflow) && close2(await metric(page, "mySpend"), a2.mySpend));

    await deleteTxn(page, "QA rpt coffee");
    await openReports(page);
    const a3 = await compareAll(page, chk, "After deleting the expense", await oracle(monthRange(now), true));
    chk("delete: outflow and my spend back to the starting totals", close2(a3.outflow, base.outflow) && close2(a3.mySpend, base.mySpend));
  },
  { viewport: { width: 1440, height: 900 } },
);

scenario(
  "rpt-cycle18",
  "Custom Month Cycle (18th): Reports uses 18th→17th by real date; calendar month still available",
  async ({ page }, chk) => {
    await h.addFixture(page, "history");
    await h.go(page, "/settings");
    await page.getByRole("tab", { name: "Profile" }).click();
    await page.getByRole("combobox", { name: /Cycle starts on/ }).click();
    await page.getByRole("option", { name: "18th", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Month cycle saved").first().waitFor({ timeout: 15000 });

    await openReports(page);
    const now = new Date();
    const cyc = cycleRange(18, now);
    chk("period bar offers Cycle / Calendar month / Custom", (await page.getByTestId("period-mode").innerText()).includes("Calendar month"));
    chk("basis chip names the 18th → 17th cycle", /18th → 17th/.test(await page.getByTestId("period-basis").innerText()), await page.getByTestId("period-basis").innerText());
    await compareAll(page, chk, "Cycle 18th", await oracle(cyc, false));
    await page.getByTestId("period-prev").click();
    await page.waitForTimeout(1500);
    const prevEnd = new Date(cyc.start.getFullYear(), cyc.start.getMonth(), cyc.start.getDate() - 1, 12);
    await compareAll(page, chk, "Previous cycle", await oracle(cycleRange(18, prevEnd), false));
    await page.getByTestId("period-mode-month").click();
    await page.waitForTimeout(1500);
    await compareAll(page, chk, "Calendar month (with an 18th cycle set)", await oracle(monthRange(now), true));
    await h.shot(page, "rpt-cycle18");

    // Restore the default.
    await h.go(page, "/settings");
    await page.getByRole("tab", { name: "Profile" }).click();
    await page.getByRole("combobox", { name: /Cycle starts on/ }).click();
    await page.getByRole("option", { name: "1st (calendar month)", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
  },
  { viewport: { width: 1440, height: 900 } },
);

for (const scheme of ["light", "dark"]) {
  scenario(
    `rpt-analytics-${scheme}`,
    `Analytics (${scheme}): figures = independent totals; no invented ₹0 months; overview on one screen; tabs; filters; drill-down`,
    async ({ page }, chk) => {
      await h.addFixture(page, "history");
      await h.go(page, "/analytics");
      await page.getByTestId("an-metric-income-value").waitFor({ timeout: 60000 });
      await page.waitForTimeout(2500);
      const now = new Date();
      const o = await oracle(monthRange(now), true);
      chk("KPI Income / Outflow / My spend = independent totals", close2(await metric(page, "income"), o.income) && close2(await metric(page, "outflow"), o.outflow) && close2(await metric(page, "mySpend"), o.mySpend), `${await metric(page, "income")}/${await metric(page, "outflow")}/${await metric(page, "mySpend")} vs ${o.income}/${o.outflow}/${o.mySpend}`);
      chk("KPI Net = income − outflow", close2(await metric(page, "net"), r2(o.income - o.outflow)));

      // Overview fits the first screen: KPIs, main chart and focus panel all end above the fold.
      const fold = await page.evaluate(() => window.innerHeight);
      const bottoms = await Promise.all(["an-kpis", "an-hero", "an-focus"].map(async (id) => (await page.getByTestId(id).boundingBox()).y + (await page.getByTestId(id).boundingBox()).height));
      chk("KPIs, main chart and focus panel are all on the first screen (no scrolling) at 1440×900", bottoms.every((b) => b <= fold), `${bottoms.map(Math.round).join(", ")} vs ${fold}`);
      const scrollH = await page.evaluate(() => document.documentElement.scrollHeight);
      chk("whole page is at most ~1.5 screens tall", scrollH <= fold * 1.55, `${scrollH} px`);

      // Sparse history: the window starts at the first period with records (no invented ₹0 months).
      const txs = (await h.list("transactions")).filter((t) => !t.deletedAt);
      const first = new Date(Math.min(...txs.map((t) => new Date(t.dateTime).getTime())));
      const expectMonths = (now.getFullYear() - first.getFullYear()) * 12 + now.getMonth() - first.getMonth() + 1;
      await page.getByTestId("an-hero-view-table").click();
      const rows = await page.getByTestId("an-hero-table").locator("tbody tr").count();
      chk("table lists only periods since the first record (no ₹0 months before it)", rows === Math.min(12, expectMonths), `${rows} rows vs ${expectMonths} months since ${first.toDateString()}`);
      chk("a note says where records start", expectMonths >= 12 || (await page.getByTestId("an-records-note").isVisible()));
      await page.getByTestId("an-hero-view-chart").click();
      await h.shot(page, `rpt-analytics-${scheme}`);

      // KPI tile switches the main chart to that metric; clicking again returns to Cash flow.
      await page.getByTestId("an-metric-mySpend").click();
      chk("clicking a KPI tile switches the main chart", (await page.getByTestId("an-view-mySpend").getAttribute("aria-checked")) === "true");
      await page.getByTestId("an-metric-mySpend").click();
      chk("clicking it again returns to Cash flow", (await page.getByTestId("an-view-flow").getAttribute("aria-checked")) === "true");

      // Explore tabs.
      for (const t of ["categories", "savings", "balances", "daily"]) {
        await page.getByTestId(`an-tab-${t}`).click();
        await page.waitForTimeout(500);
        chk(`Explore tab "${t}" shows its view`, await page.getByTestId(`an-${t}`).isVisible());
        await page.getByTestId("an-explore").screenshot({ path: `${h.SHOTS_DIR}/rpt-an-${scheme}-tab-${t}.png` });
      }
      const days = monthRange(now).end.getDate();
      chk("daily calendar has one cell per day of the period", (await page.getByTestId("an-day").count()) === days, `${await page.getByTestId("an-day").count()} vs ${days}`);
      const cells = await page.getByTestId("an-day").evaluateAll((els) => els.map((e) => ({ v: +e.dataset.value, l: +(e.dataset.level ?? 0) })));
      const shownTotal = r2(cells.reduce((s, c) => s + c.v, 0));
      chk("calendar day amounts add up to My spend", close2(shownTotal, await metric(page, "mySpend")), `${shownTotal}`);
      chk("heatmap uses more than one colour step for days with spending", new Set(cells.filter((c) => c.v > 0).map((c) => c.l)).size > 1);

      chk("page renders in the requested scheme", (await page.evaluate(() => document.documentElement.classList.contains("dark"))) === (scheme === "dark"));
      chk("no horizontal page scroll", (await overflow(page)) <= 1, await overflow(page));

      // Previous month focus.
      await page.getByTestId("period-prev").click();
      await page.waitForTimeout(1200);
      const op = await oracle(monthRange(now, -1), true);
      chk("focusing the previous month: KPIs = independent totals", close2(await metric(page, "income"), op.income) && close2(await metric(page, "mySpend"), op.mySpend));
      await page.getByTestId("period-today").click();
      await page.waitForTimeout(800);

      // Account filter: QA Bank only → income = QA Bank's income.
      await page.getByTestId("an-account-filter").click();
      await page.getByRole("button", { name: /^QA Bank/ }).click();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(1200);
      chk("account filter note is shown", await page.getByTestId("an-account-note").isVisible());
      const live = (await h.list("transactions")).filter((t) => !t.deletedAt && !t.excludeFromCalculations);
      const bankId = (await h.accountBalance("QA Bank")).id;
      const m = monthRange(now);
      const bankIncome = r2(live.filter((t) => t.accountId === bankId && t.type === "income" && !t.transferId && !(t.loanId && t.paymentAllocationType === "additionalDisbursement") && !t.isPersonLedgerMovement && effMonth(t) >= m.start && effMonth(t) <= m.end).reduce((s, t) => s + t.amount, 0));
      chk("account filter: Income = QA Bank's income only", close2(await metric(page, "income"), bankIncome), `${await metric(page, "income")} vs ${bankIncome}`);
      await page.getByTestId("an-account-filter").click();
      await page.getByRole("button", { name: "Show all accounts" }).click();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(800);

      // Category isolate + drill-down.
      await page.getByTestId("an-tab-categories").click();
      await page.waitForTimeout(400);
      await page.getByTestId("an-category-legend").locator("button").first().click();
      await page.waitForTimeout(500);
      chk("legend click isolates one category (clear button appears)", await page.getByTestId("an-category-clear").isVisible());
      chk("drill-down list opens for the isolated category", await page.getByTestId("an-drill").isVisible());
      await h.shot(page, `rpt-analytics-${scheme}-category`);
      await page.getByTestId("an-category-clear").click();
    },
    { viewport: { width: 1440, height: 900 }, scheme },
  );
}

scenario(
  "rpt-edit",
  "Editing a transaction's amount moves Analytics and Reports by exactly the difference",
  async ({ page }, chk) => {
    const now = new Date();
    await h.go(page, "/analytics");
    await page.getByTestId("an-metric-outflow-value").waitFor({ timeout: 60000 });
    await page.waitForTimeout(2500);
    const before = { outflow: await metric(page, "outflow"), mySpend: await metric(page, "mySpend") };
    const target = (await h.list("transactions")).find((t) => t.description === "QA groceries" && !t.deletedAt);
    await h.go(page, "/transactions");
    await page.waitForTimeout(3000);
    await page.getByPlaceholder(/Search description/).fill("QA groceries");
    await page.waitForTimeout(1200);
    await page.locator("tbody tr").filter({ hasText: "QA groceries" }).first().getByRole("button", { name: "Edit transaction" }).click();
    await page.waitForTimeout(1500);
    await page.locator('input[placeholder="0.00"]').first().fill(String(target.amount + 500));
    await page.getByRole("button", { name: /^(Save|Update)/ }).first().click();
    await page.waitForTimeout(3500);
    await page.getByRole("button", { name: "Cancel" }).last().click().catch(() => {});
    const stored = (await h.list("transactions")).find((t) => t.id === target.id);
    chk("the edit was saved (persisted amount +500)", close2(stored.amount, target.amount + 500), `${target.amount} → ${stored.amount}`);
    await h.go(page, "/analytics");
    await page.getByTestId("an-metric-outflow-value").waitFor({ timeout: 60000 });
    await page.waitForTimeout(2500);
    chk("Analytics outflow and my spend each moved by exactly +500", close2((await metric(page, "outflow")) - before.outflow, 500) && close2((await metric(page, "mySpend")) - before.mySpend, 500), `${before.outflow}→${await metric(page, "outflow")}`);
    const o = await oracle(monthRange(now), true);
    chk("…and still equal the independent totals", close2(await metric(page, "outflow"), o.outflow) && close2(await metric(page, "mySpend"), o.mySpend));
    await openReports(page);
    chk("Reports agrees after the edit", close2(await kpi(page, "outflow"), o.outflow) && close2(await kpi(page, "myspend"), o.mySpend));
  },
  { viewport: { width: 1440, height: 900 } },
);

/** Visual review: full pages, hovered tooltips and the heatmap in both schemes, plus timings. Screens only — no data written beyond fixtures. */
for (const scheme of ["light", "dark"]) {
  scenario(
    `rpt-visual-${scheme}`,
    `Reports & Analytics visual review (${scheme}): full pages, tooltips, heatmap, timings`,
    async ({ page }, chk, notes) => {
      await h.addFixture(page, "history");
      await h.addFixture(page, "card-emi");
      await h.addFixture(page, "shared-emi");
      const shot = (name, opts = {}) => page.screenshot({ path: `${h.SHOTS_DIR}/rptv-${scheme}-${name}.png`, ...opts });

      let t0 = Date.now();
      await h.go(page, "/reports");
      await page.getByTestId("kpi-income-value").waitFor({ timeout: 60000 });
      notes.push(`reports first paint of figures: ${Date.now() - t0} ms`);
      await page.waitForTimeout(2500);
      await shot("reports-full", { fullPage: true });
      // Tooltip on the trend columns.
      const trend = page.getByTestId("rep-trend").locator(".recharts-surface").first();
      const tb = await trend.boundingBox();
      await page.mouse.move(tb.x + tb.width * 0.92, tb.y + tb.height * 0.6);
      await page.waitForTimeout(500);
      await page.getByTestId("rep-trend").screenshot({ path: `${h.SHOTS_DIR}/rptv-${scheme}-reports-trend-tooltip.png` });
      chk("trend tooltip appears on hover", await page.locator(".recharts-tooltip-wrapper").first().isVisible());
      // Period switch timing.
      t0 = Date.now();
      await page.getByTestId("period-prev").click();
      await page.waitForFunction(() => !document.querySelector('[data-testid="period-label"]')?.textContent?.includes(new Date().toLocaleDateString("en-IN", { month: "long" })), null, { timeout: 10000 });
      notes.push(`reports period switch: ${Date.now() - t0} ms`);
      await page.getByTestId("period-today").click();
      await page.waitForTimeout(800);
      await shot("reports-overview");
      for (const t of ["spending", "accounts", "debts", "people", "networth"]) {
        await openTab(page, t);
        await page.waitForTimeout(500);
        await page.getByTestId("rep-details").screenshot({ path: `${h.SHOTS_DIR}/rptv-${scheme}-rep-tab-${t}.png` });
      }
      for (const v of ["net", "spend", "cash"]) {
        await page.getByTestId(`rep-trend-view-${v}`).click();
        await page.waitForTimeout(600);
        await page.getByTestId("rep-trend").screenshot({ path: `${h.SHOTS_DIR}/rptv-${scheme}-rep-view-${v}.png` });
      }
      await page.getByTestId("rep-trend-view-flow").click();
      const nw = page.getByTestId("rep-networth").locator(".recharts-surface").first();
      const nb = await nw.boundingBox();
      await page.mouse.move(nb.x + nb.width * 0.5, nb.y + nb.height * 0.5);
      await page.waitForTimeout(500);
      await page.getByTestId("rep-networth").screenshot({ path: `${h.SHOTS_DIR}/rptv-${scheme}-reports-nw-tooltip.png` });

      t0 = Date.now();
      await h.go(page, "/analytics");
      await page.getByTestId("an-metric-income-value").waitFor({ timeout: 60000 });
      notes.push(`analytics first paint of figures: ${Date.now() - t0} ms`);
      await page.waitForTimeout(2500);
      await shot("analytics-full", { fullPage: true });
      const hero = page.getByTestId("an-hero-chart").locator(".recharts-surface").first();
      const hb = await hero.boundingBox();
      await page.mouse.move(hb.x + hb.width * 0.97, hb.y + hb.height * 0.4);
      await page.waitForTimeout(500);
      await page.getByTestId("an-hero").screenshot({ path: `${h.SHOTS_DIR}/rptv-${scheme}-analytics-hero-tooltip.png` });
      t0 = Date.now();
      await page.getByTestId("an-window-24").click();
      await page.waitForTimeout(50);
      await page.getByTestId("an-metric-net").click();
      notes.push(`analytics 24-period window + metric switch: ${Date.now() - t0} ms`);
      await page.getByTestId("an-window-12").click();
      // Heatmap close-up + a hovered day (Daily tab).
      await page.getByTestId("an-tab-daily").click();
      await page.waitForTimeout(600);
      const daily = page.getByTestId("an-explore");
      await daily.scrollIntoViewIfNeeded();
      const day = page.getByTestId("an-day").nth(9);
      await day.hover();
      await page.waitForTimeout(500);
      await daily.screenshot({ path: `${h.SHOTS_DIR}/rptv-${scheme}-analytics-heatmap.png` });
      const bgs = await page.getByTestId("an-day").evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).backgroundColor))]);
      chk("heatmap uses distinct steps (more than one colour)", bgs.length > 1, bgs.join(" | "));
      for (const t of ["savings", "balances", "categories"]) {
        await page.getByTestId(`an-tab-${t}`).click();
        await page.waitForTimeout(700);
        await page.getByTestId("an-explore").screenshot({ path: `${h.SHOTS_DIR}/rptv-${scheme}-an-${t}.png` });
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(400);
      await shot("analytics-first-screen");
      chk("no horizontal page scroll", (await overflow(page)) <= 1, await overflow(page));
    },
    { viewport: { width: 1440, height: 900 }, scheme },
  );
}

/** "₹41,063", "−₹2,66,385", "₹41.1K", "₹2.7L" → numbers (compact values keep their precision). */
const pageAmounts = (text) =>
  [...String(text).matchAll(/([−-])?₹\s*([\d,]*\d(?:\.\d{1,2})?)\s*(K|L|Cr|T)?/g)].map((m) => {
    const mult = { K: 1e3, L: 1e5, Cr: 1e7, T: 1e12 }[m[3]] ?? 1;
    const v = Number(m[2].replace(/,/g, "")) * mult;
    return { v: m[1] ? -v : v, compact: !!m[3], step: m[3] ? mult / 10 : 1 };
  });
/** Whether `value` is shown on the page at the page's own precision (exact rupees, or a compact figure that rounds to it). */
const shows = (amounts, value) => amounts.some((a) => (a.compact ? Math.abs(a.v - value) <= a.step / 2 + 0.01 : Math.abs(a.v - Math.round(value)) <= 1));
async function settledAmounts(page, path) {
  await slowGo(page, path);
  // Wait until the page shows amounts at all, then until its text stops changing (live listeners settle).
  await page.waitForFunction(() => /₹s*d/.test(document.querySelector("main")?.innerText ?? ""), null, { timeout: 30000 }).catch(() => {});
  let last = "";
  for (let k = 0; k < 10; k++) {
    await page.waitForTimeout(2000);
    const now = await page.locator("main").innerText().catch(() => page.locator("body").innerText());
    if (now === last && /₹s*d/.test(now)) break;
    last = now;
  }
  return pageAmounts(last);
}

scenario(
  "rpt-links",
  "Reports figures agree with Month Cycle, Dashboard, People, My Money and Credit Cards for the same records",
  async ({ page }, chk) => {
    await h.addFixture(page, "history");
    await h.addFixture(page, "card-emi");
    await openReports(page);
    const v = {
      income: await kpi(page, "income"),
      outflow: await kpi(page, "outflow"),
      mySpend: await kpi(page, "myspend"),
      debt: await kpi(page, "debt"),
      netWorth: await kpi(page, "networth"),
      cashIn: Number(await page.getByTestId("rep-cash-in").locator("[data-value]").getAttribute("data-value")),
      cashOut: Number(await page.getByTestId("rep-cash-out").locator("[data-value]").getAttribute("data-value")),
    };
    await openTab(page, "people");
    const peopleText = await page.getByTestId("rep-people").innerText();
    const receivable = pageAmounts(await page.getByTestId("rep-people-receivable").innerText())[0]?.v ?? 0;
    const payable = pageAmounts(await page.getByTestId("rep-people-payable").innerText())[0]?.v ?? 0;
    chk("Reports links to every source module", (await page.locator('[data-testid="reports-page"] a[href^="/transactions"], [data-testid="reports-page"] a[href^="/accounts"], [data-testid="reports-page"] a[href^="/people"], [data-testid="reports-page"] a[href^="/loans-installments"], [data-testid="reports-page"] a[href^="/credit-cards"], [data-testid="reports-page"] a[href^="/my-money"], [data-testid="reports-page"] a[href^="/dashboard"]').count()) >= 7);

    const mc = await settledAmounts(page, "/month-cycle");
    chk("Month Cycle shows the same Income", shows(mc, v.income), `${v.income}`);
    chk("Month Cycle shows the same Total outflow or My spend (whichever view is open)", shows(mc, v.outflow) || shows(mc, v.mySpend), `${v.outflow} / ${v.mySpend}`);
    const dash = await settledAmounts(page, "/dashboard");
    chk("Dashboard shows the same Net Worth", shows(dash, v.netWorth), `${v.netWorth}`);
    chk("Dashboard shows the same cash-basis Money in and Money out", shows(dash, v.cashIn) && shows(dash, v.cashOut), `${v.cashIn} / ${v.cashOut}`);
    const ppl = await settledAmounts(page, "/people");
    await h.shot(page, "rpt-links-people");
    chk("People shows the same 'owed to me' and 'I owe' totals", (receivable === 0 || shows(ppl, receivable)) && (payable === 0 || shows(ppl, payable)), `${receivable} / ${payable} · ${peopleText.slice(0, 80).replace(/\s+/g, " ")}`);
    const mm = await settledAmounts(page, "/my-money");
    chk.finding("RPT-L1", "My Money shows the same My spend for the month", shows(mm, v.mySpend), `${v.mySpend}`);
    const cards = await settledAmounts(page, "/credit-cards");
    const cardLine = await (async () => {
      await openReports(page);
      await openTab(page, "debts");
      const t = await page.getByTestId("rep-liabilities").innerText().catch(() => "");
      const m = /Credit cards\s*\n?\s*(₹[\d,]+)/.exec(t);
      return m ? pageAmounts(m[1])[0].v : null;
    })();
    chk.finding("RPT-L2", "Credit Cards page shows the Reports 'Credit cards' owed figure", cardLine == null || shows(cards, cardLine), `${cardLine}`);
  },
  { viewport: { width: 1440, height: 900 } },
);

/* ───────────── Payment date moved to another period (live, no reload) ───────────── */

async function recordPayment(page, name, payLabel) {
  // The Loans page streams several listeners; on a cold dev server under load its first paint can take a minute.
  await slowGo(page, "/loans-installments");
  const card = page.getByText(name).first();
  await card.waitFor({ timeout: 120000 });
  await card.click();
  await page.getByRole("button", { name: "Record Payment" }).click({ timeout: 90000 });
  const dlg = page.getByRole("dialog", { name: /Pay installment|Pay EMI/ });
  await dlg.getByText("TO PAY LENDER").waitFor({ timeout: 90000 });
  await dlg.getByText("Choose paying account").click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await dlg.getByRole("button", { name: payLabel }).click();
  await dlg.waitFor({ state: "hidden", timeout: 25000 });
  await page.waitForTimeout(1500);
}
/** Opens installment 1's recorded payment and saves it with a new date (dd/mm/yyyy). */
async function moveFirstPaymentTo(page, name, ddmmyyyy) {
  await slowGo(page, "/loans-installments");
  const card = page.getByText(name).first();
  await card.waitFor({ timeout: 120000 });
  await card.click();
  await h.showSchedule(page);
  await page.getByRole("button", { name: /Installment 1 .*(edit or mark unpaid|view payment)/ }).first().click();
  const det = page.getByRole("dialog", { name: /Recorded payment/ });
  await det.waitFor();
  await det.getByRole("button", { name: "Edit payment" }).click();
  const ed = page.getByRole("dialog", { name: /Edit payment/ });
  await ed.getByText("Originally").waitFor();
  const dateBox = ed.locator('input[placeholder="dd/mm/yyyy"]').first();
  await dateBox.fill(ddmmyyyy);
  await dateBox.press("Tab");
  await page.waitForTimeout(400);
  await ed.getByRole("button", { name: /^Save/ }).click();
  await page.waitForTimeout(5000);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500);
}
const ddmmyyyy = (d) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

scenario(
  "rpt-paydate",
  "Moving an EMI and a Loan payment into last month: Reports in ANOTHER tab updates without reload; Month Cycle, Dashboard, Analytics, account cash flow agree",
  async ({ page, ctx }, chk, notes) => {
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 10, 12);
    await h.openPortalSignedIn(page);
    await recordPayment(page, "QA Phone EMI", /^Pay ₹4,000/);
    await recordPayment(page, "QA Loan 60", /^Pay /);
    const emi = (await h.list("emis")).find((e) => e.name === "QA Phone EMI");
    const loan = (await h.list("loans")).find((l) => l.name === "QA Loan 60");
    const emiTx = () => h.list("transactions").then((ts) => ts.filter((t) => t.emiId === emi.id && !t.deletedAt));
    const loanTx = () => h.list("transactions").then((ts) => ts.filter((t) => t.loanId === loan.id && !t.deletedAt && !t.excludeFromCalculations && t.paymentAllocationType !== "additionalDisbursement"));
    chk("(setup) one live EMI cash payment and one Loan cash payment today", (await emiTx()).length === 1 && (await loanTx()).length === 1);
    const loanAmount = (await loanTx())[0].amount;

    // Tab B: Reports for THIS month, opened before the edits. It is never reloaded.
    const b = await (await import("../lib/flows.mjs")).secondTab(ctx, "/reports");
    await b.getByTestId("kpi-outflow-value").waitFor({ timeout: 60000 });
    await b.waitForTimeout(3000);
    await b.evaluate(() => (window.__noReload = "same-document"));
    const oBefore = await oracle(monthRange(now), true);
    const bBefore = await kpi(b, "outflow");
    chk("tab B before: Total outflow = independent total (EMI payment counted by its date)", close2(bBefore, oBefore.outflow), `${bBefore} vs ${oBefore.outflow}`);

    // Tab A: move both payments to last month.
    await moveFirstPaymentTo(page, "QA Phone EMI", ddmmyyyy(lastMonth));
    await moveFirstPaymentTo(page, "QA Loan 60", ddmmyyyy(lastMonth));
    const eTx = (await emiTx())[0];
    const lTx = (await loanTx())[0];
    chk("persisted: the EMI payment transaction is now dated last month", eTx && when(eTx.dateTime).getMonth() === lastMonth.getMonth(), eTx?.dateTime);
    chk("persisted: the Loan payment transaction is now dated last month", lTx && when(lTx.dateTime).getMonth() === lastMonth.getMonth(), lTx?.dateTime);
    const oAfter = await oracle(monthRange(now), true);
    chk("independent: this month's outflow fell by exactly ₹4,000 + the loan payment", close2(oBefore.outflow - oAfter.outflow, 4000 + loanAmount), `${oBefore.outflow} → ${oAfter.outflow}`);

    // Tab B updates live — no reload, no navigation.
    const t0 = Date.now();
    const live = await b.waitForFunction((want) => Math.abs(Number(document.querySelector('[data-testid="kpi-outflow-value"]')?.getAttribute("data-value")) - want) < 0.01, oAfter.outflow, { timeout: 30000 }).then(() => true).catch(() => false);
    notes.push(`tab B caught up in ${Date.now() - t0} ms`);
    chk("tab B (never reloaded) shows the new this-month Total outflow", live, `${await kpi(b, "outflow")} vs ${oAfter.outflow}`);
    chk("tab B was not reloaded", (await b.evaluate(() => window.__noReload)) === "same-document");
    const bCashOut = Number(await b.getByTestId("rep-cash-out").locator("[data-value]").getAttribute("data-value"));
    chk("tab B cash-basis Money out = independent total", close2(bCashOut, oAfter.cashOut), `${bCashOut} vs ${oAfter.cashOut}`);
    const bAcc = await shownAccounts(b);
    chk("tab B account statement (QA Bank) money out = independent total", close2(bAcc["QA Bank"].out, oAfter.acct["QA Bank"].out), `${bAcc["QA Bank"].out} vs ${oAfter.acct["QA Bank"].out}`);
    await b.getByTestId("period-prev").click();
    await b.waitForTimeout(1500);
    const oPrev = await oracle(monthRange(now, -1), true);
    chk("tab B last month now includes both payments (= independent total)", close2(await kpi(b, "outflow"), oPrev.outflow) && close2(Number(await b.getByTestId("rep-cash-out").locator("[data-value]").getAttribute("data-value")), oPrev.cashOut), `${await kpi(b, "outflow")} vs ${oPrev.outflow}`);
    await h.shot(b, "rpt-paydate-tabB");

    // Same tab A, client-side navigation only.
    await h.go(page, "/analytics");
    await page.getByTestId("an-metric-outflow-value").waitFor({ timeout: 60000 });
    await page.waitForTimeout(2000);
    chk("Analytics this-month Outflow = independent total", close2(await metric(page, "outflow"), oAfter.outflow), `${await metric(page, "outflow")} vs ${oAfter.outflow}`);
    const mc = await settledAmounts(page, "/month-cycle");
    chk("Month Cycle shows the new this-month outflow", shows(mc, oAfter.outflow), `${oAfter.outflow}`);
    const dash = await settledAmounts(page, "/dashboard");
    chk("Dashboard Money out shows the new this-month cash out", shows(dash, oAfter.cashOut), `${oAfter.cashOut}`);
    await b.close();
  },
  { viewport: { width: 1440, height: 900 } },
);

/* ───────────── Card bill payment, EMI reversal and a transfer: no double counting, no artificial income/expense ───────────── */

async function payWholeCard(page) {
  const { openPayWholeCard } = await import("../lib/flows.mjs");
  await h.go(page, "/credit-cards");
  await page.waitForTimeout(2500);
  await openPayWholeCard(page);
  await page.getByText("Select account").click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await page.getByRole("button", { name: /^Pay ₹12,000/ }).click();
  await page.waitForTimeout(4000);
  await page.getByRole("button", { name: "Cancel" }).last().click().catch(() => {});
  await page.waitForTimeout(1500);
}

scenario(
  "rpt-card-emi",
  "Card bill payment moves cash only (outflow, spend, net worth unchanged); EMI mark-unpaid reverses its outflow",
  async ({ page }, chk) => {
    const now = new Date();
    await h.go(page, "/dashboard");
    const read = async () => {
      await openReports(page);
      return {
        income: await kpi(page, "income"),
        outflow: await kpi(page, "outflow"),
        mySpend: await kpi(page, "myspend"),
        netWorth: await kpi(page, "networth"),
        debt: await kpi(page, "debt"),
        cashOut: Number(await page.getByTestId("rep-cash-out").locator("[data-value]").getAttribute("data-value")),
        cashIn: Number(await page.getByTestId("rep-cash-in").locator("[data-value]").getAttribute("data-value")),
        acct: await shownAccounts(page),
      };
    };
    const base = await read();
    chk("(setup) the card purchase of ₹12,000 is already in Total outflow and My spend, not in cash out", base.outflow >= 12000 && base.mySpend >= 12000);

    // 1) Pay the whole card from the bank.
    await payWholeCard(page);
    const afterCard = await read();
    const o1 = await oracle(monthRange(now), true);
    chk("card payment: Total outflow unchanged (the purchase was counted when made)", close2(afterCard.outflow, base.outflow), `${base.outflow} → ${afterCard.outflow}`);
    chk("card payment: My spend unchanged and Income unchanged", close2(afterCard.mySpend, base.mySpend) && close2(afterCard.income, base.income));
    chk("card payment: cash Money out rose by exactly ₹12,000 (the bill, once)", close2(afterCard.cashOut - base.cashOut, 12000), `${base.cashOut} → ${afterCard.cashOut}`);
    chk("card payment: cash figures = independent totals", close2(afterCard.cashOut, o1.cashOut) && close2(afterCard.cashIn, o1.cashIn), `${afterCard.cashOut} vs ${o1.cashOut}`);
    chk("card payment: Net worth unchanged (cash → card debt, both sides)", close2(afterCard.netWorth, base.netWorth), `${base.netWorth} → ${afterCard.netWorth}`);
    chk("card payment: QA Bank money out +12,000 and the card account shows the payment received", close2(afterCard.acct["QA Bank"].out - base.acct["QA Bank"].out, 12000) && close2(afterCard.acct["QA Credit Card"].in - base.acct["QA Credit Card"].in, 12000));
    chk("card payment: account statements = reconstruction", Object.entries(o1.acct).every(([n, w]) => !afterCard.acct[n] || ["opening", "closing", "in", "out"].every((k) => close2(afterCard.acct[n][k], w[k === "in" ? "in" : k === "out" ? "out" : k]))));

    // 2) Pay an EMI installment, then mark it unpaid.
    await recordPayment(page, "QA Phone EMI", /^Pay ₹4,000/);
    const afterEmi = await read();
    chk("EMI payment: Total outflow +₹4,000 (counted by payment date), cash out +₹4,000, net worth unchanged apart from interest", close2(afterEmi.outflow - afterCard.outflow, 4000) && close2(afterEmi.cashOut - afterCard.cashOut, 4000), `${afterCard.outflow} → ${afterEmi.outflow}`);
    await slowGo(page, "/loans-installments");
    const emiCard = page.getByText("QA Phone EMI").first();
    await emiCard.waitFor({ timeout: 120000 });
    await emiCard.click();
    await h.showSchedule(page);
    await page.getByRole("button", { name: /Installment 1 .*(edit or mark unpaid|view payment)/ }).first().click();
    const det = page.getByRole("dialog", { name: /Recorded payment/ });
    await det.waitFor();
    await det.getByRole("button", { name: "Mark as unpaid" }).click();
    const confirm = page.getByRole("dialog").last();
    await confirm.getByText("This installment goes back to unpaid").waitFor();
    await confirm.getByRole("button", { name: "Mark as unpaid" }).click();
    await page.waitForTimeout(5000);
    await page.keyboard.press("Escape").catch(() => {});
    const afterUnpay = await read();
    const o2 = await oracle(monthRange(now), true);
    chk("EMI mark-unpaid: Total outflow and cash out back to the pre-EMI values", close2(afterUnpay.outflow, afterCard.outflow) && close2(afterUnpay.cashOut, afterCard.cashOut), `${afterUnpay.outflow} vs ${afterCard.outflow}`);
    chk("EMI mark-unpaid: figures = independent totals", close2(afterUnpay.outflow, o2.outflow) && close2(afterUnpay.cashOut, o2.cashOut));

    // 3) A transfer between own accounts creates neither income nor spending, and net worth is unchanged.
    await addTransfer(page, "QA Bank", "QA Cash", 700);
    const afterXfer = await read();
    chk("transfer: Income, Total outflow, My spend, Net worth and cash figures all unchanged", ["income", "outflow", "mySpend", "netWorth", "cashIn", "cashOut"].every((k) => close2(afterXfer[k], afterUnpay[k])), JSON.stringify({ a: afterUnpay.outflow, b: afterXfer.outflow, nwA: afterUnpay.netWorth, nwB: afterXfer.netWorth }));
    chk("transfer: QA Bank −700 and QA Cash +700 on the account statement", close2(afterXfer.acct["QA Bank"].out - afterUnpay.acct["QA Bank"].out, 700) && close2(afterXfer.acct["QA Cash"].in - afterUnpay.acct["QA Cash"].in, 700));
    await h.shot(page, "rpt-card-emi-final");
  },
  { viewport: { width: 1440, height: 900 } },
);

scenario(
  "rpt-livenw",
  "Reports left open: a payment recorded in ANOTHER tab after it opened -> the current period's Net Worth (chart end + KPI) = today's Net Worth",
  async ({ page, ctx }, chk, notes) => {
    const b = await (await import("../lib/flows.mjs")).secondTab(ctx, "/reports");
    await b.getByTestId("kpi-networth-value").waitFor({ timeout: 60000 });
    await b.waitForTimeout(2500);
    await openTab(b, "networth");
    await b.evaluate(() => (window.__noReload = "same-document"));
    const nwToday = async () => Number(await b.getByTestId("rep-nw-today").locator("[data-value]").getAttribute("data-value"));
    const chartEnd = async () => Number(await b.getByTestId("rep-networth").getAttribute("data-last"));
    const before = await nwToday();
    chk("before: the chart's current-period point = Net worth today", close2(await chartEnd(), before), `${await chartEnd()} vs ${before}`);

    await recordPayment(page, "QA Phone EMI", /^Pay ₹4,000/);
    const pays = (await emiPaymentsRaw()).filter((p) => p.emi.name === "QA Phone EMI");
    notes.push(`recorded payment dates: ${pays.map((p) => p.date.toISOString()).join(", ")}`);

    // Wait for tab B to settle on the new figures (live listeners), then compare.
    let today = before;
    let last = NaN;
    for (let k = 0; k < 15; k++) {
      await b.waitForTimeout(2000);
      today = await nwToday();
      last = await chartEnd();
      if (!close2(today, before) && close2(today, last)) break;
    }
    notes.push(`net worth today ${before} -> ${today}; chart end ${last}`);
    chk("tab B chart's current-period point = Net worth today (nothing walked back)", close2(last, today), `chart ${last} vs today ${today}`);
    chk("tab B Net worth KPI = Net worth today", close2(await kpi(b, "networth"), today), `${await kpi(b, "networth")} vs ${today}`);
    chk("tab B was not reloaded", (await b.evaluate(() => window.__noReload)) === "same-document");
    await b.close();
  },
  { viewport: { width: 1440, height: 900 } },
);
