import { describe, expect, it } from "vitest";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { Transaction } from "@/lib/models/transaction";
import { cardBillsForCard, cardStatementPaymentScope, payBillAmount, payBillChargeScope } from "./card-cycle-bills";
import { linkedPeopleForCard, peopleSettlementGate } from "./linked-people-readiness";

/**
 * PERMANENT regression — the OCTANE screenshot. ONE Pay Now = ONE bill.
 *
 * OCTANE: statementDay 1 (cycles 2nd → 1st), paymentDueDay 20 (assumed — the screenshot doesn't show it).
 *  Statement A  2 Aug – 1 Sep 2026, due 20 Oct  ₹22,152.02  (AMMA share ₹8,000, SHAMBU ₹1,000)
 *  Statement B  2 Sep – 1 Oct 2026, due 20 Nov  ₹27,170.00  (TRIPTHEE share ₹6,899, AMMA ₹6,686)
 *  Card outstanding ₹49,322.02. Today 3 Oct 2026: both statements are CLOSED, only A is the current bill.
 *
 * The old Pay Now combined every closed statement (₹49,322.02) and gated on all four People shares.
 */
const d = (m: number, day: number) => new Date(2026, m - 1, day, 12);
const NOW = d(10, 3);

const OCTANE: CreditCardProfile = {
  id: "octane",
  accountId: "acc-octane",
  sharedLimitId: null,
  statementDay: 1,
  paymentDueDay: 20,
  creditLimit: 200000,
  minimumDuePercent: null,
  autoPay: false,
  status: "active",
  cardNetwork: null,
  lastFourDigits: "1111",
  issuer: null,
  annualFee: 0,
  joiningFee: 0,
  interestRatePercent: null,
  rewardNotes: null,
  autoDebitAccount: null,
  cardHolderName: null,
  createdAt: d(1, 1),
  deletedAt: null,
  lastEditedAt: null,
  editHistory: [],
};

function txn(id: string, type: "income" | "expense", amount: number, date: Date, accountId = OCTANE.accountId, transferId: string | null = null): Transaction {
  return {
    id,
    type,
    amount,
    dateTime: date,
    accountId,
    categoryId: "cat-1",
    description: "",
    notes: "",
    receiptPurpose: null,
    transferId,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: date,
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
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
  };
}

/** Bill payment = one transfer from the bank (never another card): bank expense leg + card income leg. */
const pay = (id: string, amount: number, date: Date) => [txn(`${id}-out`, "expense", amount, date, "acc-sbi", id), txn(`${id}-in`, "income", amount, date, OCTANE.accountId, id)];

const PURCHASES = [
  // Statement A — 2 Aug – 1 Sep
  txn("a-amma", "expense", 16000, d(8, 5)),
  txn("a-shambu", "expense", 2000, d(8, 12)),
  txn("a-other", "expense", 4152.02, d(9, 1)), // statement close day → still A
  // Statement B — 2 Sep – 1 Oct
  txn("b-tripthee", "expense", 13798, d(9, 2)), // day after close → B
  txn("b-amma", "expense", 13372, d(9, 20)),
];

const entry = (id: string, personId: string, transactionRef: string) => ({ id, personId, type: "gave" as const, transactionRef, deletedAt: null });
const ledgerEntries = [entry("e-amma-a", "amma", "a-amma"), entry("e-shambu", "shambu", "a-shambu"), entry("e-tripthee", "tripthee", "b-tripthee"), entry("e-amma-b", "amma", "b-amma")];
const row = (key: string, title: string, share: number) => ({ key, kind: "obligation", title, amount: share, signedAmount: share, remainingNow: share });
const peopleStatements = [
  { personId: "amma", personName: "AMMA", rows: [row("ledger:e-amma-a", "Aug share", 8000), row("ledger:e-amma-b", "Sep share", 6686)] as never },
  { personId: "shambu", personName: "SHAMBU", rows: [row("ledger:e-shambu", "Aug share", 1000)] as never },
  { personId: "tripthee", personName: "TRIPTHEE", rows: [row("ledger:e-tripthee", "Sep share", 6899)] as never },
];

const scopeAt = (all: Transaction[], now = NOW) => cardStatementPaymentScope(cardBillsForCard(OCTANE, all.filter((t) => t.accountId === OCTANE.accountId), [], now), now);
/** The People gate exactly as the Pay dialog builds it: amount reach ∩ the current bill's own charges. */
const gateFor = (all: Transaction[], amount: number, now = NOW) =>
  peopleSettlementGate(
    linkedPeopleForCard({
      statements: peopleStatements,
      ledgerEntries,
      transactions: all,
      cardAccountId: OCTANE.accountId,
      lenderDue: amount,
      paymentAmount: amount,
      chargeScope: payBillChargeScope(scopeAt(all, now), amount),
    }),
  );
const owed = (g: ReturnType<typeof gateFor>) => Object.fromEntries(g.attention.map((p) => [p.personName, p.remaining]));

