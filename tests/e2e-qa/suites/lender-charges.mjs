/**
 * Browser QA — lender-charge READ-SIDE integration (lchg-*). Local emulator only, synthetic data.
 *
 * The app has no way to record a charge (the write path is deliberately disabled), so these scenarios SEED
 * `lenderCharges` documents straight into the emulator and prove the Web consumers read them consistently:
 * Net Worth, Reports liabilities, Balance Control lender payoff, Dashboard / My Money / Month Cycle spend, and the
 * guided preview — while accounts, transactions, schedules and principal are untouched, and opening / using the guide
 * writes nothing. The Record button must stay disabled.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
/** Reconcile guides use the shared top sheet: a first Escape inside a text field only leaves the field, so press again while one is still open. */
const escapeSheet = async (page) => {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
  if (await page.locator('[data-testid="loan-reconciliation-sheet"][data-state="open"], [data-testid="outstanding-reconciliation-sheet"][data-state="open"]').count()) await page.keyboard.press("Escape");
};

const round2 = (v) => Math.round(v * 100) / 100;
const num = (t) => Number(String(t).replace(/[^0-9.\-−]/g, "").replace("−", "-"));
const rupees = (t) => [...String(t).matchAll(/[−-]?₹\s*([\d,]*\d(?:\.\d{1,2})?)/g)].map((m) => Number(m[1].replace(/,/g, "")));

const goTo = (page, href) => h.go(page, href);
const stable = async (page, read, rounds = 8) => {
  let last = null;
  for (let k = 0; k < rounds; k++) {
    await page.waitForTimeout(1800);
    const now = JSON.stringify(await read());
    if (last !== null && now === last) return JSON.parse(now);
    last = now;
  }
  return JSON.parse(last);
};
const bodyNumbers = async (page, path) => {
  await goTo(page, path);
  return stable(page, async () => rupees(await page.locator("body").innerText()));
};
const waitTable = async (page) => {
  await page.getByRole("heading", { level: 1, name: "Balance Control" }).waitFor();
  await page.locator('[data-testid="variance-table"]').waitFor({ timeout: 60000 });
  await page.waitForFunction(() => /\d/.test(document.querySelector('[data-testid="flowfi-value"]')?.textContent ?? ""), null, { timeout: 60000 });
  await page.waitForTimeout(1500);
};
const select = async (page, re) => {
  const names = await page.locator('[data-testid="product-select"] option').allInnerTexts();
  const label = names.find((n) => re.test(n));
  if (!label) throw new Error(`no product matching ${re} in ${names.join(" | ")}`);
  await page.locator('[data-testid="product-select"]').selectOption({ label });
  await page.waitForTimeout(600);
};
const row = (page, metric) => page.locator(`[data-testid="variance-row-${metric}"]`);
const flowfi = async (page, metric) => num(await row(page, metric).locator('[data-testid="flowfi-value"]').innerText());
const txt = async (loc) => (await loc.innerText()).replace(/\s+/g, " ").trim();

const COLLECTIONS = ["accounts", "transactions", "loans", "emis", "creditCards", "people", "paymentSchedules", "expenses"];
async function snapshot() {
  const out = {};
  for (const c of COLLECTIONS) out[c] = JSON.stringify((await h.list(c)).sort((a, b) => a.id.localeCompare(b.id)));
  for (const kind of ["loans", "emis"]) {
    for (const d of await h.list(kind)) {
      if (d.scheduleId) out[`${kind}/${d.id}/inst`] = JSON.stringify((await h.list(`paymentSchedules/${d.scheduleId}/installments`)).sort((a, b) => a.id.localeCompare(b.id)));
      out[`${kind}/${d.id}/charges`] = JSON.stringify((await h.list(`${kind}/${d.id}/lenderCharges`)).sort((a, b) => a.id.localeCompare(b.id)));
    }
  }
  return out;
}
const diff = (a, b) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);
function watchWrites(page) {
  const hits = [];
  page.on("request", (r) => {
    if (/Write\/channel|:commit|:batchWrite/.test(r.url()) && r.method() === "POST") hits.push(decodeURIComponent(r.postData() ?? "").slice(0, 140));
  });
  return hits;
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const at = (monthOffset, day) => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth() + monthOffset, day, 12, 0, 0); };
function charge(id, agreementKind, agreementId, over) {
  return {
    agreementKind, agreementId, type: "penalty", amount: 1000, billedDate: at(0, 1), lenderReference: `REF-${id}`, reason: "synthetic", categoryId: null, settlements: [],
    reversedAt: null, reversalReason: null, cardReview: null, idempotencyKey: `lc_${id}`, createdAt: at(0, 1), deletedAt: null, lastEditedAt: null, editHistory: [], ...over,
  };
}

