/**
 * Debt-aware Net Worth history — every expectation is hand-computed: a payment of A on an installment whose principal
 * share is P (of amountDue D) moves Net Worth by −(A − P·A/D) (its interest), capped exactly like `principalPaidFor`.
 */
import { describe, expect, it } from "vitest";
import { accountBalancesAtCutoffs, debtPrincipalEvents, netWorthAtCutoffs, periodEndCutoff, personShareEvents } from "@/lib/engines/net-worth-trend";
import { emiReceivableThrough, type PersonEmiObligation } from "@/lib/engines/person-emi-obligations";
import { cycleContaining } from "@/lib/engines/person-cycle-statement";
import { outstandingPrincipalFor } from "@/lib/engines/loan-outstanding";
import type { Transaction } from "@/lib/models/transaction";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const d = (m: number, day: number) => new Date(2026, m, day, 12);
const tx = (p: Partial<Transaction> & { id: string }): Transaction => ({
  ...TransactionRepository.buildTransaction({ type: p.type ?? "expense", amount: p.amount ?? 0, dateTime: p.dateTime ?? d(10, 15), accountId: p.accountId ?? "bank", categoryId: "c" }),
  ...p,
});
const NOW_NW = 100_000;
const CUT = d(10, 1); // 1 Nov — every event below is after it
const inst = (id: string, scheduleId: string, amountDue: number, principalPortion: number | null) => ({ id, scheduleId, amountDue, principalPortion, deletedAt: null });
const pay = (scheduleId: string, installmentId: string | null, amount: number, day: number, extra: Record<string, unknown> = {}) => ({ scheduleId, installmentId, amount, date: d(10, day), deletedAt: null, paymentId: `${scheduleId}-${installmentId}-${day}`, ...extra });
const nwAt = (transactions: Transaction[], events: ReturnType<typeof debtPrincipalEvents>, shares?: Map<string, number>) =>
  netWorthAtCutoffs({ transactions, netWorthNow: NOW_NW, lenderChargeEvents: [], cutoffs: [CUT], debtEvents: events, receivableShareByTransactionId: shares })[0];
const base = { loans: [], emis: [], installments: [], loanPayments: [], emiPayments: [], breakdowns: [] };

