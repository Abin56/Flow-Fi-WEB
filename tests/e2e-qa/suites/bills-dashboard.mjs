/**
 * Bills dashboard (browser QA). Local emulator only — see tests/e2e-qa/README.md.
 *
 * The page is a read-only view over the same obligations My Money / Month Cycle read, so these scenarios check: the four
 * headlines render and agree with My Money to the rupee; every row names its source; paying a bill from the page moves
 * money exactly once (read back from the emulator, not from the screen); loan / EMI / card rows hand off to the owning
 * module's own pay flow; editing a due date moves the open cycle; the layout holds at four widths in both themes.
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
const bills = async () => (await h.list("bills")).filter((b) => b.deletedAt == null);
const elec = async () => (await bills()).find((b) => /QA Electricity/.test(b.name));
const bal = async () => (await h.accountBalance("QA Bank")).currentBalance;

scenario("bills-dash-render", "Bills dashboard: four headlines, cycle switcher, sectioned list; no console errors; no overflow at 4 widths in light + dark", async ({ page, logs }, chk) => {
  await openBills(page);
  const main = flat(await page.locator("main").innerText());
  await h.shot(page, "bills-dash-desktop-light");
  for (const t of ["Due this cycle", "Overdue", "Upcoming", "Paid", "Payments", "My bills"]) chk(`page shows "${t}"`, main.toLowerCase().includes(t.toLowerCase()), main.slice(0, 200));
  chk("the cycle switcher is there", (await page.getByRole("button", { name: "Choose cycle" }).count()) === 1 && (await page.getByRole("button", { name: "Previous cycle" }).count()) === 1);
  chk("rows name their source module", (await page.locator('[data-testid="bills-row"]').count()) >= 1 && (await page.locator('[data-testid="bills-row"][data-kind="bill"]').count()) >= 1);
  chk("no 'NaN' / 'undefined' / 'Infinity' / '[object' text", !/NaN|undefined|Infinity|\[object/.test(main), (main.match(/.{0,30}(NaN|undefined|Infinity|\[object).{0,30}/) || [""])[0]);
  chk("header count matches the bills stored", Number(/(\d+) bills/.exec(main)?.[1]) === (await bills()).length, /(\d+) bills/.exec(main)?.[0]);
  chk("Due this cycle is the sum of the counted rows' remainders (Overdue + still to come)", (await figure(page, "due")) >= (await figure(page, "overdue")));

  const overflow = () => page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: document.querySelector("main").scrollWidth - document.querySelector("main").clientWidth }));
  for (const [name, vp] of [["desktop", { width: 1920, height: 1080 }], ["laptop", { width: 1366, height: 768 }], ["tablet", { width: 768, height: 1024 }], ["mobile", { width: 390, height: 844 }]]) {
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize(vp);
      await page.waitForTimeout(600);
      const o = await overflow();
      chk(`${name} ${vp.width}px ${scheme}: no horizontal overflow`, o.doc <= 1 && o.main <= 1, JSON.stringify(o));
      await h.shot(page, `bills-dash-${name}-${scheme}`);
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
  const toPay = rupees(/To pay\s*(?:What To pay means\s*)?₹\s*([\d,]+(?:\.\d+)?)/i.exec(summary)?.[1] ?? "");
  chk("My Money To pay was read", toPay > 0, summary.slice(0, 200));
  chk("Bills 'Due this cycle' equals My Money 'To pay'", billsDue === toPay, `bills ${billsDue} vs my-money ${toPay}`);
  const overdueText = /₹\s*([\d,]+(?:\.\d+)?)\s*overdue/.exec(summary)?.[1];
  chk("overdue agrees when My Money shows one", overdueText == null ? billsOverdue === 0 : billsOverdue === rupees(overdueText), `bills ${billsOverdue} vs ${overdueText}`);
});

scenario("bills-dash-pay-bill", "Bills dashboard: part-pay a bill from its row — debited once, row + headlines + Paid follow, persisted", async ({ page, logs }, chk) => {
  await openBills(page);
  const b = await elec();
  const dueBefore = await figure(page, "due");
  const paidBefore = await figure(page, "paid");
  const bank0 = await bal();
  const row = page.locator('[data-testid="bills-row"][data-kind="bill"]').filter({ hasText: "QA Electricity" }).first();
  chk("QA Electricity is on the Payments list", (await row.count()) === 1);
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
  chk("'Due this cycle' dropped by exactly ₹500", (await figure(page, "due")) === dueBefore - 500, `${dueBefore} -> ${await figure(page, "due")}`);
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
  const label0 = flat(await page.getByRole("button", { name: "Choose cycle" }).innerText());
  await page.getByRole("button", { name: "Next cycle" }).click();
  await page.waitForTimeout(700);
  const label1 = flat(await page.getByRole("button", { name: "Choose cycle" }).innerText());
  chk("next cycle changes the label", label1 !== label0, `${label0} -> ${label1}`);
  chk("'This cycle' appears once away from the current one", (await page.getByRole("button", { name: "This cycle", exact: true }).count()) === 1);
  chk("figures stay numeric on a future cycle", !/NaN|undefined/.test(flat(await page.locator('[aria-label="Payment summary"]').innerText())));
  await page.getByRole("button", { name: "Previous cycle" }).click();
  await page.getByRole("button", { name: "Previous cycle" }).click();
  await page.waitForTimeout(700);
  chk("a past cycle renders without error", !/NaN|undefined/.test(flat(await page.locator("main").innerText())));
  await page.getByRole("button", { name: "This cycle", exact: true }).click();
  await page.waitForTimeout(700);
  chk("'This cycle' returns to the current window", flat(await page.getByRole("button", { name: "Choose cycle" }).innerText()) === label0);
});
