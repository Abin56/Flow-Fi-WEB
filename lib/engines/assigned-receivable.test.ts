import { describe, expect, it } from "vitest";
import { creditCardStanding, type UtilizationEmi } from "@/lib/engines/credit-utilization";
import { assignedOutstandingPrincipal, liabilityTotals, loanBalanceSheet, netWorthComposition, netWorthWithLoans } from "@/lib/engines/loan-balance-sheet";
import { personShareEvents } from "@/lib/engines/net-worth-trend";
import { assignedFuturePrincipal, emiReceivableThrough, personEmiObligations, type EmiObligationInstallment } from "@/lib/engines/person-emi-obligations";
import { personPosition } from "@/lib/engines/person-position";

/**
 * A credit-card-funded loan (Case B: no purchase transaction) of ₹1,08,000 principal, 12 × ₹10,000 (₹9,000 principal +
 * ₹1,000 interest each), assigned 100% to person A. The card (my name) carries the whole principal; A owes it back
 * instalment by instalment. Net Worth must carry BOTH the liability and the matching receivable — never a phantom loss.
 */
const d = (m: number, day: number, y = 2026) => new Date(y, m - 1, day);
const NOW = d(10, 25); // current cycle (start day 1) ends 31 Oct — instalment #1 (20 Oct) is due, #2 (20 Nov) is not
const CUTOFF = d(10, 31);
const CASH = 50_000;
const PRINCIPAL = 108_000;

const installments = (paid = 0): EmiObligationInstallment[] =>
  Array.from({ length: 12 }, (_, i) => ({
    id: `i${i + 1}`, scheduleId: "S1", sequenceNumber: i + 1, dueDate: d(10 + i, 20), amountDue: 10_000, principalPortion: 9_000,
    amountPaid: i < paid ? 10_000 : 0, isSkipped: false, deletedAt: null, createdAt: d(9, 28),
  }));
const source = (over: Record<string, unknown> = {}) => ({
  id: "emi1", name: "Card loan", scheduleId: "S1", beneficiaryPersonId: "A", beneficiaryRepaysInstallments: true,
  ownershipShares: null, isClosed: false, deletedAt: null, ...over,
});
const obligations = (over: Record<string, unknown> = {}, inst = installments()) =>
  personEmiObligations({ personId: "A", emis: [source(over)], loans: [], installments: inst, now: NOW });

/** Everything Net Worth reads, the way `useLoanBalanceSheet` composes it. */
function world(opts: { lenderPaid: number; aPaid: number; cash: number; inst?: EmiObligationInstallment[]; over?: Record<string, unknown> }) {
  const inst = opts.inst ?? installments(opts.lenderPaid);
  const principalPaid = opts.lenderPaid * 9_000;
  const emi: UtilizationEmi = { linkedCreditCardId: "card1", isClosed: false, principalAmount: PRINCIPAL, principalPaid, purchaseRepresented: false };
  const standing = creditCardStanding({ card: { id: "card1", statementDay: 5, creditLimit: 500_000, sharedLimitId: null }, statements: [], currentCycleStatement: null, emis: [emi] });
  const sheet = loanBalanceSheet([], [{ outstandingPrincipal: PRINCIPAL - principalPaid, ownedByTrackedCard: true }], standing.lockedEmiPrincipal);
  const obs = obligations(opts.over ?? {}, inst);
  const position = personPosition({ personId: "A", currentBalance: -opts.aPaid, loans: [], ledgerEntries: [], loanIds: new Set(), emiReceivable: emiReceivableThrough(obs, CUTOFF) });
  const future = assignedFuturePrincipal(obs, CUTOFF);
  const netWorth = netWorthWithLoans(opts.cash, sheet, position.directBalance + position.emiReceivable, future);
  const debt = liabilityTotals(sheet, 0);
  return { sheet, debt, position, future, netWorth, composition: netWorthComposition(netWorth, { total: debt.total }, { payable: 0, advanceHeld: 0 }) };
}

