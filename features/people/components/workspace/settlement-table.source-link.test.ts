import { describe, expect, it, vi } from "vitest";

// The component module transitively imports the Firebase client; these pure helpers never touch it.
vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));
import type { LedgerRow } from "@/features/people/lib/person-ledger-rows";
import type { SettlementLookups } from "@/features/people/lib/settlement-presentation";
import { sourceLink, sourceUnavailable } from "./settlement-table";

/** 16. No dead Edit/Delete navigation: a row whose source transaction is gone never links to /transactions. */
const row = (overrides: Partial<LedgerRow> = {}): LedgerRow =>
  ({
    key: "ledger:e1",
    entryId: "e1",
    category: "borrowed",
    deletable: false,
    deleteBlock: "expense",
    statementRow: { kind: "obligation" },
    loanId: null,
    ...overrides,
  }) as unknown as LedgerRow;

const lookups = (status: "live" | "deleted" | "unknown" | null): SettlementLookups => ({
  entriesById: new Map([["e1", { sourceKind: "personFundedExpense", transactionRef: "txn-exam" }]]),
  expenseByTransactionId: new Map(),
  ...(status ? { transactionStatus: () => status } : {}),
});

describe("People Ledger source actions are source-aware", () => {
  it("healthy transaction-backed row → opens its authoritative transaction", () => {
    expect(sourceLink(row(), lookups("live"))).toEqual({ href: "/transactions?transaction=txn-exam", label: "Open expense" });
    expect(sourceUnavailable(row(), lookups("live"))).toBe(false);
  });

  it("orphan row (source transaction deleted) → no link, shown as unavailable", () => {
    expect(sourceLink(row(), lookups("deleted"))).toBeNull();
    expect(sourceUnavailable(row(), lookups("deleted"))).toBe(true);
  });

  it("while transactions are still loading nothing is declared missing", () => {
    expect(sourceUnavailable(row(), lookups("unknown"))).toBe(false);
    expect(sourceUnavailable(row(), lookups(null))).toBe(false);
  });

  it("a People-native (deletable) row keeps its own Edit/Delete — never marked unavailable", () => {
    expect(sourceUnavailable(row({ deletable: true, deleteBlock: null }), lookups("deleted"))).toBe(false);
  });
});
