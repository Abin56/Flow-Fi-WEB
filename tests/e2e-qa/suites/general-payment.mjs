/**
 * General payments, Credit Card "Pay the bill now anyway", and in-dialog EMI share postponement (2026-11-03):
 *  - People: Record payment opens on "Reduce the overall balance" — the money is tied to no item, the balance drops,
 *    no row reads paid / part paid, and the account moves once.
 *  - Credit card: a person's share of a bill charge is still owed → the bill can still be paid, explicitly; the share
 *    stays owed in People; the bill shows its total, what was paid and what is left.
 *  - Loan / EMI: "Not received yet" moves people's shares to a later cycle — no payment, no
 *    transaction, the lender schedule (amounts and due dates) untouched; a double click writes once.
 * Every action is asserted on both the browser and the persisted emulator data. Local emulator only.
 */
import { scenario } from "../lib/core.mjs";
import * as f from "../lib/flows.mjs";
import * as h from "../lib/harness.mjs";

const personId = async (name) => (await h.list("people")).find((p) => p.name === name).id;
const activeEntries = async (id) => (await h.list(`people/${id}/ledger`)).filter((e) => !e.deletedAt);
const ms = (v) => (v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : Number(v));

/* ───────────── People: general payment ───────────── */

const generalBody = async ({ page }, chk) => {
  const bank0 = await f.bal("QA Bank");
  const priya = await personId("QA Priya");
  const entries0 = await activeEntries(priya);
  await f.openPerson(page, "QA Priya");
  await f.openRecord(page, { general: true });
  const general = page.getByTestId("rp-mode-general");
  chk("Record payment opens on 'Reduce the overall balance'", (await general.getAttribute("aria-checked")) === "true");
  chk("no Full / Part / Skip rows by default", (await page.getByRole("list", { name: "Items to pay" }).count()) === 0);
  await f.amountField(page).fill("400");
  await f.pickAccountIn(page, "QA Bank");
  const summary = await f.flat(page.getByTestId("rp-general"));
  chk("summary: ₹1,000 outstanding · ₹400 now · ₹600 remaining", /₹1,000/.test(summary) && /₹400/.test(summary) && /₹600/.test(summary), summary);
  await h.shot(page, "gpay-people-form");
  const btn = page.getByRole("button", { name: /^Record ₹400/ }).first();
  await page.evaluate(() => window.__reset());
  await btn.evaluate((b) => { b.click(); b.click(); });
  await page.waitForTimeout(4500);
  const added = (await activeEntries(priya)).filter((e) => !entries0.some((x) => x.id === e.id));
  chk("bank credited exactly ₹400 once (persisted)", f.close2((await f.bal("QA Bank")) - bank0, 400), `${bank0} -> ${await f.bal("QA Bank")}`);
  chk(
    "ONE settlement entry, tied to no item (persisted)",
    added.length === 1 && added[0].type === "receivedBack" && added[0].amount === 400 && added[0].parentEntryId == null && (added[0].obligationRef ?? null) == null,
    JSON.stringify(added.map((e) => [e.type, e.amount, e.parentEntryId, e.obligationRef ?? null])),
  );
  chk("exactly one ₹400 receipt transaction (persisted)", (await f.txns((t) => t.type === "income" && t.amount === 400)).length === 1);
  const body = (await page.locator("body").innerText()).split("\n").join(" ");
  await h.shot(page, "gpay-people-after");
  chk("UI: ₹600 still owed overall", /₹600/.test(body), (body.match(/CURRENT PENDING[^A-Z]{0,20}/) ?? ["?"])[0]);
  chk("UI: the dinner share reads 'Part of balance' — not paid, not part paid", /Part of balance/.test(body) && !/Got ₹400/.test(body));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  chk("no horizontal page overflow", overflow <= 1, `${overflow}px`);
  return await h.timeline(page);
};
scenario("gpay-people-general", "People: ₹400 general payment from Priya (double-click) → one unlinked entry, bank +₹400 once, ₹600 owed overall", generalBody);
scenario("gpay-people-general-mobile-dark", "People: the same general payment on mobile 390×844, dark", generalBody, { viewport: { width: 390, height: 844 }, scheme: "dark" });

