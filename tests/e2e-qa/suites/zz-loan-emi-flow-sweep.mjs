/**
 * Loan & EMI flow sweep (testing-phase check) — the CURRENT inline UI (a record opens its own `/loans/<id>/` page; Pay,
 * Edit and Receive-more open as forms inside that page, not as dialogs). Every scenario drives the real screen and then
 * reads the stored loans / installments / transactions / account balances back from the emulator, so each check proves
 * that the money, the schedule, the header figures, the list and the summary agree. Local emulator only.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const round2 = (v) => Math.round(v * 100) / 100;
const num = (s) => Number(String(s).replace(/[^0-9.\-]/g, "")) || 0;
const flat = (s) => String(s).replace(/\s+/g, " ").trim();
const share = (i) => i.principalPortion ?? i.amountDue;
const LIST_BTN = 'section[aria-label="Loans and EMIs"] [role="button"]';

async function state(collection, name) {
  const rec = (await h.list(collection)).find((r) => (r.name ?? r.institutionName) === name && !r.deletedAt);
  const insts = (await h.list(`paymentSchedules/${rec.scheduleId}/installments`)).filter((i) => !i.deletedAt).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const principalPaid = insts.reduce((a, i) => a + (i.amountPaid > 0 ? share(i) * Math.min(1, i.amountPaid / i.amountDue) : 0), 0);
  const total = collection === "loans" ? rec.loanAmount : insts.reduce((a, i) => a + share(i), 0);
  return { rec, insts, outstanding: round2(total - principalPaid), paidCount: insts.filter((i) => i.amountPaid >= i.amountDue - 0.005).length };
}
const txCount = async () => (await h.list("transactions")).filter((t) => !t.deletedAt).length;
const bank = async (n = "QA Bank") => (await h.accountBalance(n)).currentBalance;
async function until(fn, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
}
async function listSummary(page) {
  await h.go(page, "/loans");
  await page.getByText("Next payment").first().waitFor({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('main [class*="animate-pulse"]').length === 0, null, { timeout: 60000 });
  await page.waitForTimeout(1800);
  const t = flat(await page.locator('section[aria-label="Summary"]').innerText());
  const cards = await page.locator(LIST_BTN).evaluateAll((els) => els.map((el) => ({ name: el.querySelector("h3")?.innerText.trim() ?? "", text: el.innerText.replace(/\s+/g, " ") })));
  return { total: num(/TOTAL OUTSTANDING\s*(₹[\d,.]+)/i.exec(t)?.[1] ?? ""), cards };
}
async function openRecord(page, name) {
  await h.go(page, "/loans");
  await page.locator('[role="button"]', { hasText: name }).first().click();
  await page.waitForFunction(() => /^\/loans\/[^/]+\/?$/.test(location.pathname) && !location.pathname.startsWith("/loans/_"), null, { timeout: 60000 });
  await page.getByRole("button", { name: "Record Payment" }).first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(800);
}
async function headerOutstanding(page) {
  const t = flat(await page.locator("main").first().innerText());
  return num(/OUTSTANDING\s*(₹[\d,.]+)/i.exec(t)?.[1] ?? "");
}
async function startPay(page, account) {
  await page.getByRole("button", { name: "Record Payment" }).first().click();
  const pay = page.getByRole("button", { name: /^Pay ₹[\d,.]+ to lender$/ });
  await pay.waitFor({ timeout: 30000 });
  if (account) {
    await page.getByRole("combobox", { name: /Paid from/ }).first().click();
    await page.getByRole("option", { name: new RegExp(account) }).click();
  }
  return pay;
}
const ctx = { viewport: { width: 1440, height: 900 }, scheme: "light" };

scenario("lef-loan-full", "Loan & EMI flow: a full loan installment moves the money once and every figure agrees (header, list, summary, history, schedule); Mark as unpaid restores all of it", async ({ page, logs }, chk, notes) => {
  const before = await state("loans", "QA Loan 12");
  const bankBefore = await bank();
  const txBefore = await txCount();
  const sumBefore = await listSummary(page);
  const next = before.insts.find((i) => !(i.amountPaid >= i.amountDue - 0.005));
  chk("precondition: header outstanding rule — stored outstanding is loan amount minus principal paid", before.outstanding > 0 && before.paidCount === 1, `${before.outstanding}, paid ${before.paidCount}`);

  await openRecord(page, "QA Loan 12");
  chk("header outstanding matches the stored figure (before)", Math.abs((await headerOutstanding(page)) - before.outstanding) <= 1, `${await headerOutstanding(page)} vs ${before.outstanding}`);
  const pay = await startPay(page, "QA Bank");
  chk("the pay button names the exact installment balance", Math.abs(num(await pay.innerText()) - next.amountDue) < 0.011, `${await pay.innerText()} vs ${next.amountDue}`);
  await pay.evaluate((b) => b.click());
  const ok = await until(async () => Math.abs(bankBefore - (await bank()) - next.amountDue) < 0.02);
  chk("the bank is debited by exactly the installment (persisted)", !!ok, `${bankBefore} -> ${await bank()}`);
  await page.waitForTimeout(2500);

  const after = await state("loans", "QA Loan 12");
  const paidInst = after.insts.find((i) => i.sequenceNumber === next.sequenceNumber);
  chk("that installment is stored as fully paid", paidInst.amountPaid >= paidInst.amountDue - 0.005, `${paidInst.amountPaid} / ${paidInst.amountDue}`);
  chk("only that installment changed", after.insts.filter((i) => i.amountPaid > 0).length === 2, `${after.insts.filter((i) => i.amountPaid > 0).length} paid`);
  chk("outstanding fell by exactly the principal portion", Math.abs(before.outstanding - after.outstanding - share(next)) < 0.02, `${before.outstanding} -> ${after.outstanding} (principal ${share(next)})`);
  chk("one transaction was created", (await txCount()) === txBefore + 1, `${txBefore} -> ${await txCount()}`);

  await openRecord(page, "QA Loan 12");
  chk("header outstanding follows the payment", Math.abs((await headerOutstanding(page)) - after.outstanding) <= 1, `${await headerOutstanding(page)} vs ${after.outstanding}`);
  const t = flat(await page.locator("main").first().innerText());
  chk("header progress says 2 of 12 paid", /2 of 12 paid/.test(t), (/\d+ of 12 paid/.exec(t) ?? [""])[0]);
  chk("Payment history lists the new payment (count 2)", (await page.getByRole("tab", { name: /Payment history\s*2/ }).count()) === 1, flat(await page.getByRole("tab", { name: /Payment history/ }).innerText()));
  const sumAfter = await listSummary(page);
  chk("summary total outstanding fell by the principal portion (±₹1 display rounding)", Math.abs(sumBefore.total - sumAfter.total - share(next)) <= 1.01, `${sumBefore.total} -> ${sumAfter.total} (principal ${share(next)})`);
  chk("the list card shows 2 of 12", /2 of 12/.test(sumAfter.cards.find((c) => c.name === "QA Loan 12")?.text ?? ""), (sumAfter.cards.find((c) => c.name === "QA Loan 12")?.text ?? "").slice(0, 140));
  await h.shot(page, "lef-loan-full-after");

  // ── Mark as unpaid: everything must come back ──
  await openRecord(page, "QA Loan 12");
  await page.getByRole("tab", { name: /Payment history/ }).click();
  await page.getByRole("button", { name: /view payment/i }).first().click();
  const layer = page.locator("[data-stack-layer]");
  await layer.getByRole("button", { name: "Mark as unpaid", exact: true }).click();
  await layer.getByRole("heading", { name: "Mark as unpaid?" }).waitFor({ timeout: 30000 });
  await layer.getByRole("button", { name: "Mark as unpaid", exact: true }).last().click();
  const restored = await until(async () => Math.abs((await bank()) - bankBefore) < 0.02, 40000);
  chk("Mark as unpaid gives the money back to the account (persisted)", !!restored, `${bankBefore} vs ${await bank()}`);
  await page.waitForTimeout(2500);
  const undone = await state("loans", "QA Loan 12");
  chk("the schedule is back to 1 paid and the outstanding is restored", undone.paidCount === 1 && Math.abs(undone.outstanding - before.outstanding) < 0.02, `paid ${undone.paidCount}, outstanding ${undone.outstanding} vs ${before.outstanding}`);
  chk("the transaction count is restored (no leftover or duplicate)", (await txCount()) === txBefore, `${txBefore} vs ${await txCount()}`);
  const sumUndone = await listSummary(page);
  chk("summary total is restored", Math.abs(sumUndone.total - sumBefore.total) <= 1.01, `${sumBefore.total} vs ${sumUndone.total}`);
  chk("no console errors / page errors", logs.filter((l) => !/Select is changing|status of 400|React DevTools/.test(l)).length === 0, logs.slice(0, 2).join(" | "));
}, ctx);

scenario("lef-loan-part", "Loan & EMI flow: a ₹2,000 part payment debits exactly ₹2,000, leaves the installment part-paid, and reduces the outstanding by its principal share", async ({ page }, chk) => {
  const before = await state("loans", "QA Loan 12");
  const bankBefore = await bank();
  const next = before.insts.find((i) => !(i.amountPaid >= i.amountDue - 0.005));
  await openRecord(page, "QA Loan 12");
  await startPay(page, "QA Bank");
  await page.getByTestId("other-ways-toggle").click();
  await page.getByRole("radio", { name: /Part payment/ }).click();
  await page.locator('main input[type="number"]:visible').first().fill("2000");
  await page.waitForTimeout(500);
  const btn = page.getByRole("button", { name: /^Pay ₹/ }).last();
  chk("the primary action reflects the part amount", /2,000/.test(await btn.innerText()), await btn.innerText());
  await btn.evaluate((b) => b.click());
  chk("the bank is debited exactly ₹2,000 (persisted)", !!(await until(async () => Math.abs(bankBefore - (await bank()) - 2000) < 0.011)), `${bankBefore} -> ${await bank()}`);
  await page.waitForTimeout(2500);
  const after = await state("loans", "QA Loan 12");
  const inst = after.insts.find((i) => i.sequenceNumber === next.sequenceNumber);
  chk("the installment shows ₹2,000 paid and is still open", Math.abs(inst.amountPaid - 2000) < 0.011 && inst.amountPaid < inst.amountDue, `${inst.amountPaid} / ${inst.amountDue}`);
  const expected = share(next) * (2000 / next.amountDue);
  chk("outstanding fell by the matching principal share", Math.abs(before.outstanding - after.outstanding - expected) < 0.05, `${before.outstanding} -> ${after.outstanding}, expected -${round2(expected)}`);
  chk("paid count is unchanged (part payment does not complete an installment)", after.paidCount === before.paidCount, `${before.paidCount} -> ${after.paidCount}`);
}, ctx);

scenario("lef-loan-double-click", "Loan & EMI flow: rapid repeated Pay clicks record one payment", async ({ page }, chk) => {
  const bankBefore = await bank();
  const txBefore = await txCount();
  const before = await state("loans", "QA Loan 12");
  const next = before.insts.find((i) => !(i.amountPaid >= i.amountDue - 0.005));
  await openRecord(page, "QA Loan 12");
  const pay = await startPay(page, "QA Bank");
  await pay.evaluate((b) => { b.click(); b.click(); b.click(); });
  await page.keyboard.press("Enter").catch(() => {});
  await page.waitForTimeout(6000);
  chk("the bank is debited once, not 2x / 3x", Math.abs(bankBefore - (await bank()) - next.amountDue) < 0.02, `${bankBefore} -> ${await bank()}`);
  chk("exactly one transaction", (await txCount()) === txBefore + 1, `${txBefore} -> ${await txCount()}`);
}, ctx);

scenario("lef-loan-insufficient", "Loan & EMI flow: paying from an account that cannot cover the installment is blocked and writes nothing", async ({ page }, chk) => {
  const cashBefore = await bank("QA Cash");
  const txBefore = await txCount();
  await openRecord(page, "QA Loan 12");
  const pay = await startPay(page, "QA Cash");
  await page.waitForTimeout(600);
  const text = flat(await page.locator("main").first().innerText());
  chk("the user is warned the account is short", /not enough|insufficient|short|exceeds|enough/i.test(text), (/[^.]*(not enough|insufficient|short|exceeds)[^.]*/i.exec(text) ?? ["no warning text"])[0].slice(0, 120));
  chk("the Pay button is disabled", await pay.isDisabled(), String(await pay.isDisabled()));
  await pay.click({ force: true, timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(1500);
  chk("nothing was written (cash and transactions unchanged)", (await bank("QA Cash")) === cashBefore && (await txCount()) === txBefore, `${cashBefore} vs ${await bank("QA Cash")}, tx ${txBefore} vs ${await txCount()}`);
}, ctx);

