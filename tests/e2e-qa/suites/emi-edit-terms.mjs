/**
 * Browser QA — EMI "Edit terms" (lterms-*). Local emulator only. Drives the real screen and then reads the persisted
 * installments / EMI / accounts back from the emulator and cross-checks the NUMBERS shown in Loan & EMI, Balance
 * Control, Accounts, Credit Cards, Dashboard, My Money and Month Cycle against them (not merely that they render).
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
import * as f from "../lib/flows.mjs";

const round2 = (v) => Math.round(v * 100) / 100;
const share = (i) => i.principalPortion ?? i.amountDue;
const rupee = (t) => [...String(t).matchAll(/₹\s*([\d,]*\d(?:\.\d{1,2})?)/g)].map((m) => Number(m[1].replace(/,/g, "")));
const norm = (t) => String(t).replace(/\s+/g, " ").trim();

async function emiState(name) {
  const emi = (await h.list("emis")).find((e) => e.name === name);
  const insts = (await h.list(`paymentSchedules/${emi.scheduleId}/installments`)).filter((i) => !i.deletedAt).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const paid = insts.filter((i) => i.amountPaid > 0);
  const principalPaid = paid.reduce((a, i) => a + (i.amountPaid >= i.amountDue ? share(i) : share(i) * (i.amountPaid / i.amountDue)), 0);
  const remaining = round2(insts.filter((i) => !i.isSkipped).reduce((a, i) => a + Math.max(0, i.amountDue - i.amountPaid), 0));
  return { emi, insts, outstandingPrincipal: round2(emi.principalAmount - principalPaid), remaining };
}
const txCount = async () => (await h.list("transactions")).filter((t) => !t.deletedAt).length;

async function openEmi(page, name) {
  await h.go(page, "/loans-installments");
  await page.getByText(name).first().click();
  await page.getByRole("button", { name: "Edit terms" }).waitFor({ timeout: 30000 });
}
async function openEditTerms(page, name) {
  await openEmi(page, name);
  await page.getByRole("button", { name: "Edit terms" }).click();
  const dlg = page.getByRole("dialog", { name: /Edit terms/ });
  await dlg.waitFor({ timeout: 30000 });
  return dlg;
}
const tid = (dlg, id) => dlg.getByTestId(id);
async function payFirst(page, name, label) {
  await h.go(page, "/loans-installments");
  await page.getByText(name).first().click();
  await page.getByRole("button", { name: "Record Payment" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay EMI|Pay installment/ });
  await dlg.getByText("TO PAY LENDER").waitFor();
  if (label === "bank") {
    await dlg.getByText("Choose paying account").click();
    await page.getByRole("option", { name: /QA Bank/ }).click();
  }
  await dlg.getByRole("button", { name: /^(Pay|Charge|Record) ₹/ }).last().click();
  await dlg.waitFor({ state: "hidden", timeout: 40000 });
  await page.waitForTimeout(1800);
}
async function pageMoney(page, path) {
  await h.go(page, path);
  // Pages fill in as listeners report; wait until two reads 2s apart agree.
  let last = null;
  for (let k = 0; k < 8; k++) {
    await page.waitForTimeout(2000);
    const now = rupee(await page.locator("body").innerText());
    if (last != null && JSON.stringify(now) === JSON.stringify(last)) return now;
    last = now;
  }
  return last;
}
const summaryOwed = async (page) => {
  await h.go(page, "/loans");
  // The total fills in as each listener reports, so wait until two reads 2s apart agree.
  let last = null;
  for (let k = 0; k < 8; k++) {
    await page.waitForTimeout(2000);
    const text = await page.locator("body").innerText();
    const at = text.search(/total\s+outstanding/i);
    const v = at < 0 ? null : (rupee(text.slice(at, at + 160))[0] ?? null);
    if (v != null && v === last) return v;
    last = v;
  }
  return last;
};
const multiset = (xs) => { const m = new Map(); for (const x of xs) m.set(Math.round(x), (m.get(Math.round(x)) ?? 0) + 1); return m; };
/** Numbers that appeared or disappeared between two page reads. */
function movedNumbers(before, after) {
  const a = multiset(before), b = multiset(after), out = new Set();
  for (const k of new Set([...a.keys(), ...b.keys()])) if ((a.get(k) ?? 0) !== (b.get(k) ?? 0)) out.add(k);
  return [...out];
}

