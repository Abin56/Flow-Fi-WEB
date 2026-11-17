/**
 * Browser QA scenarios (postpone-exact-date.mjs). Local emulator only — see tests/e2e-qa/README.md.
 * Postpone Collection on a person's EMI share is ONE panel: pick a cycle (its date is derived from the Month Cycle —
 * no date picker), optionally a custom date, and — revealed in the same panel — what happens to the bank EMI (Pay later /
 * Pay from my account / Already paid). Every claim is read back from the persisted documents: the deferral, the lender
 * installment, the bank balance, the transactions.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
import * as f from "../lib/flows.mjs";

const SHARED = "QA Shared EMI";
const two = (n) => String(n).padStart(2, "0");
/** `today + days`, as the date field shows it (dd/mm/yyyy) and as a Date. */
function inDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return { text: `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()}`, date: new Date(d.getFullYear(), d.getMonth(), d.getDate()) };
}
const sched = async () => JSON.stringify((await f.scheduleState("emi", SHARED)).map((i) => [i.seq, i.amountDue, i.amountPaid]));

export async function openShare(page) {
  await f.openPerson(page, "QA Priya");
  // The "Linked EMIs" card above the table also says "QA Shared EMI" — expand the TABLE row, not that card.
  await page.locator("tr", { hasText: /EMI share/ }).first().locator("td").nth(2).click();
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: /postpone payment/i }).first().click();
  const group = page.getByRole("group", { name: "Postpone payment" });
  await group.waitFor();
  return group;
}

export async function priyaDeferral() {
  const priya = (await h.list("people")).find((p) => p.name === "QA Priya");
  const docs = await h.list(`people/${priya.id}/paymentDeferrals`);
  return docs.find((d) => /emi-inst:/.test(d.obligationKey ?? ""));
}

scenario("pp-emi-keep-pending", "People: postpone Priya's EMI share by CYCLE (no date picker) and Pay later → cycle stored, bank + balance untouched", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  const bank0 = await f.bal("QA Bank");
  const before = await sched();
  const txBefore = (await h.list("transactions")).length;
  const group = await openShare(page);

  chk("the heading is short: '<person> · ₹ pending'", /QA Priya · ₹[\d,]+ pending/.test(await group.getByTestId("postpone-heading").innerText()));
  chk("there is NO date picker in the primary flow", (await group.getByLabel("Postpone until date").count()) === 0);
  const line = (await group.getByTestId("postpone-preview").innerText()).replace(/\s+/g, " ");
  chk("one line states the selected cycle and the date it is derived from", /Selected .+ Expected from \d\d \w{3}/.test(line), line);
  chk("no long explanatory paragraph is shown", !/will remain unpaid/i.test(await group.innerText()));
  chk("'What about this EMI?' is revealed in the SAME panel, 'Pay later' preselected", (await group.getByTestId("emi-handling-pending").getAttribute("aria-checked")) === "true" && /What about this EMI\?/.test(await group.innerText()));
  chk("the bank EMI shows its amount and due date", /₹3,000/.test(await group.getByTestId("emi-handling").innerText()));
  await h.shot(page, "pp-panel");
  await page.evaluate(() => window.__reset());
  await group.getByTestId("postpone-emi-confirm").click();
  await group.waitFor({ state: "hidden", timeout: 20000 });
  await page.waitForTimeout(1200);

  const d = await priyaDeferral();
  chk("the postponement is persisted (not just a toast)", d != null && d.state === "active", JSON.stringify(d)?.slice(0, 200));
  chk("a cycle was stored, with no custom date", d?.expected?.cycle?.start != null && d.expected.date == null, JSON.stringify(d?.expected));
  chk("the stored cycle is a FUTURE cycle", new Date(d.expected.cycle.start).getTime() > Date.now(), String(d?.expected?.cycle?.start));
  chk("the bank installment is untouched (not paid, same amount)", (await sched()) === before);
  chk("no money moved: the bank account is exactly as before", f.close2(await f.bal("QA Bank"), bank0), `${bank0} -> ${await f.bal("QA Bank")}`);
  chk("no transaction was created by postponing", (await h.list("transactions")).length === txBefore);
  const body = await page.locator("body").innerText();
  chk("the row shows it moved to the later cycle", /Moved to .* cycle/.test(body), (body.match(/Moved to[^\n]{0,30}/) ?? ["?"])[0]);
  return await h.timeline(page);
});