describe("debt-aware Net Worth walk-back", () => {
  it("a borrowed-loan payment moves Net Worth by its interest only (1,100 paid, 1,000 principal → +100 earlier)", () => {
    const events = debtPrincipalEvents({ ...base, loans: [{ scheduleId: "S", direction: "taken", ownedByTrackedCard: false }], installments: [inst("i1", "S", 1_100, 1_000)], loanPayments: [pay("S", "i1", 1_100, 10)] });
    expect(nwAt([tx({ id: "p", amount: 1_100, dateTime: d(10, 10), loanId: "L", paymentAllocationType: "regularEmi" })], events)).toBe(100_100);
  });

  it("partial payments prorate, an over-payment is capped at the installment's principal", () => {
    const events = debtPrincipalEvents({
      ...base,
      loans: [{ scheduleId: "S", direction: "taken", ownedByTrackedCard: false }],
      installments: [inst("i1", "S", 1_100, 1_000), inst("i2", "S", 1_100, 1_000)],
      loanPayments: [pay("S", "i1", 550, 5), pay("S", "i1", 550, 6), pay("S", "i2", 1_200, 7)],
    });
    expect(events.map((e) => Math.round(e.delta * 100) / 100)).toEqual([500, 500, 1_000]);
    // The events add up to exactly what the balance sheet counts as paid.
    const paid = 2_000 - outstandingPrincipalFor(2_000, [
      { amountDue: 1_100, amountPaid: 1_100, isSkipped: false, principalPortion: 1_000 },
      { amountDue: 1_100, amountPaid: 1_200, isSkipped: false, principalPortion: 1_000 },
    ]);
    expect(events.reduce((s, e) => s + e.delta, 0)).toBeCloseTo(paid, 6);
  });

  it("an extra-principal payment is Net-Worth-neutral; a retired installment's payment is ignored", () => {
    const events = debtPrincipalEvents({
      ...base,
      loans: [{ scheduleId: "S", direction: "taken", ownedByTrackedCard: false }],
      installments: [inst("i1", "S", 1_100, 1_000)],
      loanPayments: [pay("S", "i1", 2_000, 8, { allocationType: "principalPrepayment", prepaymentPrincipalAmount: 2_000 }), pay("S", "gone", 900, 9)],
    });
    expect(nwAt([tx({ id: "pre", amount: 2_000, dateTime: d(10, 8), loanId: "L", paymentAllocationType: "principalPrepayment" })], events)).toBe(100_000);
  });

  it("a repayment received on money I lent raises Net Worth by its interest (past is 100 lower)", () => {
    const events = debtPrincipalEvents({ ...base, loans: [{ scheduleId: "G", direction: "given", ownedByTrackedCard: false }], installments: [inst("g1", "G", 1_100, 1_000)], loanPayments: [pay("G", "g1", 1_100, 12)] });
    expect(nwAt([tx({ id: "r", type: "income", amount: 1_100, dateTime: d(10, 12), loanId: "LG", paymentAllocationType: "regularEmi" })], events)).toBe(99_900);
  });

  it("card-locked EMI uses the payment's breakdown principal; Case A has no principal event (card already carries it)", () => {
    const events = debtPrincipalEvents({
      ...base,
      emis: [{ scheduleId: "B", ownership: "cardLock" }, { scheduleId: "A", ownership: "cardRepresented" }],
      installments: [inst("b1", "B", 1_000, 800), inst("a1", "A", 1_000, 850)],
      emiPayments: [pay("B", "b1", 1_000, 14, { paymentId: "pb" }), pay("A", "a1", 1_000, 14, { paymentId: "pa" })],
      breakdowns: [{ paymentId: "pb", principalPaid: 800, deletedAt: null }, { paymentId: "pa", principalPaid: 850, deletedAt: null }],
    });
    expect(events).toEqual([{ date: d(10, 14), delta: 800 }]);
    // Case B: card charged 1,000, lock −800 → −200. Case A: card charged interest 150 only → −150.
    const nw = nwAt([tx({ id: "cb", amount: 1_000, dateTime: d(10, 14), accountId: "card", emiId: "EB" }), tx({ id: "ca", amount: 150, dateTime: d(10, 14), accountId: "card", emiId: "EA" })], events);
    expect(nw).toBe(100_350);
  });

  it("a split expense moves Net Worth by my share only (tracked friend's share became a receivable)", () => {
    const shares = new Map([["dinner", 2_000]]);
    expect(nwAt([tx({ id: "dinner", amount: 3_000, dateTime: d(10, 6) })], [], shares)).toBe(101_000);
  });

  it("transfers, People legs and disbursements stay neutral; deleted / excluded rows never count", () => {
    const rows = [
      tx({ id: "t1", amount: 500, dateTime: d(10, 3), transferId: "X" }),
      tx({ id: "pl", amount: 700, dateTime: d(10, 3), isPersonLedgerMovement: true }),
      tx({ id: "dis", type: "income", amount: 9_000, dateTime: d(10, 3), loanId: "L", paymentAllocationType: "additionalDisbursement" }),
      tx({ id: "del", amount: 50, dateTime: d(10, 3), deletedAt: d(10, 4) }),
      tx({ id: "exc", amount: 60, dateTime: d(10, 3), excludeFromCalculations: true }),
    ];
    expect(nwAt(rows, [])).toBe(100_000);
  });

  it("without debt events the base (Dashboard) rule is unchanged: loan / EMI rows skipped", () => {
    const rows = [tx({ id: "p", amount: 1_100, dateTime: d(10, 10), loanId: "L", paymentAllocationType: "regularEmi" }), tx({ id: "food", amount: 300, dateTime: d(10, 10) })];
    expect(netWorthAtCutoffs({ transactions: rows, netWorthNow: NOW_NW, lenderChargeEvents: [], cutoffs: [CUT] })[0]).toBe(100_300);
  });
});


