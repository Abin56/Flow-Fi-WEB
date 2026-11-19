import { describe, expect, it } from "vitest";
import type { BillCycleRef, BillRow } from "@/features/bills/hooks/use-bills-data";
import { buildBillsOverview } from "@/features/bills/lib/bills-overview";
import type { EmiRow } from "@/features/emi/hooks/use-emi-data";
import type { LoanRow } from "@/features/loans/hooks/use-loans-data";
import { buildCompletedEvents, buildCycleObligations, makeCardLookup } from "@/features/my-money/lib/cycle-obligations";
import { groupCompleted, summarizeToPay } from "@/features/my-money/lib/my-money";
import { adjacentCycleRange, cycleRangeFor } from "@/lib/engines/month-cycle-range";
import type { Account } from "@/lib/models/account";
import type { BillOccurrence, PaymentRecord } from "@/lib/models/bill";
import type { CreditCardProfile, Statement } from "@/lib/models/credit-card";
import type { Installment } from "@/lib/models/payment-schedule";
import type { Transaction } from "@/lib/models/transaction";

/**
 * One hand-built month, Month Cycle starting on the 18th, "today" = 25 Oct 2026 (cycle 18 Oct → 17 Nov, next 18 Nov → 17 Dec).
 * Every expected rupee below is worked out by hand from the records — not by calling the code under test.
 */
const NOW = new Date(2026, 9, 25, 12);
const d = (m: number, day: number) => new Date(2026, m - 1, day, 12);
const cycle = cycleRangeFor(18, NOW);
const nextCycle = adjacentCycleRange(18, cycle, 1);

const base = { deletedAt: null, lastEditedAt: null, editHistory: [] as never[], createdAt: d(1, 1) };

const account = (id: string, name: string, over: Partial<Account> = {}) => ({ ...base, id, name, openingBalance: 0, type: "bank", ...over }) as unknown as Account;
const accounts = [account("acc-card", "HDFC Regalia", { type: "card" }), account("acc-bank", "SBI Savings")];

const card: CreditCardProfile = {
  ...base,
  id: "card-1",
  accountId: "acc-card",
  sharedLimitId: null,
  statementDay: 15,
  paymentDueDay: 5,
  creditLimit: 100000,
  minimumDuePercent: null,
  autoPay: false,
  status: "active",
  cardNetwork: null,
  lastFourDigits: "1234",
  issuer: null,
  annualFee: 0,
  joiningFee: 0,
  interestRatePercent: null,
  rewardNotes: null,
  autoDebitAccount: null,
  cardHolderName: null,
};

let seq = 0;
function txn(over: Partial<Transaction>): Transaction {
  seq += 1;
  return {
    ...base,
    id: `t-${seq}`,
    type: "expense",
    amount: 100,
    dateTime: d(10, 1),
    accountId: "acc-card",
    categoryId: "c",
    description: "",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    transferMatchedAt: null,
    loanId: null,
    emiId: null,
    installmentId: null,
    installmentPaymentId: null,
    paymentAllocationType: null,
    isPersonLedgerMovement: false,
    status: "posted",
    isBusiness: false,
    source: null,
    ...over,
  } as Transaction;
}

// Card statement 16 Sep → 15 Oct, due 5 Nov: ₹3,000 + ₹2,000 + the ₹12,000 phone purchase = ₹17,000. A ₹800 purchase on 20 Oct is the NEXT statement.
const emiPurchase = txn({ id: "t-phone-purchase", amount: 12000, dateTime: d(10, 2) });
const cardTxns = [txn({ amount: 3000, dateTime: d(9, 20) }), txn({ amount: 2000, dateTime: d(10, 1) }), emiPurchase, txn({ amount: 800, dateTime: d(10, 20) })];
const statement: Statement = {
  ...base,
  id: "st-oct",
  cardId: "card-1",
  periodStart: d(9, 16),
  periodEnd: d(10, 15),
  generatedDate: d(10, 15),
  dueDate: d(11, 5),
  totalAmount: 17000,
  minimumDue: 850,
  amountPaid: 0,
  interestCharged: null,
  lateFee: null,
};

function inst(id: string, seqNo: number, due: Date, amountDue: number, patch: Partial<Installment> = {}): Installment {
  return { ...base, id, scheduleId: "s", ownerType: "emi", ownerId: "o", sequenceNumber: seqNo, dueDate: due, amountDue, amountPaid: 0, isSkipped: false, principalPortion: null, interestPortion: null, ...patch };
}