scenario("pp-emi-custom-date", "People: 'Custom date' is a secondary option — the exact day is stored and the Selected line follows it", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  const group = await openShare(page);
  await group.getByRole("button", { name: "Custom date" }).click();
  const until = inDays(10);
  await group.getByLabel("Postpone until date").fill(until.text);
  await page.waitForTimeout(400);
  const line = (await group.getByTestId("postpone-preview").innerText()).replace(/\s+/g, " ");
  chk("the Selected line reads 'Custom date · Expected on <day>'", /Custom date/.test(line) && /Expected on/.test(line), line);
  await group.getByTestId("postpone-emi-confirm").click();
  await group.waitFor({ state: "hidden", timeout: 20000 });
  await page.waitForTimeout(1200);
  const d = await priyaDeferral();
  const stored = d?.expected?.date ? new Date(d.expected.date) : null;
  chk("the exact date is stored", stored != null && Math.abs(stored.getTime() - until.date.getTime()) < 36 * 3600 * 1000, `${d?.expected?.date} vs ${until.date.toISOString()}`);
  return await h.timeline(page);
});

scenario("pp-emi-pay-in-sheet", "People: 'Pay from my account' stays INSIDE the panel (no second dialog) — balance, EMI, balance after; postpones then pays the bank EMI exactly once", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  const bank0 = await f.bal("QA Bank");
  const txBefore = (await h.list("transactions")).length;
  const group = await openShare(page);
  await group.getByTestId("emi-handling-payNow").click();
  const confirm = group.getByTestId("postpone-emi-confirm");
  chk("blocked until an account is chosen, and it says why", (await confirm.isDisabled()) && /Choose account/.test(await group.innerText()));
  await group.getByRole("combobox", { name: "Pay the EMI from account" }).click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await page.waitForTimeout(500);
  const summary = await group.getByTestId("payment-source-summary").innerText();
  chk("account balance, EMI amount and projected balance are shown inside the panel", /Balance/i.test(summary) && /₹3,000/.test(summary) && /After payment/i.test(summary), summary.replace(/\s+/g, " "));
  chk("the button states exactly what it will do", /Postpone & pay ₹3,000/.test(await confirm.innerText()), await confirm.innerText());
  await h.shot(page, "pp-pay-in-sheet");
  chk("no second dialog is open", (await page.getByRole("dialog").count()) === 0);
  await page.evaluate(() => window.__reset());
  await confirm.click();
  await group.waitFor({ state: "hidden", timeout: 25000 });
  await page.waitForTimeout(3000);

  chk("the postponement was saved", (await priyaDeferral())?.state === "active");
  chk("the bank EMI is paid once (persisted)", f.paidTotal(await f.scheduleState("emi", SHARED)) === 3000, await sched());
  chk("the bank was debited exactly ₹3,000 once (persisted)", f.close2(bank0 - (await f.bal("QA Bank")), 3000), `${bank0} -> ${await f.bal("QA Bank")}`);
  chk("exactly one transaction was created (no duplicate deduction)", (await h.list("transactions")).length - txBefore === 1, String((await h.list("transactions")).length - txBefore));
  return await h.timeline(page);
});