scenario("lterms-standalone", "EMI Edit terms (standalone): preview = saved result; paid installment, principal and cash untouched; numbers consistent across Loan & EMI, Balance Control, Accounts, Dashboard, My Money, Month Cycle", async ({ page }, chk) => {
  await payFirst(page, "QA Phone EMI", "bank");
  const before = await emiState("QA Phone EMI");
  const bankBefore = await f.bal("QA Bank");
  const txBefore = await txCount();
  const owedBefore = await summaryOwed(page);
  const pages = ["/", "/my-money", "/month-cycle", "/accounts"];
  const moneyBefore = {};
  for (const p of pages) moneyBefore[p] = await pageMoney(page, p);

  const dlg = await openEditTerms(page, "QA Phone EMI");
  chk("the screen shows the saved terms and no change yet; Save is disabled", (await tid(dlg, "emi-terms-unchanged").count()) === 1 && (await dlg.getByRole("button", { name: /Save new terms/ }).isDisabled()));
  await tid(dlg, "emi-terms-rate").fill("12");
  await tid(dlg, "emi-terms-count").fill("8");
  await page.waitForTimeout(500);
  await h.shot(page, "lterms-standalone-preview");

  const principalShown = rupee(await tid(dlg, "emi-terms-impact-principal").innerText())[0];
  const [payBeforeShown, payAfterShown] = rupee(await tid(dlg, "emi-terms-impact-payable").innerText());
  const [emiBeforeShown, emiAfterShown] = rupee(await tid(dlg, "emi-terms-row-emi").innerText());
  chk("preview: outstanding principal equals the stored one and is marked unchanged", Math.abs(principalShown - before.outstandingPrincipal) < 0.01 && /unchanged/.test(await tid(dlg, "emi-terms-impact-principal").innerText()), `${principalShown} vs ${before.outstandingPrincipal}`);
  chk("preview: 'still to pay' before = the stored remaining", Math.abs(payBeforeShown - before.remaining) < 0.01, `${payBeforeShown} vs ${before.remaining}`);
  chk("preview: new rate raises what is still payable (interest added), principal does not move", payAfterShown > payBeforeShown, `${payBeforeShown} → ${payAfterShown}`);
  chk("preview: next installment amount before = stored next installment", Math.abs(emiBeforeShown - before.insts.find((i) => !(i.amountPaid > 0)).amountDue) < 0.01);
  chk("preview: effective-from line names installment 2 and says the paid one is kept", /Applies from installment 2/.test(await tid(dlg, "emi-terms-effective").innerText()) && /1 settled installment/.test(await tid(dlg, "emi-terms-effective").innerText()));
  chk("preview: the account-impact line says no balance changes (standalone EMI)", (await tid(dlg, "emi-terms-account-impact").count()) === 1 && (await tid(dlg, "emi-terms-card-impact").count()) === 0);
  const rows = await tid(dlg, "emi-terms-schedule-row").count();
  chk("preview: schedule rows listed (first six of the 7 unpaid-or-new installments)", rows === 6, rows);

  chk("Save stays disabled until the confirmation is ticked", await dlg.getByRole("button", { name: /Save new terms/ }).isDisabled());
  await tid(dlg, "emi-terms-confirm").check();
  await dlg.getByRole("button", { name: /Save new terms/ }).click();
  await dlg.waitFor({ state: "hidden", timeout: 40000 });
  await page.waitForTimeout(2500);

  const after = await emiState("QA Phone EMI");
  const tail = after.insts.filter((i) => !(i.amountPaid > 0));
  chk("saved: 8 installments, the paid one untouched", after.insts.length === 8 && after.insts[0].id === before.insts[0].id && after.insts[0].amountPaid === 4000 && after.insts[0].amountDue === before.insts[0].amountDue);
  chk("saved: interest is 12% on the EMI", Number(after.emi.interest?.ratePercent) === 12 && after.emi.installmentCount === 8, JSON.stringify(after.emi.interest));
  chk("saved: the first new installment equals the previewed 'next installment' amount", Math.abs(tail[0].amountDue - emiAfterShown) < 0.01, `${tail[0].amountDue} vs ${emiAfterShown}`);
  chk("saved: what is still payable equals the previewed figure", Math.abs(after.remaining - payAfterShown) < 0.01, `${after.remaining} vs ${payAfterShown}`);
  chk("saved: outstanding principal is exactly what it was", Math.abs(after.outstandingPrincipal - before.outstandingPrincipal) < 0.01, `${before.outstandingPrincipal} → ${after.outstandingPrincipal}`);
  chk("saved: bank balance and transaction count unchanged (no cash moved)", Math.abs((await f.bal("QA Bank")) - bankBefore) < 0.005 && (await txCount()) === txBefore);

  // Cross-module numbers.
  const owedAfter = await summaryOwed(page);
  chk("Loan & EMI total outstanding moved by exactly the change in what is payable", Math.abs(owedAfter - owedBefore - (after.remaining - before.remaining)) <= 1, `${owedBefore} → ${owedAfter}; expected +${round2(after.remaining - before.remaining)}`);
  await h.go(page, "/loans-installments");
  await page.waitForTimeout(2500);
  chk("Loan & EMI: the EMI's next-installment figure is the new amount", (await page.locator("body").innerText()).includes(Math.round(tail[0].amountDue).toLocaleString("en-IN")), `looking for ${Math.round(tail[0].amountDue)}`);
  await h.go(page, "/balance-control");
  await page.locator('[data-testid="variance-table"]').waitFor({ timeout: 60000 });
  await page.waitForFunction(() => /\d/.test(document.querySelector('[data-testid="flowfi-value"]')?.textContent ?? ""), null, { timeout: 60000 });
  const names = await page.locator('[data-testid="product-select"] option').allInnerTexts();
  await page.locator('[data-testid="product-select"]').selectOption({ label: names.find((n) => /QA Phone EMI/.test(n)) });
  await page.waitForTimeout(600);
  const bcPrincipal = rupee(await page.locator('[data-testid="variance-row-emiPrincipal"] [data-testid="flowfi-value"]').innerText())[0];
  chk("Balance Control: EMI remaining principal unchanged", Math.abs(bcPrincipal - before.outstandingPrincipal) < 0.01, bcPrincipal);

  const allowed = new Set([...before.insts, ...after.insts].map((i) => Math.round(i.amountDue)).concat([Math.round(before.remaining), Math.round(after.remaining), Math.round(owedBefore), Math.round(owedAfter)]));
  for (const p of pages) {
    const moved = movedNumbers(moneyBefore[p], await pageMoney(page, p));
    const unexpected = moved.filter((n) => !allowed.has(n));
    chk(`${p === "/" ? "Dashboard" : p}: every number that changed is one this edit legitimately changes (EMI amounts / payable); nothing else moved`, unexpected.length === 0, `moved: ${moved.join(",") || "none"}; unexpected: ${unexpected.join(",") || "none"}`);
    if (p === "/accounts") chk("Accounts: bank balance shown equals the stored, unchanged balance", (await page.locator("body").innerText()).includes(Math.round(bankBefore).toLocaleString("en-IN")));
    await h.shot(page, `lterms-after-${p.replace(/\W/g, "") || "dashboard"}`);
  }
});

