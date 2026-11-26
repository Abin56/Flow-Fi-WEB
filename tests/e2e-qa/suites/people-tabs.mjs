/**
 * Browser QA scenarios (people-tabs.mjs) — the compact People Ledger person page (2026-11-20, desktop): one compact header
 * (identity band + settlement · overall · EMI strip + actions) above Overview / Linked EMIs / Transactions / Details tabs.
 * UI only — the payment scenario reads the persisted documents back to prove the money path is unchanged.
 * Local emulator only — see tests/e2e-qa/README.md.
 */
import { scenario } from "../lib/core.mjs";
import * as f from "../lib/flows.mjs";
import * as h from "../lib/harness.mjs";

const tab = (page, name) => page.getByRole("tab", { name: new RegExp(`^${name}`) }).first();
const selected = async (page, name) => (await tab(page, name).getAttribute("aria-selected")) === "true";
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

scenario("ptabs-layout", "People: the person page opens on a compact header + Overview tab — balances and Record payment visible, no long stacked page", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  await f.openPerson(page, "QA Priya", { tab: null });
  const header = page.locator("main header").first();
  const box = await header.boundingBox();
  chk("desktop header is compact (≤ 180px tall)", box != null && box.height <= 180, `${Math.round(box?.height ?? 0)}px`);
  const htext = await f.flat(header);
  chk("header shows settlement, overall and EMI figures", /Settlement/i.test(htext) && /Overall with QA/i.test(htext) && /You need to receive/.test(htext) && /EMI shares/i.test(htext), htext.slice(0, 300));
  chk("one visible Record payment action on load", (await page.getByRole("button", { name: "Record payment" }).filter({ visible: true }).count()) === 1);
  chk("Add · Split · Share sit beside it", ["Add", "Split", "Share"].every(Boolean) && (await page.getByRole("button", { name: /^(Add|Split|Share)$/ }).filter({ visible: true }).count()) === 3);
  chk("four tabs, Overview selected", (await page.getByRole("tab").count()) === 4 && (await selected(page, "Overview")));
  const balanceDetails = page.getByTestId("person-overview-more");
  const emiDetails = page.getByTestId("person-overview-emis");
  chk("Balance breakdown and linked EMI preview start collapsed", (await balanceDetails.getAttribute("open")) === null && (await emiDetails.getAttribute("open")) === null);
  chk("Secondary figures stay out of the default view", !(await page.getByTestId("person-overview-cycle").isVisible()) && !(await page.getByTestId("linked-emi-snapshot").isVisible()));
  const open = page.getByTestId("open-items");
  const otext = (await open.count()) ? await f.flat(open) : "";
  chk("Open items lists the unpaid EMI with Paid and Pending columns and a Record receipt action", /QA Shared EMI|EMI/i.test(otext)
    && await open.getByRole("columnheader", { name: "Paid", exact: true }).isVisible()
    && await open.getByRole("columnheader", { name: "Pending", exact: true }).isVisible()
    && (await open.getByRole("button", { name: /^Record receipt/ }).count()) >= 1, otext.slice(0, 200));
  chk("no transaction table on the Overview tab", (await page.locator("tr[data-obligation-key]:visible").count()) === 0);
  chk("header shows the cycle ring", (await header.getByRole("progressbar", { name: /of this cycle settled/ }).count()) === 1);
  const main = await page.evaluate(() => { const m = document.querySelector("main"); return m ? { sh: m.scrollHeight, ch: m.clientHeight } : null; });
  chk("Overview fits in about one screen (≤ 1.6× viewport)", main != null && main.sh <= main.ch * 1.6, JSON.stringify(main));
  chk("no horizontal page overflow", (await overflowX(page)) <= 1);
  await h.shot(page, "ptabs-overview");

  await page.getByRole("button", { name: "Toggle theme" }).click();
  await page.locator("html.dark").waitFor();
  chk("Open items stay visible in dark mode", await open.isVisible());
  await h.shot(page, "ptabs-overview-dark");
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await page.locator("html:not(.dark)").waitFor();

  await emiDetails.locator("summary").click();
  const linked = page.getByTestId("linked-emi-snapshot");
  chk("Linked EMI disclosure opens the preview", await linked.isVisible());
  const btext = await f.flat(linked);
  chk("EMI preview shows the remaining balance, what is due now and later, and lender progress", /Remaining balance[\s|]+−₹3,000.*Due now[\s|]+₹1,000.*Due later[\s|]+₹2,000.*Paid to lender\s+0\/3/i.test(btext), btext.slice(0, 240));
  await emiDetails.locator("summary").click();

  await page.setViewportSize({ width: 390, height: 844 });
  const row = open.locator("tbody tr").first();
  chk("phone layout stacks open items and keeps both actions in view", await row.evaluate((tr) => {
    const rowRect = tr.getBoundingClientRect();
    const actions = [...tr.querySelectorAll("button")];
    return getComputedStyle(tr).display === "grid" && actions.length === 2 && actions.every((button) => {
      const rect = button.getBoundingClientRect();
      return rect.left >= rowRect.left && rect.right <= rowRect.right && rect.bottom <= window.innerHeight;
    });
  }));
  chk("no horizontal page overflow on a phone", (await overflowX(page)) <= 1);
  await h.shot(page, "ptabs-overview-mobile");

  await tab(page, "Linked EMIs").click();
  chk("EMI card fits the phone viewport", await page.getByTestId("linked-emi-card").first().evaluate((card) => {
    const rect = card.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= document.documentElement.clientWidth + 1;
  }));
  await h.shot(page, "ptabs-emis-mobile");
});