scenario("pp-emi-already-paid-in-sheet", "People: 'Already paid' inside the panel — recorded as a past payment, NO account movement, postponement saved", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  const bank0 = await f.bal("QA Bank");
  const countedBefore = (await h.list("transactions")).filter((t) => !t.deletedAt && String(t.excludeFromCalculations) !== "true").length;
  const group = await openShare(page);
  await group.getByTestId("emi-handling-paidEarlier").click();
  chk("date and 'don't know the date' are offered inside the panel", (await group.getByLabel("Date paid").count()) === 1 && /Don't know the date/i.test(await group.innerText()));
  chk("it says no balance changes", /No balance changes/.test(await group.getByTestId("emi-paid-fields").innerText()));
  await h.shot(page, "pp-already-paid");
  await page.evaluate(() => window.__reset());
  await group.getByTestId("postpone-emi-confirm").click();
  await group.waitFor({ state: "hidden", timeout: 25000 });
  await page.waitForTimeout(3000);
  chk("the postponement was saved", (await priyaDeferral())?.state === "active");
  chk("the installment is recorded paid (persisted)", f.paidTotal(await f.scheduleState("emi", SHARED)) > 0, await sched());
  chk("no account balance changed", f.close2(await f.bal("QA Bank"), bank0), `${bank0} -> ${await f.bal("QA Bank")}`);
  chk("no counted transaction was created", (await h.list("transactions")).filter((t) => !t.deletedAt && String(t.excludeFromCalculations) !== "true").length === countedBefore);
  return await h.timeline(page);
});

scenario("pp-emi-no-unrelated-link", "People: 'Already paid' never suggests an unrelated expense (QA groceries ₹850) — empty state, nothing linked, no link written", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  const group = await openShare(page);
  await group.getByTestId("emi-handling-paidEarlier").click();
  const picker = group.getByTestId("link-transaction");
  chk("the picker says there is no likely match", /no likely match/.test(await picker.innerText()), (await picker.innerText()).slice(0, 120));
  await picker.getByText(/Link a transaction you already recorded/).click();
  chk("it says nothing is linked and shows an empty state", /Not linked/.test(await picker.innerText()) && (await picker.getByTestId("link-empty").count()) === 1);
  chk("the unrelated expense is NOT listed or suggested", (await group.getByTestId("link-candidate").count()) === 0);
  chk("nothing is linked", (await group.getByTestId("linked-transaction").count()) === 0);
  await h.shot(page, "pp-no-unrelated-link");
  // Save without a link: no transaction gets a link marker.
  await page.evaluate(() => window.__reset());
  await group.getByTestId("postpone-emi-confirm").click();
  await group.waitFor({ state: "hidden", timeout: 25000 });
  await page.waitForTimeout(2500);
  const linkedTx = (await h.list("transactions")).filter((t) => t.earlierPaymentLink != null);
  chk("no transaction was linked to the EMI", linkedTx.length === 0, String(linkedTx.length));
  chk("the groceries expense is untouched", (await h.list("transactions")).some((t) => t.description === "QA groceries" && !t.deletedAt && t.earlierPaymentLink == null));
  return await h.timeline(page);
});

