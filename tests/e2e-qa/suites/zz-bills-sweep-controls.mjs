/**
 * Bills sweep, part 2 (testing-phase check): every control on the Bills page does what its label says and the tiles, balances
 * and statuses stay in step. Local emulator only. Part 1 (render / input validation) is zz-bills-sweep.mjs.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const IGNORED = /Select is changing|status of 400|React DevTools|Download the React/;
const flat = (s) => String(s).replace(/\s+/g, " ").trim();

async function openBills(page) {
  await h.go(page, "/bills");
  await page.getByRole("heading", { level: 1, name: "Bills" }).waitFor({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('main [class*="animate-pulse"]').length === 0, null, { timeout: 60000 });
  await page.waitForTimeout(1200);
}
const bills = async () => (await h.list("bills")).filter((b) => b.deletedAt == null);
const bal = async () => (await h.accountBalance("QA Bank")).currentBalance;
const elec = async () => (await bills()).find((b) => /QA Electricity/.test(b.name));
const tiles = async (page) => flat(await page.locator("main div.grid-cols-2.lg\\:grid-cols-4").first().innerText());

scenario("bills-sweep-dues", "Bills sweep: Card/Loan/EMI dues — filter tiles toggle, totals stay put, every row links to its own page", async ({ page, logs }, chk) => {
  await openBills(page);
  const section = page.locator("section", { has: page.getByRole("heading", { name: /Card, Loan & EMI Dues/ }) });
  const group = section.getByRole("group", { name: "Filter dues by type" });
  const total = () => section.locator("span.text-2xl").innerText().then(flat);
  const totalBefore = await total();
  const rows = () => section.locator("ul li a");
  const all = await rows().count();
  chk("dues rows are listed", all >= 1, all);
  chk("header says how many payments", new RegExp(`${all} payments?`).test(flat(await section.innerText())), flat(await section.innerText()).slice(0, 160));

  for (const [label, badge] of [["Loan Installments", "Loan"], ["EMI Installments", "EMI"], ["Credit Card Due", "Credit Card"]]) {
    const tile = group.getByRole("button", { name: new RegExp(label) });
    await tile.click();
    chk(`${label}: tile is pressed`, (await tile.getAttribute("aria-pressed")) === "true");
    const texts = await rows().evaluateAll((as) => as.map((a) => a.innerText));
    chk(`${label}: only ${badge} rows shown`, texts.every((t) => t.toLowerCase().includes(badge.toLowerCase())), texts.map((t) => t.split("\n")[0]).join(" | "));
    chk(`${label}: headline total unchanged by the filter`, (await total()) === totalBefore);
    await tile.click();
    chk(`${label}: second click clears the filter`, (await rows().count()) === all);
  }

  const hrefs = await rows().evaluateAll((as) => as.map((a) => ({ href: a.getAttribute("href"), text: a.innerText.split("\n")[0] })));
  for (const { href, text } of hrefs) {
    await openBills(page);
    await page.locator(`section ul li a[href="${href}"]`).first().click();
    await page.waitForFunction((p) => location.pathname.replace(/\/+$/, "") === p.split("?")[0], href, { timeout: 30000 }).catch(() => {});
    const here = await page.evaluate(() => location.pathname.replace(/\/+$/, "") + location.search);
    const want = href.split("?")[0].replace(/\/+$/, "");
    chk(`row "${text}" opens ${want}`, here.startsWith(want) && here.includes("agreement=") === href.includes("agreement="), here);
    await page.waitForTimeout(800);
  }
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("bills-sweep-controls", "Bills sweep: detail drawer — Skip/Un-skip, Edit (incl. refusal of bad input), Delete all do what they say and keep the tiles in step", async ({ page, logs }, chk) => {
  await openBills(page);
  chk("start: Upcoming 1, Paid 0, Overdue 0", /Upcoming 1/.test(await tiles(page)) && /Paid 0/.test(await tiles(page)) && /Overdue 0/.test(await tiles(page)), await tiles(page));

  await page.getByRole("button", { name: /QA Electricity/ }).first().click();
  const drawer = page.getByRole("dialog").filter({ hasText: "QA Electricity" }).first();
  await drawer.waitFor();
  const txt0 = flat(await drawer.innerText());
  chk("drawer shows Amount, Status, Remaining, Due Date, Recurrence, Account", ["Amount", "Status", "Remaining", "Due Date", "Recurrence", "Account"].every((l) => txt0.includes(l)), txt0.slice(0, 220));
  chk("drawer: Remaining equals Amount for an unpaid bill", (txt0.match(/₹1,500/g) ?? []).length >= 2, txt0.slice(0, 220));
  chk("Pay… Skip Edit Delete all enabled", (await Promise.all(["Pay…", "Skip", "Edit", "Delete"].map((n) => page.getByRole("button", { name: n, exact: true }).isEnabled()))).every(Boolean));

  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await page.waitForTimeout(1500);
  let occ = await h.list(`bills/${(await elec()).id}/occurrences`);
  chk("Skip: current cycle stored as skipped", occ.some((o) => o.isSkipped === true), JSON.stringify(occ.map((o) => o.isSkipped)));
  // A recurring bill's skipped cycle is settled and the page rolls on to the next cycle (documented; Un-skip itself is covered
  // by bills-safety-unskip with a one-time bill).
  const drawerAfter = flat(await page.getByRole("dialog").filter({ hasText: "QA Electricity" }).first().innerText());
  chk("Skip on a monthly bill: drawer rolls on to next month's cycle (Due Date 12 Dec), still payable", /Due Date 12 Dec/.test(drawerAfter) && (await page.getByRole("button", { name: "Pay…" }).isEnabled()), drawerAfter.slice(0, 200));
  chk("Skip on a monthly bill: Upcoming tile still 1 (this month's skipped cycle no longer counts)", /Upcoming 1/.test(await tiles(page)), await tiles(page));

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const edlg = page.getByRole("dialog", { name: /Edit QA Electricity/ });
  await edlg.waitFor();
  chk("Edit form is seeded: name, amount", (await edlg.getByPlaceholder("e.g. Electricity").inputValue()) === "QA Electricity" && Number(await edlg.getByPlaceholder("0.00").inputValue()) === 1500);
  const before = await elec();
  await edlg.getByPlaceholder("dd/mm/yyyy").fill("");
  await edlg.getByRole("button", { name: "Save Changes" }).click();
  await page.waitForTimeout(1200);
  const afterBadDate = await elec();
  chk("Edit with cleared due date: nothing written", afterBadDate.nextDueDate === before.nextDueDate && (afterBadDate.editHistory ?? []).length === (before.editHistory ?? []).length, `${before.nextDueDate} → ${afterBadDate.nextDueDate}`);
  chk("Edit with cleared due date: dialog stays open", await edlg.isVisible());
  await edlg.getByPlaceholder("dd/mm/yyyy").fill("");
  await edlg.getByPlaceholder("dd/mm/yyyy").fill(await page.evaluate((iso) => { const d = new Date(iso); return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`; }, before.nextDueDate));
  await edlg.getByPlaceholder("e.g. Electricity").fill("   ");
  await edlg.getByRole("button", { name: "Save Changes" }).click();
  await page.waitForTimeout(1200);
  chk("Edit with blank name: name unchanged in storage", (await elec()) !== undefined);
  chk("Edit with blank name: dialog stays open", await edlg.isVisible());
  await edlg.getByPlaceholder("e.g. Electricity").fill("QA Electricity");
  await edlg.getByPlaceholder("0.00").fill("1800");
  await edlg.getByPlaceholder("Optional notes").fill("sweep note");
  await edlg.getByRole("button", { name: "Save Changes" }).click();
  await edlg.waitFor({ state: "hidden", timeout: 15000 });
  await page.waitForTimeout(1500);
  const edited = await elec();
  chk("valid edit persisted (amount 1800, notes)", Number(edited.amount) === 1800 && edited.notes === "sweep note", JSON.stringify([edited.amount, edited.notes]));
  chk("valid edit did not move the due date", new Date(edited.nextDueDate).toDateString() === new Date(before.nextDueDate).toDateString(), `${before.nextDueDate} → ${edited.nextDueDate}`);

  await page.getByRole("button", { name: /QA Electricity/ }).first().click();
  chk("drawer shows the note", flat(await page.getByRole("dialog").filter({ hasText: "QA Electricity" }).first().innerText()).includes("sweep note"));
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const confirm = page.getByRole("alertdialog").or(page.getByRole("dialog", { name: /Delete QA Electricity/ })).first();
  await confirm.waitFor();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await page.waitForTimeout(600);
  chk("Delete → Cancel keeps the bill", (await bills()).some((b) => b.name === "QA Electricity"));
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await confirm.waitFor();
  await confirm.getByRole("button", { name: "Delete" }).click();
  await page.waitForTimeout(2000);
  chk("Delete → Delete soft-deletes the bill", !(await bills()).some((b) => b.name === "QA Electricity"));
  chk("deleted bill leaves the page; empty state shown", (await page.getByText("No bills yet").count()) === 1);
  chk("header count back to 0 bills", /0 bills/.test(flat(await page.locator("main").innerText())));
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});

scenario("bills-sweep-payments", "Bills sweep: pay from account, edit the payment, cancel it, record paid-earlier, cancel that — balances and statuses stay right", async ({ page, logs }, chk) => {
  await openBills(page);
  const b0 = await bal();
  const open = async () => { await page.getByRole("button", { name: /QA Electricity/ }).first().click(); await page.getByRole("button", { name: "Edit", exact: true }).waitFor(); };

  await open();
  await page.getByRole("button", { name: "Pay…" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay QA Electricity/ });
  await dlg.waitFor();
  chk("Pay is blocked until a method is chosen", await dlg.getByRole("button", { name: /Pay now/ }).isDisabled());
  await dlg.getByRole("button", { name: /Pay from my account now/ }).click();
  await dlg.getByRole("combobox").first().click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await dlg.locator('input[type="number"]').first().fill("2000");
  chk("amount above what is due is refused", (await dlg.getByRole("button", { name: /Pay now/ }).isDisabled()) && /Only/.test(flat(await dlg.innerText())));
  await dlg.locator('input[type="number"]').first().fill("500");
  const prev = flat(await dlg.innerText());
  chk("balance preview shows now / payment / after", /Balance now/.test(prev) && /Payment/.test(prev) && /Balance after/.test(prev), prev.slice(0, 260));
  await dlg.getByRole("button", { name: /Pay now/ }).click();
  await dlg.waitFor({ state: "hidden", timeout: 15000 });
  await page.waitForTimeout(1800);
  chk("pay ₹500: account debited by exactly 500", (await bal()) === b0 - 500, `${b0} → ${await bal()}`);
  chk("tiles: still Upcoming 1 (part-paid is not paid)", /Upcoming 1/.test(await tiles(page)) && /Paid 0/.test(await tiles(page)), await tiles(page));
  chk("card badge says Partially Paid", /Partially Paid/.test(flat(await page.getByRole("button", { name: /QA Electricity/ }).first().innerText())));

  await open();
  const hist = page.locator('section[aria-label="Payment history"]');
  chk("history lists one payment of ₹500 from QA Bank", /₹500/.test(flat(await hist.innerText())) && /QA Bank/.test(flat(await hist.innerText())), flat(await hist.innerText()).slice(0, 200));
  await hist.getByRole("button", { name: "Edit payment" }).click();
  const edlg = page.getByRole("dialog", { name: /Edit payment/ });
  await edlg.waitFor();
  await edlg.locator('input[type="number"]').first().fill("700");
  await edlg.getByRole("button", { name: "Save changes" }).click();
  await edlg.waitFor({ state: "hidden", timeout: 15000 });
  await page.waitForTimeout(1800);
  chk("edit payment 500 → 700: account is 700 below start (net, not stacked)", (await bal()) === b0 - 700, `${b0} → ${await bal()}`);

  await open();
  await page.locator('section[aria-label="Payment history"]').getByRole("button", { name: "Cancel payment" }).click();
  const cdlg = page.getByRole("dialog", { name: /Cancel payment/ });
  await cdlg.waitFor();
  chk("cancel dialog names a refund of ₹700", /700/.test(flat(await cdlg.innerText())) && /Refund/.test(flat(await cdlg.innerText())), flat(await cdlg.innerText()).slice(0, 240));
  await cdlg.getByRole("button", { name: "Keep payment" }).click();
  await page.waitForTimeout(600);
  chk("Keep payment: nothing refunded", (await bal()) === b0 - 700);
  // Keep payment closes only the confirmation; the bill drawer is still open behind it.
  await page.locator('section[aria-label="Payment history"]').getByRole("button", { name: "Cancel payment" }).click();
  await cdlg.waitFor();
  await cdlg.getByRole("button", { name: "Cancel payment" }).click();
  await page.waitForTimeout(2000);
  chk("cancel payment: account back to start balance", (await bal()) === b0, `${b0} → ${await bal()}`);

  await open();
  await page.getByRole("button", { name: "Pay…" }).click();
  await dlg.waitFor();
  await dlg.getByRole("button", { name: /Already paid earlier/ }).click();
  chk("earlier mode: primary button reads Record as paid", (await dlg.getByRole("button", { name: /Record as paid/ }).count()) === 1);
  await dlg.getByRole("button", { name: /Record as paid/ }).click();
  await dlg.waitFor({ state: "hidden", timeout: 15000 });
  await page.waitForTimeout(1800);
  chk("paid earlier: no balance change", (await bal()) === b0, `${b0} → ${await bal()}`);
  // A monthly bill's paid cycle is settled and the page rolls on to next month's cycle (documented roll-forward).
  chk("paid earlier: this month's due is cleared, next month's cycle is the one shown (Due This Month ₹0, Upcoming 1)", /Due This Month ₹0\b/.test(await tiles(page)) && /Upcoming 1/.test(await tiles(page)), await tiles(page));
  chk("card now shows next month's cycle (12 Dec), Upcoming", /12 Dec/.test(flat(await page.getByRole("button", { name: /QA Electricity/ }).first().innerText())) && /Upcoming/.test(flat(await page.getByRole("button", { name: /QA Electricity/ }).first().innerText())), flat(await page.getByRole("button", { name: /QA Electricity/ }).first().innerText()));
  await open();
  const hist2 = page.locator('section[aria-label="Payment history"]');
  await hist2.getByRole("button", { name: "Cancel payment" }).waitFor({ timeout: 15000 }); // history loads a moment after the drawer opens
  const h2 = flat(await hist2.innerText());
  chk("history lists the November cycle as Paid, already paid earlier, with Cancel but no Edit", /Cycle due 12 Nov 2026/.test(h2) && /Paid/.test(h2) && /Already paid earlier/.test(h2) && (await hist2.getByRole("button", { name: "Edit payment" }).count()) === 0 && (await hist2.getByRole("button", { name: "Cancel payment" }).count()) === 1, h2.slice(0, 220));
  await hist2.getByRole("button", { name: "Cancel payment" }).click();
  await cdlg.waitFor();
  chk("cancel dialog says no refund", /None/.test(flat(await cdlg.innerText())));
  await cdlg.getByRole("button", { name: "Cancel payment" }).click();
  await page.waitForTimeout(2000);
  chk("cancel earlier payment: balance still unchanged", (await bal()) === b0);
  chk("cancelled cycle is open again and counted once: Upcoming 2, Due This Month ₹1,500", /Upcoming 2/.test(await tiles(page)) && /Due This Month ₹1,500/.test(await tiles(page)), await tiles(page));
  await open();
  const payCycle = page.locator('section[aria-label="Payment history"]').getByRole("button", { name: /Pay this cycle/ });
  await payCycle.waitFor({ timeout: 15000 }).catch(() => {});
  chk("history offers 'Pay this cycle' for the reopened November cycle", (await payCycle.count()) === 1);
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});