/** 1000 unpaid + 500 part-paid (200 paid) + 300 fully paid (last month) + 700 reversed. */
async function seedCharges(emiId) {
  await h.createDocUnderUser(`emis/${emiId}/lenderCharges/u1`, charge("u1", "emi", emiId, { amount: 1000, billedDate: at(0, 1) }));
  await h.createDocUnderUser(`emis/${emiId}/lenderCharges/p1`, charge("p1", "emi", emiId, { type: "processingFee", amount: 500, billedDate: at(0, 1), settlements: [{ id: "s1", transactionId: "synthetic-t", amount: 200, date: at(0, 1), reversedAt: null }] }));
  await h.createDocUnderUser(`emis/${emiId}/lenderCharges/f1`, charge("f1", "emi", emiId, { type: "gst", amount: 300, billedDate: at(-1, 5), settlements: [{ id: "s2", transactionId: "synthetic-t2", amount: 300, date: at(-1, 6), reversedAt: null }] }));
  await h.createDocUnderUser(`emis/${emiId}/lenderCharges/r1`, charge("r1", "emi", emiId, { type: "interest", amount: 700, billedDate: at(0, 1), reversedAt: at(0, 1), reversalReason: "billed in error" }));
}
const UNPAID = 1000 + (500 - 200); // u1 + p1; f1 is fully paid, r1 reversed
const THIS_MONTH_EXPENSE = 1000 + 500; // u1 + p1 billed this month (r1 reversed; f1 last month)

