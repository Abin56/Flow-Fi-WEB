import { describe, expect, it } from "vitest";
import type { Transaction } from "@/lib/models/transaction";
import { planAccountTransactionClearing, runAccountTransactionClearing } from "./account-transaction-clearing";

let n = 0;
function tx(over: Partial<Transaction> & { id: string }): Transaction {
  n += 1;
  return {
    type: "expense",
    amount: 100,
    dateTime: new Date(2026, 0, n),
    accountId: "A",
    categoryId: "c",
    description: "x",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: new Date(2026, 0, n),
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
    deletedAt: null,
    ...over,
  } as Transaction;
}

const accounts = [
  { id: "A", name: "Card A", currentBalance: -300 },
  { id: "B", name: "Bank B", currentBalance: 1000 },
];

describe("planAccountTransactionClearing", () => {
  it("plain rows are direct and only move this account", () => {
    const all = [tx({ id: "1" }), tx({ id: "2", type: "income", amount: 50 }), tx({ id: "o", accountId: "B" })];
    const plan = planAccountTransactionClearing({ accountId: "A", transactions: all, accounts, splitOwnedTransactionIds: new Set(), target: "all" });
    expect(plan.steps.map((s) => s.transaction.id).sort()).toEqual(["1", "2"]);
    expect(plan.needsLinkedAcknowledgement).toBe(false);
    expect(plan.balanceMovements).toEqual([{ accountId: "A", name: "Card A", before: -300, after: -250 }]);
  });

  it("a card bill payment removes both legs once and moves both balances", () => {
    const all = [
      tx({ id: "card", type: "income", amount: 200, transferId: "T" }),
      tx({ id: "bank", type: "expense", amount: 200, transferId: "T", accountId: "B" }),
    ];
    const plan = planAccountTransactionClearing({ accountId: "A", transactions: all, accounts, splitOwnedTransactionIds: new Set(), target: "all" });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.coveredIds.sort()).toEqual(["bank", "card"]);
    expect(plan.otherAccountTransactionCount).toBe(1);
    expect(plan.needsLinkedAcknowledgement).toBe(true);
    expect(plan.balanceMovements.find((m) => m.accountId === "A")!.after).toBe(-500);
    expect(plan.balanceMovements.find((m) => m.accountId === "B")!.after).toBe(1200);
  });

  it("a transfer fee is removed with its transfer, not as its own row", () => {
    const all = [
      tx({ id: "card", type: "income", amount: 200, transferId: "T" }),
      tx({ id: "bank", type: "expense", amount: 200, transferId: "T", accountId: "B" }),
      tx({ id: "T_fee", amount: 5, transferFeeForId: "T" }),
    ];
    const plan = planAccountTransactionClearing({ accountId: "A", transactions: all, accounts, splitOwnedTransactionIds: new Set(), target: "all" });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.coveredIds.sort()).toEqual(["T_fee", "bank", "card"]);
    expect(plan.counts.fees).toBe(1);
  });

  it("blocks Loan/EMI, bill and EMI-linked transfer rows; never plans them", () => {
    const all = [
      tx({ id: "emi", emiId: "e1" }),
      tx({ id: "loan", loanId: "l1" }),
      tx({ id: "bill", billPaymentId: "b1" }),
      tx({ id: "leg", type: "income", transferId: "T" }),
      tx({ id: "other", accountId: "B", transferId: "T", emiId: "e2" }),
      tx({ id: "ok" }),
    ];
    const plan = planAccountTransactionClearing({ accountId: "A", transactions: all, accounts, splitOwnedTransactionIds: new Set(), target: "all" });
    expect(plan.steps.map((s) => s.transaction.id)).toEqual(["ok"]);
    expect(plan.blocked.map((b) => b.transaction.id).sort()).toEqual(["bill", "emi", "leg", "loan"]);
  });

  it("split and People cash legs are linked and need acknowledgement", () => {
    const all = [tx({ id: "s" }), tx({ id: "p", isPersonLedgerMovement: true, linkedPersonId: "x" })];
    const plan = planAccountTransactionClearing({ accountId: "A", transactions: all, accounts, splitOwnedTransactionIds: new Set(["s"]), target: "all" });
    expect(plan.counts).toMatchObject({ splits: 1, people: 1, direct: 0 });
    expect(plan.needsLinkedAcknowledgement).toBe(true);
  });

  it("selected mode only touches the chosen rows and ignores already deleted ones", () => {
    const all = [tx({ id: "1" }), tx({ id: "2" }), tx({ id: "3", deletedAt: new Date() })];
    const plan = planAccountTransactionClearing({ accountId: "A", transactions: all, accounts, splitOwnedTransactionIds: new Set(), target: new Set(["2", "3"]) });
    expect(plan.steps.map((s) => s.transaction.id)).toEqual(["2"]);
  });
});

describe("runAccountTransactionClearing", () => {
  it("continues past a refused row and reports it", async () => {
    const all = [tx({ id: "1" }), tx({ id: "2" }), tx({ id: "3" })];
    const plan = planAccountTransactionClearing({ accountId: "A", transactions: all, accounts, splitOwnedTransactionIds: new Set(), target: "all" });
    const calls: string[] = [];
    const res = await runAccountTransactionClearing(
      plan.steps,
      async (t) => {
        calls.push(t.id);
        if (t.id === "2") throw new Error("nope");
      },
      { messageFor: (e) => (e as Error).message },
    );
    expect(calls).toEqual(["1", "2", "3"]);
    expect(res.removedSteps).toBe(2);
    expect(res.failures.map((f) => f.step.transaction.id)).toEqual(["2"]);
  });
});