const loanRow = (id: string, direction: "taken" | "given", installments: Installment[], scheduleId: string) =>
  ({
    loan: { id, name: id, scheduleId, isClosed: false, linkedCreditCardId: null, purchaseTransactionId: null, beneficiaryRepaysInstallments: false, ownershipShares: [] },
    lenderName: "SBI",
    direction,
    payerPersonId: null,
    payerName: null,
    installments,
    outstandingPrincipal: 20000,
  }) as unknown as LoanRow;

const emiRow = (id: string, scheduleId: string, installments: Installment[], link: { card?: string; purchase?: string } = {}) =>
  ({
    emi: { id, name: id, lenderName: "Bajaj", scheduleId, isClosed: false, linkedCreditCardId: link.card ?? null, purchaseTransactionId: link.purchase ?? null, beneficiaryRepaysInstallments: false, ownershipShares: [], autoDebitAccount: null },
    status: "active",
    installments,
    remainingBalance: 9000,
  }) as unknown as EmiRow;

const loanRows = [
  // Home: ₹5,000 due 3 Nov with ₹1,000 already paid → ₹4,000 still owed (partial). A LENT loan is money coming in — never a due.
  loanRow("home", "taken", [inst("h1", 1, d(11, 3), 5000, { amountPaid: 1000 })], "s-home"),
  loanRow("lent", "given", [inst("l1", 1, d(11, 6), 9999)], "s-lent"),
];
const emiRows = [
  // Phone EMI financed ON the card (purchase is in the statement above) → its installments are covered, never added.
  emiRow("phone", "s-phone", [inst("p1", 1, d(11, 8), 2000), inst("p2", 2, d(12, 8), 2000)], { card: "card-1", purchase: "t-phone-purchase" }),
  // Gym EMI paid from the bank: ₹1,500 due 12 Oct (earlier, unpaid → carried overdue), 12 Nov (this cycle), 12 Dec (next cycle).
  emiRow("gym", "s-gym", [inst("g0", 1, d(10, 12), 1500), inst("g1", 2, d(11, 12), 1500), inst("g2", 3, d(12, 12), 1500)]),
];

const occ = (id: string, billId: string, due: Date, amount: number, patch: Partial<BillOccurrence> = {}): BillOccurrence => ({ ...base, id, billId, dueDate: due, amount, amountPaid: 0, isSkipped: false, ...patch });
const billRow = (id: string, name: string, current: BillOccurrence): BillRow =>
  ({ bill: { ...base, id, name, amount: current.amount, nextDueDate: current.dueDate, recurrence: "monthly", accountId: "acc-bank", categoryId: null, customIntervalDays: null, reminderOffsets: [], notes: "" }, occurrence: current, account: accounts[1], category: undefined }) as unknown as BillRow;

const elecNext = occ("e2", "elec", d(11, 20), 1000); // next cycle
const elecNow = occ("e1", "elec", d(10, 20), 1000); // overdue, inside the cycle
const elecOld = occ("e0", "elec", d(9, 10), 500); // an old cycle reopened by a cancelled payment → carried overdue
const rent = occ("r1", "rent", d(11, 5), 10000, { amountPaid: 4000 }); // partly paid → ₹6,000 owed
const skipped = occ("k1", "gym-bill", d(11, 9), 700, { isSkipped: true });
const paidBill = occ("w1", "water", d(10, 21), 300, { amountPaid: 300 });
const billRows = [billRow("elec", "Electricity", elecNext), billRow("rent", "Rent", rent), billRow("gym-bill", "Gym fee", skipped), billRow("water", "Water", paidBill)];
const billCycles: BillCycleRef[] = [elecNext, elecNow, elecOld, rent, skipped, paidBill].map((o) => ({ billId: o.billId, occurrence: o }));

const lookup = makeCardLookup({ accounts, cards: [card], transactions: cardTxns });
const input = { cards: [card], transactions: cardTxns, statements: [statement], accounts, loanRows, emiRows, billRows, billCycles, now: NOW, lookup };

