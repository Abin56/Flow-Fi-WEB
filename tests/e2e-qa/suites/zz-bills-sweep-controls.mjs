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
// The headline figures live on the Payments tab, the bill cards / drawer on My bills: read the figures, then come back.
const figs = async (page) => {
  await page.getByRole("tab", { name: "Payments" }).click();
  await page.waitForSelector('[data-testid="bills-summary-due"]');
  const read = async (id) => Number((await page.locator(`[data-testid="bills-summary-${id}"] p`).first().innerText()).replace(/[^0-9.]/g, "")) || 0;
  const f = { due: await read("due"), overdue: await read("overdue"), upcoming: await read("upcoming"), paid: await read("paid") };
  await h.openMyBills(page);
  return f;
};

scenario("bills-sweep-controls", "Bills sweep: detail drawer — Skip/Un-skip, Edit (incl. refusal of bad input), Delete all do what they say and keep the tiles in step", async ({ page, logs }, chk) => {
  await openBills(page);
  const f0 = await figs(page);
  chk("start: the page reads its figures (Due this cycle covers the bill)", f0.due >= 1500 && Number.isFinite(f0.paid), JSON.stringify(f0));

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
  const f1 = await figs(page);
  chk("Skip: the skipped cycle leaves Due this cycle and the next month cycle shows as Upcoming, each by exactly the bill amount", f1.due === f0.due - 1500 && f1.upcoming === f0.upcoming + 1500, JSON.stringify([f0, f1]));

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
  const g0 = await figs(page);
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
  const p1 = await figs(page);
  chk("figures: a part payment lowers Due this cycle and raises Paid by exactly that part", p1.due === g0.due - 500 && p1.paid === g0.paid + 500, JSON.stringify([g0, p1]));
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
  const p2 = await figs(page);
  chk("paid earlier: this cycle due is cleared by the bill amount and the next month cycle is Upcoming", p2.due === g0.due - 1500 && p2.upcoming === g0.upcoming + 1500 && p2.paid === g0.paid + 1500, JSON.stringify([g0, p2]));
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
  const p3 = await figs(page);
  chk("cancelled cycle is open again and counted once: Due this cycle is back to its start, next month cycle still Upcoming", p3.due === g0.due && p3.upcoming === g0.upcoming + 1500 && p3.paid === g0.paid, JSON.stringify([g0, p3]));
  await open();
  const payCycle = page.locator('section[aria-label="Payment history"]').getByRole("button", { name: /Pay this cycle/ });
  await payCycle.waitFor({ timeout: 15000 }).catch(() => {});
  chk("history offers 'Pay this cycle' for the reopened November cycle", (await payCycle.count()) === 1);
  const errs = logs.filter((l) => !IGNORED.test(l));
  chk("no console errors", errs.length === 0, errs.slice(0, 5).join(" || "));
});