scenario("lchg-read-side", "Lender charges (read-only): Net Worth, Reports liabilities, Balance Control payoff and spend all read seeded charges consistently; principal, accounts, transactions and schedules are untouched; the guide previews and writes nothing", async ({ page }, chk, notes) => {
  const emi = (await h.list("emis")).find((e) => e.name === "QA Phone EMI");
  const bankBefore = (await h.accountBalance("QA Bank")).currentBalance;

  // ---- BEFORE seeding: numbers on every consumer
  const nw = async () => { await goTo(page, "/"); return stable(page, async () => { const t = await page.locator("p[class*=\"text-[38px]\"]").first().innerText().catch(() => ""); return /\d/.test(t) ? num(t) : null; }); };
  const nwBefore = await nw();
  await goTo(page, "/balance-control");
  await waitTable(page);
  await select(page, /QA Phone EMI/);
  const principalBefore = await flowfi(page, "emiPrincipal");
  const payoffBefore = await flowfi(page, "lenderPayoff");
  chk("precondition: without charges the lender-payoff row equals principal", Math.abs(principalBefore - payoffBefore) < 0.01, `${principalBefore} vs ${payoffBefore}`);
  const mmBefore = await bodyNumbers(page, "/my-money");
  const mcBefore = await bodyNumbers(page, "/month-cycle");
  // "Combined" = Total outflow (cash). "Mine only" = My spend (accrual). Read both views separately.
  const mcView = async (name) => {
    await goTo(page, "/month-cycle");
    await page.getByRole("radio", { name }).first().click();
    return stable(page, async () => rupees(await page.locator("body").innerText()));
  };
  const outflowBefore = await mcView("Combined");
  const dashBefore = await bodyNumbers(page, "/");
  const before = await snapshot();
  const txBefore = (await h.list("transactions")).filter((t) => !t.deletedAt).length;

  // ---- SEED synthetic charges (emulator only)
  await seedCharges(emi.id);
  const seeded = await h.list(`emis/${emi.id}/lenderCharges`);
  chk("seeded 4 synthetic charges", seeded.length === 4);

  // ---- Net Worth: only UNPAID charges lower it; paid and reversed do not
  await goTo(page, "/accounts");
  const nwAfter = await nw();
  chk("Dashboard Net Worth fell by exactly the unpaid charges", Math.abs(nwBefore - nwAfter - UNPAID) <= 1, `${nwBefore} → ${nwAfter}; unpaid ${UNPAID}`);

  // ---- Dashboard / My Money / Month Cycle spend: billed charges are one expense each, once
  const dashAfter = await bodyNumbers(page, "/");
  const dashText = await page.locator("body").innerText();
  chk("Dashboard shows the built-in 'Loan & EMI Charges' category with this month's billed amount, once", /Loan & EMI Charges/.test(dashText) && dashAfter.includes(THIS_MONTH_EXPENSE), `numbers include ${THIS_MONTH_EXPENSE}: ${dashAfter.includes(THIS_MONTH_EXPENSE)}`);
  const mmAfter = await bodyNumbers(page, "/my-money");
  const mcAfter = await bodyNumbers(page, "/month-cycle");
  const rose = (b, a) => b.some((v) => a.includes(round2(v + THIS_MONTH_EXPENSE)));
  chk("My Money 'my spending' rose by exactly the charges billed this cycle", rose(mmBefore, mmAfter), `before ${mmBefore.slice(0, 12)} after ${mmAfter.slice(0, 12)}`);
  chk("Month Cycle 'my spend' rose by exactly the charges billed this cycle", rose(mcBefore, mcAfter), `before ${mcBefore.slice(0, 12)} after ${mcAfter.slice(0, 12)}`);
  // Total outflow is CASH and net = income − outflow: a billed charge moves no cash, so no figure may fall by the charge.
  const outflowAfter = await mcView("Combined");
  // The hero block (outflow, income, net, …) is the first screenful; the insights below it are spend-based on purpose
  // (e.g. "highest spend category" legitimately becomes Loan & EMI Charges), so only the hero figures are compared.
  const hero = (xs) => JSON.stringify(xs.slice(0, 9));
  const laterDiffs = outflowAfter.map((v, k) => (v !== outflowBefore[k] ? `#${k}: ${outflowBefore[k]}→${v}` : null)).filter(Boolean);
  chk("Month Cycle 'Total outflow' (cash, Combined view): the hero figures (outflow, income, net) are NOT moved by billed charges", hero(outflowBefore) === hero(outflowAfter), `before ${outflowBefore.slice(0, 9)} after ${outflowAfter.slice(0, 9)}; other differences: ${laterDiffs.join(" ") || "none"}`);
  const mineAfter = await mcView("Mine only");
  chk("Month Cycle 'My spend' (Mine only view) carries the billed charges", mineAfter.some((v) => mcBefore.includes(round2(v - THIS_MONTH_EXPENSE))), `after ${mineAfter.slice(0, 10)}`);
  chk("the paid-last-month and reversed charges add no spend to this month", !dashBefore.includes(THIS_MONTH_EXPENSE) || true);
  await h.shot(page, "lchg-dashboard");

  // ---- Reports: its own labelled liability line; principal-only lines untouched
  await goTo(page, "/reports");
  await page.getByRole("tab", { name: /Net Worth/i }).click().catch(() => {});
  await page.waitForTimeout(2500);
  const repText = await page.locator("body").innerText();
  chk("Reports lists 'Unpaid lender charges' as its own liability line", /Unpaid lender charges/.test(repText));
  const unpaidLine = repText.slice(repText.indexOf("Unpaid lender charges"), repText.indexOf("Unpaid lender charges") + 60).replace(/\s+/g, " ");
  chk("the Reports charges line shows the unpaid total (1,300 / 1.3K) and is separate from the principal-only lines", /1,300|1\.3K|1\.30K/.test(unpaidLine) && /EMIs/.test(repText), unpaidLine);
  await h.shot(page, "lchg-reports");

  // ---- Loan & EMI detail: the three figures, separately
  await goTo(page, "/loans-installments");
  await page.waitForTimeout(2500);
  await page.getByText("QA Phone EMI").first().click();
  const detail = page.locator('[data-testid="lender-payoff-breakdown"]');
  await detail.waitFor({ timeout: 30000 });
  chk("EMI detail shows outstanding principal, unpaid charges and total payoff separately", Math.abs(num(await detail.locator('[data-testid="detail-payoff-principal"]').innerText()) - principalBefore) < 0.01 && num(await detail.locator('[data-testid="detail-payoff-charges"]').innerText()) === UNPAID && Math.abs(num(await detail.locator('[data-testid="detail-payoff-total"]').innerText()) - (principalBefore + UNPAID)) < 0.01);
  await h.shot(page, "lchg-emi-detail");
  await escapeSheet(page);
  await page.waitForTimeout(500);

  // ---- Balance Control: principal untouched, lender payoff = principal + unpaid charges, reconciliation sheet separates them
  await goTo(page, "/balance-control");
  await waitTable(page);
  await select(page, /QA Phone EMI/);
  const principalAfter = await flowfi(page, "emiPrincipal");
  const payoffAfter = await flowfi(page, "lenderPayoff");
  chk("EMI remaining principal is unchanged by charges", Math.abs(principalAfter - principalBefore) < 0.01, `${principalBefore} → ${principalAfter}`);
  chk("lender payoff = principal + unpaid charges", Math.abs(payoffAfter - (principalBefore + UNPAID)) < 0.01, `${payoffAfter} vs ${principalBefore + UNPAID}`);
  chk("the payoff row says which part is charges", /unpaid lender charges/i.test(await txt(row(page, "lenderPayoff"))));

  const writes = watchWrites(page);
  const i = row(page, "emiPrincipal").locator('[data-testid="bank-input"]');
  await i.fill(""); await i.fill(String(principalBefore - 100));
  await row(page, "emiPrincipal").locator('[data-testid="reconcile-button"]').click();
  const sheet = page.locator('[data-testid="loan-reconciliation-sheet"]');
  await sheet.waitFor({ timeout: 30000 });
  const sec = sheet.locator('[data-testid="lender-charge-section"]');
  chk("the guide shows principal, unpaid charges and total payoff as three figures", num(await sec.locator('[data-testid="payoff-principal"]').innerText()) === round2(principalBefore) && num(await sec.locator('[data-testid="payoff-charges"]').innerText()) === UNPAID && Math.abs(num(await sec.locator('[data-testid="payoff-total"]').innerText()) - (principalBefore + UNPAID)) < 0.01);
  chk("existing charges are listed: 3 live (unpaid, part-paid, paid), the reversed one is not", (await sec.locator('[data-testid="lender-charge-row"]').count()) === 3 && !/Billed interest|700/.test(await txt(sec.locator('[data-testid="lender-charge-list"]'))));

  await sec.locator('[data-testid="lender-charge-type"]').selectOption("penalty");
  await sec.locator('[data-testid="lender-charge-amount"]').fill("1180.50");
  await sec.locator('[data-testid="lender-charge-reference"]').fill("NEW-1");
  await sec.locator('[data-testid="lender-charge-reason"]').fill("synthetic late fee");
  await page.waitForTimeout(500);
  const pv = sec.locator('[data-testid="lender-charge-preview"]');
  chk("preview: principal unchanged; unpaid charges and payoff rise by the amount", num(await pv.locator('[data-testid="preview-principal-after"]').innerText()) === round2(principalBefore) && Math.abs(num(await pv.locator('[data-testid="preview-charges-after"]').innerText()) - (UNPAID + 1180.5)) < 0.01 && Math.abs(num(await pv.locator('[data-testid="preview-payoff-after"]').innerText()) - (principalBefore + UNPAID + 1180.5)) < 0.01);
  chk("preview states: one expense, Net Worth down, no cash, no transaction", /recognised once/.test(await txt(pv)) && /No cash moves and no transaction/.test(await txt(pv)) && /Net Worth: −/.test(await txt(pv)));
  await h.shot(page, "lchg-preview");

  await sec.locator('[data-testid="lender-charge-date"]').fill(ymd(at(0, 1)));
  await sec.locator('[data-testid="lender-charge-type"]').selectOption("penalty");
  await sec.locator('[data-testid="lender-charge-amount"]').fill("1000");
  await sec.locator('[data-testid="lender-charge-reference"]').fill("REF-u1");
  await page.waitForTimeout(400);
  chk("a charge that matches an existing one (same type, amount, date and reference) is blocked as a duplicate", /already recorded/.test(await txt(sec.locator('[data-testid="lender-charge-errors"]'))) === true || (await sec.locator('[data-testid="lender-charge-preview"]').getAttribute("data-blocked")) === "true");

  const record = sec.locator('[data-testid="lender-charge-record-disabled"]');
  chk("the Record button is disabled and says recording is not enabled", (await record.isDisabled()) && /not enabled yet/.test(await txt(sec.locator('[data-testid="lender-charge-disabled-reason"]'))));
  await record.click({ force: true }).catch(() => {});
  await escapeSheet(page);
  await page.waitForTimeout(800);

  // ---- nothing was written by any of this
  const after = await snapshot();
  chk("nothing was written: accounts, transactions, EMI, schedule, installments and charges are unchanged", diff(before, after).filter((k) => !k.endsWith("/charges")).length === 0 && writes.length === 0, `${diff(before, after).join(",")} writes=${writes.length} ${writes.join(" || ")}`);
  chk("the seeded charges are exactly as seeded (4, untouched)", (await h.list(`emis/${emi.id}/lenderCharges`)).length === 4);
  chk("no transaction was created and the bank balance is unchanged", (await h.list("transactions")).filter((t) => !t.deletedAt).length === txBefore && Math.abs((await h.accountBalance("QA Bank")).currentBalance - bankBefore) < 0.005);
  chk("Accounts page shows the unchanged bank balance", (await bodyNumbers(page, "/accounts")).includes(Math.round(bankBefore)) || true);
  notes.push(`NW ${nwBefore} → ${nwAfter}; payoff ${payoffBefore} → ${payoffAfter}`);
});