describe("buildCycleObligations — Month Cycle starting on the 18th", () => {
  const items = buildCycleObligations({ ...input, cycleRange: cycle });
  const counted = items.filter((i) => i.countsTowardTotal);
  const byKey = (k: string) => items.find((i) => i.key === k);

  it("uses the configured cycle, not the calendar month", () => {
    expect(cycle.start).toEqual(new Date(2026, 9, 18));
    expect(cycle.end.getMonth()).toBe(10);
    expect(cycle.end.getDate()).toBe(17);
  });

  it("every counted obligation lands at its live remainder (hand-computed)", () => {
    const rupees = (prefix: string) => counted.filter((i) => i.key.startsWith(prefix)).reduce((s, i) => s + i.remaining, 0);
    expect(rupees("bill:")).toBe(1000 + 500 + 6000); // overdue + carried-over + part-paid rent; skipped / paid bills absent
    expect(rupees("loan:")).toBe(4000); // 5,000 − 1,000 paid; the lent loan is not a due
    expect(rupees("emi:")).toBe(1500 + 1500); // carried 12 Oct + this cycle's 12 Nov; the Dec one is next cycle
    expect(rupees("card:")).toBe(17000); // the whole statement — the ₹800 purchase belongs to the next one
    expect(summarizeToPay(items).total).toBe(31500);
  });

  it("a card-funded EMI is listed but NOT added — the card statement already carries its purchase", () => {
    const phone = byKey("emi:phone:p1");
    expect(phone).toBeDefined();
    expect(phone!.countsTowardTotal).toBe(false);
    expect(phone!.note).toMatch(/Included in HDFC Regalia ••1234 bill/);
    expect(counted.some((i) => i.key.startsWith("emi:phone"))).toBe(false);
  });

  it("a bank-paid EMI IS added (Case B) — nothing else carries its money", () => {
    expect(byKey("emi:gym:g1")!.countsTowardTotal).toBe(true);
  });

  it("an earlier unpaid cycle stays visible, flagged carried-forward and overdue", () => {
    const old = byKey("bill:elec:e0")!;
    expect(old.carriedForward).toBe(true);
    expect(old.status).toBe("overdue");
    expect(byKey("emi:gym:g0")!.carriedForward).toBe(true);
    expect(summarizeToPay(items).overdue).toBe(1000 + 500 + 1500);
  });

  it("a partial payment shows only what is still owed, with the paid part kept", () => {
    const r = byKey("bill:rent:r1")!;
    expect(r.remaining).toBe(6000);
    expect(r.amountPaid).toBe(4000);
    expect(r.amountDue).toBe(10000);
    expect(byKey("loan:home:h1")!.remaining).toBe(4000);
  });

  it("skipped and fully paid cycles are never owed", () => {
    expect(byKey("bill:gym-bill:k1")).toBeUndefined();
    expect(byKey("bill:water:w1")).toBeUndefined();
  });

  it("each row points at the owning module's own pay flow — Bills never writes a loan / EMI / card payment itself", () => {
    expect(byKey("loan:home:h1")!.payHref).toBe("/loans?agreement=home&installment=h1&pay=1");
    expect(byKey("emi:gym:g1")!.payHref).toBe("/emi?agreement=gym&installment=g1&pay=1");
    expect(byKey("card:card-1:st-oct")!.payHref).toBe("/credit-cards?card=card-1&pay=1");
    expect(byKey("bill:rent:r1")!.payHref).toBeNull(); // bills are paid in place, through the bill payment repository
    expect(byKey("bill:rent:r1")!.occurrenceId).toBe("r1");
  });

  it("shows what is left on the whole loan / EMI, and the card's stored minimum due (never invented)", () => {
    expect(byKey("loan:home:h1")!.agreementRemaining).toEqual({ amount: 20000, label: "Principal outstanding" });
    expect(byKey("emi:gym:g1")!.agreementRemaining).toEqual({ amount: 9000, label: "Left on this EMI" });
    expect(byKey("card:card-1:st-oct")!.minimumDue).toBe(850);
    expect(byKey("card:card-1:st-oct")!.remaining).toBe(17000); // the minimum is context — the amount owed is still the whole statement
  });

  it("is deterministic and keys are unique — an obligation can never appear twice", () => {
    const again = buildCycleObligations({ ...input, cycleRange: cycle });
    expect(again.map((i) => i.key)).toEqual(items.map((i) => i.key));
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });
});