describe("OCTANE screenshot — Pay Now pays ONE statement (permanent regression)", () => {
  it("trace: A and B are both closed; A is the current bill (due 20 Oct), B is later (due 20 Nov)", () => {
    const s = scopeAt(PURCHASES);
    expect(s.statements).toHaveLength(2); // allocation order still knows both
    const A = s.current!;
    expect([A.periodStart, A.periodEnd, A.dueDate]).toEqual([new Date(2026, 7, 2), new Date(2026, 8, 1), new Date(2026, 9, 20)]);
    expect(A).toMatchObject({ totalAmount: 22152.02, amountPaid: 0, remaining: 22152.02, isClosed: true });
    expect(s.currentOverdue).toBe(false);
    const [B] = s.later;
    expect([B.periodStart, B.periodEnd, B.dueDate]).toEqual([new Date(2026, 8, 2), new Date(2026, 9, 1), new Date(2026, 10, 20)]);
    expect(B).toMatchObject({ totalAmount: 27170, remaining: 27170, isClosed: true });
    expect(s).toMatchObject({ statementDue: 22152.02, closedDue: 49322.02, unbilled: 0, cardOutstanding: 49322.02 });
  });

  it("Pay now opens ₹22,152.02 (was ₹49,322.02); full outstanding only when explicitly chosen", () => {
    const s = scopeAt(PURCHASES);
    expect(payBillAmount(s, "statement", 49322.02)).toBe(22152.02);
    expect(payBillAmount(s, "full", 49322.02)).toBe(49322.02);
  });

  it("People gate for the ₹22,152.02 bill: AMMA ₹8,000 + SHAMBU ₹1,000 only — Statement B's shares excluded by transaction identity", () => {
    expect(owed(gateFor(PURCHASES, 22152.02))).toEqual({ AMMA: 8000, SHAMBU: 1000 });
    // Before: the combined ₹49,322.02 payment pulled in B's TRIPTHEE ₹6,899 and AMMA ₹6,686 too.
    expect(owed(gateFor(PURCHASES, 49322.02))).toEqual({ AMMA: 14686, SHAMBU: 1000, TRIPTHEE: 6899 });
  });

  it("partial ₹10,000: gates only the A charge it reaches (AMMA ₹8,000); A → ₹12,152.02, B untouched", () => {
    expect(owed(gateFor(PURCHASES, 10000))).toEqual({ AMMA: 8000 });
    const s = scopeAt([...PURCHASES, ...pay("p1", 10000, NOW)]);
    expect(s.current?.periodEnd).toEqual(new Date(2026, 8, 1));
    expect(s).toMatchObject({ statementDue: 12152.02, cardOutstanding: 39322.02 });
    expect(s.later.map((b) => b.remaining)).toEqual([27170]);
  });

  it("edit ₹10,000 → ₹15,000 then revert: A ₹7,152.02 → ₹22,152.02; B ₹27,170 throughout", () => {
    const edited = scopeAt([...PURCHASES, ...pay("p1", 15000, NOW)]);
    expect([edited.statementDue, edited.later[0].remaining]).toEqual([7152.02, 27170]);
    const reverted = scopeAt([...PURCHASES, ...pay("p1", 15000, NOW).map((t) => ({ ...t, deletedAt: NOW }))]);
    expect([reverted.statementDue, reverted.later[0].remaining, reverted.cardOutstanding]).toEqual([22152.02, 27170, 49322.02]);
  });

  it("A unpaid past 20 Oct → A is the OVERDUE current bill, B still separate (never merged)", () => {
    const s = scopeAt(PURCHASES, d(10, 21));
    expect(s.currentOverdue).toBe(true);
    expect(s.statementDue).toBe(22152.02);
    expect(s.later.map((b) => b.remaining)).toEqual([27170]);
  });

  it("advance to B's cycle with A paid → B becomes the Pay Now bill, gated by B's own shares", () => {
    const all = [...PURCHASES, ...pay("pA", 22152.02, d(10, 15))];
    const s = scopeAt(all, d(11, 5));
    expect(s.current?.periodEnd).toEqual(new Date(2026, 9, 1));
    expect(s.current?.dueDate).toEqual(new Date(2026, 10, 20));
    expect(s).toMatchObject({ statementDue: 27170, closedDue: 27170, cardOutstanding: 27170 });
    expect(s.later).toEqual([]);
    // Statement A's People shares are still open in the ledger (paying the issuer never settles People),
    // but A's charges are paid — they no longer gate. Only B's own shares do.
    expect(owed(gateFor(all, 27170, d(11, 5)))).toEqual({ AMMA: 6686, TRIPTHEE: 6899 });
  });

  it("no bill when nothing closed is unpaid: Pay now has nothing to prefill", () => {
    const all = [...PURCHASES, ...pay("pAll", 49322.02, NOW)];
    const s = scopeAt(all);
    expect(s.current).toBeNull();
    expect(payBillAmount(s, "statement", 0)).toBeUndefined();
  });
});
