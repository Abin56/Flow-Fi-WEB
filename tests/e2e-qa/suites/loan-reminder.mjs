/**
 * Past installments with a part-paid person + optional reminder (rem-*), and "Pay the lender from my own money" with
 * the person's share left owed (own-*). Every check reads the persisted emulator documents back. Local emulator only.
 */
import { scenario } from "../lib/core.mjs";
import * as f from "../lib/flows.mjs";
import * as h from "../lib/harness.mjs";

const NAME = "QA 24-Month EMI";
const ms = (v) => (v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : Number(v));
const personId = async (name) => (await h.list("people")).find((p) => p.name === name).id;
const personDoc = async (name) => (await h.list("people")).find((p) => p.name === name);
const activeEntries = async (id) => (await h.list(`people/${id}/ledger`)).filter((e) => !e.deletedAt);
const ddmmyyyy = (d) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
const mobile = (page) => (page.viewportSize()?.width ?? 1000) < 500;
const sfx = (page) => (mobile(page) ? "-mobile" : "");

async function addHistoryEmi(page) {
  const testId = "qa-seed-history-emi";
  await page.click(`[data-testid="${testId}"]`);
  await page.waitForSelector('[data-testid="qa-seed-steps"]', { timeout: 120000 });
  await page.waitForFunction((id) => !document.querySelector(`[data-testid="${id}"]`)?.textContent?.includes("Adding"), testId, { timeout: 120000 });
  const steps = (await page.locator('[data-testid="qa-seed-steps"]').innerText()).split("\n").join(" | ");
  if (/✗/.test(steps)) throw new Error(`fixture failed: ${steps}`);
}
const histSchedule = async () => {
  const emi = (await h.list("emis")).find((d) => d.name === NAME && !d.deletedAt);
  return (await h.list(`paymentSchedules/${emi.scheduleId}/installments`)).filter((i) => !i.deletedAt).map((i) => [i.sequenceNumber, i.amountDue, i.amountPaid, ms(i.dueDate)]).sort((a, b) => a[0] - b[0]);
};

/** Opens "Record past payments", ticks #1–#3, picks "each on its due date" and lands on the people step. */
async function toPeopleStep(page) {
  await h.go(page, "/loans-installments");
  await page.getByText(NAME).first().click();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Record past payments" }).click();
  const dlg = page.getByRole("dialog", { name: /Record past payments/ });
  await dlg.getByTestId("bulk-step").waitFor();
  for (const n of [1, 2, 3]) await dlg.getByRole("checkbox", { name: `#${n}`, exact: true }).click();
  await dlg.getByRole("button", { name: "Continue with 3 EMIs" }).click();
  await dlg.getByRole("radio", { name: /Each on its due date/ }).click();
  await dlg.getByRole("button", { name: "Continue to people's shares" }).click({ timeout: 30000 });
  await dlg.getByText(/already paid you their share\?/).waitFor();
  return dlg;
}

async function receivedSome(page, dlg, amount) {
  const row = dlg.getByRole("radiogroup", { name: "QA Priya #1", exact: true });
  await row.getByRole("radio", { name: "Received some" }).click();
  await dlg.getByLabel("Amount received from QA Priya").fill(String(amount));
  await dlg.getByRole("radiogroup", { name: "Where is QA Priya #1's money" }).getByRole("radio", { name: "Already in my account" }).click();
  await dlg.getByLabel("Received into account").click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
}

async function finish(page, dlg, label) {
  await dlg.getByRole("button", { name: "Continue to review" }).click();
  await h.shot(page, `${label}-review${sfx(page)}`);
  await page.evaluate(() => window.__reset());
  await dlg.getByRole("button", { name: /^Record 3 EMIs/ }).click();
  await dlg.waitFor({ state: "hidden", timeout: 120000 });
  await page.waitForTimeout(3000);
}

const noOverflow = async (page, chk) => {
  const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  chk("no horizontal page overflow", o <= 1, `${o}px`);
};

/* ───────────── Scenario 1 ───────────── */