scenario("lterms-card-linked", "EMI Edit terms (card-linked): card standing, bank and transactions unchanged; principal lock unchanged; preview says so; numbers match in Balance Control and Credit Cards", async ({ page }, chk) => {
  await h.openPortalSignedIn(page);
  await h.addFixture(page, "card-emi");
  await payFirst(page, "QA Card EMI", "card");
  const before = await emiState("QA Card EMI");
  const bankBefore = await f.bal("QA Bank");
  const cardBefore = (await h.accountBalance("QA EMI Card")).currentBalance;
  const txBefore = await txCount();
  const cardPageBefore = await pageMoney(page, "/credit-cards");
  await h.go(page, "/balance-control");
  await page.locator('[data-testid="variance-table"]').waitFor({ timeout: 60000 });
  await page.waitForFunction(() => /\d/.test(document.querySelector('[data-testid="flowfi-value"]')?.textContent ?? ""), null, { timeout: 60000 });
  const bcNames = await page.locator('[data-testid="product-select"] option').allInnerTexts();
  await page.locator('[data-testid="product-select"]').selectOption({ label: bcNames.find((n) => /9090|QA EMI Card/.test(n)) });
  await page.waitForTimeout(600);
  const bcBefore = {
    avail: rupee(await page.locator('[data-testid="variance-row-availableCredit"] [data-testid="flowfi-value"]').innerText())[0],
    out: rupee(await page.locator('[data-testid="variance-row-totalOutstanding"] [data-testid="flowfi-value"]').innerText())[0],
  };

  const dlg = await openEditTerms(page, "QA Card EMI");
  await tid(dlg, "emi-terms-rate").fill("12");
  await tid(dlg, "emi-terms-count").fill("6");
  await page.waitForTimeout(500);
  const cardImpact = await tid(dlg, "emi-terms-card-impact").innerText();
  chk("preview: linked-card impact names the card, the unchanged locked principal and says nothing changes today", /9090/.test(cardImpact) && cardImpact.includes(Math.round(before.outstandingPrincipal).toLocaleString("en-IN")) && /nothing changes today/.test(cardImpact), cardImpact);
  await h.shot(page, "lterms-card-preview");
  await tid(dlg, "emi-terms-confirm").check();
  await dlg.getByRole("button", { name: /Save new terms/ }).click();
  await dlg.waitFor({ state: "hidden", timeout: 40000 });
  await page.waitForTimeout(2500);

  const after = await emiState("QA Card EMI");
  chk("saved: 6 installments, first one (card-paid) untouched, rate 12%", after.insts.length === 6 && after.insts[0].amountPaid === 3000 && Number(after.emi.interest?.ratePercent) === 12);
  chk("saved: outstanding principal unchanged, and still payable rose", Math.abs(after.outstandingPrincipal - before.outstandingPrincipal) < 0.01 && after.remaining > before.remaining, `${before.remaining} → ${after.remaining}`);
  chk("card account balance, bank balance and transaction count unchanged", Math.abs((await h.accountBalance("QA EMI Card")).currentBalance - cardBefore) < 0.005 && Math.abs((await f.bal("QA Bank")) - bankBefore) < 0.005 && (await txCount()) === txBefore);
  chk("EMI stays linked to the same card and keeps its principal", after.emi.linkedCreditCardId === before.emi.linkedCreditCardId && after.emi.principalAmount === before.emi.principalAmount);

  const cardPageAfter = await pageMoney(page, "/credit-cards");
  chk("Credit Cards page: every figure identical before and after (outstanding, available credit, utilization unchanged)", movedNumbers(cardPageBefore, cardPageAfter).length === 0, `moved: ${movedNumbers(cardPageBefore, cardPageAfter).join(",")}`);
  await h.go(page, "/balance-control");
  await page.locator('[data-testid="variance-table"]').waitFor({ timeout: 60000 });
  await page.waitForFunction(() => /\d/.test(document.querySelector('[data-testid="flowfi-value"]')?.textContent ?? ""), null, { timeout: 60000 });
  const names = await page.locator('[data-testid="product-select"] option').allInnerTexts();
  await page.locator('[data-testid="product-select"]').selectOption({ label: names.find((n) => /9090|QA EMI Card/.test(n)) });
  await page.waitForTimeout(600);
  const avail = rupee(await page.locator('[data-testid="variance-row-availableCredit"] [data-testid="flowfi-value"]').innerText())[0];
  const out = rupee(await page.locator('[data-testid="variance-row-totalOutstanding"] [data-testid="flowfi-value"]').innerText())[0];
  chk("Balance Control: the card's available credit and total outstanding are exactly what they were before the edit (the lock is the same principal)", Math.abs(avail - bcBefore.avail) < 0.01 && Math.abs(out - bcBefore.out) < 0.01, `available ${bcBefore.avail}→${avail}, outstanding ${bcBefore.out}→${out}`);
  for (const p of ["/", "/my-money", "/month-cycle", "/accounts"]) await pageMoney(page, p);
});

