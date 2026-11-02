/**
 * General payments and in-dialog EMI postponement (2026-11-03):
 *  - People: Record payment opens on "Reduce the overall balance" — the money is tied to no item, the balance drops,
 *    no row reads paid / part paid, and the account moves once.
 *  - Loan / EMI: "Not received yet — postpone" moves each person's share to next month — no payment, no transaction,
 *    the lender schedule untouched.
 * Every action is asserted on both the browser and the persisted emulator data. Local emulator only.
 */
import { scenario } from "../lib/core.mjs";
import * as f from "../lib/flows.mjs";
import * as h from "../lib/harness.mjs";

const personId = async (name) => (await h.list("people")).find((p) => p.name === name).id;
const activeEntries = async (id) => (await h.list(`people/${id}/ledger`)).filter((e) => !e.deletedAt);

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

scenario("gpay-emi-postpone", "Pay EMI: 'Not received yet — postpone' → both shares moved to next month; no payment, no transaction, schedule untouched", async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  const bank0 = await f.bal("QA Bank");
  const tx0 = (await f.txns(() => true)).length;
  await h.go(page, "/loans-installments");
  await page.getByText("QA Shared EMI").first().click();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Record Payment" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay EMI/ });
  await dlg.getByText("TO PAY LENDER").waitFor();
  await dlg.getByRole("radio", { name: /Not received yet — postpone/ }).click();
  const form = dlg.getByTestId("share-postpone");
  await form.waitFor();
  const preview = await form.getByTestId("share-postpone-preview").innerText();
  chk("preview: not a payment, EMI stays due", /Not a payment/.test(preview) && /EMI stays due/.test(preview), preview);
  await h.shot(page, "gpay-emi-postpone-form");
  await form.getByRole("button", { name: /^Postpone to \w+ cycle$/ }).click();
  await form.waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const text = await f.flat(dlg);
  await h.shot(page, "gpay-emi-postponed");
  chk("dialog now says when they will pay", /will pay you in the \w+ cycle/.test(text), text.slice(0, 300));
  const people = (await h.list("people")).filter((p) => p.name === "QA Priya" || p.name === "QA Ravi");
  const deferrals = (await Promise.all(people.map((p) => h.list(`people/${p.id}/paymentDeferrals`)))).flat();
  chk("one active deferral per person (persisted)", deferrals.length === 2 && deferrals.every((d) => d.state === "active"), JSON.stringify(deferrals.map((d) => [d.personId, d.state])));
  chk("lender schedule untouched (persisted)", f.paidTotal(await f.scheduleState("emi", "QA Shared EMI")) === 0);
  chk("no transaction written, bank unchanged (persisted)", (await f.txns(() => true)).length === tx0 && f.close2(await f.bal("QA Bank"), bank0), `${tx0} -> ${(await f.txns(() => true)).length}`);
});