describe("card-funded loan assigned 100% to a person", () => {
  it("legal liability stays whole; the receivable is split into due + upcoming principal", () => {
    const w = world({ lenderPaid: 0, aPaid: 0, cash: CASH });
    expect(w.debt.creditCards).toBe(PRINCIPAL); // what I legally owe — untouched
    expect(w.position.emiReceivable).toBe(10_000); // #1 is due
    expect(w.future).toBe(11 * 9_000); // #2–#12 principal only, no unaccrued interest
    expect(assignedOutstandingPrincipal([{ outstandingPrincipal: PRINCIPAL, source: source() }])).toBe(PRINCIPAL); // 100% theirs
  });

  it("Net Worth does not drop for money someone else owes — only the billed interest shows", () => {
    const w = world({ lenderPaid: 0, aPaid: 0, cash: CASH });
    expect(w.netWorth).toBe(CASH + 1_000); // 50,000 − 108,000 + 10,000 + 99,000
    expect(w.composition.assets - w.composition.debt).toBe(w.netWorth); // Assets − Debt = Net Worth, still exact
  });

  it("without the person-pays opt-in (association only) nothing changes: it is my own debt", () => {
    const w = world({ lenderPaid: 0, aPaid: 0, cash: CASH, over: { beneficiaryRepaysInstallments: false } });
    expect(w.future).toBe(0);
    expect(w.netWorth).toBe(CASH - PRINCIPAL);
  });

  it("I pay the bank #1, then A reimburses: the interest I fronted is the only movement, and A's repayment is a swap", () => {
    const paid = world({ lenderPaid: 1, aPaid: 0, cash: CASH - 10_000 });
    expect(paid.debt.creditCards).toBe(PRINCIPAL - 9_000);
    expect(paid.netWorth).toBe(CASH); // −₹10,000 cash, +₹9,000 liability released; A's ₹10,000 is still receivable
    const reimbursed = world({ lenderPaid: 1, aPaid: 10_000, cash: CASH });
    expect(reimbursed.position.net).toBe(0);
    expect(reimbursed.netWorth).toBe(paid.netWorth); // cash in, receivable out
  });

  it("A part-pays ₹4,000 before I pay the bank: receivable falls ₹4,000, cash rises ₹4,000, Net Worth unchanged", () => {
    const before = world({ lenderPaid: 0, aPaid: 0, cash: CASH });
    const after = world({ lenderPaid: 0, aPaid: 4_000, cash: CASH + 4_000 });
    expect(after.position.net).toBe(6_000);
    expect(after.netWorth).toBe(before.netWorth);
  });

  it("reversing my bank payment restores liability, cash and Net Worth exactly", () => {
    const base = world({ lenderPaid: 0, aPaid: 4_000, cash: CASH + 4_000 });
    const paid = world({ lenderPaid: 1, aPaid: 4_000, cash: CASH + 4_000 - 10_000 });
    const reverted = world({ lenderPaid: 0, aPaid: 4_000, cash: CASH + 4_000 });
    expect(paid.netWorth).toBe(base.netWorth - 1_000); // the bank's interest is a real cost until A reimburses
    expect(reverted).toEqual(base);
  });

  it("a person paying future instalments ahead nets against the upcoming receivable (no phantom payable)", () => {
    const base = world({ lenderPaid: 0, aPaid: 0, cash: CASH });
    const ahead = world({ lenderPaid: 0, aPaid: 20_000, cash: CASH + 20_000 }); // #1 and #2 paid in advance
    expect(ahead.netWorth).toBe(base.netWorth);
  });

  it("closed, skipped and deleted agreements carry no upcoming receivable beyond what was really charged", () => {
    expect(world({ lenderPaid: 0, aPaid: 0, cash: CASH, over: { isClosed: true } }).future).toBe(0);
    const skipped = installments().map((i, n) => (n >= 6 ? { ...i, isSkipped: true } : i));
    expect(assignedFuturePrincipal(obligations({}, skipped), CUTOFF)).toBe(5 * 9_000); // #2–#6
    expect(world({ lenderPaid: 0, aPaid: 0, cash: CASH, over: { deletedAt: d(10, 1) } }).future).toBe(0);
  });

  it("shared with me (25% me / 75% A): only A's part is a receivable and an 'assigned' debt", () => {
    const shares = [{ personId: null, amount: 27_000 }, { personId: "A", amount: 81_000 }];
    const o = obligations({ ownershipShares: shares, beneficiaryRepaysInstallments: false });
    expect(assignedFuturePrincipal(o, CUTOFF)).toBe(11 * 6_750);
    expect(assignedOutstandingPrincipal([{ outstandingPrincipal: PRINCIPAL, source: source({ ownershipShares: shares }) }])).toBe(81_000);
  });

  it("history: the principal part is never a dated event; only the interest enters on its cycle start", () => {
    const events = personShareEvents(obligations(), (x) => new Date(x.getFullYear(), x.getMonth(), 1), NOW);
    expect(events).toHaveLength(1); // only #1's cycle has started
    expect(events[0].delta).toBe(1_000);
  });

  it("editing one historical instalment date moves only that instalment between due and upcoming", () => {
    const edited = installments().map((i) => (i.id === "i3" ? { ...i, dueDate: d(10, 28) } : i)); // moved from 20 Dec into this cycle
    const o = obligations({}, edited);
    expect(emiReceivableThrough(o, CUTOFF)).toBe(20_000);
    expect(assignedFuturePrincipal(o, CUTOFF)).toBe(10 * 9_000);
    const others = (list: typeof o) => list.filter((x) => x.installmentId !== "i3").map((x) => [x.installmentId, x.amount, x.dueDate.getTime()]);
    expect(others(o)).toEqual(others(obligations()));
  });
});

describe("People still owe you — what is counted (investigation checks)", () => {
  it("a share paid ahead shows as refund inside payable, so gross display can net it against the upcoming principal", async () => {
    const { personDirectGross, personShareRefund, personPosition: pp } = await import("@/lib/engines/person-position");
    const position = pp({ personId: "A", currentBalance: -10_000, loans: [], ledgerEntries: [], loanIds: new Set(), emiReceivable: 10_000 });
    const entry = { id: "r1", type: "receivedBack" as const, amount: 20_000, parentEntryId: null, transactionRef: null, isDeleted: false, obligationRef: "emi-inst:i2", sourceKind: null };
    const prepaid = { ...position, directBalance: -20_000, emiReceivable: 10_000 };
    const gross = personDirectGross(prepaid, [entry], new Set());
    expect(personShareRefund(prepaid, [entry], new Set())).toBe(10_000); // ₹20,000 settled vs ₹10,000 due
    expect(gross.payable).toBe(10_000);
  });

  it("a deleted ledger settlement stops counting: the share is owed again", () => {
    const owed = (aPaid: number) => personPosition({ personId: "A", currentBalance: -aPaid, loans: [], ledgerEntries: [], loanIds: new Set(), emiReceivable: 10_000 }).net;
    expect(owed(4_000)).toBe(6_000);
    expect(owed(0)).toBe(10_000); // settlement deleted → balance back
  });
});
