import { describe, expect, it } from "vitest";
import {
  allocateOwnership,
  checkedOwnership,
  ownershipSharesFromData,
  personInstallmentShare,
  resolveOwnership,
  splitByOwnership,
  splitPaise,
  validateOwnership,
  type OwnershipShare,
} from "@/lib/engines/debt-ownership";
import { buildDebtSnapshot, cardPurchaseShares, requiredByOwnership } from "@/lib/engines/debt-position";
import { requiredThisPeriod, simulatePayoff } from "@/lib/engines/debt-payoff";
import { buildPersonCycleStatement, type StatementLedgerEntry } from "@/lib/engines/person-cycle-statement";
import { emiReceivableThrough, personEmiObligations, type EmiObligationInstallment } from "@/lib/engines/person-emi-obligations";
import { amortizedSchedule, cardInput, emiInput, flatSchedule, loanInput, NOW, personInput } from "@/lib/engines/debt-planner.fixtures";

const d = (m: number, day: number, y = 2026) => new Date(y, m - 1, day);
const sumPaise = (xs: readonly { amount: number }[]) => xs.reduce((s, x) => s + Math.round(x.amount * 100), 0);

/** ₹30,000 loan: Me ₹10,000 · AMMA ₹10,000 · SHAMBU ₹10,000. */
const EQUAL: OwnershipShare[] = [
  { personId: null, amount: 10_000 },
  { personId: "amma", amount: 10_000 },
  { personId: "shambu", amount: 10_000 },
];
/** Me 50% · AMMA 30% · SHAMBU 20% of ₹30,000. */
const WEIGHTED: OwnershipShare[] = [
  { personId: null, amount: 15_000 },
  { personId: "amma", amount: 9_000 },
  { personId: "shambu", amount: 6_000 },
];

describe("allocation — shares always reconcile exactly to the principal (invariant 1)", () => {
  it("equal split of ₹30,000 between three", () => {
    const r = allocateOwnership(30_000, "equal", [{ personId: null, value: 0 }, { personId: "amma", value: 0 }, { personId: "shambu", value: 0 }]);
    expect(r.shares.map((s) => s.amount)).toEqual([10_000, 10_000, 10_000]);
    expect(r.remaining).toBe(0);
    expect(r.error).toBeNull();
  });

  it("equal split with a paise remainder is deterministic (first rows get the extra paise)", () => {
    const r = allocateOwnership(100, "equal", [{ personId: null, value: 0 }, { personId: "a", value: 0 }, { personId: "b", value: 0 }]);
    expect(r.shares.map((s) => s.amount)).toEqual([33.34, 33.33, 33.33]);
    expect(sumPaise(r.shares)).toBe(10_000);
    expect(allocateOwnership(100, "equal", [{ personId: null, value: 0 }, { personId: "a", value: 0 }, { personId: "b", value: 0 }])).toEqual(r);
  });

  it("percentage 40 / 35 / 25", () => {
    const r = allocateOwnership(30_000, "percentage", [{ personId: null, value: 40 }, { personId: "amma", value: 35 }, { personId: "shambu", value: 25 }]);
    expect(r.shares.map((s) => s.amount)).toEqual([12_000, 10_500, 7_500]);
    expect(r.error).toBeNull();
  });

  it("percentages with awkward thirds still sum to the paise", () => {
    const r = allocateOwnership(1_000.01, "percentage", [{ personId: null, value: 33.3333 }, { personId: "a", value: 33.3333 }, { personId: "b", value: 33.3334 }]);
    expect(sumPaise(r.shares)).toBe(100_001);
    expect(r.error).toBeNull();
  });

  it("percentages not reaching 100 block save", () => {
    const r = allocateOwnership(30_000, "percentage", [{ personId: null, value: 50 }, { personId: "a", value: 30 }]);
    expect(r.error).not.toBeNull();
    expect(r.remaining).toBe(6_000);
  });

  it("custom over-allocation (₹40,000 on a ₹30,000 loan) is rejected", () => {
    const r = allocateOwnership(30_000, "custom", [{ personId: null, value: 20_000 }, { personId: "a", value: 20_000 }]);
    expect(r.allocated).toBe(40_000);
    expect(r.remaining).toBe(-10_000);
    expect(r.error).toMatch(/more than the loan amount/);
  });

  it("custom under-allocation shows what is left", () => {
    const r = allocateOwnership(30_000, "custom", [{ personId: null, value: 10_000 }, { personId: "a", value: 10_000 }]);
    expect(r.remaining).toBe(10_000);
    expect(r.error).toMatch(/still to allocate/);
  });

  it("rejects duplicates, empty person rows and zero shares", () => {
    expect(validateOwnership(100, [{ personId: "a", amount: 50 }, { personId: "a", amount: 50 }])).not.toBeNull();
    expect(validateOwnership(100, [{ personId: "", amount: 100 }])).not.toBeNull();
    expect(validateOwnership(100, [{ personId: null, amount: 100 }, { personId: "a", amount: 0 }])).not.toBeNull();
  });

  it("repository guard throws on anything that doesn't reconcile", () => {
    expect(() => checkedOwnership(30_000, [{ personId: null, amount: 20_000 }, { personId: "a", amount: 20_000 }])).toThrow();
    expect(checkedOwnership(30_000, EQUAL)).toEqual(EQUAL);
  });
});

