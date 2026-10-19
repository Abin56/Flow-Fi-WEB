import { describe, expect, it } from "vitest";
import { buildAccountStatement } from "@/features/accounts/lib/account-statement";
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
const acct = (id: string, opening: number, txs: Transaction[], drift = 0) => ({
  id,
  name: id,
  openingBalance: opening,
  currentBalance: Math.round((opening + txs.filter((t) => t.accountId === id && !t.deletedAt).reduce((s, t) => s + balanceEffect(t), 0) + drift) * 100) / 100,
});
const d = (day: number, h = 0) => new Date(2026, 9, day, h);

describe("buildAccountStatement", () => {
  it("opening 10, debit 5, credit 20, debit 10 → 5, 25, 15", () => {
    const txs = [
      tx({ accountId: "a", type: "expense", amount: 5, dateTime: d(12), description: "Expense" }),
      tx({ accountId: "a", type: "income", amount: 20, dateTime: d(13) }),
      tx({ accountId: "a", type: "expense", amount: 10, dateTime: d(14), emiId: "e1", description: "EMI payment" }),
    ];
    const s = buildAccountStatement({ accounts: [acct("a", 10, txs)], transactions: [...txs].reverse() });
    expect(s.rows.map((r) => [r.debit, r.credit, r.balance])).toEqual([[5, 0, 5], [0, 20, 25], [10, 0, 15]]);
    expect(s.rows[1].description).toBe("Money received");
    expect(s.fromRecords).toBe(15);
    expect(s.difference).toBe(0);
  });

  it("orders same-time records deterministically regardless of load order", () => {
    const a = tx({ id: "b", accountId: "a", type: "expense", amount: 1, dateTime: d(1), createdAt: d(1, 1) });
    const b = tx({ id: "a", accountId: "a", type: "income", amount: 2, dateTime: d(1), createdAt: d(1, 1) });
    const c = tx({ id: "c", accountId: "a", type: "income", amount: 4, dateTime: d(1), createdAt: d(1, 0) });
    const accounts = [acct("a", 0, [a, b, c])];
    const one = buildAccountStatement({ accounts, transactions: [a, b, c] }).rows.map((r) => r.id);
    const two = buildAccountStatement({ accounts, transactions: [c, b, a] }).rows.map((r) => r.id);
    expect(one).toEqual(["c", "a", "b"]);
    expect(two).toEqual(one);
  });

  it("shows each transfer / card payment / loan / people leg on its own account", () => {
    const txs = [
      tx({ accountId: "bank", type: "expense", amount: 300, transferId: "x", dateTime: d(1) }),
      tx({ accountId: "card", type: "income", amount: 300, transferId: "x" }),
      tx({ accountId: "bank", type: "expense", amount: 50, loanId: "l", dateTime: d(2) }),
      tx({ accountId: "bank", type: "income", amount: 70, isPersonLedgerMovement: true, dateTime: d(3) }),
    ];
    const bank = buildAccountStatement({ accounts: [acct("bank", 1000, txs)], transactions: txs });
    expect(bank.rows.map((r) => r.balance)).toEqual([700, 650, 720]);
    const card = buildAccountStatement({ accounts: [acct("card", -300, txs)], transactions: txs });
    expect(card.rows.map((r) => [r.credit, r.balance])).toEqual([[300, 0]]);
  });

  it("ignores excluded, soft-deleted and other-account records", () => {
    const txs = [
      tx({ accountId: "a", type: "expense", amount: 40, excludeFromCalculations: true }),
      tx({ accountId: "a", type: "expense", amount: 60, deletedAt: d(5) }),
      tx({ accountId: "z", type: "expense", amount: 9 }),
      tx({ accountId: "a", type: "expense", amount: 1 }),
    ];
    const s = buildAccountStatement({ accounts: [acct("a", 10, txs)], transactions: txs });
    expect(s.rows).toHaveLength(1);
    expect(s.notCountedCount).toBe(1);
    expect(s.fromRecords).toBe(9);
  });

  it("is exact to the paisa", () => {
    const txs = Array.from({ length: 10 }, (_, i) => tx({ accountId: "a", type: "income", amount: 0.1, dateTime: d(1, i) }));
    const s = buildAccountStatement({ accounts: [acct("a", 0.2, txs)], transactions: txs });
    expect(s.rows[9].balance).toBe(1.2);
    expect(s.difference).toBe(0);
  });

  it("reports a stored-balance mismatch without adjusting it", () => {
    const txs = [tx({ accountId: "a", type: "income", amount: 100 })];
    const s = buildAccountStatement({ accounts: [acct("a", 0, txs, 12.34)], transactions: txs });
    expect(s.fromRecords).toBe(100);
    expect(s.stored).toBe(112.34);
    expect(s.difference).toBe(12.34);
  });

  it("a historical edit recomputes later balances", () => {
    const first = tx({ accountId: "a", type: "expense", amount: 5, dateTime: d(1) });
    const second = tx({ accountId: "a", type: "income", amount: 20, dateTime: d(2) });
    const before = buildAccountStatement({ accounts: [acct("a", 10, [first, second])], transactions: [first, second] });
    const edited = { ...first, amount: 8 };
    const after = buildAccountStatement({ accounts: [acct("a", 10, [edited, second])], transactions: [edited, second] });
    expect(before.rows[1].balance).toBe(25);
    expect(after.rows[1].balance).toBe(22);
  });
});