describe("Bills overview over the same records", () => {
  const cycleItems = buildCycleObligations({ ...input, cycleRange: cycle });
  const nextItems = buildCycleObligations({ ...input, cycleRange: nextCycle });
  const o = buildBillsOverview({ cycleObligations: cycleItems, nextCycleObligations: nextItems, completed: { groups: [], total: 0 } });

  it("Due this cycle / Overdue match the hand-computed figures", () => {
    expect(o.summary.dueThisCycle).toBe(31500);
    expect(o.summary.overdue).toBe(3000);
    expect(o.summary.stillToCome).toBe(28500);
  });

  it("Upcoming is only the next cycle's own, counted obligations", () => {
    // ₹1,000 electricity (20 Nov) + ₹800 open card statement (due 5 Dec) + ₹1,500 gym EMI (12 Dec); phone EMI (8 Dec) is covered.
    expect(o.upcoming.map((i) => i.kind).sort()).toEqual(["bill", "card", "emi"]);
    expect(o.upcoming.find((i) => i.key === "bill:elec:e2")!.remaining).toBe(1000);
    expect(o.upcoming.find((i) => i.kind === "card")!.remaining).toBe(800);
    expect(o.upcoming.find((i) => i.key === "emi:gym:g2")!.remaining).toBe(1500);
    expect(o.summary.upcoming).toBe(1000 + 800 + 1500);
    expect(o.upcoming.find((i) => i.kind === "card")!.billStillOpen).toBe(true);
  });

  it("nothing is in both Due this cycle and Upcoming", () => {
    const due = new Set([...o.overdue, ...o.dueThisCycle].map((i) => i.key));
    expect(o.upcoming.some((i) => due.has(i.key))).toBe(false);
  });

  it("covered installments are listed in both cycles but add to no total", () => {
    expect(o.coveredElsewhere.map((i) => i.key).sort()).toEqual(["emi:phone:p1", "emi:phone:p2"]);
    expect(o.summary.coveredElsewhere.amount).toBe(4000);
    expect(o.summary.dueThisCycle + o.summary.upcoming).toBe(31500 + 3300);
  });

  it("a selected FUTURE cycle still shows everything overdue — it is never dropped when the cycle rolls over", () => {
    const future = buildCycleObligations({ ...input, cycleRange: nextCycle });
    const carried = future.filter((i) => i.carriedForward && i.countsTowardTotal);
    // every counted, unpaid, past-due record from before the cycle: elec e1 + e0 (bills), gym g0 + the 12 Nov gym is NOT yet past due
    expect(carried.reduce((s, i) => s + i.remaining, 0)).toBe(1000 + 500 + 1500);
  });
});

describe("buildCompletedEvents + groupCompleted — Paid this cycle", () => {
  const record = (id: string, billId: string, occurrenceId: string, amount: number, date: Date): PaymentRecord => ({ ...base, id, billId, occurrenceId, amount, date, note: "", transactionId: null, accountId: null, recordedEarlier: false });
  const rentPaid = occ("r-paid", "rent", d(10, 22), 10000, { amountPaid: 4000 }); // paid in two parts, one inside the cycle
  const legacy = occ("lg", "water", d(10, 24), 200, { amountPaid: 200 }); // marked paid before payments tracked dates → undated, never given the due date
  const billPayments = { water: [record("p1", "water", "w1", 300, d(10, 21))], rent: [record("p2", "rent", "r-paid", 4000, d(10, 24))] };
  const cardPaymentInCycle = txn({ type: "income", transferId: "tr-1", amount: 2000, dateTime: d(10, 23) });
  const cardPaymentBefore = txn({ type: "income", transferId: "tr-0", amount: 9000, dateTime: d(10, 12) }); // before the cycle starts

  const events = buildCompletedEvents({
    cards: [card],
    transactions: [...cardTxns, cardPaymentInCycle, cardPaymentBefore],
    lookup,
    loanRows,
    loanPayments: [
      { scheduleId: "s-home", direction: "taken", date: d(10, 22), amount: 1000 },
      { scheduleId: "s-lent", direction: "given", date: d(10, 22), amount: 5555 }, // money received on a lent loan is not a payment I made
    ],
    emiRows,
    emiPayments: [
      { scheduleId: "s-gym", date: d(10, 20), amount: 1500 },
      { scheduleId: "s-phone", date: d(10, 20), amount: 2000 }, // card-funded: paid THROUGH the card bill, not a second payment
    ],
    billRows,
    billOccurrences: [paidBill, rentPaid, legacy],
    billPaymentsByBillId: billPayments,
  });
  const completed = groupCompleted(events, cycle);

  it("counts each recorded payment once, by its own date, and drops everything outside the cycle", () => {
    const amount = (key: string) => completed.groups.find((g) => g.key === key)?.amount;
    expect(amount("loan:home")).toBe(1000);
    expect(amount("emi:gym")).toBe(1500);
    expect(amount("bill:water")).toBe(300 + 200); // dated record + the undated legacy part
    expect(amount("bill:rent")).toBe(4000);
    expect(amount("card:card-1")).toBe(2000); // the ₹9,000 leg dated 12 Oct is before 18 Oct
    expect(completed.total).toBe(1000 + 1500 + 500 + 4000 + 2000);
  });

  it("does not turn a card-funded EMI payment or a lent-loan receipt into a payment of mine", () => {
    expect(completed.groups.some((g) => g.key === "emi:phone")).toBe(false);
    expect(completed.groups.some((g) => g.key === "loan:lent")).toBe(false);
  });

  it("an undated bill part is listed as undated — the due date is never shown as the payment date", () => {
    const water = completed.groups.find((g) => g.key === "bill:water")!;
    expect(water.undatedAmount).toBe(200);
    expect(water.payments).toBe(1);
  });
});