describe("installment shares — always add back to the installment (invariant 2)", () => {
  it("₹3,000 EMI at 50/30/20 → 1,500 / 900 / 600", () => {
    expect(splitByOwnership(3_000, WEIGHTED).map((s) => s.amount)).toEqual([1_500, 900, 600]);
  });

  it("holds for awkward amounts across many installments", () => {
    for (const amount of [1, 0.01, 999.99, 2_847.37, 12_345.67, 3_333.33]) {
      for (const shares of [EQUAL, WEIGHTED]) expect(sumPaise(splitByOwnership(amount, shares))).toBe(Math.round(amount * 100));
    }
    expect(splitPaise(1, [1, 1, 1])).toEqual([1, 0, 0]);
  });

  it("a re-amortized (changed) installment amount splits by the same weights", () => {
    expect(splitByOwnership(2_400, WEIGHTED).map((s) => s.amount)).toEqual([1_200, 720, 480]);
  });
});

describe("resolving ownership — authoritative links only", () => {
  it("legacy association only (no opt-in) stays all mine", () => {
    expect(resolveOwnership({ beneficiaryPersonId: "amma" }, 10_000)).toEqual([{ personId: null, amount: 10_000 }]);
  });
  it("legacy opt-in → 100% that person", () => {
    expect(resolveOwnership({ beneficiaryPersonId: "amma", beneficiaryRepaysInstallments: true }, 10_000)).toEqual([{ personId: "amma", amount: 10_000 }]);
  });
  it("explicit shares win", () => {
    expect(resolveOwnership({ ownershipShares: EQUAL, beneficiaryPersonId: "x", beneficiaryRepaysInstallments: true }, 30_000)).toEqual(EQUAL);
  });
  it("reads legacy / malformed Firestore data as absent", () => {
    expect(ownershipSharesFromData(undefined)).toBeNull();
    expect(ownershipSharesFromData([])).toBeNull();
    expect(ownershipSharesFromData([{ personId: 3, amount: 1 }])).toBeNull();
    expect(ownershipSharesFromData([{ personId: null, amount: 5 }, { personId: "a", amount: 5 }])).toEqual([{ personId: null, amount: 5 }, { personId: "a", amount: 5 }]);
  });
});

// ───────────── People ledger: one lender schedule, per-person sub-obligations ─────────────

const loanInstallments = (paid: number[] = []): EmiObligationInstallment[] =>
  Array.from({ length: 10 }, (_, i) => ({
    id: `L${i + 1}`,
    scheduleId: "LS",
    sequenceNumber: i + 1,
    dueDate: d(8 + i, 5),
    amountDue: 3_000,
    amountPaid: paid.includes(i + 1) ? 3_000 : 0,
    isSkipped: false,
    deletedAt: null,
    createdAt: d(7, 1),
  }));
const sharedLoan = (over: Partial<{ isClosed: boolean; deletedAt: Date | null; ownershipShares: OwnershipShare[] }> = {}) => ({
  id: "loan1",
  name: "Personal Loan",
  scheduleId: "LS",
  direction: "taken" as const,
  personId: null,
  ownershipShares: WEIGHTED,
  isClosed: false,
  deletedAt: null,
  ...over,
});