describe("Person-linked EMI shares in the Net Worth history", () => {
  const obligations = [
    { dueDate: new Date(2026, 8, 25), amount: 3_000 },
    { dueDate: new Date(2026, 9, 25), amount: 3_000 },
    { dueDate: new Date(2026, 10, 25), amount: 3_000 },
    { dueDate: new Date(2026, 11, 25), amount: 3_000 }, // next cycle — not in today's figure
  ] as unknown as PersonEmiObligation[];
  const NOW = new Date(2026, 10, 19, 12);

  for (const startDay of [1, 18]) {
    it(`walk-back equals the People formula at every past date (cycle start day ${startDay})`, () => {
      const cycleStart = (d: Date) => cycleContaining(d, startDay).start;
      const events = personShareEvents(obligations, cycleStart, NOW);
      const today = emiReceivableThrough(obligations, cycleContaining(NOW, startDay).end);
      for (let day = 0; day < 120; day++) {
        const t = new Date(2026, 7, 1 + day, 12); // Aug → Nov
        const formula = emiReceivableThrough(obligations, cycleContaining(t, startDay).end);
        const walkedBack = today - events.filter((e) => e.date.getTime() >= t.getTime()).reduce((s, e) => s + e.delta, 0);
        expect(walkedBack, t.toDateString()).toBe(formula);
      }
    });
  }

  it("a share whose cycle has not started yet produces no event (it is not in today's figure)", () => {
    const events = personShareEvents(obligations, (d) => cycleContaining(d, 1).start, NOW);
    expect(events.map((e) => e.date.getMonth())).toEqual([8, 9, 10]);
  });
});

describe("periodEndCutoff — the current period ends at today's real position", () => {
  const mounted = new Date(2026, 10, 19, 9, 0); // page opened 09:00
  const recordedLater = tx({ id: "late", type: "expense", amount: 2_500, dateTime: new Date(2026, 10, 19, 15, 30) }); // stamped 15:30
  const novEnd = new Date(2026, 10, 30, 23, 59, 59, 999);

  it("keeps a record stamped after the page mounted inside the current period's Net Worth (was reverted with min(end, now))", () => {
    const [nw] = netWorthAtCutoffs({ transactions: [recordedLater], netWorthNow: NOW_NW, lenderChargeEvents: [], cutoffs: [periodEndCutoff(novEnd, mounted)], debtEvents: [] });
    expect(nw).toBe(NOW_NW);
    // The old cutoff (min(end + 1, now)) walked it back: today's figure + 2,500.
    const [old] = netWorthAtCutoffs({ transactions: [recordedLater], netWorthNow: NOW_NW, lenderChargeEvents: [], cutoffs: [new Date(Math.min(novEnd.getTime() + 1, mounted.getTime()))], debtEvents: [] });
    expect(old).toBe(NOW_NW + 2_500);
  });

  it("keeps it inside the current period's closing account balance too", () => {
    const balances = accountBalancesAtCutoffs({ accounts: [{ id: "bank", currentBalance: 10_000 }], transactions: [recordedLater], cutoffs: [periodEndCutoff(novEnd, mounted)] });
    expect(balances.get("bank")).toEqual([10_000]);
  });

  it("a finished period still ends at the start of its next day", () => {
    const octEnd = new Date(2026, 9, 31, 23, 59, 59, 999);
    expect(periodEndCutoff(octEnd, mounted).getTime()).toBe(octEnd.getTime() + 1);
    const [nw] = netWorthAtCutoffs({ transactions: [recordedLater], netWorthNow: NOW_NW, lenderChargeEvents: [], cutoffs: [periodEndCutoff(octEnd, mounted)], debtEvents: [] });
    expect(nw).toBe(NOW_NW + 2_500);
  });
});
