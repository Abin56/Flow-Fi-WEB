import { describe, expect, it } from "vitest";
import { runFinancialAudit, type AuditInput } from "@/lib/engines/financial-audit";
import type { Installment } from "@/lib/models/payment-schedule";
import type { LedgerEntry, Person } from "@/lib/models/person";

const person = { id: "p1", name: "AMMA", deletedAt: null, currentBalance: -1000, openingBalance: 0 } as unknown as Person;
const entry = (patch: Partial<LedgerEntry> = {}) =>
  ({ id: "e1", personId: "p1", type: "receivedBack", amount: 1000, date: new Date(2026, 1, 12), increasesBalance: true, deletedAt: null,
    sourceKind: "emiInstallment", obligationRef: "emi-inst:i1", parentEntryId: null, transactionRef: null, ...patch }) as unknown as LedgerEntry;
const inst = (patch: Partial<Installment> = {}) => ({ id: "i1", scheduleId: "s1", deletedAt: null, amountPaid: 0, ...patch }) as unknown as Installment;
const input = (ledgerEntries: LedgerEntry[], installments: Installment[]): AuditInput =>
  ({ accounts: [], transactions: [], people: [person], ledgerEntries, loans: [], emis: [], expenses: [], installments, payments: [] });
const found = (i: AuditInput) => runFinancialAudit(i, new Date(2026, 10, 15)).findings.filter((f) => f.category === "orphan-share-settlement");

describe("audit: a person's repayment of an installment that no longer exists", () => {
  it("is reported when the installment is gone — the exact state an EMI deletion after a repayment used to leave", () => {
    const [f] = found(input([entry()], []));
    expect(f.status).toBe("confirmed");
    expect(f.title).toMatch(/AMMA.*EMI installment that no longer exists/);
    expect(f.refs).toContainEqual({ kind: "ledgerEntry", id: "e1" });
  });

  it("also when the installment is only soft-deleted, and for a Loan share", () => {
    expect(found(input([entry()], [inst({ deletedAt: new Date() })]))).toHaveLength(1);
    expect(found(input([entry({ sourceKind: "loanInstallment", obligationRef: "loan-inst:i1" })], []))[0].title).toMatch(/Loan installment/);
  });

  it("is silent when the installment exists, the entry is reverted, or it is not an installment settlement", () => {
    expect(found(input([entry()], [inst()]))).toEqual([]);
    expect(found(input([entry({ deletedAt: new Date() })], []))).toEqual([]);
    expect(found(input([entry({ sourceKind: "manual", obligationRef: null })], []))).toEqual([]);
    expect(found(input([entry({ sourceKind: "splitExpense", obligationRef: "emi-inst:i1" })], []))).toEqual([]);
  });

  it("never proposes an automatic balance change", () => {
    for (const f of found(input([entry()], []))) expect(f.proposal).toMatchObject({ balanceDelta: null, needsDecision: true });
  });
});