describe("shared loan → People ledger", () => {
  it("each person owes only their share of each installment; the shares + mine = the installment", () => {
    const amma = personEmiObligations({ personId: "amma", emis: [], loans: [sharedLoan()], installments: loanInstallments(), now: NOW });
    const shambu = personEmiObligations({ personId: "shambu", emis: [], loans: [sharedLoan()], installments: loanInstallments(), now: NOW });
    expect(amma).toHaveLength(10);
    expect(amma[0].amount).toBe(900);
    expect(amma[0].installmentAmount).toBe(3_000);
    expect(shambu[0].amount).toBe(600);
    const mine = splitByOwnership(3_000, WEIGHTED).find((s) => s.personId === null)!.amount;
    expect(amma[0].amount + shambu[0].amount + mine).toBe(3_000);
  });

  it("a person not in the allocation owes nothing", () => {
    expect(personEmiObligations({ personId: "other", emis: [], loans: [sharedLoan()], installments: loanInstallments(), now: NOW })).toEqual([]);
  });

  it("lender payment never settles the person (invariant 4): paying the bank changes only lenderStatus", () => {
    const before = personEmiObligations({ personId: "amma", emis: [], loans: [sharedLoan()], installments: loanInstallments(), now: NOW });
    const after = personEmiObligations({ personId: "amma", emis: [], loans: [sharedLoan()], installments: loanInstallments([1, 2, 3]), now: NOW });
    expect(after.map((o) => o.amount)).toEqual(before.map((o) => o.amount));
    expect(emiReceivableThrough(after, NOW)).toBe(emiReceivableThrough(before, NOW));
    expect(after[0].lenderStatus).toBe("paid");
  });

  describe("People statement — AMMA, October 2026 (installment #3, due 05 Oct, share ₹900)", () => {
    const repayment = (id: string, amount: number, date: Date): StatementLedgerEntry => ({
      id,
      personId: "amma",
      type: "receivedBack",
      amount,
      date,
      note: "",
      increasesBalance: false,
      transactionRef: null,
      parentEntryId: null,
      sourceKind: "emiInstallment",
      obligationRef: "loan-inst:L3",
      createdAt: date,
      deletedAt: null,
    });
    const build = (ledgerEntries: StatementLedgerEntry[], installments = loanInstallments([1, 2])) =>
      buildPersonCycleStatement({
        person: { id: "amma", name: "AMMA", openingBalance: 0, createdAt: d(1, 1) },
        ledgerEntries,
        loanIds: new Set(["loan1"]),
        emis: [],
        loans: [sharedLoan()],
        installments,
        cycle: { start: d(10, 1), end: d(10, 31) },
        now: NOW,
      });
    const emiRow = (s: ReturnType<typeof build>) => s.rows.find((r) => r.category === "emi" && r.kind === "obligation")!;

    it("shows only her share, labelled as a share of the whole installment", () => {
      const row = emiRow(build([]));
      expect(row.amount).toBe(900);
      expect(row.title).toBe("Personal Loan · EMI share");
      expect(row.emi).toMatchObject({ installmentNumber: 3, installmentAmount: 3_000 });
    });

    it("partial repayment ₹500 → ₹400 remaining; the lender installment is untouched (invariant 3)", () => {
      const installments = loanInstallments([1, 2]);
      const before = JSON.stringify(installments);
      const s = build([repayment("r1", 500, d(10, 6))], installments);
      expect(emiRow(s).remainingNow).toBe(400);
      expect(JSON.stringify(installments)).toBe(before);
      expect(emiRow(s).emi!.status).not.toBe("paid");
    });

    it("lender paid in full does not settle her share (invariant 4)", () => {
      const s = build([], loanInstallments([1, 2, 3]));
      expect(emiRow(s).emi!.status).toBe("paid");
      expect(emiRow(s).remainingNow).toBe(900);
    });

    it("a reverted (soft-deleted) repayment restores what she owes (invariant 9)", () => {
      const s = build([{ ...repayment("r1", 500, d(10, 6)), deletedAt: d(10, 7) }]);
      expect(emiRow(s).remainingNow).toBe(900);
    });
  });

  it("closed loan: never-paid tail is dropped; paid history keeps its shares (invariant 10)", () => {
    const inst = loanInstallments([1, 2]);
    const closed = personEmiObligations({ personId: "amma", emis: [], loans: [sharedLoan({ isClosed: true })], installments: inst, now: NOW });
    expect(closed.map((o) => o.installmentNumber)).toEqual([1, 2]);
    expect(closed.every((o) => o.amount === 900)).toBe(true);
  });

  it("deleted (trashed) loan creates no obligations", () => {
    expect(personEmiObligations({ personId: "amma", emis: [], loans: [sharedLoan({ deletedAt: d(9, 1) })], installments: loanInstallments(), now: NOW })).toEqual([]);
  });

  it("re-amortized tail: paid installments keep their historical share, new amounts split by the same weights", () => {
    const inst = loanInstallments([1, 2]).map((i) => (i.sequenceNumber > 2 ? { ...i, amountDue: 2_400 } : i));
    const amma = personEmiObligations({ personId: "amma", emis: [], loans: [sharedLoan()], installments: inst, now: NOW });
    expect(amma.slice(0, 2).map((o) => o.amount)).toEqual([900, 900]);
    expect(amma.slice(2).every((o) => o.amount === 720)).toBe(true);
  });

  it("legacy single-beneficiary opt-in still owes the whole installment", () => {
    const legacy = { ...sharedLoan({ ownershipShares: undefined as never }), ownershipShares: null, beneficiaryPersonId: "amma", beneficiaryRepaysInstallments: true };
    const o = personEmiObligations({ personId: "amma", emis: [], loans: [legacy], installments: loanInstallments(), now: NOW });
    expect(o[0].amount).toBe(3_000);
    expect(personInstallmentShare(legacy, 3_000, "amma")).toBe(3_000);
  });
});