/* ───────────── Credit card: pay the bill while a person's share is still owed ───────────── */

scenario("gpay-card-pay-anyway", "Credit Card: Priya's ₹4,000 share of the bill is still owed → 'Pay the bill now anyway' pays ₹5,000 once; the share stays owed; bill shows total · paid · remaining", async ({ page }, chk) => {
  const priya = await personId("QA Priya");
  const card = (await h.list("accounts")).find((a) => a.name === "QA Credit Card");
  const purchase = (await f.txns((t) => t.description === "QA card purchase"))[0];
  const now = new Date();
  // Synthetic fixture: Priya owes ₹4,000 of the ₹12,000 card purchase (a share of a charge this bill is made of).
  await h.createDocUnderUser(`people/${priya}/ledger/qa-card-share`, {
    id: "qa-card-share", personId: priya, type: "gave", amount: 4000, date: now, note: "QA card purchase share", increasesBalance: true,
    transactionRef: purchase.id, parentEntryId: null, createdAt: now, receivedStatus: "yetToReceive", deletedAt: null, lastEditedAt: null, editHistory: [],
  });
  const ledger0 = JSON.stringify(await activeEntries(priya));
  const bank0 = await f.bal("QA Bank");
  const card0 = card.currentBalance;
  await h.go(page, "/credit-cards");
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /^Pay (bill|now)/ }).first().click();
  const dlg = page.getByRole("dialog").last();
  const anyway = dlg.getByTestId("gate-pay-anyway");
  await anyway.waitFor({ timeout: 30000 });
  const gateText = await f.flat(dlg.getByRole("region", { name: "People settlement" }));
  chk("the People card names Priya's ₹4,000 as still to come", /QA PRIYA/i.test(gateText) && /₹4,000/.test(gateText) && /pay the bill anyway/i.test(gateText), gateText.slice(0, 200));
  chk("'Pay the bill now anyway' is offered, not preselected", !(await anyway.getByRole("checkbox").isChecked()));
  chk("no Pay action until it is chosen", (await dlg.getByRole("button", { name: /^Pay ₹/ }).count()) === 0);
  // A partial ₹5,000 payment of the bill — so the bill shows total · paid · remaining afterwards.
  const amount = dlg.locator("input[inputmode='decimal'], input[inputmode='numeric']").first();
  await amount.fill("5000");
  await dlg.getByText("Select account").first().click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await anyway.getByRole("checkbox").check();
  await h.shot(page, "gpay-card-pay-anyway-form");
  const pay = dlg.getByRole("button", { name: /^Pay ₹5,000/ });
  await page.evaluate(() => window.__reset());
  await pay.evaluate((b) => { b.click(); b.click(); });
  await page.waitForTimeout(5000);
  await page.keyboard.press("Escape").catch(() => {});
  const bank1 = await f.bal("QA Bank");
  const card1 = (await h.list("accounts")).find((a) => a.name === "QA Credit Card").currentBalance;
  chk("bank debited ₹5,000 exactly once (persisted)", f.close2(bank0 - bank1, 5000), `${bank0} -> ${bank1}`);
  chk("card liability down by ₹5,000 (persisted)", f.close2(Math.abs(card1 - card0), 5000), `${card0} -> ${card1}`);
  chk("one transfer pair (persisted)", (await f.txns((t) => t.transferId != null && t.amount === 5000)).length === 2);
  chk("Priya's ledger unchanged — her share is still owed (persisted)", JSON.stringify(await activeEntries(priya)) === ledger0);
  await h.go(page, "/credit-cards");
  await page.waitForTimeout(2500);
  const summary = page.getByTestId("card-bill-paid-summary").first();
  const text = (await summary.count()) > 0 ? await summary.innerText() : "";
  await h.shot(page, "gpay-card-after");
  chk("bill shows total · paid · remaining", /Bill ₹12,000/.test(text) && /Paid ₹5,000/.test(text) && /Remaining ₹7,000/.test(text), text);
});

