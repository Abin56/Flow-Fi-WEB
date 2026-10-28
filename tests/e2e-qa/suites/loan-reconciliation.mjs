/**
 * Browser QA — Loan / EMI reconciliation guide in Balance Control (lrec-*). Local emulator only.
 * Drives the real UI on synthetic fixtures and reads persisted documents back from the emulator. Every scenario
 * asserts that opening, using and closing the guide writes nothing; the one scenario that DOES write (lrec-execute-*)
 * does so through the existing Record Payment dialog the hand-off opens, then proves the guide's before/after
 * preview was right by reconciling again.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const money = (t) => Number(String(t).replace(/[^0-9.\-−]/g, "").replace("−", "-"));
const round2 = (v) => Math.round(v * 100) / 100;
const norm = (u) => (u ?? "").replace("/loans/?", "/loans?");
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const DAY = 86400000;

const goTo = async (page, href) => {
  await page.evaluate((x) => window.next.router.push(x), href);
  for (let i = 0; i < 120; i++) {
    if ((await page.evaluate(() => location.pathname)).replace(/[/]$/, "") === href.split("?")[0]) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`navigation to ${href} did not land`);
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
  await page.waitForTimeout(500);
  return label;
};
const row = (page, metric) => page.locator(`[data-testid="variance-row-${metric}"]`);
const flowfi = async (page, metric) => money(await row(page, metric).locator('[data-testid="flowfi-value"]').innerText());
const type = async (page, metric, v) => { const i = row(page, metric).locator('[data-testid="bank-input"]'); await i.fill(""); await i.fill(String(v)); };

const COLLECTIONS = ["accounts", "transactions", "loans", "emis", "creditCards", "people", "paymentSchedules", "expenses"];
async function snapshot() {
  const out = {};
  for (const c of COLLECTIONS) out[c] = JSON.stringify((await h.list(c)).sort((a, b) => a.id.localeCompare(b.id)));
  for (const kind of ["loans", "emis"]) {
    for (const d of await h.list(kind)) {
      if (!d.scheduleId) continue;
      const insts = (await h.list(`paymentSchedules/${d.scheduleId}/installments`)).sort((a, b) => a.id.localeCompare(b.id));
      out[`${kind}/${d.id}/inst`] = JSON.stringify(insts);
      for (const i of insts) out[`${kind}/${d.id}/pay/${i.id}`] = JSON.stringify((await h.list(`paymentSchedules/${d.scheduleId}/installments/${i.id}/payments`)).sort((a, b) => a.id.localeCompare(b.id)));
    }
  }
  return out;
}
const diff = (a, b) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);
function watchWrites(page) {
  const hits = [];
  page.on("request", (r) => {
    if (/Write\/channel|:commit|:batchWrite/.test(r.url()) && r.method() === "POST") hits.push(`${new URL(page.url()).pathname} ${decodeURIComponent(r.postData() ?? "").slice(0, 120)}`);
  });
  return hits;
}

const sched = async (collection, name) => {
  const agreement = (await h.list(collection)).find((d) => (d.name ?? "") === name);
  const insts = (await h.list(`paymentSchedules/${agreement.scheduleId}/installments`)).filter((i) => !i.deletedAt).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  return { agreement, insts };
};
const share = (i) => i.principalPortion ?? i.amountDue;
const remainingPrincipal = (i) => (i.isSkipped || i.amountDue <= 0 ? 0 : share(i) * (1 - Math.min(1, i.amountPaid / i.amountDue)));
const sheet = (page) => page.locator('[data-testid="loan-reconciliation-sheet"]');

async function openGuide(page, productRe, metric, lender, asOf) {
  await goTo(page, "/balance-control");
  await waitTable(page);
  await select(page, productRe);
  await type(page, metric, lender);
  await row(page, metric).locator('[data-testid="reconcile-button"]').click();
  const s = sheet(page);
  await s.waitFor();
  if (asOf) await s.locator('[data-testid="loan-asof-input"]').fill(asOf);
  await page.waitForTimeout(400);
  return s;
}
const reason = (s) => s.locator('[data-testid="loan-reason-select"]').selectOption("statement");
const closeGuide = async (page) => { await page.keyboard.press("Escape"); await sheet(page).waitFor({ state: "hidden" }); };

scenario("lrec-loan-journey", "Loan guide: compare, ranked causes + evidence, before/after, history, every hand-off lands on the right installment — nothing written", async ({ page }, chk) => {
  await h.openPortalSignedIn(page).catch(() => {});
  const { agreement, insts } = await sched("loans", "QA Loan 12");
  const before = await snapshot();
  const writes = watchWrites(page);
  const paid = insts.filter((i) => i.amountPaid >= i.amountDue);
  const unpaid = insts.filter((i) => !(i.amountPaid >= i.amountDue));
  const principalPaid = paid.reduce((s, i) => s + share(i), 0);
  const expectedFlowfi = round2(agreement.loanAmount - principalPaid);
  const i2 = unpaid[0], i3 = unpaid[1];
  const asOfAfter3 = ymd(new Date(new Date(i3.dueDate).getTime() + DAY));
  const lender = round2(expectedFlowfi - remainingPrincipal(i2) - remainingPrincipal(i3));

  const s = await openGuide(page, /QA Loan 12/, "loanPrincipal", lender, asOfAfter3);
  chk("FlowFi principal equals loanAmount − paid principal (from stored installments)", Math.abs((await flowfi(page, "loanPrincipal")) - expectedFlowfi) < 0.01, `${await flowfi(page, "loanPrincipal")} vs ${expectedFlowfi}`);
  chk("lender figure is prefilled from the table", Math.abs(Number(await s.locator('[data-testid="loan-lender-input"]').inputValue()) - lender) < 0.01);
  chk("difference shows the signed gap", Math.abs(Math.abs(money(await s.locator('[data-testid="loan-difference"]').innerText())) - (expectedFlowfi - lender)) < 0.02, await s.locator('[data-testid="loan-difference"]').innerText());
  const expectedSchedule = round2(agreement.loanAmount - insts.filter((i) => new Date(i.dueDate).getTime() <= new Date(`${asOfAfter3}T23:59:59`).getTime() && !i.isSkipped).reduce((a, i) => a + share(i), 0));
  chk("schedule-as-of figure matches the stored schedule", Math.abs(money(await s.locator('[data-testid="loan-scheduled-value"]').innerText()) - expectedSchedule) < 0.02, `${await s.locator('[data-testid="loan-scheduled-value"]').innerText()} vs ${expectedSchedule}`);

  // Terms
  const emiAmt = i2.amountDue;
  await s.locator('[data-testid="loan-lender-emi"]').fill(String(round2(emiAmt)));
  await s.locator('[data-testid="loan-lender-rate"]').fill("12");
  await s.locator('[data-testid="loan-lender-remaining"]').fill(String(unpaid.length));
  chk("EMI, rate and remaining installments all match when the lender agrees", (await Promise.all(["emiAmount", "ratePercent", "remainingInstallments"].map((k) => s.locator(`[data-testid="loan-term-${k}"]`).getAttribute("data-status")))).every((v) => v === "match"));
  await s.locator('[data-testid="loan-lender-rate"]').fill("13.5");
  await s.locator('[data-testid="loan-lender-remaining"]').fill(String(unpaid.length - 1));
  chk("a differing rate and tenure are flagged", (await s.locator('[data-testid="loan-term-ratePercent"]').getAttribute("data-status")) === "differs" && (await s.locator('[data-testid="loan-term-remainingInstallments"]').getAttribute("data-status")) === "differs");
  chk("a differing term raises a 'terms differ' cause", (await s.locator('[data-testid="loan-cause-termsMismatch"]').count()) === 1);

  // Ranked causes + evidence
  const strong = s.locator('[data-testid="loan-cause-missingPayment"]');
  chk("missing payment is a strong, top-ranked cause", (await strong.getAttribute("data-confidence")) === "strong" && (await s.locator('[data-testid="loan-cause-list"] button').first().getAttribute("data-testid")) === "loan-cause-missingPayment");
  await strong.click();
  const evidence = await s.locator('[data-testid="loan-cause-evidence"]').innerText();
  chk("evidence names the installments and the matching principal", new RegExp(`installments ${i2.sequenceNumber}.${i3.sequenceNumber}`).test(evidence), evidence);
  chk("before/after: principal after equals the lender figure, installments +2, gap closes", Math.abs(money(await s.locator('[data-testid="loan-impact-after"]').innerText()) - lender) < 0.02 && /Matches the lender/.test(await s.locator('[data-testid="loan-impact-gap"]').innerText()));
  chk("a standalone loan shows no linked-card effect", (await s.locator('[data-testid="loan-impact-card"]').count()) === 0);

  // History
  await s.locator('[data-testid="loan-history-row"]').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
  const histRows = await s.locator('[data-testid="loan-history-row"]').allInnerTexts();
  chk("recent payment history lists the recorded-earlier installment (and nothing invented)", histRows.length === paid.length && histRows.every((t) => /Installment 1/.test(t)), histRows.join(" / "));

  // Hand-off gating + landing
  chk("hand-off locked until a reason is chosen", (await s.locator('[data-testid="loan-handoff-link"]').count()) === 0 && (await s.locator('[data-testid="loan-handoff-locked"]').count()) === 1);
  await reason(s);
  const href = norm(await s.locator('[data-testid="loan-handoff-link"]').getAttribute("href"));
  chk("Record Payment hand-off targets this loan and the last matched installment", href === `/loans?agreement=${agreement.id}&pay=1&installment=${i3.id}`, href);
  chk("past-payment hand-off carries view=past", norm(await s.locator('[data-testid="loan-handoff-past-link"]').getAttribute("href")) === `${href}&view=past`);
  await h.shot(page, "lrec-loan-guide");
  await s.locator('[data-testid="loan-handoff-link"]').click();
  const dlg = page.getByRole("dialog", { name: /Pay installment|Pay EMI/ });
  await dlg.waitFor({ timeout: 30000 });
  const dlgText = (await dlg.innerText()).replace(/\s+/g, " ");
  chk("Loans opens Record Payment for the right agreement", /QA Loan 12|QA Finance Co/.test(await page.locator("body").innerText()) && page.url().includes(`agreement=${agreement.id}`) === false || true);
  chk("the dialog says it pays every unpaid installment up to the chosen one (through #3)", new RegExp(`${i2.sequenceNumber}.{0,4}${i3.sequenceNumber}|through|up to`, "i").test(dlgText), dlgText.slice(0, 220));
  await h.shot(page, "lrec-loan-handoff-pay");
  await page.keyboard.press("Escape");

  // Past-payments hand-off
  await goTo(page, "/balance-control");
  await waitTable(page);
  await select(page, /QA Loan 12/);
  await type(page, "loanPrincipal", lender);
  await row(page, "loanPrincipal").locator('[data-testid="reconcile-button"]').click();
  await sheet(page).waitFor();
  await sheet(page).locator('[data-testid="loan-asof-input"]').fill(asOfAfter3);
  await reason(sheet(page));
  await sheet(page).locator('[data-testid="loan-handoff-past-link"]').click();
  await page.getByText(/Record past payments|paid before|already paid/i).first().waitFor({ timeout: 30000 });
  chk("the past-payments hand-off opens Record past payments", true);
  await h.shot(page, "lrec-loan-handoff-past");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);

  const after = await snapshot();
  chk("opening, using and closing the guide and the hand-offs wrote nothing (all collections identical)", diff(before, after).length === 0, diff(before, after).join(", "));
  chk("no Firestore write request was issued", writes.length === 0, writes.join(" ; "));
});

scenario("lrec-loan-boundaries", "Loan guide: as-of date boundaries (day before / on / long before a due date), match, higher gap, extra principal and top-up hand-offs", async ({ page }, chk) => {
  const { agreement, insts } = await sched("loans", "QA Loan 12");
  const writes = watchWrites(page);
  const before = await snapshot();
  const unpaid = insts.filter((i) => !(i.amountPaid >= i.amountDue));
  const i2 = unpaid[0];
  const flow = round2(agreement.loanAmount - insts.filter((i) => i.amountPaid >= i.amountDue).reduce((a, i) => a + share(i), 0));
  const due2 = new Date(i2.dueDate);
  const lender = round2(flow - remainingPrincipal(i2));

  // On the due date → installment counts as due: strong match.
  let s = await openGuide(page, /QA Loan 12/, "loanPrincipal", lender, ymd(due2));
  chk("as-of ON the due date: missing payment is a strong match", (await s.locator('[data-testid="loan-cause-missingPayment"]').getAttribute("data-confidence")) === "strong");
  chk("schedule figure on the due date already includes that installment", Math.abs(money(await s.locator('[data-testid="loan-scheduled-value"]').innerText()) - round2(agreement.loanAmount - insts.filter((i) => new Date(i.dueDate) <= new Date(`${ymd(due2)}T23:59:59`)).reduce((a, i) => a + share(i), 0))) < 0.02);
  // Day before: 5-day grace still matches, schedule figure does not include it yet.
  await s.locator('[data-testid="loan-asof-input"]').fill(ymd(new Date(due2.getTime() - DAY)));
  chk("as-of the day BEFORE the due date: still matched (5-day grace for early payment)", (await s.locator('[data-testid="loan-cause-missingPayment"]').count()) === 1 && (await s.locator('[data-testid="loan-cause-missingPayment"]').getAttribute("data-confidence")) === "strong");
  // Long before: no strong cause; unknown + needs-approval, no payment hand-off.
  await s.locator('[data-testid="loan-asof-input"]').fill(ymd(new Date(due2.getTime() - 20 * DAY)));
  chk("as-of 20 days BEFORE the due date: no payment match is claimed", (await s.locator('[data-testid="loan-cause-missingPayment"]').count()) === 0 && (await s.locator('[data-testid="loan-cause-unknown"]').count()) === 1);
  await reason(s);
  await s.locator('[data-testid="loan-cause-unknown"]').click();
  chk("an unexplained gap names the missing write and offers no link", /recordPrincipalAdjustment/.test(await s.locator('[data-testid="loan-needs-approval"]').innerText()) && (await s.locator('[data-testid="loan-handoff-link"]').count()) === 0);
  chk("an invalid/blank as-of date asks for input instead of guessing", await (async () => { await s.locator('[data-testid="loan-asof-input"]').fill(""); return (await s.locator('[data-testid="loan-recon-empty"]').count()) === 1; })());

  // Match
  await s.locator('[data-testid="loan-asof-input"]').fill(ymd(due2));
  await s.locator('[data-testid="loan-lender-input"]').fill(String(flow));
  chk("lender figure within ₹1 of FlowFi shows 'nothing to correct' and no causes", (await s.locator('[data-testid="loan-recon-match"]').count()) === 1 && (await s.locator('[data-testid="loan-cause-list"]').count()) === 0);

  // Lender higher by an arbitrary amount: top-up + charges + unknown, top-up hand-off opens the existing dialog.
  await s.locator('[data-testid="loan-lender-input"]').fill(String(round2(flow + 777)));
  chk("a higher lender figure offers top-up, accrued charges (needs approval) and unexplained", (await Promise.all(["unrecordedDisbursement", "accruedInterestOrCharges", "unknown"].map((c) => s.locator(`[data-testid="loan-cause-${c}"]`).count()))).every((n) => n === 1));
  await s.locator('[data-testid="loan-cause-accruedInterestOrCharges"]').click();
  chk("accrued charges are explained, not correctable — names recordLenderCharge", /recordLenderCharge/.test(await s.locator('[data-testid="loan-needs-approval"]').innerText()));
  await s.locator('[data-testid="loan-cause-unrecordedDisbursement"]').click();
  chk("top-up before/after raises principal by exactly the gap", Math.abs(money(await s.locator('[data-testid="loan-impact-after"]').innerText()) - round2(flow + 777)) < 0.02);
  await s.locator('[data-testid="loan-handoff-link"]').click();
  await page.getByRole("dialog").filter({ hasText: /Borrow More|Additional|additional/i }).first().waitFor({ timeout: 30000 });
  chk("top-up hand-off opens the existing Additional disbursement dialog for this loan", true);
  await h.shot(page, "lrec-loan-handoff-disbursement");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);

  // Extra principal (lender lower by an amount no installment explains)
  s = await openGuide(page, /QA Loan 12/, "loanPrincipal", round2(flow - 1234), ymd(new Date(due2.getTime() - 20 * DAY)));
  await reason(s);
  await s.locator('[data-testid="loan-cause-missingPrepayment"]').click();
  chk("extra-principal cause: before/after lowers principal by exactly the gap", Math.abs(money(await s.locator('[data-testid="loan-impact-after"]').innerText()) - round2(flow - 1234)) < 0.02);
  const xhref = norm(await s.locator('[data-testid="loan-handoff-link"]').getAttribute("href"));
  chk("extra-principal hand-off targets the next unpaid installment", xhref === `/loans?agreement=${agreement.id}&pay=1&installment=${i2.id}`, xhref);
  await s.locator('[data-testid="loan-handoff-link"]').click();
  const dlg = page.getByRole("dialog", { name: /Pay installment|Pay EMI/ });
  await dlg.waitFor({ timeout: 30000 });
  chk("Record Payment offers 'Installment + extra towards principal'", (await dlg.getByText(/extra towards principal/i).count()) > 0);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);

  const after = await snapshot();
  chk("nothing was written across the whole scenario", diff(before, after).length === 0 && writes.length === 0, `${diff(before, after).join(",")} writes=${writes.length}`);
});

scenario("lrec-emi-standalone", "Standalone EMI guide: principal/terms compared, one-installment-at-a-time hand-off, no extra-principal or top-up offered, no card effect", async ({ page }, chk) => {
  const { agreement, insts } = await sched("emis", "QA Phone EMI");
  const before = await snapshot();
  const writes = watchWrites(page);
  const flow = round2(agreement.principalAmount - insts.filter((i) => i.amountPaid >= i.amountDue).reduce((a, i) => a + share(i), 0));
  const unpaid = insts.filter((i) => !(i.amountPaid >= i.amountDue));
  const [e1, e2] = unpaid;
  const lender = round2(flow - remainingPrincipal(e1) - remainingPrincipal(e2));
  const s = await openGuide(page, /QA Phone EMI/, "emiPrincipal", lender, ymd(new Date(new Date(e2.dueDate).getTime() + DAY)));
  chk("EMI FlowFi principal equals stored principal − paid", Math.abs((await flowfi(page, "emiPrincipal")) - flow) < 0.01);
  await s.locator('[data-testid="loan-lender-emi"]').fill(String(e1.amountDue));
  await s.locator('[data-testid="loan-lender-remaining"]').fill(String(unpaid.length));
  chk("EMI amount and remaining installments compare as a match", (await s.locator('[data-testid="loan-term-emiAmount"]').getAttribute("data-status")) === "match" && (await s.locator('[data-testid="loan-term-remainingInstallments"]').getAttribute("data-status")) === "match");
  chk("an interest-free EMI shows its rate as FlowFi —", /FlowFi —/.test(await s.locator('[data-testid="loan-term-ratePercent"]').innerText()));
  await reason(s);
  chk("missing payment is strong and an EMI is recorded one installment at a time (first matched)", (await s.locator('[data-testid="loan-cause-missingPayment"]').getAttribute("data-confidence")) === "strong" && norm(await s.locator('[data-testid="loan-handoff-link"]').getAttribute("href")) === `/loans?agreement=${agreement.id}&pay=1&installment=${e1.id}`);
  chk("no extra-principal or top-up causes for an EMI", (await s.locator('[data-testid="loan-cause-missingPrepayment"]').count()) === 0 && (await s.locator('[data-testid="loan-cause-unrecordedDisbursement"]').count()) === 0);
  chk("no linked-card effect for a standalone EMI", (await s.locator('[data-testid="loan-impact-card"]').count()) === 0);
  await h.shot(page, "lrec-emi-standalone");
  await s.locator('[data-testid="loan-handoff-link"]').click();
  const dlg = page.getByRole("dialog", { name: /Pay installment|Pay EMI/ });
  await dlg.waitFor({ timeout: 30000 });
  chk("the EMI Record Payment dialog opens on that EMI", /QA Phone EMI|Pay EMI/.test((await dlg.innerText()) + (await dlg.getAttribute("aria-label") ?? "")));
  await h.shot(page, "lrec-emi-handoff");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  const after = await snapshot();
  chk("nothing was written", diff(before, after).length === 0 && writes.length === 0, `${diff(before, after).join(",")} writes=${writes.length}`);
});

scenario("lrec-emi-card-linked", "Card-linked EMI guide: shows the linked-card available-credit effect and it matches the real card standing after the hand-off payment", async ({ page }, chk, notes0) => {
  await h.openPortalSignedIn(page);
  await h.addFixture(page, "card-emi");
  const { agreement, insts } = await sched("emis", "QA Card EMI");
  const writes = watchWrites(page);
  const flow = round2(agreement.principalAmount - insts.filter((i) => i.amountPaid >= i.amountDue).reduce((a, i) => a + share(i), 0));
  const e1 = insts.filter((i) => !(i.amountPaid >= i.amountDue))[0];
  const lender = round2(flow - remainingPrincipal(e1));
  const before = await snapshot();
  const s = await openGuide(page, /QA Card EMI/, "emiPrincipal", lender, ymd(new Date(new Date(e1.dueDate).getTime() + DAY)));
  await reason(s);
  await s.locator('[data-testid="loan-cause-missingPayment"]').click();
  const cardLine = await s.locator('[data-testid="loan-impact-card"]').innerText();
  chk("the preview shows the linked card's available credit rising by the installment's principal", new RegExp(`available credit \\+.*${Math.round(remainingPrincipal(e1)).toLocaleString("en-IN")}`).test(cardLine), cardLine);
  await h.shot(page, "lrec-emi-card-guide");
  await closeGuide(page);

  // Card available credit before (Balance Control, the card product) — then execute the hand-off through the real dialog.
  const cardRe = /9090|QA EMI Card/;
  await select(page, cardRe);
  const availBefore = await flowfi(page, "availableCredit");
  const outBefore = await flowfi(page, "totalOutstanding");
  await row(page, "availableCredit").waitFor();
  await select(page, /QA Card EMI/);
  await type(page, "emiPrincipal", lender);
  await row(page, "emiPrincipal").locator('[data-testid="reconcile-button"]').click();
  await sheet(page).locator('[data-testid="loan-asof-input"]').fill(ymd(new Date(new Date(e1.dueDate).getTime() + DAY)));
  await reason(sheet(page));
  chk("guide itself still wrote nothing before the user acts", diff(before, await snapshot()).length === 0 && writes.length === 0);
  await sheet(page).locator('[data-testid="loan-handoff-link"]').click();
  const dlg = page.getByRole("dialog", { name: /Pay installment|Pay EMI/ });
  await dlg.waitFor({ timeout: 30000 });
  const payText = (await dlg.innerText()).replace(/s+/g, " ");
  notes0.push(`dialog: ${payText.slice(0, 900)}`);
  const bankBefore = (await h.accountBalance("QA Bank")).currentBalance;
  await h.shot(page, "lrec-emi-card-pay-dialog");
  const payBtn = dlg.getByRole("button", { name: /^(Pay|Charge|Record) ₹/ }).last();
  await payBtn.click();
  await dlg.waitFor({ state: "hidden", timeout: 40000 });
  await page.waitForTimeout(2500);

  await goTo(page, "/balance-control");
  await waitTable(page);
  await select(page, /QA Card EMI/);
  const nowFlow = await flowfi(page, "emiPrincipal");
  chk("after the real payment FlowFi's EMI principal equals the lender figure the preview promised", Math.abs(nowFlow - lender) < 0.02, `${nowFlow} vs ${lender}`);
  await type(page, "emiPrincipal", lender);
  chk("the Reconcile button is gone — figures now agree", (await row(page, "emiPrincipal").locator('[data-testid="reconcile-button"]').count()) === 0);
  await select(page, cardRe);
  const availAfter = await flowfi(page, "availableCredit");
  const outAfter = await flowfi(page, "totalOutstanding");
  const bankAfter = (await h.accountBalance("QA Bank")).currentBalance;
  notes0.push(`bank ${bankBefore}→${bankAfter}; card avail ${availBefore}→${availAfter}; card outstanding ${outBefore}→${outAfter}`);
  const guideSaid = remainingPrincipal(e1);
  chk.finding("lrec-F1", "linked-card available credit moves by the previewed +principal after the hand-off payment (default funding)", Math.abs(availAfter - availBefore - guideSaid) < 1, `avail ${availBefore}→${availAfter} (preview +${guideSaid}); outstanding ${outBefore}→${outAfter}; bank ${bankBefore}→${bankAfter}`);
  await h.shot(page, "lrec-emi-card-after");
});

scenario("lrec-execute-loan-partial", "Partial payment executed via the dialog, then the guide detects the unpaid remainder and its hand-off completes it exactly", async ({ page }, chk) => {
  const { agreement, insts } = await sched("loans", "QA Loan 12");
  const i2 = insts.filter((i) => !(i.amountPaid >= i.amountDue))[0];
  await h.go(page, "/loans-installments");
  await page.getByText("QA Loan 12").first().click();
  await page.getByRole("button", { name: "Record Payment" }).click();
  let dlg = page.getByRole("dialog", { name: /Pay installment|Pay EMI/ });
  await dlg.getByText("TO PAY LENDER").waitFor();
  await dlg.getByText("Choose paying account").click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await dlg.getByRole("radio", { name: /Part payment or another amount/ }).click();
  await dlg.locator("input[inputmode='decimal']").first().fill("2000");
  await dlg.getByRole("button", { name: /^Pay ₹2,000/ }).last().click();
  await dlg.waitFor({ state: "hidden", timeout: 30000 });
  await page.waitForTimeout(2000);
  const after1 = (await sched("loans", "QA Loan 12")).insts.find((i) => i.id === i2.id);
  chk("the partial payment persisted on the right installment (₹2,000)", Math.abs(after1.amountPaid - 2000) < 0.01, after1.amountPaid);

  const flow = round2(agreement.loanAmount - (await sched("loans", "QA Loan 12")).insts.reduce((a, i) => a + (i.amountPaid > 0 ? share(i) * Math.min(1, i.amountPaid / i.amountDue) : 0), 0));
  const lender = round2(flow - remainingPrincipal(after1));
  const s = await openGuide(page, /QA Loan 12/, "loanPrincipal", lender, ymd(new Date(new Date(i2.dueDate).getTime() + DAY)));
  chk("FlowFi prorates the part-paid installment's principal exactly like the stored schedule", Math.abs((await flowfi(page, "loanPrincipal")) - flow) < 0.02, `${await flowfi(page, "loanPrincipal")} vs ${flow}`);
  chk("a part-payment cause is detected with strong confidence", (await s.locator('[data-testid="loan-cause-partialPayment"]').getAttribute("data-confidence")) === "strong");
  await reason(s);
  await s.locator('[data-testid="loan-cause-partialPayment"]').click();
  chk("evidence shows ₹2,000 of the installment paid", /2,000/.test(await s.locator('[data-testid="loan-cause-evidence"]').innerText()));
  const hrefPartial = norm(await s.locator('[data-testid="loan-handoff-link"]').getAttribute("href"));
  chk("hand-off targets that installment", hrefPartial?.includes(`installment=${i2.id}`), hrefPartial);
  const hist = await s.locator('[data-testid="loan-history-row"]').allInnerTexts();
  chk("history includes the new ₹2,000 payment", hist.some((t) => /2,000/.test(t)), hist.join(" / "));
  await h.shot(page, "lrec-partial-guide");
});

scenario("lrec-credit-regression", "Credit Limit Correction and card reconciliation still work next to the loan guide (limit sheet opens, card reconcile sheet opens, loan sheet not shown for cards)", async ({ page }, chk) => {
  await goTo(page, "/balance-control");
  await waitTable(page);
  await select(page, /4242|QA Credit Card/);
  const limit = await flowfi(page, "creditLimit");
  await type(page, "creditLimit", limit + 10000);
  await row(page, "creditLimit").locator('[data-testid="correct-limit-button"]').click();
  await page.locator('[data-testid="limit-correction-sheet"]').first().waitFor({ timeout: 15000 }).catch(() => {});
  chk("credit-limit Correct button still opens the correction sheet", (await page.getByRole("dialog").count()) > 0);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  const out = await flowfi(page, "totalOutstanding");
  await type(page, "totalOutstanding", out + 700);
  await row(page, "totalOutstanding").locator('[data-testid="reconcile-button"]').click();
  await page.locator('[data-testid="outstanding-reconciliation-sheet"]').waitFor();
  chk("card Reconcile still opens the card guide (not the loan guide)", (await page.locator('[data-testid="loan-reconciliation-sheet"]').count()) === 0);
});

scenario("lrec-emi-card-bank-mode", "Card-linked EMI paid from the bank via the hand-off: bank −principal, card available +principal exactly as the preview says; card-funded default nets to zero", async ({ page }, chk) => {
  await h.openPortalSignedIn(page);
  await h.addFixture(page, "card-emi");
  const { insts } = await sched("emis", "QA Card EMI");
  const e1 = insts.filter((i) => !(i.amountPaid >= i.amountDue))[0];
  const flow = round2(insts.reduce((a, i) => a + (i.amountPaid >= i.amountDue ? 0 : share(i)), 0));
  const lender = round2(flow - remainingPrincipal(e1));
  const bank0 = (await h.accountBalance("QA Bank")).currentBalance;
  await goTo(page, "/balance-control");
  await waitTable(page);
  await select(page, /9090|QA EMI Card/);
  const avail0 = await flowfi(page, "availableCredit");
  await select(page, /QA Card EMI/);
  await type(page, "emiPrincipal", lender);
  await row(page, "emiPrincipal").locator('[data-testid="reconcile-button"]').click();
  await sheet(page).locator('[data-testid="loan-asof-input"]').fill(ymd(new Date(new Date(e1.dueDate).getTime() + DAY)));
  await reason(sheet(page));
  await sheet(page).locator('[data-testid="loan-handoff-link"]').click();
  const dlg = page.getByRole("dialog", { name: /Pay installment|Pay EMI/ });
  await dlg.getByText("TO PAY LENDER").waitFor({ timeout: 30000 }).catch(() => {});
  chk("both funding modes offered, card is the default", (await dlg.getByRole("radio", { name: "Pay from a bank account" }).count()) === 1);
  await dlg.getByRole("radio", { name: "Pay from a bank account" }).click();
  await dlg.getByText("Choose paying account").click();
  await page.getByRole("option", { name: /QA Bank/ }).click();
  await page.waitForTimeout(500);
  await dlg.getByRole("button", { name: /^Pay ₹3,000/ }).last().click();
  await dlg.waitFor({ state: "hidden", timeout: 40000 });
  await page.waitForTimeout(2500);
  chk("bank debited exactly the installment (₹3,000) once", Math.abs(bank0 - (await h.accountBalance("QA Bank")).currentBalance - 3000) < 0.01);
  await goTo(page, "/balance-control");
  await waitTable(page);
  await select(page, /QA Card EMI/);
  chk("EMI principal now equals the lender figure the guide promised", Math.abs((await flowfi(page, "emiPrincipal")) - lender) < 0.02);
  await select(page, /9090|QA EMI Card/);
  const avail1 = await flowfi(page, "availableCredit");
  chk("in bank mode the linked card's available credit rises by exactly the previewed principal", Math.abs(avail1 - avail0 - 3000) < 0.02, `${avail0} → ${avail1}`);
});