scenario("lterms-nothing-settled", "EMI Edit terms with NOTHING settled: installment #1 keeps its date for a rate+tenure edit and a due-day edit; saved = preview; principal, cash and transactions untouched", async ({ page }, chk) => {
  const before = await emiState("QA Phone EMI");
  chk("precondition: no installment settled", before.insts.every((i) => !(i.amountPaid > 0)));
  const bankBefore = await f.bal("QA Bank");
  const txBefore = await txCount();
  const owedBefore = await summaryOwed(page);

  let dlg = await openEditTerms(page, "QA Phone EMI");
  chk("not blocked, inputs enabled", (await tid(dlg, "emi-terms-blocked").count()) === 0 && !(await tid(dlg, "emi-terms-rate").isDisabled()));
  await tid(dlg, "emi-terms-rate").fill("12");
  await tid(dlg, "emi-terms-count").fill("8");
  await page.waitForTimeout(500);
  const eff = await tid(dlg, "emi-terms-effective").innerText();
  chk("preview: applies from installment 1 on the EMI's first date", /installment 1,/.test(eff), eff);
  const [payBeforeShown, payAfterShown] = rupee(await tid(dlg, "emi-terms-impact-payable").innerText());
  const [, emiAfterShown] = rupee(await tid(dlg, "emi-terms-row-emi").innerText());
  await h.shot(page, "lterms-nothing-settled-preview");
  await tid(dlg, "emi-terms-confirm").check();
  await dlg.getByRole("button", { name: /Save new terms/ }).click();
  await dlg.waitFor({ state: "hidden", timeout: 40000 });
  await page.waitForTimeout(2500);

  let after = await emiState("QA Phone EMI");
  chk("saved: 8 installments, #1 still on the original first date (no one-period shift)", after.insts.length === 8 && after.insts[0].dueDate === before.insts[0].dueDate && new Date(after.insts[0].dueDate).getTime() === new Date(before.emi.startDate).getTime(), `${before.insts[0].dueDate} → ${after.insts[0].dueDate}`);
  chk("saved: due dates strictly increase", after.insts.every((x, k) => k === 0 || new Date(x.dueDate) > new Date(after.insts[k - 1].dueDate)));
  chk("saved: first installment equals the previewed amount; payable equals the previewed figure", Math.abs(after.insts[0].amountDue - emiAfterShown) < 0.01 && Math.abs(after.remaining - payAfterShown) < 0.01 && Math.abs(payBeforeShown - before.remaining) < 0.01, `${after.insts[0].amountDue}/${emiAfterShown}; ${after.remaining}/${payAfterShown}`);
  chk("saved: outstanding principal exactly unchanged", Math.abs(after.outstandingPrincipal - before.outstandingPrincipal) < 0.01, `${before.outstandingPrincipal} → ${after.outstandingPrincipal}`);
  chk("saved: bank balance and transaction count unchanged", Math.abs((await f.bal("QA Bank")) - bankBefore) < 0.005 && (await txCount()) === txBefore);
  const owedAfter = await summaryOwed(page);
  chk("Loan & EMI total outstanding moved by exactly the change in what is payable", Math.abs(owedAfter - owedBefore - (after.remaining - before.remaining)) <= 1, `${owedBefore} → ${owedAfter}`);

  // A due-day edit on the same (still nothing-settled) EMI: #1 stays, the rest pin to the day.
  dlg = await openEditTerms(page, "QA Phone EMI");
  await tid(dlg, "emi-terms-dueday").fill("28");
  await page.waitForTimeout(400);
  await tid(dlg, "emi-terms-confirm").check();
  await dlg.getByRole("button", { name: /Save new terms/ }).click();
  await dlg.waitFor({ state: "hidden", timeout: 40000 });
  await page.waitForTimeout(2500);
  const second = await emiState("QA Phone EMI");
  chk("due-day edit: #1 untouched on its date; installments 2.. fall on the 28th", new Date(second.insts[0].dueDate).getTime() === new Date(before.emi.startDate).getTime() && second.insts.slice(1).every((x) => new Date(x.dueDate).getDate() === 28));
  chk("due-day edit: principal and cash still unchanged", Math.abs(second.outstandingPrincipal - before.outstandingPrincipal) < 0.01 && Math.abs((await f.bal("QA Bank")) - bankBefore) < 0.005 && (await txCount()) === txBefore);
  for (const p of ["/", "/my-money", "/month-cycle", "/accounts"]) await pageMoney(page, p);
});