/* ───────────── Loan / EMI: postpone their share ───────────── */

async function openPayEmi(page) {
  await h.addFixture(page, "shared-emi");
  await h.go(page, "/loans-installments");
  // The details view can still be on its first dev compile ("Compiling…") and swallow the click — retry until it opens.
  const record = page.getByRole("button", { name: "Record Payment" });
  for (let i = 0; i < 6 && !(await record.isVisible().catch(() => false)); i++) {
    await page.getByText("QA Shared EMI").first().click();
    await record.waitFor({ timeout: 15000 }).catch(() => {});
  }
  await record.click();
  const dlg = page.getByRole("dialog", { name: /Pay EMI/ });
  await dlg.getByText("TO PAY LENDER").waitFor();
  return dlg;
}
const schedule = async () => {
  const emi = (await h.list("emis")).find((d) => d.name === "QA Shared EMI" && !d.deletedAt);
  return (await h.list(`paymentSchedules/${emi.scheduleId}/installments`)).filter((i) => !i.deletedAt).map((i) => [i.id, i.amountDue, i.amountPaid, ms(i.dueDate)]).sort();
};
const deferralsOf = async (names) => {
  const people = (await h.list("people")).filter((p) => names.includes(p.name));
  return (await Promise.all(people.map(async (p) => (await h.list(`people/${p.id}/paymentDeferrals`)).map((d) => ({ ...d, name: p.name }))))).flat();
};

