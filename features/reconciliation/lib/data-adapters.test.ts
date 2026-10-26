import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

import type { CreditCardProfile, Statement } from "@/lib/models/credit-card";
import type { Expense } from "@/lib/models/expense";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { Transaction } from "@/lib/models/transaction";
import { buildCycleResolver } from "./card-cycle-status";
import { buildExistingRecords, transactionOrigin } from "./existing-records";
import { importedTransactionIdsFor, reconciliationSessionId } from "./session-key";
import { captureSessionId } from "@/features/smart-capture/lib/capture-review";
import { importTransferKey } from "@/features/transaction-studio/lib/commit-review-import";

function txn(over: Partial<Transaction> & { id: string }): Transaction {
  return {
    type: "expense",
    amount: 500,
    dateTime: new Date("2026-09-05T13:00:00+05:30"),
    accountId: "acc-card",
    categoryId: "c1",
    description: "Swiggy",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: new Date("2026-09-05T13:00:00+05:30"),
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
    lastEditedAt: null,
    editHistory: [],
    ...over,
  };
}

describe("existing record adapters (read-only)", () => {
  it("reads origin from keys/source; a null source is unknown, never manual", () => {
    expect(transactionOrigin(txn({ id: "txn_sms_abc12345" }))).toBe("sms");
    expect(transactionOrigin(txn({ id: "x", source: "sms" }))).toBe("sms");
    expect(transactionOrigin(txn({ id: "txn_imp_aa_r1", notes: "Imported via Smart Capture" }))).toBe("smart_capture");
    expect(transactionOrigin(txn({ id: "txn_imp_aa_7" }))).toBe("statement_import");
    expect(transactionOrigin(txn({ id: "x", source: "manual" }))).toBe("manual");
    expect(transactionOrigin(txn({ id: "x" }))).toBe("unknown");
  });

  it("marks owners, transfer legs, deletions; SMS candidates resolve a card to its account", () => {
    const expenses = [{ id: "e1", transactionId: "t-split", splitType: "equal", participants: [{}], deletedAt: null } as unknown as Expense];
    const cards = [{ id: "card1", accountId: "acc-card" } as CreditCardProfile];
    const sms = [{ id: "s1", amount: 500, direction: "debit", transactionDate: new Date("2026-09-05T12:00:00+05:30"), merchant: "SWIGGY", bankName: null, cardId: "card1", accountId: null, rawLastFour: "4821" } as unknown as SmsTransactionCandidate];
    const records = buildExistingRecords({
      transactions: [txn({ id: "t-emi", emiId: "e" }), txn({ id: "t-split" }), txn({ id: "t-xfer", transferId: "x", type: "income" })],
      trashedTransactions: [txn({ id: "t-gone", deletedAt: new Date() })],
      smsCandidates: sms,
      creditCards: cards,
      expenses,
    });
    const byId = new Map(records.map((r) => [r.id, r]));
    expect(byId.get("t-emi")!.owner).toBe("emi");
    expect(byId.get("t-split")!.owner).toBe("split");
    expect(byId.get("t-xfer")).toMatchObject({ isTransferLeg: true, direction: "credit" });
    expect(byId.get("t-gone")!.deleted).toBe(true);
    expect(byId.get("sms:s1")).toMatchObject({ kind: "sms_pending", accountId: "acc-card", rawLastFour: "4821" });
  });
});

describe("already-imported keys", () => {
  it("covers both a future Reconciliation import and Smart Capture's direct import of the same paste", () => {
    const text = "05/09/2026 SWIGGY 500.00";
    const ids = importedTransactionIdsFor("r1", { fingerprint: "fp:1", accountId: "acc-card", priorSessionIds: { "acc-card": captureSessionId(text, "acc-card") } });
    expect(ids).toEqual([`txn_${importTransferKey("r1", reconciliationSessionId("fp:1", "acc-card"))}`, `txn_${importTransferKey("r1", captureSessionId(text, "acc-card"))}`]);
    expect(reconciliationSessionId("fp:1", "acc-card")).not.toBe(reconciliationSessionId("fp:1", "acc-bank"));
  });
});

describe("D10 card-cycle resolver", () => {
  // Statement day 17: the cycle 18 Aug – 17 Sep closes on 17 Sep; due 5 Oct.
  const card = { id: "card1", accountId: "acc-card", statementDay: 17, paymentDueDay: 5, minimumDuePercent: null } as unknown as CreditCardProfile;
  const now = new Date(2026, 9, 26, 12);

  it("open / closed / paid, without any stored statement", () => {
    const resolver = buildCycleResolver({
      card,
      transactions: [
        txn({ id: "aug", amount: 1000, dateTime: new Date(2026, 7, 10, 12) }), // cycle Jul 18–Aug 17
        txn({ id: "pay", amount: 1000, type: "income", transferId: "xf", dateTime: new Date(2026, 8, 1, 12) }), // pays it
        txn({ id: "sep", amount: 700, dateTime: new Date(2026, 8, 10, 12) }), // cycle Aug 18–Sep 17, unpaid
      ],
      statements: [] as Statement[],
      now,
    });
    expect(resolver(new Date(2026, 7, 10))!.status).toBe("paid");
    expect(resolver(new Date(2026, 8, 10))!.status).toBe("closed");
    expect(resolver(new Date(2026, 9, 20))!.status).toBe("open");
    // A closed cycle with no charges at all is still closed.
    expect(resolver(new Date(2026, 5, 1))!.status).toBe("closed");
  });

  it("a non-card account has no cycle", () => {
    expect(buildCycleResolver({ card: null, transactions: [], statements: [] })(new Date())).toBeNull();
  });
});
