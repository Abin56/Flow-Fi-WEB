import { describe, expect, it } from "vitest";
import { computeLinkedFunds, unpaidCardCharges, type LinkedFundsTransaction } from "@/lib/engines/linked-funds";
import type { LedgerEntry } from "@/lib/models/person";

const d = (day: number) => new Date(2026, 8, day);
const tx = (id: string, type: "income" | "expense", amount: number, accountId: string, day: number, extra: Partial<LinkedFundsTransaction> = {}): LinkedFundsTransaction => ({
  id, type, amount, accountId, dateTime: d(day), createdAt: d(day), description: id.toUpperCase(), deletedAt: null, isPersonLedgerMovement: false, ...extra,
});
const entry = (id: string, fields: Partial<LedgerEntry>): LedgerEntry & { id: string } =>
  ({
    id, personId: "amma", type: "receivedBack", amount: 0, date: d(20), note: "", increasesBalance: true, transactionRef: null, parentEntryId: null,
    createdAt: d(20), receivedStatus: "received", deletedAt: null, lastEditedAt: null, editHistory: [], ...fields,
  }) as LedgerEntry & { id: string };

describe("unpaidCardCharges — card payments cover the oldest charges first", () => {
  it("opening debt is covered before any purchase", () => {
    const txs = [tx("kseb", "expense", 1000, "hdfc", 5), tx("pay", "income", 1500, "hdfc", 10)];
    expect(unpaidCardCharges(txs, "hdfc", -2000).get("kseb")).toBe(1000); // ₹1,500 paid only ₹1,500 of the ₹2,000 opening
    expect(unpaidCardCharges(txs, "hdfc", 0).get("kseb")).toBe(0);
  });

  it("partial payment leaves the newest charge partly unpaid", () => {
    const txs = [tx("a", "expense", 500, "hdfc", 1), tx("kseb", "expense", 1000, "hdfc", 5), tx("pay", "income", 900, "hdfc", 10)];
    expect(unpaidCardCharges(txs, "hdfc").get("a")).toBe(0);
    expect(unpaidCardCharges(txs, "hdfc").get("kseb")).toBe(600);
  });
});

describe("computeLinkedFunds", () => {
  const cashLeg = tx("leg", "income", 3000, "sbi", 20, { isPersonLedgerMovement: true });
  const base = { persons: [{ id: "amma", name: "Amma" }], creditCardAccountIds: new Set(["hdfc"]), emis: [], loans: [], installments: [] };

  it("a loan with the person themself is never an onward payment; only an opted-in beneficiary loan is", () => {
    const inst = { id: "li1", scheduleId: "sch-loan", sequenceNumber: 2, amountDue: 3000, amountPaid: 0, deletedAt: null };
    const settle = entry("s1", { amount: 3000, paymentId: "p1", transactionRef: "leg", obligationRef: "loan-inst:li1", sourceKind: "loanInstallment" });
    const counterpartyLoan = { id: "l1", name: "Loan from Amma", scheduleId: "sch-loan", direction: "taken" as const, beneficiaryPersonId: null, deletedAt: null };
    expect(computeLinkedFunds({ ...base, entries: [settle], transactions: [cashLeg], loans: [counterpartyLoan], installments: [inst] })).toEqual([]);
    const beneficiaryLoan = { ...counterpartyLoan, name: "Bike loan", beneficiaryPersonId: "amma", beneficiaryRepaysInstallments: true };
    const [f] = computeLinkedFunds({ ...base, entries: [settle], transactions: [cashLeg], loans: [beneficiaryLoan], installments: [inst] });
    expect(f).toMatchObject({ title: "Bike loan #2", pendingAmount: 3000, status: "pending", destination: { kind: "loan", installmentId: "li1" } });
  });

  it("a bank-paid share, an advance and a manual settlement are never linked funds", () => {
    const bankExpense = tx("dinner", "expense", 1000, "sbi", 3);
    const parent = entry("gave", { type: "gave", amount: 1000, transactionRef: "dinner", sourceKind: "splitExpense", receivedStatus: "yetToReceive" });
    const settle = entry("s1", { amount: 1000, paymentId: "p1", transactionRef: "leg", parentEntryId: "gave", sourceKind: "splitExpense" });
    const advance = entry("adv", { amount: 2000, paymentId: "p1", transactionRef: "leg", sourceKind: "advance" });
    expect(computeLinkedFunds({ ...base, entries: [parent, settle, advance], transactions: [cashLeg, bankExpense] })).toEqual([]);
  });

  it("a deleted (reverted) cash leg or settlement drops the linked fund", () => {
    const charge = tx("kseb", "expense", 1000, "hdfc", 3);
    const parent = entry("gave", { type: "gave", amount: 1000, transactionRef: "kseb", sourceKind: "assignedExpense", receivedStatus: "yetToReceive" });
    const settle = entry("s1", { amount: 1000, paymentId: "p1", transactionRef: "leg", parentEntryId: "gave", sourceKind: "assignedExpense" });
    expect(computeLinkedFunds({ ...base, entries: [parent, settle], transactions: [cashLeg, charge] })).toHaveLength(1);
    expect(computeLinkedFunds({ ...base, entries: [parent, settle], transactions: [{ ...cashLeg, deletedAt: d(21) }, charge] })).toEqual([]);
    expect(computeLinkedFunds({ ...base, entries: [parent, { ...settle, deletedAt: d(21) }], transactions: [cashLeg, charge] })).toEqual([]);
  });
});
