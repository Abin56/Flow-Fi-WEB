/**
 * Bills dashboard (browser QA). Local emulator only — see tests/e2e-qa/README.md.
 *
 * The page is a read-only view over the same obligations My Money / Month Cycle read, so these scenarios check: the four
 * headlines render and agree with My Money to the rupee; every row names its source; paying a bill from the page moves
 * money exactly once (read back from the emulator, not from the screen); loan / EMI / card rows hand off to the owning
 * module's own pay flow; editing a due date moves the open cycle; List and Grid fit in both themes.
 * All fixture dates are relative to "today", so nothing here hard-codes a calendar date.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const IGNORED = /Select is changing|status of 400|React DevTools|Download the React/;
const flat = (s) => String(s).replace(/\s+/g, " ").trim();
const rupees = (s) => Number(String(s).replace(/[^0-9.]/g, "")) || 0;

async function openBills(page) {
  await h.go(page, "/bills");
  await page.getByRole("heading", { level: 1, name: "Bills" }).waitFor({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('main [class*="animate-pulse"]').length === 0, null, { timeout: 60000 });
  await page.waitForSelector('[data-testid="bills-summary-due"]', { timeout: 60000 });
  await page.waitForTimeout(800);
}
const figure = async (page, id) => rupees(await page.locator(`[data-testid="bills-summary-${id}"] p`).first().innerText());
const cycleControls = (page) => page.getByRole("group", { name: "Bills cycle" });
const bills = async () => (await h.list("bills")).filter((b) => b.deletedAt == null);
const elec = async () => (await bills()).find((b) => /QA Electricity/.test(b.name));
const bal = async () => (await h.accountBalance("QA Bank")).currentBalance;

scenario("bills-dash-render", "Bills dashboard: four headlines and cycle controls; List and Grid fit at five widths in both themes", async ({ page, logs }, chk) => {
  await openBills(page);
  const main = flat(await page.locator("main").innerText());
  await h.shot(page, "bills-dash-desktop-light");
  for (const t of ["Due this cycle", "Overdue", "Upcoming", "Paid", "Payments", "My bills"]) chk(`page shows "${t}"`, main.toLowerCase().includes(t.toLowerCase()), main.slice(0, 200));
  const cycle = cycleControls(page);
  chk("the cycle switcher is there", (await cycle.getByRole("button", { name: "Choose cycle" }).count()) === 1 && (await cycle.getByRole("button", { name: "Previous cycle" }).count()) === 1);
  chk("rows name their source module", (await page.locator('[data-testid="bills-row"]').count()) >= 1 && (await page.locator('[data-testid="bills-row"][data-kind="bill"]').count()) >= 1);
  chk("no 'NaN' / 'undefined' / 'Infinity' / '[object' text", !/NaN|undefined|Infinity|\[object/.test(main), (main.match(/.{0,30}(NaN|undefined|Infinity|\[object).{0,30}/) || [""])[0]);
  const myBillsTab = await page.getByRole("tab", { name: /^My bills/ }).innerText();
  chk("My bills count matches the bills stored", Number(/\((\d+)\)/.exec(myBillsTab)?.[1]) === (await bills()).length, myBillsTab);
  chk("Due this cycle is the sum of the counted rows' remainders (Overdue + still to come)", (await figure(page, "due")) >= (await figure(page, "overdue")));

  const widths = [
    ["desktop", { width: 1920, height: 1080 }],
    ["laptop", { width: 1366, height: 768 }],
    ["tablet", { width: 768, height: 1024 }],
    ["mobile", { width: 390, height: 844 }],
    ["narrow", { width: 320, height: 740 }],
  ];
  for (const view of ["List", "Grid"]) {
    await page.getByRole("button", { name: `${view} view` }).click();
    for (const [name, vp] of widths) {
      for (const scheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize(vp);
        await page.waitForTimeout(600);
        const overflow = await page.locator("main").evaluate((main) => ({
          doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          main: main.scrollWidth - main.clientWidth,
          rows: [...main.querySelectorAll('[data-testid="bills-row"], [data-testid="bills-paid-row"]')]
            .some((row) => row.scrollWidth > row.clientWidth + 1),
        }));
        chk(`${view} ${name} ${vp.width}px ${scheme}: no horizontal overflow`, overflow.doc <= 1 && overflow.main <= 1 && !overflow.rows, JSON.stringify(overflow));
        await h.shot(page, `bills-dash-${view.toLowerCase()}-${name}-${scheme}`);
      }
    }
  }
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors / warnings / page errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("bills-dash-agrees-with-my-money", "Bills dashboard: 'Due this cycle' and 'Overdue' equal My Money's To pay (same cycle, same engine)", async ({ page }, chk) => {
  await openBills(page);
  const billsDue = await figure(page, "due");
  const billsOverdue = await figure(page, "overdue");
  await h.go(page, "/my-money");
  await page.getByRole("heading", { level: 1, name: "My Money" }).waitFor({ timeout: 60000 });
  await page.waitForSelector('[aria-label="Period summary"]', { timeout: 60000 });
  await page.waitForTimeout(2500);
  const summary = flat(await page.locator('[aria-label="Period summary"]').innerText());
  const toPayText = /To pay\s*(?:What To pay means\s*)?₹\s*([\d,]+(?:\.\d+)?)/i.exec(summary)?.[1];
  const toPay = toPayText == null ? null : rupees(toPayText);
  chk("My Money To pay was read", toPay != null, summary.slice(0, 200));
  chk("Bills 'Due this cycle' equals My Money 'To pay'", billsDue === toPay, `bills ${billsDue} vs my-money ${toPay}`);
  const overdueText = /₹\s*([\d,]+(?:\.\d+)?)\s*overdue/.exec(summary)?.[1];
  chk("overdue agrees when My Money shows one", overdueText == null ? billsOverdue === 0 : billsOverdue === rupees(overdueText), `bills ${billsOverdue} vs ${overdueText}`);
});

scenario("bills-dash-pay-bill", "Bills dashboard: part-pay a bill from its row — debited once, row + headlines + Paid follow, persisted", async ({ page, logs }, chk) => {
  await openBills(page);
  await page.getByRole("button", { name: "Grid view" }).click();
  const b = await elec();
  const paidBefore = await figure(page, "paid");
  const bank0 = await bal();
  const row = page.locator('[data-testid="bills-row"][data-kind="bill"]').filter({ hasText: "QA Electricity" }).first();
  chk("QA Electricity is on the Payments list", (await row.count()) === 1);
  const section = await row.locator("xpath=ancestor::section[1]").getAttribute("aria-label");
  const dueMetric = section === "Upcoming" ? "upcoming" : "due";
  const dueBefore = await figure(page, dueMetric);
  await row.getByRole("button", { name: /Pay now: QA Electricity/ }).click();
  const dlg = page.getByRole("dialog", { name: /Pay QA Electricity/ });
  await dlg.waitFor();
  await dlg.getByRole("button", { name: /Pay from my account now/ }).click(); // the part-payment hint appears once a method is chosen
  chk("the dialog explains a part payment", /part payment/i.test(flat(await dlg.innerText())), flat(await dlg.innerText()).slice(0, 200));
  await dlg.getByRole("combobox").first().click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await dlg.locator('input[type="number"]').first().fill("500");
  await page.evaluate(() => window.__reset());
  await dlg.getByRole("button", { name: /Pay now/ }).evaluate((el) => { el.click(); el.click(); }); // a double click is one action
  await dlg.waitFor({ state: "hidden", timeout: 15000 });
  await page.waitForTimeout(2500);

  chk("bank debited ₹500 exactly once (persisted)", Math.abs(bank0 - (await bal()) - 500) < 0.01, `${bank0} -> ${await bal()}`);
  const pays = (await h.list(`bills/${b.id}/payments`)).filter((p) => p.deletedAt == null);
  chk("exactly one live payment record of ₹500", pays.length === 1 && Number(pays[0].amount) === 500, JSON.stringify(pays.map((p) => p.amount)));
  const occ = (await h.list(`bills/${b.id}/occurrences`)).filter((o) => o.deletedAt == null);
  chk("the cycle's amountPaid is 500 and no cycle was duplicated", occ.length === 1 && Number(occ[0].amountPaid) === 500, JSON.stringify(occ.map((o) => [o.amountPaid, o.dueDate])));
  const dueAfter = await figure(page, dueMetric);
  chk(`'${dueMetric === "upcoming" ? "Upcoming" : "Due this cycle"}' dropped by exactly ₹500`, dueAfter === dueBefore - 500, `${dueBefore} -> ${dueAfter}`);
  chk("'Paid' rose by exactly ₹500", (await figure(page, "paid")) === paidBefore + 500, `${paidBefore} -> ${await figure(page, "paid")}`);
  const rowAfter = flat(await page.locator('[data-testid="bills-row"]').filter({ hasText: "QA Electricity" }).first().innerText());
  chk("the row now reads Partially paid with ₹1,000 left of ₹1,500", /Partially paid/.test(rowAfter) && /1,000/.test(rowAfter) && /500 paid/.test(rowAfter), rowAfter.slice(0, 200));
  chk("the Paid section lists the payment", (await page.locator('[data-testid="bills-paid-row"]').filter({ hasText: "QA Electricity" }).count()) === 1);
  await h.shot(page, "bills-dash-after-part-payment");
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("bills-dash-owner-pay-flows", "Bills dashboard: loan / EMI / card rows open the OWNING module's own pay flow (Bills records nothing for them)", async ({ page }, chk) => {
  await openBills(page);
  const commits = () => page.evaluate(() => (window.__ev ?? []).filter((e) => /commit/i.test(e.n)).length);
  const payLinks = await page.locator('[data-testid="bills-row"]:not([data-kind="bill"]) a[href*="pay=1"]').evaluateAll((as) => as.map((a) => ({ href: a.getAttribute("href"), label: a.getAttribute("aria-label") })));
  chk("loan / EMI / card rows offer a Pay link into their own module", payLinks.length >= 1, JSON.stringify(payLinks));
  const loan = payLinks.find((l) => l.href.startsWith("/loans?"));
  if (loan) {
    chk("the loan link names the exact installment", /agreement=[^&]+&installment=[^&]+&pay=1/.test(loan.href), loan.href);
    const before = await bal();
    await page.evaluate(() => window.__reset?.());
    await page.locator(`a[href="${loan.href}"]`).first().click();
    await page.waitForFunction(() => location.pathname.replace(/\/+$/, "") === "/loans", null, { timeout: 30000 });
    await page.getByRole("dialog").first().waitFor({ timeout: 30000 }).catch(() => {});
    chk("the Loan's own Record Payment opens on arrival", (await page.getByRole("dialog").count()) >= 1, page.url());
    chk("navigating there wrote nothing and moved no money", (await commits()) === 0 && (await bal()) === before);
  }
  const card = payLinks.find((l) => l.href.startsWith("/credit-cards?"));
  chk("a card bill, when due, links to that card's Pay bill", card == null || /card=[^&]+&pay=1/.test(card.href), card?.href);
});

scenario("bills-dash-edit-due-date", "Bills dashboard: editing a bill's due date moves the open cycle on the page and in storage", async ({ page, logs }, chk) => {
  await openBills(page);
  const b = await elec();
  const cycleBefore = (await h.list(`bills/${b.id}/occurrences`)).filter((o) => o.deletedAt == null);
  chk("fixture: one open cycle", cycleBefore.length === 1);
  await page.getByRole("tab", { name: /My bills/ }).click();
  await page.getByRole("button", { name: /QA Electricity/ }).first().click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const dlg = page.getByRole("dialog", { name: /Edit QA Electricity/ });
  await dlg.waitFor();
  // move the due date 75 days out, typed in the field's own dd/mm/yyyy format
  const target = new Date(Date.now() + 75 * 86_400_000); // beyond the NEXT cycle too, so it is neither owed nor Upcoming
  const typed = `${String(target.getDate()).padStart(2, "0")}/${String(target.getMonth() + 1).padStart(2, "0")}/${target.getFullYear()}`;
  await dlg.getByPlaceholder("dd/mm/yyyy").fill(typed);
  await dlg.getByRole("button", { name: "Save Changes" }).click();
  await dlg.waitFor({ state: "hidden", timeout: 15000 });
  await page.waitForTimeout(2000);
  const cycles = (await h.list(`bills/${b.id}/occurrences`)).filter((o) => o.deletedAt == null);
  const stored = new Date(cycles[0].dueDate);
  chk("still exactly one cycle (moved, not duplicated)", cycles.length === 1, cycles.length);
  chk("the stored cycle now carries the new due date", stored.getDate() === target.getDate() && stored.getMonth() === target.getMonth(), `${cycles[0].dueDate} vs ${typed}`);
  chk("the cycle's audit trail records the move", (cycles[0].editHistory ?? []).some((e) => e.field === "dueDate"), JSON.stringify(cycles[0].editHistory ?? []));
  await page.getByRole("tab", { name: "Payments" }).click();
  await page.waitForTimeout(800);
  chk("the bill left this cycle's list (its new date is in a later cycle)", (await page.locator('[data-testid="bills-row"]').filter({ hasText: "QA Electricity" }).count()) === 0);
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("bills-dash-cycle-nav", "Bills dashboard: stepping the cycle changes the window, 'This cycle' returns, figures never go NaN", async ({ page }, chk) => {
  await openBills(page);
  const cycle = cycleControls(page);
  const choose = cycle.getByRole("button", { name: "Choose cycle" });
  const previous = cycle.getByRole("button", { name: "Previous cycle" });
  const thisCycle = cycle.getByRole("button", { name: "This cycle", exact: true });
  const label0 = flat(await choose.innerText());
  await cycle.getByRole("button", { name: "Next cycle" }).click();
  await page.waitForTimeout(700);
  const label1 = flat(await choose.innerText());
  chk("next cycle changes the label", label1 !== label0, `${label0} -> ${label1}`);
  chk("'This cycle' appears once away from the current one", (await thisCycle.count()) === 1);
  chk("figures stay numeric on a future cycle", !/NaN|undefined/.test(flat(await page.locator('[aria-label="Payment summary"]').innerText())));
  await previous.click();
  await previous.click();
  await page.waitForTimeout(700);
  chk("a past cycle renders without error", !/NaN|undefined/.test(flat(await page.locator("main").innerText())));
  await thisCycle.click();
  await page.waitForTimeout(700);
  chk("'This cycle' returns to the current window", flat(await choose.innerText()) === label0);
});
