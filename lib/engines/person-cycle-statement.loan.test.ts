import { describe, expect, it } from "vitest";
import { buildPersonCycleStatement, type StatementInstallment, type StatementLedgerEntry, type StatementLoanSource } from "./person-cycle-statement";

const d = (s: string) => new Date(`${s}T00:00:00`);
const cycle = (start: string, end: string) => ({ start: d(start), end: d(end) });
const AUG_SEP = cycle("2026-08-18", "2026-09-17");
const SEP_OCT = cycle("2026-09-18", "2026-10-17");
const OCT_NOV = cycle("2026-10-18", "2026-11-17");

function loan(overrides: Partial<StatementLoanSource> = {}): StatementLoanSource {
  return { id: "L", name: "Personal Loan", scheduleId: "S", direction: "taken", personId: "A", isClosed: false, deletedAt: null, ...overrides };
}

// ₹30,000 over 10 × ₹3,000, due the 10th from Sep 2026.
function installments(paid: Record<number, number> = {}): StatementInstallment[] {
  return Array.from({ length: 10 }, (_, k) => ({
    id: `i${k + 1}`,
    scheduleId: "S",
    sequenceNumber: k + 1,
    dueDate: new Date(2026, 8 + k, 10),
    amountDue: 3000,
    amountPaid: paid[k + 1] ?? 0,
    isSkipped: false,
    deletedAt: null,
    createdAt: d("2026-08-01"),
  }));
}

function statement(opts: {
  cycle: { start: Date; end: Date };
  loans?: StatementLoanSource[];
  installments?: StatementInstallment[];
  ledgerEntries?: StatementLedgerEntry[];
  loanPayments?: { installmentId: string; amount: number; date: Date; deletedAt: null }[];
}) {
  return buildPersonCycleStatement({
    person: { id: "A", name: "Person A", openingBalance: 0, createdAt: d("2026-01-01") },
    ledgerEntries: opts.ledgerEntries ?? [],
    loanIds: new Set(["L"]),
    emis: [],
    loans: opts.loans ?? [loan()],
    installments: opts.installments ?? installments(),
    cycle: opts.cycle,
    now: d("2026-09-29"),
    loanPayments: opts.loanPayments,
  });
}

describe("PersonCycleStatement — Loans with this person", () => {
  it("borrowed from Person A: this cycle's installment is 'you owe them' ₹3,000, never the principal", () => {
    const s = statement({ cycle: AUG_SEP });
    expect(s.direction).toBe("iOwe");
    expect(s.cycleActivity).toBe(-3000);
    expect(s.amount).toBe(3000);
    expect(s.rows.map((r) => [r.category, r.typeLabel, r.amount])).toEqual([["loan", "Loan EMI", 3000]]);
  });

  it("an unpaid earlier installment is Previous pending, this cycle's is This cycle — each once", () => {
    const s = statement({ cycle: SEP_OCT });
    expect(s.previousPending).toBe(-3000);
    expect(s.cycleActivity).toBe(-3000);
    expect(s.amount).toBe(6000);
    // The Sep installment is NOT re-listed in the Oct cycle.
    expect(s.rows.map((r) => r.key)).toEqual(["loan-inst:i2"]);
  });

  it("a payment settles the installment, dated when it was paid, and clears it", () => {
    const s = statement({
      cycle: SEP_OCT,
      installments: installments({ 1: 3000 }),
      loanPayments: [{ installmentId: "i1", amount: 3000, date: d("2026-09-20"), deletedAt: null }],
    });
    expect(s.previousPending).toBe(-3000);
    expect(s.cycleSettlements).toBe(3000);
    expect(s.cycleActivity).toBe(-3000);
    expect(s.amount).toBe(3000);
    const pay = s.rows.find((r) => r.kind === "settlement")!;
    expect(pay).toMatchObject({ category: "repaid", amount: 3000, settlesKey: "loan-inst:i1" });
    expect(pay.settles?.remainingAfter).toBe(0);
  });

  it("a partial payment leaves the remainder open (₹2,000), not paid", () => {
    const s = statement({ cycle: AUG_SEP, installments: installments({ 1: 1000 }) });
    expect(s.amount).toBe(2000);
    expect(s.rows.find((r) => r.kind === "obligation")!.remainingNow).toBe(2000);
  });

  it("lent to Person B: direction is 'they owe you' — never forced one way", () => {
    const s = statement({ cycle: AUG_SEP, loans: [loan({ direction: "given" })] });
    expect(s.direction).toBe("theyOwe");
    expect(s.amount).toBe(3000);
  });

  it("a bank Loan (no personId) never reaches a Person's statement", () => {
    const s = statement({ cycle: AUG_SEP, loans: [loan({ personId: null })] });
    expect(s.rows).toEqual([]);
    expect(s.amount).toBe(0);
  });

  it("legacy Loan-generated ledger entries are not counted on top of the installments", () => {
    const legacy: StatementLedgerEntry = {
      id: "e1",
      personId: "A",
      type: "borrowed",
      amount: 30000,
      date: d("2026-08-01"),
      note: "Loan",
      increasesBalance: false,
      transactionRef: "L",
      parentEntryId: null,
      createdAt: d("2026-08-01"),
      deletedAt: null,
    };
    const s = statement({ cycle: AUG_SEP, ledgerEntries: [legacy] });
    expect(s.amount).toBe(3000);
  });

  it("cycle navigation follows real due dates", () => {
    const paidThroughSep = installments({ 1: 3000 });
    const oct = statement({ cycle: SEP_OCT, installments: paidThroughSep });
    const nov = statement({ cycle: OCT_NOV, installments: paidThroughSep });
    expect(oct.rows.filter((r) => r.kind === "obligation").map((r) => r.date.getMonth())).toEqual([9]);
    expect(nov.rows.filter((r) => r.kind === "obligation").map((r) => r.date.getMonth())).toEqual([10]);
  });
});