scenario("lterms-blocked", "EMI Edit terms: shared EMIs are explained and disabled; invalid terms are refused; Save needs a real change and the confirmation", async ({ page }, chk) => {
  let dlg;
  // 1. Shared EMI.
  await h.openPortalSignedIn(page);
  await h.addFixture(page, "shared-emi");
  dlg = await openEditTerms(page, "QA Shared EMI");
  chk("shared EMI: the reason names the per-person shares and the dialog is disabled", /shared/i.test(await tid(dlg, "emi-terms-blocked").innerText()) && (await dlg.getByRole("button", { name: /Save new terms/ }).isDisabled()));
  await page.keyboard.press("Escape");

  // 3. Validation on an editable EMI (one installment settled).
  await payFirst(page, "QA Phone EMI", "bank");
  dlg = await openEditTerms(page, "QA Phone EMI");
  chk("editable EMI: not blocked", (await tid(dlg, "emi-terms-blocked").count()) === 0);
  await tid(dlg, "emi-terms-count").fill("1");
  chk("fewer installments than already settled is refused with the reason", /At least 1|still owed/.test(await tid(dlg, "emi-terms-errors").innerText()) && (await dlg.getByRole("button", { name: /Save new terms/ }).isDisabled()), await tid(dlg, "emi-terms-errors").innerText().catch(() => "no error"));
  await tid(dlg, "emi-terms-count").fill("6");
  await tid(dlg, "emi-terms-rate").fill("-3");
  chk("a negative rate is refused", /negative/.test(await tid(dlg, "emi-terms-errors").innerText()));
  await tid(dlg, "emi-terms-rate").fill("");
  chk("back to the saved terms: 'no change yet' and Save disabled", (await tid(dlg, "emi-terms-unchanged").count()) === 1 && (await dlg.getByRole("button", { name: /Save new terms/ }).isDisabled()));
  await tid(dlg, "emi-terms-count").fill("7");
  chk("a valid change still needs the confirmation ticked", await dlg.getByRole("button", { name: /Save new terms/ }).isDisabled());
  await h.shot(page, "lterms-validation");
});