scenario("pp-emi-link-needs-confirmation", "People: an unrelated expense can be linked only by choosing it from 'other expenses' AND pressing 'Link this expense'; the link is persisted, no second deduction", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  const bank0 = await f.bal("QA Bank");
  const group = await openShare(page);
  await group.getByTestId("emi-handling-paidEarlier").click();
  const picker = group.getByTestId("link-transaction");
  await picker.getByText(/Link a transaction you already recorded/).click();
  await picker.getByTestId("link-show-others").click();
  chk("a warning says these only match by amount and date", /only match by amount and date/.test(await picker.innerText()));
  await picker.getByTestId("link-candidate").filter({ hasText: "QA groceries" }).click();
  const pending = await picker.getByTestId("link-pending").innerText();
  chk("details are shown to verify: name, amount, date, account", /QA groceries/.test(pending) && /₹850/.test(pending) && /QA Bank/.test(pending), pending.replace(/\s+/g, " "));
  chk("it warns that nothing mentions the EMI", /Nothing in this expense mentions the EMI/.test(pending));
  chk("picking alone linked nothing", (await group.getByTestId("linked-transaction").count()) === 0);
  await picker.getByTestId("link-confirm").click();
  chk("after confirming it shows as Linked", /Linked: QA groceries/.test(await group.getByTestId("linked-transaction").innerText()));
  await h.shot(page, "pp-link-confirmed");
  await page.evaluate(() => window.__reset());
  await group.getByTestId("postpone-emi-confirm").click();
  await group.waitFor({ state: "hidden", timeout: 25000 });
  await page.waitForTimeout(3000);
  const groceries = (await h.list("transactions")).find((t) => t.description === "QA groceries" && !t.deletedAt);
  chk("the link is persisted on the expense", groceries?.earlierPaymentLink != null, JSON.stringify(groceries?.earlierPaymentLink ?? null));
  chk("no second deduction: the bank balance is unchanged", f.close2(await f.bal("QA Bank"), bank0), `${bank0} -> ${await f.bal("QA Bank")}`);
  chk("the installment shows the linked amount as paid (₹850 part payment)", f.paidTotal(await f.scheduleState("emi", SHARED)) === 850, await sched());
  return await h.timeline(page);
});

scenario("pp-emi-postpone-again-cancel", "People: Postpone again moves the SAME deferral (no duplicate obligation); Cancel postponement removes it; no money moves", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  const bank0 = await f.bal("QA Bank");
  const before = await sched();
  let group = await openShare(page);
  await group.getByTestId("postpone-emi-confirm").click();
  await group.waitFor({ state: "hidden", timeout: 20000 });
  await page.waitForTimeout(1200);
  const first = await priyaDeferral();

  await page.getByRole("button", { name: /^Postpone again/ }).first().click();
  group = page.getByRole("group", { name: "Postpone payment" });
  await group.waitFor();
  const cards = group.getByRole("radiogroup", { name: "Expected cycle" });
  chk("the saved cycle is marked 'Current'", /Current/.test(await cards.innerText()));
  await cards.getByRole("radio").filter({ hasText: "Current" }).click();
  chk("choosing the current cycle again can't be confirmed (nothing would change)", await group.getByTestId("postpone-emi-confirm").isDisabled());
  await group.getByRole("radio", { name: /cycle$/ }).nth(1).click(); // the cycle after the first choice
  await group.getByTestId("postpone-emi-confirm").click();
  await group.waitFor({ state: "hidden", timeout: 20000 });
  await page.waitForTimeout(1500);
  const second = await priyaDeferral();
  const people = (await h.list("people")).find((p) => p.name === "QA Priya");
  const docs = (await h.list(`people/${people.id}/paymentDeferrals`)).filter((d) => /emi-inst:/.test(d.obligationKey ?? ""));
  chk("still ONE deferral document for the obligation (no duplicate)", docs.length === 1, String(docs.length));
  chk("its expected cycle moved later", new Date(second.expected.cycle.start).getTime() > new Date(first.expected.cycle.start).getTime(), `${first.expected.cycle.start} -> ${second.expected.cycle.start}`);

  await page.getByRole("button", { name: /^(Back to .* cycle|Cancel postponement)$/ }).first().click();
  await page.waitForTimeout(2000);
  const cancelBtn = page.getByRole("button", { name: /^Cancel postponement$/ }).first();
  if (await cancelBtn.isVisible().catch(() => false)) {
    await cancelBtn.click();
    await page.waitForTimeout(2000);
  }
  const last = await priyaDeferral();
  chk("after cancelling, no active postponement remains", last == null || last.state !== "active", JSON.stringify(last)?.slice(0, 160));
  chk("through every step no money moved and the schedule is unchanged", f.close2(await f.bal("QA Bank"), bank0) && (await sched()) === before);
  return await h.timeline(page);
});