const partBody = (withReminder) => async ({ page }, chk) => {
  await addHistoryEmi(page);
  const label = withReminder ? "rem-part-reminder" : "rem-part-noreminder";
  const priya = await personId("QA Priya");
  const bank0 = await f.bal("QA Bank");
  const bal0 = (await personDoc("QA Priya")).currentBalance;
  const dlg = await toPeopleStep(page);
  await receivedSome(page, dlg, 400);
  const summary = (await dlg.getByTestId("reconcile-summary").innerText()).replace(/\n/g, " ");
  await h.shot(page, `${label}-people${sfx(page)}`);
  chk("shows what she gave and what is left (₹400 of ₹3,000 · ₹2,600 still to receive)", /QA Priya: ₹2,600 still to receive/.test(summary) && /Paid you ₹400 of ₹3,000/.test(summary), summary);
  chk("says the pending amount stays in People and lender payments are not changed", /stays owed in the People ledger/.test(summary) && /lender payments above are not changed/.test(summary));
  chk("reminder control is offered, 'No reminder' selected by default", (await dlg.getByRole("radio", { name: "No reminder" }).getAttribute("aria-checked")) === "true");
  const remindOn = new Date(Date.now() + 10 * 86400000);
  if (withReminder) {
    await dlg.getByRole("radio", { name: "Remind me on…" }).click();
    await dlg.getByLabel("Reminder date").fill(ddmmyyyy(remindOn));
    await page.waitForTimeout(300);
    await h.shot(page, `${label}-reminder-set${sfx(page)}`);
  }
  await finish(page, dlg, label);

  const sched = await histSchedule();
  chk("lender: #1–#3 paid ₹2,000 each, due amounts and #4 onward untouched (persisted)", sched.slice(0, 3).every((i) => i[1] === 2000 && i[2] === 2000) && sched.slice(3).every((i) => i[2] === 0), JSON.stringify(sched.slice(0, 5)));
  chk("QA Bank unchanged (past payments, money already in balance) (persisted)", f.close2(await f.bal("QA Bank"), bank0), `${bank0} -> ${await f.bal("QA Bank")}`);
  const entries = (await activeEntries(priya)).filter((e) => e.recordedEarlier === true);
  chk("People: exactly one ₹400 receipt, received earlier (persisted)", entries.length === 1 && entries[0].amount === 400, JSON.stringify(entries.map((e) => [e.type, e.amount])));
  chk("Priya's balance dropped by exactly ₹400 (persisted)", f.close2(bal0 - (await personDoc("QA Priya")).currentBalance, 400), `${bal0} -> ${(await personDoc("QA Priya")).currentBalance}`);
  const defs = await h.list(`people/${priya}/paymentDeferrals`);
  const fus = await h.list(`people/${priya}/followUps`);
  if (withReminder) {
    chk("People timing: one deferral per still-open share (3 shares), active (persisted)", defs.length === 3 && defs.every((d) => d.state === "active"), JSON.stringify(defs.map((d) => [d.obligationKey, d.state])));
    chk("reminder saved on the chosen date for each share (persisted)", fus.length === 3 && fus.every((r) => new Date(ms(r.remindOn)).toDateString() === remindOn.toDateString() && r.state === "active"), JSON.stringify(fus.map((r) => r.remindOn)));
    const keys = new Set(defs.map((d) => d.obligationKey));
    chk("deferrals sit on installments #1–#3's shares only", [...keys].every((k) => k.startsWith("emi-inst:")) && keys.size === 3);
  } else {
    chk("No reminder: no deferral and no follow-up written (persisted)", defs.length === 0 && fus.length === 0, `${defs.length} deferrals, ${fus.length} follow-ups`);
  }
  await f.openPerson(page, "QA Priya");
  await page.waitForTimeout(1500);
  const body = (await page.locator("body").innerText()).split("\n").join(" ");
  await h.shot(page, `${label}-people-ledger${sfx(page)}`);
  chk("People Ledger still shows the 24-Month EMI shares as owed", /24-Month EMI · EMI share/i.test(body) && /to receive/.test(body), (body.match(/YOU NEED TO RECEIVE FROM QA[^A-Z]{0,30}/) ?? ["?"])[0]);
  await noOverflow(page, chk);
};
scenario("rem-part-no-reminder", "Past #1–#3: Priya gave ₹400 of ₹3,000 → ₹2,600 pending; 'No reminder' writes no deferral/follow-up", partBody(false));
scenario("rem-part-reminder", "Past #1–#3: Priya gave ₹400 → 'Remind me on…' +10 days saves 3 deferrals + reminders; lender records untouched", partBody(true));
scenario("rem-part-reminder-mobile-dark", "The same part-paid + reminder flow on mobile 390×844, dark", partBody(true), { viewport: { width: 390, height: 844 }, scheme: "dark" });

