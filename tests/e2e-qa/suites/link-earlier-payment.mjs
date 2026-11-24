/**
 * Browser QA scenarios (link-earlier-payment.mjs). Local emulator only — see tests/e2e-qa/README.md.
 * "Past payment" of a Loan installment linked to an EXISTING expense (the seeded ₹850 "QA groceries" on QA Bank): the
 * transaction becomes the payment — nothing is posted, no account moves, it is counted once — and unlinking it (mark unpaid)
 * leaves the transaction and the account exactly as they were. Every claim is read back from the persisted documents.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";
import * as f from "../lib/flows.mjs";

const LOAN = "QA Loan 12";

async function openPay(page) {
  await h.go(page, "/loans-installments");
  await page.getByText(LOAN).first().click();
  await page.getByRole("button", { name: "Record Payment" }).click();
  const dlg = page.getByRole("dialog", { name: /Pay installment|Pay EMI/ });
  await dlg.getByText(/TO PAY LENDER|Lender installment balance/i).waitFor();
  return dlg;
}
const grocery = async () => (await h.list("transactions")).find((t) => t.description === "QA groceries" && !t.deletedAt);
const counted = async () => (await h.list("transactions")).filter((t) => !t.deletedAt && t.type === "expense" && String(t.excludeFromCalculations) !== "true");

scenario("link-past-payment", "Loan: link a past payment to an existing ₹850 expense → installment part-paid, no balance change, expense counted once; unpaid → unlinked, transaction intact", async ({ page }, chk) => {
  const bank0 = await f.bal("QA Bank");
  const tx0 = await grocery();
  const expenseTotal0 = (await counted()).reduce((s, t) => s + Number(t.amount), 0);
  const paid0 = f.paidTotal(await f.scheduleState("loan", LOAN));
  chk("(fixture) the ₹850 expense exists, unlinked", tx0 != null && Number(tx0.amount) === 850 && !tx0.earlierPaymentLink);

  // Past payment → one EMI → the form with "Link a transaction you already recorded".
  const dlg = await openPay(page);
  await dlg.getByRole("radio", { name: /Past payment/ }).click();
  await page.getByRole("button", { name: /^Continue with 1/ }).click();
  const past = page.getByRole("dialog", { name: /Record past payment/ });
  await past.getByText(/Link a transaction you already recorded/).waitFor();
  await h.shot(page, "link-form");
  await past.getByText(/Link a transaction you already recorded/).click();
  // "QA groceries" has nothing tying it to the loan, so it is NOT suggested — it is reachable only on request, behind a warning,
  // and linking needs an explicit confirmation.
  chk("the unrelated expense is not suggested by default", (await past.getByTestId("link-candidate").count()) === 0);
  await past.getByTestId("link-show-others").click();
  const candidate = past.getByTestId("link-candidate").filter({ hasText: "QA groceries" });
  chk("the ₹850 expense is reachable under 'other expenses'", (await candidate.count()) === 1);
  await candidate.click();
  chk("picking it links nothing until confirmed", (await past.getByTestId("linked-transaction").count()) === 0);
  await past.getByTestId("link-confirm").click();
  const linkedCard = past.getByTestId("linked-transaction");
  const cardText = await linkedCard.innerText();
  chk("the linked transaction is shown with its amount, date and account", /QA groceries/.test(cardText) && /850/.test(cardText) && /QA Bank/.test(cardText), cardText.replace(/\s+/g, " "));
  chk("the card says no balance changes and nothing is counted twice", /no balance changes/.test(cardText));
  const save = past.getByRole("button", { name: /^Save past payment of ₹850/ });
  chk("the save button states the exact linked amount", (await save.count()) > 0);
  await h.shot(page, "link-chosen");
  await page.evaluate(() => window.__reset());
  await save.click();
  await past.waitFor({ state: "hidden", timeout: 25000 });
  await page.waitForTimeout(2500);

  // Persisted truth.
  const state = await f.scheduleState("loan", LOAN);
  chk("the installment is part-paid by exactly ₹850 (persisted)", f.close2(f.paidTotal(state) - paid0, 850), JSON.stringify(state.map((i) => i.amountPaid)));
  chk("no money moved: QA Bank is exactly as before (persisted)", f.close2(await f.bal("QA Bank"), bank0), `${bank0} -> ${await f.bal("QA Bank")}`);
  const tx1 = await grocery();
  chk("the user's expense is untouched (amount, account, still live) and now marked as linked", tx1 != null && Number(tx1.amount) === 850 && tx1.earlierPaymentLink != null, JSON.stringify(tx1?.earlierPaymentLink));
  chk("the expense is still counted exactly once across the book", f.close2((await counted()).reduce((s, t) => s + Number(t.amount), 0), expenseTotal0), `${expenseTotal0}`);
  const scheduleId = (await h.list("loans")).find((l) => l.name === LOAN).scheduleId;
  const payments = (await Promise.all(state.map((i) => h.list(`paymentSchedules/${scheduleId}/installments/${i.id}/payments`).catch(() => [])))).flat().filter((p) => !p.deletedAt);
  chk("the payment document references that transaction", payments.some((p) => p.linkedTransactionId === tx0.id), payments.map((p) => p.linkedTransactionId).join(","));

  // Details: it says so, Edit is not offered, and marking it unpaid unlinks only.
  await h.go(page, "/loans-installments");
  await page.getByText(LOAN).first().click();
  await h.showSchedule(page);
  const rowButtons = page.getByRole("button", { name: /Installment \d+.*(edit or mark unpaid|view payment)/ });
  const target = rowButtons.filter({}).last();
  await target.click();
  const det = page.getByRole("dialog", { name: /Recorded payment/ });
  await det.waitFor();
  const detText = await f.flat(det);
  await h.shot(page, "link-details");
  chk("the details say it is linked to the transaction", /Linked to/.test(detText) && /QA groceries/.test(detText), detText.slice(0, 260));
  chk("editing the payment is not offered (its numbers belong to the transaction)", (await det.getByRole("button", { name: "Edit payment" }).count()) === 0 || (await det.getByRole("button", { name: "Edit payment" }).isDisabled().catch(() => true)));
  await det.getByRole("button", { name: "Mark as unpaid" }).click();
  const conf = page.getByRole("dialog").last();
  await conf.getByText(/linked transaction/i).waitFor();
  await conf.getByRole("button", { name: "Mark as unpaid" }).click();
  await page.waitForTimeout(3500);

  const after = await f.scheduleState("loan", LOAN);
  chk("the installment is unpaid again (persisted)", f.close2(f.paidTotal(after), paid0), JSON.stringify(after.map((i) => i.amountPaid)));
  chk("QA Bank is STILL exactly as before — unlinking never refunds or charges (persisted)", f.close2(await f.bal("QA Bank"), bank0), `${bank0} -> ${await f.bal("QA Bank")}`);
  const tx2 = await grocery();
  chk("the user's expense is intact and unlinked again (persisted)", tx2 != null && Number(tx2.amount) === 850 && !tx2.earlierPaymentLink && !tx2.deletedAt);
  chk("expense still counted once", f.close2((await counted()).reduce((s, t) => s + Number(t.amount), 0), expenseTotal0));
  return await h.timeline(page);
});