scenario("ptabs-switch", "People: tabs switch content (Linked EMIs cards + schedule, Transactions table + row expansion, Details) and survive a reload", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  await f.openPerson(page, "QA Priya", { tab: null });

  await tab(page, "Linked EMIs").click();
  await page.waitForTimeout(500);
  const card = page.getByTestId("linked-emi-card").first();
  await card.waitFor();
  const height = Math.round((await card.boundingBox()).height);
  chk("the collapsed desktop EMI card fits within 170px", height <= 170, `${height}px`);
  const ctext = await f.flat(card);
  chk("EMI card shows the share balance and timing separately from lender payments", /Share total/i.test(ctext) && /Paid toward share/i.test(ctext) && /Remaining balance/i.test(ctext) && /Due now/i.test(ctext) && /Paid to lender/i.test(ctext) && (await card.getByRole("progressbar").count()) === 1, ctext.slice(0, 240));
  chk("EMI card: settlement status line", /(owes|Up to date|Fully settled|postponed)/i.test(ctext), ctext.slice(0, 240));
  await h.shot(page, "ptabs-emis-compact");
  await card.getByRole("button", { name: "Schedule" }).click();
  await page.waitForTimeout(400);
  const schedule = card.getByRole("table", { name: /monthly schedule/ });
  chk("Schedule opens a table with dates, amounts and status", await schedule.isVisible()
    && (await schedule.getByRole("columnheader").allTextContents()).join("|") === "Due date|EMI share|Paid|Pending|Status");
  const statuses = card.getByTestId("linked-emi-schedule-status");
  chk("schedule identifies the person's repayment status", await statuses.count() > 0 && (await statuses.allTextContents()).every((status) => /Paid|Partially paid|Overdue|Pending|Upcoming|Postponed/.test(status)));
  await page.setViewportSize({ width: 390, height: 844 });
  chk("schedule tiles and amounts fit a phone screen", await schedule.locator("tbody tr").first().evaluate((row) =>
    getComputedStyle(row).display === "grid" && row.scrollWidth <= row.clientWidth));
  await page.setViewportSize({ width: 1280, height: 900 });
  await h.shot(page, "ptabs-emis");

  await tab(page, "Transactions").click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(600);
  const rows = page.locator("tr[data-obligation-key]:visible");
  chk("Transactions tab shows the ledger table", (await rows.count()) >= 1, String(await rows.count()));
  chk("desktop ledger separates signed cash flow from item amounts", await page.getByRole("columnheader", { name: "Cash flow" }).isVisible() && await page.getByRole("columnheader", { name: "Item amount" }).isVisible());
  chk("one filter offers the seven activity views", (await page.getByRole("combobox", { name: "Filter transactions" }).locator("option").count()) === 7);
  await page.getByRole("button", { name: "How balances are counted" }).click();
  chk("lender context is available before a reimbursement is recorded", await page.getByText("Lender payment", { exact: true }).isVisible());
  await page.getByRole("button", { name: "How balances are counted" }).click();
  await page.getByRole("searchbox", { name: "Search transactions" }).fill("unmatched-description");
  chk("a filtered ledger shows its result count", await page.getByRole("status").filter({ hasText: "0 matching entries" }).isVisible());
  await page.getByRole("button", { name: "Clear filters" }).click();
  chk("clearing filters restores the ledger rows", (await rows.count()) >= 1);
  chk("no '#' column", (await page.locator("th", { hasText: /^#$/ }).count()) === 0);
  await page.locator("tr[data-obligation-key]", { hasText: /EMI share/ }).first().locator("td").nth(1).click();
  await page.locator('[data-testid="row-expansion"]:visible').first().waitFor();
  chk("a row still expands to its compact panel", (await page.locator('[data-testid="row-expansion"]:visible').count()) === 1);
  await h.shot(page, "ptabs-transactions");

  await tab(page, "Details").click();
  await page.waitForTimeout(400);
  chk("Details tab shows the person details", await page.locator("#person-details").isVisible());
  chk("URL keeps ?tab=details", /[?&]tab=details/.test(page.url()), page.url());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: /^Details/ }).first().waitFor({ timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(800);
  chk("after reload the Details tab is still selected", (await page.getByRole("tab").count()) === 4 && (await selected(page, "Details")));
  await page.keyboard.press("Tab");
  await tab(page, "Details").focus();
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(300);
  chk("arrow keys move between tabs", await selected(page, "Transactions"));
});

scenario("ptabs-many-agreements", "People desktop: bounded overview, searchable agreement list, and one active schedule", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  await page.getByTestId("qa-seed-history-emi").click();
  await page.getByTestId("qa-seed-steps").getByText(/24-month shared EMI/).waitFor();
  const person = (await h.list("people")).find((p) => p.name === "QA Priya");
  const start = new Date();
  const end = new Date(start.getFullYear() + 1, start.getMonth(), start.getDate());
  await Promise.all(Array.from({ length: 7 }, (_, i) => h.createDocUnderUser(`emis/qa-unassigned-${i + 1}`, {
    name: `QA Linked ${i + 1}`,
    beneficiaryPersonId: person.id,
    beneficiaryRepaysInstallments: false,
    principalAmount: 12000,
    installmentCount: 12,
    installmentFrequency: "monthly",
    scheduleId: `qa-unassigned-schedule-${i + 1}`,
    startDate: start,
    endDate: end,
    createdAt: start,
    deletedAt: null,
  })));
  await f.openPerson(page, "QA Priya", { tab: null });
  const open = page.getByTestId("open-items");
  const rows = open.locator("tbody tr:visible");
  chk("desktop overview previews only four open items", (await rows.count()) === 4);
  await open.getByRole("button", { name: /^Show all/ }).click();
  chk("remaining open items can still be viewed", (await rows.count()) > 4);
  await open.getByRole("button", { name: "Show fewer items" }).click();

  await page.getByTestId("person-overview-emis").locator(":scope > summary").click();
  await page.getByTestId("linked-emi-snapshot").getByRole("button", { name: /QA 24-Month EMI/ }).click();
  const card = page.getByTestId("linked-emi-card");
  await card.getByRole("heading", { name: "QA 24-Month EMI", exact: true }).waitFor();
  const choices = page.getByTestId("linked-emi-choice");
  chk("the preview opens the selected agreement, with one detail card and six list rows", (await card.count()) === 1 && (await choices.count()) === 6);
  const next = page.getByRole("button", { name: "Next page" });
  await next.click();
  chk("the next page has the remaining three agreements", (await choices.count()) === 3);
  const search = page.getByRole("searchbox", { name: "Search linked agreements" });
  await search.fill("QA Linked 7");
  chk("search finds any agreement and preserves the Include in balance action", (await choices.count()) === 1 && await page.getByRole("button", { name: "Include in balance" }).isVisible());
  await search.fill("QA Shared EMI");
  await card.getByRole("heading", { name: "QA Shared EMI", exact: true }).waitFor();
  await card.getByRole("button", { name: "Schedule" }).click();
  chk("the selected agreement still opens its schedule", await card.getByRole("table", { name: /monthly schedule/ }).isVisible());
  await h.shot(page, "ptabs-many-agreements");
}, { viewport: { width: 1440, height: 900 } });

scenario("ptabs-actions", "People: header actions open their existing flows from any tab; the sticky bar carries Record payment once the header scrolls away", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  await f.openPerson(page, "QA Priya", { tab: null });
  await page.getByRole("button", { name: "Record payment" }).filter({ visible: true }).first().click();
  await page.getByText(/Amount received|Amount paid/).first().waitFor();
  chk("Record payment opens the payment sheet", true);
  await page.getByRole("button", { name: "Cancel", exact: true }).filter({ visible: true }).last().click();
  await page.waitForTimeout(800);
  await tab(page, "Transactions").click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("radiogroup", { name: "Transaction type" }).waitFor({ timeout: 30000 });
  chk("Add opens from the Transactions tab", true);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Split", exact: true }).first().click();
  await page.getByText(/Split expense/).first().waitFor({ timeout: 30000 });
  chk("Split opens", true);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  // Scroll the page so the header leaves the viewport — the sticky tab bar then carries name · balance · Record payment.
  await page.evaluate(() => { const m = document.querySelector("main"); if (m) m.scrollTop = 400; });
  await page.waitForTimeout(700);
  const bar = page.getByTestId("person-tab-bar");
  const barRecord = bar.getByRole("button", { name: "Record payment" });
  const visibleRecord = (await barRecord.count()) === 1 && (await barRecord.evaluate((b) => getComputedStyle(b).opacity)) === "1";
  const scrolled = await page.evaluate(() => document.querySelector("main")?.scrollTop ?? 0);
  chk("sticky bar shows Record payment once the header is gone (or the page is too short to scroll)", visibleRecord || scrolled < 200, `scrollTop=${scrolled}`);
  await h.shot(page, "ptabs-sticky");
});

scenario("ptabs-repayments", "People: a general payment shows under Repayments as 'Toward overall balance' — persisted money path unchanged", async ({ page }, chk) => {
  const bank0 = await f.bal("QA Bank");
  await f.openPerson(page, "QA Priya", { tab: null });
  await f.openRecord(page, { general: true });
  await f.amountField(page).fill("400");
  await f.pickAccountIn(page, "QA Bank");
  await page.getByRole("button", { name: /^Record ₹400/ }).first().click();
  await page.waitForTimeout(4500);
  chk("bank credited ₹400 once (persisted)", f.close2((await f.bal("QA Bank")) - bank0, 400), `${bank0} -> ${await f.bal("QA Bank")}`);
  await f.showPersonTab(page, "Overview");
  await page.getByTestId("person-overview-more").locator(":scope > summary").click();
  const rep = page.getByTestId("person-overview-repayments");
  const text = await f.flat(rep);
  chk("Repayments: received ₹400, all toward the overall balance", /Received from QA/.test(text) && /Toward overall balance/.test(text) && /₹400/.test(text), text.slice(0, 300));
  await f.showPersonTab(page, "Transactions");
  const journey = await f.flat(page.getByTestId("ledger-summary"));
  chk("Transactions summary: ₹400 toward the overall balance", /Toward overall balance\W+₹400/.test(journey), journey);
  chk("the signed cash-flow column shows the actual ₹400 receipt", await page.getByRole("cell", { name: "+₹400", exact: true }).first().isVisible());
  await f.showPersonTab(page, "Overview");
  await page.getByTestId("open-items").getByRole("button", { name: /^Record receipt/ }).first().click();
  await page.getByText(/Amount received|Amount paid/).first().waitFor();
  chk("Open items → Record receipt opens the payment sheet", true);
  await page.getByRole("button", { name: "Cancel", exact: true }).filter({ visible: true }).last().click();
  chk("Repayments: each payment listed with what it was applied to", /overall balance/i.test(text));
  await h.shot(page, "ptabs-repayments");
});

scenario("ptabs-money-trail", "People: posted money, repayments, cleared items, and lender status stay distinct", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  const person = (await h.list("people")).find((p) => p.name === "QA Priya");
  const bank = (await h.list("accounts")).find((a) => a.name === "QA Bank");
  const emi = (await h.list("emis")).find((row) => row.name === "QA Shared EMI");
  const schedule = `paymentSchedules/${emi.scheduleId}/installments`;
  const first = (await h.list(schedule)).find((i) => i.sequenceNumber === 1);
  const date = new Date();
  const originalLoan = "orig_people_history_loan";
  const agreement = (name, amount) => ({ name, personId: person.id, direction: "given", fundingSource: "person", loanAmount: amount, loanDate: date, createdAt: date, repaymentType: "oneTime", deletedAt: null });
  const funding = (amount, description) => ({ loanId: originalLoan, accountId: bank.id, type: "expense", status: "posted", paymentAllocationType: "additionalDisbursement", amount, description, dateTime: date, createdAt: date, deletedAt: null });
  const ledger = (type, amount, note, parentEntryId = null) => ({ personId: person.id, type, amount, note, parentEntryId, date, createdAt: date, deletedAt: null });
  await Promise.all([
    h.createDocUnderUser(`loans/${originalLoan}`, { ...agreement("QA Funded Loan", 2500), scheduleId: "qa-funded-schedule" }),
    h.createDocUnderUser("loans/qa-historical-agreement", { ...agreement("QA Agreement Only", 900), scheduleId: "qa-history-schedule" }),
    h.createDocUnderUser("transactions/orig_people_history_txn", funding(2000, "QA origin")),
    h.createDocUnderUser("transactions/qa-lend-more", funding(500, "QA Lent More")),
    h.createDocUnderUser(`people/${person.id}/ledger/qa-gave`, ledger("gave", 1000, "QA Manual Loan")),
    h.createDocUnderUser(`people/${person.id}/ledger/qa-got-back`, { ...ledger("receivedBack", 1000, "QA Repayment", "qa-gave"), recordedEarlier: true, receivedDateKnown: false }),
    h.patchNumber(`${schedule}/${first.id}`, "amountPaid", 3000).then((res) => { if (!res.ok) throw new Error(`Synthetic installment update failed: ${res.status}`); }),
  ]);

  await f.openPerson(page, "QA Priya");
  const summary = page.getByTestId("ledger-summary");
  const given = summary.locator('[data-stat="lent"]');
  const received = summary.locator('[data-stat="received-back"]');
  await summary.getByText("₹3,500", { exact: true }).waitFor();
  chk("the cycle counts posted funding and manual lending once", (await given.innerText()) === "₹3,500");
  chk("repayments count exactly once", (await received.innerText()) === "₹1,000");
  chk("an earlier repayment has a separate label in the totals", await summary.getByText("₹1,000 recorded earlier", { exact: true }).isVisible());
  const table = page.getByRole("table").filter({ visible: true });
  const emiRow = table.getByRole("row").filter({ hasText: /QA Shared EMI/ }).first();
  chk("a paid lender installment still shows the separate amount owed by the person", await emiRow.getByText("Bank paid", { exact: true }).isVisible() && await emiRow.getByText("₹1,000 to receive", { exact: true }).isVisible());
  const recordedOnly = table.getByRole("row").filter({ hasText: /QA Agreement Only/ }).first();
  chk("recorded-only principal is shown as an agreement amount", await recordedOnly.getByText(/Agreement amount/).isVisible() && await recordedOnly.getByText("Agreement recorded", { exact: true }).isVisible());

  const filter = page.getByRole("combobox", { name: "Filter transactions" });
  await filter.selectOption("settled");
  chk("cleared items show the settlement and what it applied to", await table.getByText("Cleared this item", { exact: true }).isVisible() && await table.getByText(/Applied to QA Manual Loan/).isVisible());
  chk("the date and account movement of the earlier repayment are labelled accurately", await table.getByText("Date not known", { exact: true }).isVisible() && await table.getByText(/Recorded earlier · no account change/).isVisible());
  await filter.selectOption("out");
  chk("money sent includes the loan's posted account and excludes agreement-only context", await table.getByText(/From QA Bank/).count() === 2 && !(await recordedOnly.isVisible()));
  await filter.selectOption("all");
  await page.getByRole("tab", { name: "All transactions", exact: true }).click();
  chk("all dates preserves the same posted funding and repayment totals", (await given.innerText()) === "₹3,500" && (await received.innerText()) === "₹1,000");
  await h.shot(page, "ptabs-money-trail");
}, { viewport: { width: 1440, height: 900 } });