// ───────────── Debt Planner ownership ─────────────

const names = { amma: "AMMA", shambu: "SHAMBU" };

describe("Debt Planner — my debt vs others' share", () => {
  it("loan only for me: all mine", () => {
    const snap = buildDebtSnapshot({ loans: [loanInput({ id: "l1", installments: flatSchedule("s1", 30_000, 10, d(10, 5)), outstandingPrincipal: 30_000, loanAmount: 30_000 })], emis: [], cards: [], people: [], now: NOW });
    expect(snap.ownership).toMatchObject({ mine: 30_000, others: 0 });
  });

  it("loan only for another person: liability stays in total, all of it others' share", () => {
    const snap = buildDebtSnapshot({
      loans: [loanInput({ id: "l1", installments: flatSchedule("s1", 30_000, 10, d(10, 5)), outstandingPrincipal: 30_000, loanAmount: 30_000, ownershipShares: [{ personId: "amma", amount: 30_000 }] })],
      emis: [],
      cards: [],
      people: [],
      personNames: names,
      now: NOW,
    });
    expect(snap.total).toBe(30_000);
    expect(snap.ownership).toMatchObject({ mine: 0, others: 30_000 });
    expect(snap.positions[0].ownership.others).toEqual([{ personId: "amma", name: "AMMA", amount: 30_000 }]);
  });

  it("shared loan: outstanding split by weights, never changes the contractual outstanding", () => {
    const snap = buildDebtSnapshot({
      loans: [loanInput({ id: "l1", installments: flatSchedule("s1", 30_000, 10, d(10, 5)), outstandingPrincipal: 21_000, loanAmount: 30_000, ownershipShares: WEIGHTED })],
      emis: [],
      cards: [],
      people: [],
      personNames: names,
      now: NOW,
    });
    const p = snap.positions[0];
    expect(p.outstanding).toBe(21_000);
    expect(p.ownership).toMatchObject({ total: 21_000, mine: 10_500, othersTotal: 10_500 });
    expect(p.ownership.others.map((o) => [o.name, o.amount])).toEqual([["AMMA", 6_300], ["SHAMBU", 4_200]]);
  });

  it("card: fully assigned, partially shared and my own purchases; cap per person; my + others = total (invariants 5/6)", () => {
    const byFacility = cardPurchaseShares(
      [
        { facilityId: "octane", personId: "amma", name: "AMMA", unrecovered: 8_000, dueDate: d(9, 1) },
        { facilityId: "octane", personId: "shambu", name: "SHAMBU", unrecovered: 5_000, dueDate: d(9, 2) },
      ],
      { amma: 8_000, shambu: 5_000 },
    );
    const snap = buildDebtSnapshot({ loans: [], emis: [], cards: [cardInput({ id: "octane", outstanding: 20_000, purchaseShares: byFacility.octane })], people: [], now: NOW });
    const p = snap.positions[0];
    expect(p.ownership).toMatchObject({ total: 20_000, mine: 7_000, othersTotal: 13_000 });
    expect(p.ownership.mine + p.ownership.othersTotal).toBe(p.outstanding);
    expect(snap.total).toBe(20_000); // nothing removed from the liability
  });

  it("a share already offset by what I owe that person is not attributed twice", () => {
    // AMMA's ₹8,000 card share but I owe her ₹5,000 directly → net she owes me ₹3,000.
    const byFacility = cardPurchaseShares([{ facilityId: "c", personId: "amma", name: "AMMA", unrecovered: 8_000, dueDate: d(9, 1) }], { amma: 3_000 });
    expect(byFacility.c).toEqual([{ personId: "amma", name: "AMMA", amount: 3_000 }]);
    // I owe her nothing net → nothing attributable.
    expect(cardPurchaseShares([{ facilityId: "c", personId: "amma", name: "AMMA", unrecovered: 8_000, dueDate: d(9, 1) }], { amma: 0 })).toEqual({});
  });

  it("people's parts can never exceed the card exposure", () => {
    const snap = buildDebtSnapshot({
      loans: [],
      emis: [],
      cards: [cardInput({ id: "c", outstanding: 5_000, purchaseShares: [{ personId: "amma", name: "AMMA", amount: 8_000 }] })],
      people: [],
      now: NOW,
    });
    expect(snap.positions[0].ownership).toMatchObject({ mine: 0, othersTotal: 5_000 });
  });

  it("card EMI assigned to a person (card-owned, locking): counted once, on the card, as their share", () => {
    const snap = buildDebtSnapshot({
      loans: [],
      emis: [emiInput({ id: "e1", principalAmount: 12_000, installments: flatSchedule("es", 12_000, 12, d(10, 20)), outstandingPrincipal: 12_000, ownedByCardId: "c", ownershipShares: [{ personId: "amma", amount: 12_000 }] })],
      cards: [cardInput({ id: "c", cardIds: ["c"], outstanding: 10_000, lockedEmiPrincipal: 12_000 })],
      people: [],
      personNames: names,
      now: NOW,
    });
    expect(snap.positions).toHaveLength(1);
    expect(snap.total).toBe(22_000);
    expect(snap.positions[0].ownership).toMatchObject({ mine: 10_000, othersTotal: 12_000 });
  });

  it("snapshot totals reconcile: mine + others + unallocated = total", () => {
    const snap = buildDebtSnapshot({
      loans: [loanInput({ id: "l1", installments: amortizedSchedule("s1", 30_000, 12, 10, d(10, 5)), outstandingPrincipal: 30_000, loanAmount: 30_000, ownershipShares: EQUAL })],
      emis: [],
      cards: [cardInput({ id: "c", outstanding: 20_000, purchaseShares: [{ personId: "amma", name: "AMMA", amount: 8_000 }] })],
      people: [personInput({ personId: "p", name: "Friend", directBalance: -2_000 })],
      personNames: names,
      now: NOW,
    });
    const o = snap.ownership;
    expect(Math.round((o.mine + o.others + o.unallocated) * 100)).toBe(Math.round(snap.total * 100));
    expect(o.byPerson.find((p) => p.personId === "amma")!.amount).toBe(18_000);
  });

  it("payoff projection is unchanged by ownership (engine meaning preserved) and required payments split without shrinking", () => {
    const base = { loans: [loanInput({ id: "l1", installments: flatSchedule("s1", 30_000, 10, d(10, 5)), outstandingPrincipal: 30_000, loanAmount: 30_000 })], emis: [], cards: [], people: [], now: NOW };
    const mine = buildDebtSnapshot(base);
    const shared = buildDebtSnapshot({ ...base, loans: [{ ...base.loans[0], ownershipShares: WEIGHTED }], personNames: names });
    const run = (s: typeof mine) => simulatePayoff({ positions: s.positions, monthlyBudget: 5_000, strategy: "avalanche", monthCycleStartDay: 1, now: NOW });
    expect(run(shared).months.length).toBe(run(mine).months.length);

    const req = requiredThisPeriod(shared.positions, 1, NOW);
    const split = requiredByOwnership(req.byDebt, shared.positions);
    expect(split.required).toBe(req.total); // the lender still expects the full amount
    expect(Math.round((split.mine + split.fromPeople) * 100)).toBe(Math.round(split.required * 100));
    expect(split.fromPeople).toBe(1_500); // 50% of ₹3,000
  });
});
