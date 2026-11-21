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
  chk("header is compact (≤ 230px tall)", box != null && box.height <= 230, `${Math.round(box?.height ?? 0)}px`);
  const htext = await f.flat(header);
  chk("header shows settlement, overall and EMI figures", /Settlement/i.test(htext) && /Overall with QA/i.test(htext) && /You need to receive/.test(htext) && /EMI shares/i.test(htext), htext.slice(0, 300));
  chk("one visible Record payment action on load", (await page.getByRole("button", { name: "Record payment" }).filter({ visible: true }).count()) === 1);
  chk("Add · Split · Share sit beside it", ["Add", "Split", "Share"].every(Boolean) && (await page.getByRole("button", { name: /^(Add|Split|Share)$/ }).filter({ visible: true }).count()) === 3);
  chk("four tabs, Overview selected", (await page.getByRole("tab").count()) === 4 && (await selected(page, "Overview")));
  chk("Overview cards: This cycle + Repayments", (await page.getByTestId("person-overview-cycle").count()) === 1 && (await page.getByTestId("person-overview-repayments").count()) === 1);
  const open = page.getByTestId("open-items");
  const otext = (await open.count()) ? await f.flat(open) : "";
  chk("Open items lists the unpaid EMI share with a Received action", /QA Shared EMI|EMI/i.test(otext) && (await open.getByRole("button", { name: /^Received/ }).count()) >= 1, otext.slice(0, 200));
  chk("no transaction table on the Overview tab", (await page.locator("tr[data-obligation-key]:visible").count()) === 0);
  const linked = await page.getByTestId("linked-emi-snapshot").count();
  chk("EMI responsibility board on the Overview", linked === 1);
  const btext = linked ? await f.flat(page.getByTestId("linked-emi-snapshot")) : "";
  chk("board names Repaid · Owed · Postponed · Later · Bank", ["Repaid", "Owed", "Postponed", "Later", "Bank"].every((w) => btext.toLowerCase().includes(w.toLowerCase())), btext.slice(0, 240));
  chk("header shows the cycle ring", (await header.getByRole("progressbar", { name: /of this cycle settled/ }).count()) === 1);
  const main = await page.evaluate(() => { const m = document.querySelector("main"); return m ? { sh: m.scrollHeight, ch: m.clientHeight } : null; });
  chk("Overview fits in about one screen (≤ 1.6× viewport)", main != null && main.sh <= main.ch * 1.6, JSON.stringify(main));
  chk("no horizontal page overflow", (await overflowX(page)) <= 1);
  await h.shot(page, "ptabs-overview");
});

scenario("ptabs-switch", "People: tabs switch content (Linked EMIs cards + schedule, Transactions table + row expansion, Details) and survive a reload", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  await f.openPerson(page, "QA Priya", { tab: null });

  await tab(page, "Linked EMIs").click();
  await page.waitForTimeout(500);
  const card = page.getByTestId("linked-emi-card").first();
  await card.waitFor();
  const ctext = await f.flat(card);
  chk("EMI card: Due now · Paid · Later + progress", /Due now/i.test(ctext) && /Paid/i.test(ctext) && /Later/i.test(ctext) && (await card.getByRole("progressbar").count()) === 1, ctext.slice(0, 240));
  chk("EMI card: settlement status line", /(owes|Up to date|Fully settled|postponed)/i.test(ctext), ctext.slice(0, 240));
  await card.getByRole("button", { name: "Schedule" }).click();
  await page.waitForTimeout(400);
  chk("Schedule opens the monthly list", (await card.getByRole("list", { name: /monthly schedule/ }).count()) === 1);
  await h.shot(page, "ptabs-emis");

  await tab(page, "Transactions").click();
  await page.waitForTimeout(600);
  const rows = page.locator("tr[data-obligation-key]:visible");
  chk("Transactions tab shows the ledger table", (await rows.count()) >= 1, String(await rows.count()));
  chk("quick lenses present", (await page.getByRole("group", { name: "Quick view" }).getByRole("button").count()) === 7);
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
  const rep = page.getByTestId("person-overview-repayments");
  const text = await f.flat(rep);
  chk("Repayments: received ₹400, all toward the overall balance", /Received from QA/.test(text) && /Toward overall balance/.test(text) && /₹400/.test(text), text.slice(0, 300));
  await f.showPersonTab(page, "Transactions");
  const journey = await f.flat(page.getByTestId("ledger-summary"));
  chk("Transactions summary: ₹400 toward the overall balance", /Toward overall balance\W+₹400/.test(journey), journey);
  await f.showPersonTab(page, "Overview");
  await page.getByTestId("open-items").getByRole("button", { name: /^Received/ }).first().click();
  await page.getByText(/Amount received|Amount paid/).first().waitFor();
  chk("Open items → Received opens the payment sheet", true);
  await page.getByRole("button", { name: "Cancel", exact: true }).filter({ visible: true }).last().click();
  chk("Repayments: each payment listed with what it was applied to", /overall balance/i.test(text));
  await h.shot(page, "ptabs-repayments");
});

scenario("ptabs-overview-more", "People: Overview 'More details' opens the all-time figures, each payment and the calculation; the cycle strip shows previous + new − received = remaining", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  await f.openPerson(page, "QA Priya", { tab: null });
  await f.openRecord(page, { general: true });
  await f.amountField(page).fill("400");
  await f.pickAccountIn(page, "QA Bank");
  await page.getByRole("button", { name: /^Record ₹400/ }).first().click();
  await page.waitForTimeout(4500);
  await f.showPersonTab(page, "Overview");
  const cycle = await f.flat(page.getByTestId("person-overview-cycle"));
  chk("cycle strip: Previous + New this cycle − Received = Remaining", /Previous/.test(cycle) && /New this cycle/.test(cycle) && /Received/.test(cycle) && /Remaining/.test(cycle) && /₹2,000/.test(cycle) && /₹400/.test(cycle) && /Remaining\W+₹1,600/.test(cycle), cycle.slice(0, 260));
  chk("general payment kept apart from item payments", /To specific items\W+₹0/.test(cycle) && /Toward overall balance\W+₹400/.test(cycle), cycle.slice(0, 300));
  const more = page.getByTestId("person-overview-more");
  chk("More details starts closed", (await more.getAttribute("open")) === null);
  await more.locator("summary").click();
  await page.waitForTimeout(500);
  const text = await f.flat(more);
  chk("More details: each payment + how it is calculated", /Each payment/.test(text) && /How this cycle is calculated/.test(text) && /overall balance/i.test(text), text.slice(0, 300));
  await h.shot(page, "ptabs-overview-more");
});