scenario("lef-emi-pay", "Loan & EMI flow: an EMI installment payment debits the account, completes that installment, and the EMI's header, list card and summary follow", async ({ page, logs }, chk) => {
  const before = await state("emis", "QA Phone EMI");
  const bankBefore = await bank();
  const txBefore = await txCount();
  const sumBefore = await listSummary(page);
  const next = before.insts.find((i) => !(i.amountPaid >= i.amountDue - 0.005));
  await openRecord(page, "QA Phone EMI");
  const pay = await startPay(page, "QA Bank");
  chk("the pay button names the exact EMI installment", Math.abs(num(await pay.innerText()) - next.amountDue) < 0.011, `${await pay.innerText()} vs ${next.amountDue}`);
  await pay.evaluate((b) => b.click());
  chk("the bank is debited by exactly the EMI installment (persisted)", !!(await until(async () => Math.abs(bankBefore - (await bank()) - next.amountDue) < 0.02)), `${bankBefore} -> ${await bank()}`);
  await page.waitForTimeout(2500);
  const after = await state("emis", "QA Phone EMI");
  chk("that installment is fully paid and the paid count rose by one", after.paidCount === before.paidCount + 1, `${before.paidCount} -> ${after.paidCount}`);
  chk("outstanding fell by the installment's principal share", Math.abs(before.outstanding - after.outstanding - share(next)) < 0.02, `${before.outstanding} -> ${after.outstanding}`);
  chk("one transaction was created", (await txCount()) === txBefore + 1, `${txBefore} -> ${await txCount()}`);
  const sumAfter = await listSummary(page);
  chk("summary total outstanding fell by the principal share (±₹1)", Math.abs(sumBefore.total - sumAfter.total - share(next)) <= 1.01, `${sumBefore.total} -> ${sumAfter.total}`);
  const card = sumAfter.cards.find((c) => c.name === "QA Phone EMI")?.text ?? "";
  chk(`the list card shows ${after.paidCount} of ${after.insts.length} paid`, new RegExp(`${after.paidCount} of ${after.insts.length}`).test(card), card.slice(0, 160));
  await h.shot(page, "lef-emi-pay-after");
  chk("no console errors / page errors", logs.filter((l) => !/Select is changing|status of 400|React DevTools/.test(l)).length === 0, logs.slice(0, 2).join(" | "));
}, ctx);