scenario("lterms-stale-two-tabs", "EMI Edit terms: a payment recorded in another tab while the screen is open is never overwritten — a confirmation never survives a changed schedule, and a save that raced a change is refused", async ({ page, ctx }, chk, notes) => {
  await payFirst(page, "QA Phone EMI", "bank");
  // Tab B exists BEFORE the edit screen opens (loading a second app tab makes this tab's workspace reload).
  const b = await f.secondTab(ctx, "/loans-installments");
  await b.waitForTimeout(3000);
  await b.getByText("QA Phone EMI").first().click();
  await b.getByRole("button", { name: "Record Payment" }).click();
  const payDlg = b.getByRole("dialog", { name: /Pay EMI|Pay installment/ });
  await payDlg.getByText("TO PAY LENDER").waitFor();
  await payDlg.getByText("Choose paying account").click();
  await b.getByRole("option", { name: /QA Bank/ }).click();

  await page.bringToFront();
  await page.waitForTimeout(2500);
  const dlg = await openEditTerms(page, "QA Phone EMI");
  await tid(dlg, "emi-terms-count").fill("8");
  await tid(dlg, "emi-terms-confirm").check();
  chk("precondition: confirmed on the 1-settled preview", await tid(dlg, "emi-terms-confirm").isChecked());

  await b.bringToFront();
  await payDlg.getByRole("button", { name: /^Pay ₹/ }).last().click();
  await payDlg.waitFor({ state: "hidden", timeout: 40000 });
  await b.waitForTimeout(1500);
  const mid = await emiState("QA Phone EMI");
  chk("precondition: tab B paid installment 2", mid.insts[1].amountPaid === 4000);

  await page.bringToFront();
  const trail = [];
  for (let k = 0; k < 10; k++) { trail.push(await page.getByRole("dialog", { name: /Edit terms/ }).count()); await page.waitForTimeout(500); }
  notes.push(`edit screen present after B paid (every 500ms): ${trail.join("")}`);
  const stillOpen = (await page.getByRole("dialog", { name: /Edit terms/ }).count()) > 0;
  const save = dlg.getByRole("button", { name: /Save new terms/ });
  if (stillOpen) {
    const live = await dlg.getByText(/Includes the 2 already settled/).waitFor({ timeout: 20000 }).then(() => true, () => false);
    if (live) {
      chk("the screen updated live: the earlier confirmation was withdrawn and Save is disabled until re-confirmed", !(await tid(dlg, "emi-terms-confirm").isChecked()) && (await save.isDisabled()));
      await tid(dlg, "emi-terms-confirm").check();
      await save.click();
      await dlg.waitFor({ state: "hidden", timeout: 40000 });
      await page.waitForTimeout(2500);
      const after = await emiState("QA Phone EMI");
      const tail = after.insts.filter((x) => !(x.amountPaid > 0));
      chk("saved on the fresh schedule: both paid installments kept, only the 6 unpaid re-planned, principal conserved", after.insts.length === 8 && after.insts[0].amountPaid === 4000 && after.insts[1].amountPaid === 4000 && tail.length === 6 && Math.abs(tail.reduce((a, x) => a + share(x), 0) - 16000) < 0.05, `${after.insts.length} inst, tail ${tail.length}`);
    } else {
      await tid(dlg, "emi-terms-confirm").check();
      await save.click();
      await page.waitForTimeout(3500);
      const after = await emiState("QA Phone EMI");
      chk("(listener lagged) the stale save changed nothing — still 6 installments, #2 still paid", after.insts.length === 6 && after.insts[1].amountPaid === 4000);
      chk("(listener lagged) the user is told the schedule changed", /schedule changed|reopen/i.test(await page.locator("body").innerText()));
    }
  } else {
    const after = await emiState("QA Phone EMI");
    chk("the live refresh closed the screen without saving: still 6 installments, #2 paid, terms unchanged", after.insts.length === 6 && after.insts[1].amountPaid === 4000 && after.emi.interest == null);
    // Reopen: the preview is computed from the fresh schedule, with nothing pre-confirmed.
    const again = await openEditTerms(page, "QA Phone EMI");
    await tid(again, "emi-terms-count").fill("8");
    chk("reopened on the fresh schedule (2 settled), nothing pre-confirmed", /Includes the 2 already settled/.test(await again.innerText()) && !(await tid(again, "emi-terms-confirm").isChecked()));
    await tid(again, "emi-terms-confirm").check();
    await again.getByRole("button", { name: /Save new terms/ }).click();
    await again.waitFor({ state: "hidden", timeout: 40000 });
    await page.waitForTimeout(2500);
    const done = await emiState("QA Phone EMI");
    const tail = done.insts.filter((x) => !(x.amountPaid > 0));
    chk("saved on the fresh schedule: both paid installments kept, 6 unpaid re-planned, principal conserved", done.insts.length === 8 && done.insts[1].amountPaid === 4000 && tail.length === 6 && Math.abs(tail.reduce((a, x) => a + share(x), 0) - 16000) < 0.05);
  }
  await h.shot(page, "lterms-stale");
});