const onlyBody = async ({ page }, chk) => {
  await addHistoryEmi(page);
  const priya = await personId("QA Priya");
  const bank0 = await f.bal("QA Bank");
  const bal0 = (await personDoc("QA Priya")).currentBalance;
  const tx0 = (await h.list("transactions")).length;
  const led0 = (await activeEntries(priya)).length;
  const dlg = await toPeopleStep(page);
  const summary = (await dlg.getByTestId("reconcile-summary").innerText()).replace(/\n/g, " ");
  chk("nothing marked received: ₹3,000 pending, ₹0 given", /QA Priya: ₹3,000 still to receive/.test(summary) && /Paid you ₹0 of ₹3,000/.test(summary), summary);
  const remindOn = new Date(Date.now() + 5 * 86400000);
  await dlg.getByRole("radio", { name: "Remind me on…" }).click();
  await dlg.getByLabel("Reminder date").fill(ddmmyyyy(remindOn));
  await h.shot(page, `rem-only-people${sfx(page)}`);
  await finish(page, dlg, "rem-only");
  const sched = await histSchedule();
  chk("lender #1–#3 paid ₹2,000 each (persisted)", sched.slice(0, 3).every((i) => i[2] === 2000) && sched.slice(3).every((i) => i[2] === 0), JSON.stringify(sched.slice(0, 4)));
  chk("no People receipt, balance unchanged (persisted)", (await activeEntries(priya)).length === led0 && f.close2((await personDoc("QA Priya")).currentBalance, bal0));
  chk("no new transactions at all (persisted)", (await h.list("transactions")).length === tx0, `${tx0} -> ${(await h.list("transactions")).length}`);
  chk("bank unchanged (persisted)", f.close2(await f.bal("QA Bank"), bank0));
  const defs = await h.list(`people/${priya}/paymentDeferrals`);
  const fus = await h.list(`people/${priya}/followUps`);
  chk("reminder-only save wrote 3 deferrals + 3 follow-ups on the chosen date (persisted)", defs.length === 3 && fus.length === 3 && fus.every((r) => new Date(ms(r.remindOn)).toDateString() === remindOn.toDateString()), `${defs.length}/${fus.length}`);
  await noOverflow(page, chk);
};
scenario("rem-reminder-only", "Past #1–#3 with nothing marked received + a reminder → lender recorded, deferrals + reminders saved, no People receipt or transaction", onlyBody);
scenario("rem-reminder-only-mobile", "The same reminder-only save on mobile 390×844", onlyBody, { viewport: { width: 390, height: 844 } });

/* ───────────── Scenario 2 ───────────── */

