import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";
import { AgreementDeletionBlockedError, atomicWriteCount, planAgreementDeletion, type AgreementDeletionInput } from "./agreement-deletion";

function txn(id: string, o: Partial<Transaction> = {}): Transaction {
  return {
    id,
    type: "expense",
    amount: 0,
    dateTime: new Date("2026-09-01T00:00:00Z"),
    accountId: "hdfc",
    categoryId: "loan_payment",
    description: "",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    transferMatchedAt: null,
    status: "posted",
    isBusiness: false,
    source: "manual",
    loanId: null,
    emiId: null,
    installmentId: null,
    installmentPaymentId: null,
    paymentAllocationType: null,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...o,
  } as Transaction;
}

function entry(id: string, o: Partial<LedgerEntry>): LedgerEntry {
  return {
    id,
    personId: "ravi",
    type: "borrowed",
    amount: 0,
    date: new Date("2026-09-01T00:00:00Z"),
    note: "",
    increasesBalance: false,
    transactionRef: "loan-1",
    createdAt: new Date("2026-09-01T00:00:00Z"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...o,
  } as LedgerEntry;
}

const base = (o: Partial<AgreementDeletionInput> = {}): AgreementDeletionInput => ({
  kind: "loan",
  agreementId: "loan-1",
  purchaseTransactionId: null,
  referencedTransactionIds: [],
  transactions: [],
  ledgerEntries: [],
  dependentExpenseTransactionIds: [],
  ...o,
});

const deltas = (input: AgreementDeletionInput) => Object.fromEntries(planAgreementDeletion(input).accountDeltas);

describe("permanent Loan/EMI deletion — what is reversed", () => {
  it("1/2/3. an agreement with no activity (Loan or EMI, installments only) reverses nothing", () => {
    for (const kind of ["loan", "emi"] as const) {
      const plan = planAgreementDeletion(base({ kind }));
      expect(plan.ownedTransactions).toEqual([]);
      expect(plan.accountDeltas.size).toBe(0);
      expect(plan.personDelta).toBe(0);
    }
  });

  it("9. ₹1,00,000 received into HDFC at creation → ₹1,00,000 taken back out of HDFC", () => {
    const origination = txn("orig_k_txn", { type: "income", amount: 100000, loanId: "loan-1", paymentAllocationType: "additionalDisbursement" });
    expect(deltas(base({ transactions: [origination] }))).toEqual({ hdfc: -100000 });
  });

  it("4. creation +₹1,00,000 and a ₹20,000 payment → HDFC moves −₹80,000: as if the loan never existed", () => {
    const transactions = [
      txn("orig", { type: "income", amount: 100000, loanId: "loan-1" }),
      txn("pay1", { type: "expense", amount: 20000, loanId: "loan-1", paymentAllocationType: "regularEmi" }),
    ];
    expect(deltas(base({ transactions }))).toEqual({ hdfc: -80000 });
  });

  it("5/6/8. several payments — interest-bearing, from two accounts, fully paid — each undone once on its own account", () => {
    const transactions = [
      txn("orig", { type: "income", amount: 50000, loanId: "loan-1" }),
      txn("p1", { amount: 17438.72, loanId: "loan-1" }), // principal + interest together, as paid
      txn("p2", { amount: 17438.72, loanId: "loan-1", accountId: "icici" }),
      txn("p3", { amount: 17438.73, loanId: "loan-1" }), // last one settles the loan
    ];
    expect(deltas(base({ transactions }))).toEqual({ hdfc: -15122.55, icici: 17438.72 });
  });

  it("6/extra principal. an extra-principal payment's Transaction is reversed like any other", () => {
    const transactions = [txn("pre", { amount: 30000, loanId: "loan-1", paymentAllocationType: "principalPrepayment" })];
    expect(deltas(base({ transactions }))).toEqual({ hdfc: 30000 });
  });

  it("a payment Transaction named only by the loan's own payment record (no back-reference) is still owned", () => {
    const transactions = [txn("legacy-linked", { amount: 5000 })];
    expect(deltas(base({ transactions, referencedTransactionIds: ["legacy-linked"] }))).toEqual({ hdfc: 5000 });
  });

  it("15. no double reversal: a payment already marked unpaid (soft-deleted) is removed but moves nothing; duplicates count once", () => {
    const reversed = txn("undone", { amount: 20000, loanId: "loan-1", deletedAt: new Date() });
    const active = txn("pay", { amount: 5000, loanId: "loan-1" });
    const plan = planAgreementDeletion(base({ transactions: [reversed, active, active], referencedTransactionIds: ["pay"] }));
    expect(Object.fromEntries(plan.accountDeltas)).toEqual({ hdfc: 5000 });
    expect(plan.ownedTransactions.map((t) => t.id).sort()).toEqual(["pay", "undone"]);
  });

  it("unrelated history is never touched — other loans, similar amounts, excluded-from-calculation rows move nothing", () => {
    const transactions = [
      txn("groceries", { amount: 20000 }), // same amount, no link
      txn("other-loan-pay", { amount: 20000, loanId: "loan-2" }),
      txn("hidden", { amount: 999, loanId: "loan-1", excludeFromCalculations: true }),
    ];
    const plan = planAgreementDeletion(base({ transactions }));
    expect(plan.ownedTransactions.map((t) => t.id)).toEqual(["hidden"]);
    expect(plan.accountDeltas.size).toBe(0);
  });

  it("7/10. card-linked EMI: its card charges (advance included) are reversed on the card; the linked purchase is kept", () => {
    const transactions = [
      txn("purchase", { amount: 40000, accountId: "card-acc", emiId: "emi-1" }), // user's real purchase
      txn("emi_k1_p0", { amount: 5000, accountId: "card-acc", emiId: "emi-1", paymentAllocationType: "regularEmi" }),
      txn("emi_k2_p0", { amount: 15000, accountId: "card-acc", emiId: "emi-1", paymentAllocationType: "advanceEmi" }),
    ];
    const plan = planAgreementDeletion(base({ kind: "emi", agreementId: "emi-1", purchaseTransactionId: "purchase", transactions }));
    expect(plan.ownedTransactions.map((t) => t.id)).toEqual(["emi_k1_p0", "emi_k2_p0"]);
    // Card account balance is a liability shown negative: the ₹20,000 of EMI charges come back off it.
    expect(Object.fromEntries(plan.accountDeltas)).toEqual({ "card-acc": 20000 });
  });

  it("11. People: legacy Loan-generated entries are reversed once — active ones move the balance, trashed ones are only removed", () => {
    const ledgerEntries = [
      entry("created", { type: "borrowed", amount: 25000 }), // I borrowed from Ravi → balance −25,000
      entry("repaid", { type: "repaid", amount: 5000 }), // repaid → +5,000
      entry("trashed", { type: "repaid", amount: 1000, deletedAt: new Date() }),
      entry("manual", { type: "gave", amount: 700, transactionRef: null }), // unrelated manual entry
    ];
    const plan = planAgreementDeletion(base({ ledgerEntries }));
    expect(plan.personDelta).toBe(20000);
    expect(plan.ledgerEntryIds.sort()).toEqual(["created", "repaid", "trashed"]);
  });

  it("a split/shared expense built on one of its payments stops the deletion — nothing is deleted as a side effect", () => {
    const transactions = [txn("pay", { amount: 5000, loanId: "loan-1" })];
    expect(() => planAgreementDeletion(base({ transactions, dependentExpenseTransactionIds: ["pay"] }))).toThrow(AgreementDeletionBlockedError);
    // An expense on some other Transaction doesn't matter.
    expect(() => planAgreementDeletion(base({ transactions, dependentExpenseTransactionIds: ["unrelated"] }))).not.toThrow();
  });

  it("counts the writes of the single atomic money step", () => {
    const plan = planAgreementDeletion(
      base({
        transactions: [txn("a", { type: "income", amount: 100000, loanId: "loan-1" }), txn("b", { amount: 20000, loanId: "loan-1", accountId: "icici" })],
        ledgerEntries: [entry("e", { amount: 100 })],
      }),
    );
    // 2 accounts + 2 Transactions + Person + 1 entry + agreement + schedule marker
    expect(atomicWriteCount(plan)).toBe(8);
  });
});