const postponeAllBody = async ({ page }, chk) => {
  const dlg = await openPayEmi(page);
  const bank0 = await f.bal("QA Bank");
  const tx0 = (await f.txns(() => true)).length;
  const sched0 = JSON.stringify(await schedule());
  const choices = await dlg.getByRole("radiogroup", { name: "How to pay the lender" }).getByRole("radio").allInnerTexts();
  chk("three choices, in order", /^Received/.test(choices[0]) && /^Not received yet/.test(choices[1]) && /^Pay the lender from my own money/.test(choices[2]), JSON.stringify(choices));
  await dlg.getByRole("radio", { name: /^Not received yet/ }).click();
  const form = dlg.getByTestId("share-postpone");
  await form.waitFor();
  const who = await form.getByRole("list", { name: "Shares not received" }).innerText();
  chk("lists whose share hasn't come, with amounts", /QA PRIYA/i.test(who) && /QA RAVI/i.test(who) && /₹/.test(who), who.replace(/\n/g, " | "));
  const preview = (await form.getByTestId("share-postpone-preview").innerText()).replace(/\n/g, " ");
  chk("preview: their share → a cycle; the lender EMI unchanged; not a payment", /expected in \w+ cycle/.test(preview) && /Lender EMI unchanged/.test(preview) && /Not a payment/.test(preview), preview);
  await h.shot(page, `gpay-emi-postpone-form${page.viewportSize()?.width < 500 ? "-mobile" : ""}`);
  const btn = form.getByRole("button", { name: /^Postpone 2 shares to [A-Z][a-z]{2}( \d{4})?$/ });
  await btn.evaluate((b) => { b.click(); b.click(); }); // double click — must write once
  const done = dlg.getByTestId("share-postponed");
  await done.waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  const doneText = await done.innerText();
  await h.shot(page, `gpay-emi-postponed${page.viewportSize()?.width < 500 ? "-mobile" : ""}`);
  chk("success: whose share, until when, EMI unchanged", /^Postponed — /.test(doneText) && /now expected in the \w+ cycle/.test(doneText) && /lender EMI is still due/.test(doneText), doneText.replace(/\n/g, " "));
  const panel = await f.flat(dlg.getByRole("region", { name: "Who pays this installment" }));
  chk("each person now reads 'Postponed to … cycle · from …'", (panel.match(/Postponed to \w+ cycle · from \d{2} \w{3}/g) ?? []).length === 2, panel.slice(0, 300));
  const defs = await deferralsOf(["QA Priya", "QA Ravi"]);
  chk("one active deferral per person, written once (revision 1) (persisted)", defs.length === 2 && defs.every((d) => d.state === "active" && d.revision === 1), JSON.stringify(defs.map((d) => [d.name, d.state, d.revision])));
  chk("lender schedule untouched — amounts AND due dates (persisted)", JSON.stringify(await schedule()) === sched0);
  chk("no transaction written, bank unchanged (persisted)", (await f.txns(() => true)).length === tx0 && f.close2(await f.bal("QA Bank"), bank0), `${tx0} -> ${(await f.txns(() => true)).length}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  chk("no horizontal page overflow", overflow <= 1, `${overflow}px`);
};
scenario("gpay-emi-postpone", "Pay EMI: 'Not received yet' (double-click) → both shares to next month once; no payment, schedule untouched", postponeAllBody);
scenario("gpay-emi-postpone-mobile-dark", "Pay EMI: the same postponement on mobile 390×844, dark", postponeAllBody, { viewport: { width: 390, height: 844 }, scheme: "dark" });

scenario("gpay-emi-postpone-one-later", "Pay EMI: Ravi's row 'Postpone' → only Ravi, a later cycle and a reminder date; Priya untouched", async ({ page }, chk) => {
  const dlg = await openPayEmi(page);
  const sched0 = JSON.stringify(await schedule());
  await dlg.getByRole("button", { name: "Postpone QA Ravi's share here" }).click();
  const form = dlg.getByTestId("share-postpone");
  await form.waitFor();
  chk("only Ravi is selected", (await form.getByRole("checkbox", { name: "Postpone QA Ravi's share" }).isChecked()) && !(await form.getByRole("checkbox", { name: "Postpone QA Priya's share" }).isChecked()));
  const later = form.getByLabel("Another cycle");
  const laterValue = await later.locator("option").nth(2).getAttribute("value");
  await later.selectOption(laterValue);
  await form.getByRole("radio", { name: "Pick a date" }).click();
  const remindOn = new Date(Date.now() + 20 * 86400000);
  const iso = `${remindOn.getFullYear()}-${String(remindOn.getMonth() + 1).padStart(2, "0")}-${String(remindOn.getDate()).padStart(2, "0")}`;
  await form.getByLabel("Reminder date").fill(`${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`);
  await page.waitForTimeout(400);
  const preview = (await form.getByTestId("share-postpone-preview").innerText()).replace(/\n/g, " ");
  chk("preview names Ravi only, the later cycle and the reminder", /QA Ravi's ₹/.test(preview) && !/Priya/.test(preview) && /reminder/.test(preview), preview);
  await h.shot(page, "gpay-emi-postpone-one-later");
  // The month carries its year when it isn't this year's ("Mar 2027").
  await form.getByRole("button", { name: /^Postpone QA Ravi's share to [A-Z][a-z]{2}( \d{4})?$/ }).click();
  await dlg.getByTestId("share-postponed").waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  const defs = await deferralsOf(["QA Priya", "QA Ravi"]);
  const ravi = defs.find((d) => d.name === "QA Ravi");
  chk("only Ravi's share postponed (persisted)", defs.length === 1 && ravi?.state === "active", JSON.stringify(defs.map((d) => [d.name, d.state])));
  const expectedEnd = ravi?.expected?.cycle?.end ? ms(ravi.expected.cycle.end) : 0;
  chk("to a cycle at least two months out (persisted)", expectedEnd - Date.now() > 40 * 86400000, new Date(expectedEnd).toDateString());
  const raviId = await personId("QA Ravi");
  const followUps = await h.list(`people/${raviId}/followUps`);
  chk("the reminder is saved on that date (persisted)", followUps.some((r) => new Date(ms(r.remindOn)).toDateString() === remindOn.toDateString()), JSON.stringify(followUps.map((r) => r.remindOn)));
  chk("lender schedule untouched (persisted)", JSON.stringify(await schedule()) === sched0);
  // Priya is still undecided: the choice stays available for her.
  chk("Priya can still be postponed or collected", (await dlg.getByRole("radio", { name: /^Not received yet/ }).count()) === 1);
});