scenario("ptabs-overview-more", "People: Overview shows the cycle arithmetic and opens balance details and payment history", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  await f.openPerson(page, "QA Priya", { tab: null });
  await f.openRecord(page, { general: true });
  await f.amountField(page).fill("400");
  await f.pickAccountIn(page, "QA Bank");
  await page.getByRole("button", { name: /^Record ₹400/ }).first().click();
  await page.waitForTimeout(4500);
  await f.showPersonTab(page, "Overview");
  const more = page.getByTestId("person-overview-more");
  chk("Balance details start closed", (await more.getAttribute("open")) === null);
  await more.locator(":scope > summary").click();
  const cycle = await f.flat(page.getByTestId("person-overview-cycle"));
  chk("cycle breakdown shows the signed changes and remaining amount", /Previous/.test(cycle) && /New this cycle\W+₹2,000/.test(cycle) && /Received\s*[| ]+−\s*₹400/.test(cycle) && /Remaining\W+To receive\W+₹1,600/.test(cycle), cycle.slice(0, 260));
  chk("general payment kept apart from item payments", /To specific items\W+₹0/.test(cycle) && /Toward overall balance\W+₹400/.test(cycle), cycle.slice(0, 300));
  const text = await f.flat(more);
  chk("Balance breakdown shows payment history and how the cycle is calculated", /Payment history/i.test(text) && /How this cycle is calculated/.test(text) && /overall balance/i.test(text), text.slice(0, 300));
  const calculation = page.getByTestId("person-cycle-calculation");
  chk("line-by-line calculation starts collapsed", (await calculation.getAttribute("open")) === null);
  await calculation.locator("summary").click();
  chk("calculation entries reveal their existing source labels", /QA team dinner|QA Shared EMI/.test(await f.flat(calculation)));
  await calculation.locator("summary").click();
  await h.shot(page, "ptabs-overview-more");
});
