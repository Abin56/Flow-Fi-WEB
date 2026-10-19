import { describe, expect, it } from "vitest";
import { buildTransactionStatementView } from "@/features/transactions/lib/transaction-statement";
import type { Account } from "@/lib/models/account";
import { balanceEffect, type Transaction } from "@/lib/models/transaction";

let seq = 0;
function tx(o: Partial<Transaction> & Pick<Transaction, "accountId" | "type" | "amount">): Transaction {
  seq += 1;
  return {
    id: `t${seq}`,
    dateTime: new Date(2026, 9, 1),
    categoryId: "c",
    description: "",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: new Date(2026, 9, 1),
    transferMatchedAt: null,
    status: "posted",
    isBusiness: false,
    source: null,
    loanId: null,
    emiId: null,
    installmentId: null,
    installmentPaymentId: null,
    paymentAllocationType: null,
    isPersonLedgerMovement: false,
    fundedByPersonId: null,
    transferFeeForId: null,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...o,
  };
}
const account = (id: string, type: Account["type"], opening: number, txs: Transaction[]): Account =>
  ({
    id,
    name: id,
    type,
    openingBalance: opening,
    currentBalance: Math.round((opening + txs.filter((t) => t.accountId === id && !t.deletedAt).reduce((s, t) => s + balanceEffect(t), 0)) * 100) / 100,
    accountNumberLast4: null,
  }) as unknown as Account;
const d = (day: number) => new Date(2026, 9, day);
const all = (txs: Transaction[]) => new Set(txs.map((t) => t.id));

describe("buildTransactionStatementView", () => {
  it("has no view without a single account (All Accounts never gets a running balance)", () => {
    expect(buildTransactionStatementView({ account: null, transactions: [], visibleIds: new Set() })).toBeNull();
  });

  it("matches the Accounts statement: opening 1000, then DR/CR with running balance, newest first", () => {
    const txs = [
      tx({ accountId: "bank", type: "expense", amount: 300, dateTime: d(1) }),
      tx({ accountId: "bank", type: "income", amount: 500.5, dateTime: d(2) }),
      tx({ accountId: "bank", type: "expense", amount: 0.25, dateTime: d(3) }),
    ];
    const v = buildTransactionStatementView({ account: account("bank", "bank", 1000, txs), transactions: txs, visibleIds: all(txs) })!;
    expect(v.rows.map((r) => [r.debit, r.credit, r.balance])).toEqual([[0.25, 0, 1200.25], [0, 500.5, 1200.5], [300, 0, 700]]);
    expect(v.statement.opening).toBe(1000);
    expect(v.statement.difference).toBe(0);
    expect(v.narrowed).toBe(false);
  });

  it("never mixes accounts: another account's records do not move this balance", () => {
    const txs = [
      tx({ accountId: "a", type: "expense", amount: 10, dateTime: d(1) }),
      tx({ accountId: "b", type: "expense", amount: 999, dateTime: d(1) }),
    ];
    const v = buildTransactionStatementView({ account: account("a", "bank", 100, txs), transactions: txs, visibleIds: all(txs) })!;
    expect(v.rows.map((r) => r.balance)).toEqual([90]);
  });

  it("filters hide rows but never restart or recompute the balance", () => {
    const txs = [
      tx({ accountId: "a", type: "income", amount: 100, dateTime: d(1) }),
      tx({ accountId: "a", type: "expense", amount: 30, dateTime: d(2) }),
      tx({ accountId: "a", type: "expense", amount: 20, dateTime: d(3) }),
    ];
    const visible = new Set([txs[2].id]);
    const v = buildTransactionStatementView({ account: account("a", "bank", 0, txs), transactions: txs, visibleIds: visible })!;
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0].balance).toBe(50); // 100 − 30 − 20, not −20
    expect(v.narrowed).toBe(true);
  });

  it("each transfer leg lands on its own account (card payment credits the card, debits the bank)", () => {
    const txs = [
      tx({ accountId: "bank", type: "expense", amount: 300, transferId: "x", dateTime: d(1) }),
      tx({ accountId: "card", type: "income", amount: 300, transferId: "x", dateTime: d(1) }),
    ];
    const bank = buildTransactionStatementView({ account: account("bank", "bank", 1000, txs), transactions: txs, visibleIds: all(txs) })!;
    const card = buildTransactionStatementView({ account: account("card", "card", -300, txs), transactions: txs, visibleIds: all(txs) })!;
    expect(bank.rows.map((r) => [r.debit, r.credit, r.balance])).toEqual([[300, 0, 700]]);
    expect(card.isCard).toBe(true);
    expect(card.rows.map((r) => [r.debit, r.credit, r.balance])).toEqual([[0, 300, 0]]);
    expect(bank.isCard).toBe(false);
  });

  it("account-neutral records (person-funded, excluded, already-paid-earlier) have no row and no effect", () => {
    const txs = [
      tx({ accountId: "a", type: "expense", amount: 40, excludeFromCalculations: true, loanId: "l", dateTime: d(1) }),
      tx({ accountId: "a", type: "expense", amount: 25, fundedByPersonId: "p", dateTime: d(2) }),
      tx({ accountId: "a", type: "expense", amount: 5, dateTime: d(3) }),
    ];
    const v = buildTransactionStatementView({ account: account("a", "bank", 50, txs), transactions: txs, visibleIds: all(txs) })!;
    expect(v.rows.map((r) => r.balance)).toEqual([45]);
    expect(v.notCountedCount).toBe(1);
  });

  it("People receipt and loan/EMI payments move only their real leg", () => {
    const txs = [
      tx({ accountId: "a", type: "income", amount: 70, isPersonLedgerMovement: true, dateTime: d(1) }),
      tx({ accountId: "a", type: "expense", amount: 20, emiId: "e", dateTime: d(2) }),
    ];
    const v = buildTransactionStatementView({ account: account("a", "bank", 0, txs), transactions: txs, visibleIds: all(txs) })!;
    expect(v.rows.map((r) => [r.debit, r.credit, r.balance])).toEqual([[20, 0, 50], [0, 70, 70]]);
  });

  it("ties on the same instant order deterministically and soft-deleted records are ignored", () => {
    const a = tx({ id: "b", accountId: "a", type: "expense", amount: 1, dateTime: d(1) });
    const b = tx({ id: "a", accountId: "a", type: "income", amount: 2, dateTime: d(1) });
    const gone = tx({ accountId: "a", type: "expense", amount: 500, dateTime: d(1), deletedAt: d(5) });
    const one = buildTransactionStatementView({ account: account("a", "bank", 0, [a, b]), transactions: [a, b, gone], visibleIds: all([a, b, gone]) })!;
    const two = buildTransactionStatementView({ account: account("a", "bank", 0, [a, b]), transactions: [gone, b, a], visibleIds: all([a, b, gone]) })!;
    expect(one.rows.map((r) => r.id)).toEqual(two.rows.map((r) => r.id));
    expect(one.rows[0].balance).toBe(1);
  });
});