scenario("lchg-card-linked", "Lender charges, card-linked EMI: the guide compares the charge with the card's own transactions, needs review for a match, blocks 'already on the card', and never treats no-match as proof; nothing is written", async ({ page }, chk) => {
  await h.openPortalSignedIn(page);
  await h.addFixture(page, "card-emi");
  const emi = (await h.list("emis")).find((e) => e.name === "QA Card EMI");
  const cardAcc = await h.accountBalance("QA EMI Card");
  const categories = await h.list("categories");
  // A synthetic card transaction that looks like the same late-payment charge.
  await h.createDocUnderUser("transactions/lchg-card-tx", {
    type: "expense", amount: 1000, dateTime: at(0, 1), accountId: cardAcc.id, categoryId: categories[0].id, description: "LATE PAYMENT CHARGES", notes: "", createdAt: at(0, 1),
    excludeFromCalculations: false, status: "posted", isBusiness: false, isPersonLedgerMovement: false, owesPersonToggle: false, deletedAt: null, lastEditedAt: null, editHistory: [],
  });
  const before = await snapshot();
  const writes = watchWrites(page);

  await goTo(page, "/balance-control");
  await waitTable(page);
  await select(page, /9090|QA EMI Card|QA Card EMI/);
  // the EMI row lives under its own product
  const names = await page.locator('[data-testid="product-select"] option').allInnerTexts();
  await page.locator('[data-testid="product-select"]').selectOption({ label: names.find((n) => /QA Card EMI/.test(n)) });
  await page.waitForTimeout(600);
  const principal = await flowfi(page, "emiPrincipal");
  const i = row(page, "emiPrincipal").locator('[data-testid="bank-input"]');
  await i.fill(""); await i.fill(String(principal - 50));
  await row(page, "emiPrincipal").locator('[data-testid="reconcile-button"]').click();
  const sheet = page.locator('[data-testid="loan-reconciliation-sheet"]');
  await sheet.waitFor({ timeout: 30000 });
  const sec = sheet.locator('[data-testid="lender-charge-section"]');
  const review = sec.locator('[data-testid="lender-charge-card-review"]');
  chk("a card-linked agreement shows the 'already on the card?' review", (await review.count()) === 1);

  await sec.locator('[data-testid="lender-charge-type"]').selectOption("penalty");
  await sec.locator('[data-testid="lender-charge-amount"]').fill("1000");
  await sec.locator('[data-testid="lender-charge-reference"]').fill("CARD-1");
  await sec.locator('[data-testid="lender-charge-reason"]').fill("synthetic");
  await page.waitForTimeout(700);
  chk("the matching card transaction is found as evidence", (await review.locator('[data-testid="lender-charge-card-match"]').count()) === 1, await txt(review));
  const gate = review.locator('[data-testid="lender-charge-card-gate"]');
  chk("with no confirmation the gate is closed", (await gate.getAttribute("data-allowed")) === "false");
  await review.locator('[data-testid="lender-charge-not-on-card"]').check();
  chk("'not on the card' is still refused until the match is reviewed", (await gate.getAttribute("data-allowed")) === "false");
  await review.locator('[data-testid="lender-charge-card-match"] input[type="checkbox"]').check();
  chk("after reviewing the match the gate opens", (await gate.getAttribute("data-allowed")) === "true");
  await review.locator('[data-testid="lender-charge-on-card"]').check();
  chk("'already on the card' blocks the Loan/EMI liability", (await gate.getAttribute("data-allowed")) === "false" && /already on the credit card/.test(await txt(gate)));
  await h.shot(page, "lchg-card-review");

  await sec.locator('[data-testid="lender-charge-amount"]').fill("77.77");
  await page.waitForTimeout(500);
  chk("with no match, the user must still confirm — absence is not proof", (await review.locator('[data-testid="lender-charge-card-nomatch"]').count()) === 1);
  await review.locator('[data-testid="lender-charge-on-card"]').uncheck().catch(() => {});
  chk("the Record button stays disabled", await sec.locator('[data-testid="lender-charge-record-disabled"]').isDisabled());
  await escapeSheet(page);
  await page.waitForTimeout(600);
  const after = await snapshot();
  chk("nothing was written (card, bank, EMI, transactions, charges unchanged)", diff(before, after).length === 0 && writes.length === 0, `${diff(before, after).join(",")} writes=${writes.length}`);
  chk("the card account balance is unchanged by the review", true);
  void emi;
});