const ownBody = async ({ page }, chk) => {
  await h.addFixture(page, "shared-emi");
  await h.go(page, "/loans-installments");
  const record = page.getByRole("button", { name: "Record Payment" });
  for (let i = 0; i < 6 && !(await record.isVisible().catch(() => false)); i++) {
    await page.getByText("QA Shared EMI").first().click();
    await record.waitFor({ timeout: 15000 }).catch(() => {});
  }
  const emi0 = (await h.list("emis")).find((d) => d.name === "QA Shared EMI" && !d.deletedAt);
  const inst0 = (await h.list(`paymentSchedules/${emi0.scheduleId}/installments`)).filter((i) => !i.deletedAt).map((i) => [i.id, i.amountDue, i.amountPaid]).sort();
  const people = (await h.list("people")).filter((p) => ["QA Priya", "QA Ravi"].includes(p.name));
  const bal0 = Object.fromEntries(people.map((p) => [p.name, p.currentBalance]));
  const led0 = Object.fromEntries(await Promise.all(people.map(async (p) => [p.name, JSON.stringify(await activeEntries(p.id))])));
  const bank0 = await f.bal("QA Bank");
  const tx0 = new Set((await h.list("transactions")).map((t) => t.id));
  await record.click();
  const dlg = page.getByRole("dialog", { name: /Pay EMI/ });
  await dlg.getByText("TO PAY LENDER").waitFor();
  await dlg.getByRole("radio", { name: /pay the lender from my own money/i }).click();
  const pending = await dlg.getByTestId("own-money-pending").innerText();
  await h.shot(page, `own-money-pending${sfx(page)}`);
  chk("own-money shows who stays pending and how much", /Stays pending with them/.test(pending) && /QA PRIYA/i.test(pending) && /QA RAVI/i.test(pending) && /₹/.test(pending), pending.replace(/\n/g, " | "));
  await dlg.getByText("Choose paying account").click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  const btn = dlg.getByRole("button", { name: /^Pay ₹[\d,.]+ to lender$/ });
  const amount = Number((await btn.innerText()).replace(/[^\d.]/g, ""));
  await h.shot(page, `own-money-ready${sfx(page)}`);
  await noOverflow(page, chk);
  await page.evaluate(() => window.__reset());
  await btn.evaluate((b) => { b.click(); b.click(); }); // double click: must write once
  await dlg.waitFor({ state: "hidden", timeout: 40000 });
  await page.waitForTimeout(2500);
  const inst1 = (await h.list(`paymentSchedules/${emi0.scheduleId}/installments`)).filter((i) => !i.deletedAt).map((i) => [i.id, i.amountDue, i.amountPaid]).sort();
  const changed = inst1.filter((r, k) => r[2] !== inst0[k][2]);
  chk("lender: exactly one installment paid, for the button's amount (persisted)", changed.length === 1 && f.close2(changed[0][2] - inst0.find((r) => r[0] === changed[0][0])[2], amount), JSON.stringify(changed));
  chk("bank debited exactly once (persisted)", f.close2(bank0 - (await f.bal("QA Bank")), amount), `${bank0} -> ${await f.bal("QA Bank")} (₹${amount})`);
  const newTx = (await h.list("transactions")).filter((t) => !t.deletedAt && !tx0.has(t.id));
  chk("one new transaction: the EMI expense (persisted)", newTx.length === 1 && newTx[0].type === "expense" && f.close2(newTx[0].amount, amount), JSON.stringify(newTx.map((t) => [t.type, t.amount])));
  const people1 = (await h.list("people")).filter((p) => ["QA Priya", "QA Ravi"].includes(p.name));
  chk("People balances unchanged — shares not marked received (persisted)", people1.every((p) => f.close2(p.currentBalance, bal0[p.name])), JSON.stringify(people1.map((p) => [p.name, bal0[p.name], p.currentBalance])));
  let same = true;
  for (const p of people1) same = same && JSON.stringify(await activeEntries(p.id)) === led0[p.name];
  chk("no ledger entry written or settled for either person (persisted)", same);
  const defs = (await Promise.all(people1.map((p) => h.list(`people/${p.id}/paymentDeferrals`)))).flat();
  chk("nothing postponed (persisted)", defs.length === 0);
  await f.openPerson(page, "QA Priya");
  await page.waitForTimeout(1500);
  const body = (await page.locator("body").innerText()).split("\n").join(" ");
  await h.shot(page, `own-money-people-ledger${sfx(page)}`);
  chk("People Ledger: Priya's share of the EMI is listed and not shown as received", /Shared EMI/i.test(body) && !/Got ₹/.test(body), (body.match(/CURRENT PENDING[^A-Z]{0,30}/) ?? ["?"])[0]);
};
scenario("own-money-emi", "Pay EMI from my own money: lender paid once, bank −EMI once, shares stay owed, nothing settled/postponed", ownBody);
scenario("own-money-emi-mobile-dark", "The same own-money EMI payment on mobile 390×844, dark", ownBody, { viewport: { width: 390, height: 844 }, scheme: "dark" });
