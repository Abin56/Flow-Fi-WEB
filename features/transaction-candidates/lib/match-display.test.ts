import { describe, expect, it } from "vitest";
import type { Account } from "@/lib/models/account";
import type { Transaction } from "@/lib/models/transaction";
import { evaluateCandidateDuplicate } from "./candidate-duplicate";
import { buildRowMatches } from "./match-display";
import { findPossibleMatches, mergeGateMatch } from "./possible-matches";

const accounts = [{ id: "acc-1", name: "HDFC Savings", accountNumberLast4: "4821" }] as Account[];
const categories = [{ id: "cat-food", name: "Food" }];
const saved = (o: Partial<Transaction> = {}) =>
  ({ id: "txn_abcdef123456", description: "SWIGGY", amount: 200, dateTime: new Date(2026, 9, 12), accountId: "acc-1", categoryId: "cat-food", type: "expense", source: "pdf", ...o }) as Transaction;
const sms = { id: "c1", merchant: "Swiggy", bankName: "HDFC", amount: 200.08, transactionDate: new Date(2026, 9, 12, 14, 30), referenceNumber: null, direction: "debit" as const, accountId: "acc-1" };

describe("inbox match pipeline (finder + strict gate + display)", () => {
  it("₹200.08 SMS vs the ₹200 statement row already imported: a readable POSSIBLE match, not flagged by the strict gate", () => {
    const t = saved();
    expect(evaluateCandidateDuplicate(sms, [t]).duplicateOfTransactionId).toBeNull(); // strict gate misses it — this is the gap
    const found = mergeGateMatch(findPossibleMatches(sms, "acc-1", [t]), null, sms, "acc-1", new Map([[t.id, t]]));
    const [row] = buildRowMatches(found, new Map([[t.id, t]]), accounts, categories);
    expect(row).toMatchObject({ kind: "possible" });
    expect(row?.existing).toMatchObject({ description: "SWIGGY", dateText: "12 Oct 2026", amountText: "₹200", directionText: "Expense", accountLabel: "HDFC Savings •••• 4821", categoryLabel: "Food", sourceLabel: "Statement import" });
    expect(JSON.stringify(row?.existing)).not.toContain("txn_");
  });

  it("the same SMS at the exact amount is an EXACT match and the strict gate agrees", () => {
    const t = saved();
    const exactSms = { ...sms, amount: 200 };
    const gate = evaluateCandidateDuplicate(exactSms, [t]);
    expect(gate.duplicateOfTransactionId).toBe(t.id);
    const [m] = mergeGateMatch(findPossibleMatches(exactSms, "acc-1", [t]), gate, exactSms, "acc-1", new Map([[t.id, t]]));
    expect(m?.kind).toBe("exact");
  });

  it("drops a match whose transaction is no longer loaded", () => {
    expect(buildRowMatches(findPossibleMatches(sms, "acc-1", [saved()]), new Map(), accounts, categories)).toEqual([]);
  });
});
