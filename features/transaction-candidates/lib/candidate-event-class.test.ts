import { describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase/firestore";
import {
  SMS_CANDIDATE_EVENT_CLASSES,
  smsTransactionCandidateFromFirestore,
  smsTransactionCandidateToFirestore,
  type SmsCandidateEventClass,
  type SmsTransactionCandidate,
} from "@/lib/models/sms-transaction-candidate";
import type { Transaction } from "@/lib/models/transaction";
import { candidateImportBlockReason, candidateIntegrityReviewReason, candidatePassesIntegrity } from "./candidate-event-class";
import { deriveCandidateStatus } from "./candidate-status";
import { partitionBulkEligible } from "./bulk-selection";
import { bulkImportCandidates, importCandidate } from "./import-candidate";

function candidate(overrides: Partial<SmsTransactionCandidate> = {}): SmsTransactionCandidate {
  return {
    id: "sms-1",
    amount: 350,
    direction: "debit",
    eventType: "upiPayment",
    transactionDate: new Date("2026-11-01T17:46:00.000Z"),
    merchant: "ABIN JOHN",
    bankName: "Bank of India",
    rawLastFour: "9585",
    accountId: "acc-boi",
    cardId: null,
    referenceNumber: "630557620611",
    confidenceLevel: "high",
    confidenceScore: 0.9,
    needsReview: false,
    needsReviewReasons: [],
    source: "sms",
    createdAt: new Date("2026-11-01T17:46:05.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

/** A candidate uploaded with Android's classification v1. */
function classified(eventClass: SmsCandidateEventClass, overrides: Partial<SmsTransactionCandidate> = {}): SmsTransactionCandidate {
  const moving = ["actualCredit", "actualDebit", "creditCardPurchase", "creditCardRefund", "cardBillPayment", "emiDebited", "reversal"].includes(eventClass);
  return candidate({
    eventClass,
    moneyMovement: moving,
    directionEvidence: "contextual",
    ownership: "verified",
    classificationVersion: 1,
    ...overrides,
  });
}

const NO_MONEY_MOVED: SmsCandidateEventClass[] = [
  "scheduledCredit",
  "scheduledDebit",
  "emiReminder",
  "failedTransaction",
  "pendingTransaction",
  "balanceAlert",
  "thirdPartyEvent",
  "informational",
  "unknown",
];

function mockRepos() {
  const createTransaction = vi.fn(async () => ({ id: "txn-1" }) as Transaction);
  const markHandled = vi.fn(async () => ({ outcome: "imported" as const, mismatched: false }));
  return {
    transactionRepository: { createTransaction, editTransaction: vi.fn() } as unknown as import("@/lib/repositories/transaction-repository").TransactionRepository,
    candidateRepository: { markHandled } as unknown as import("@/lib/repositories/sms-transaction-candidate-repository").SmsTransactionCandidateRepository,
    expenseRepository: {} as unknown as import("@/lib/repositories/expense-repository").ExpenseRepository,
    createTransaction,
    markHandled,
  };
}

describe("candidateImportBlockReason", () => {
  it.each(NO_MONEY_MOVED)("blocks %s — no money moved", (eventClass) => {
    expect(candidateImportBlockReason(classified(eventClass))).toEqual(expect.any(String));
  });

  it.each(["actualCredit", "actualDebit", "creditCardPurchase", "creditCardRefund", "cardBillPayment", "emiDebited", "reversal"] as const)(
    "never blocks money-moving %s",
    (eventClass) => {
      expect(candidateImportBlockReason(classified(eventClass))).toBeNull();
    },
  );

  it("a legacy candidate (no eventClass) is never blocked — behaviour unchanged", () => {
    expect(candidateImportBlockReason(candidate())).toBeNull();
    expect(candidatePassesIntegrity(candidate())).toBe(true);
  });

  it("moneyMovement === false wins over a money-moving class (stricter reading)", () => {
    expect(candidateImportBlockReason(classified("actualDebit", { moneyMovement: false }))).toEqual(expect.any(String));
  });
});

describe("candidateIntegrityReviewReason", () => {
  it("a routine class with contextual direction passes", () => {
    expect(candidateIntegrityReviewReason(classified("actualDebit"))).toBeNull();
    expect(candidatePassesIntegrity(classified("actualDebit"))).toBe(true);
  });

  it.each(["creditCardRefund", "cardBillPayment", "reversal"] as const)("%s always needs individual review", (eventClass) => {
    expect(candidateIntegrityReviewReason(classified(eventClass))).toEqual(expect.any(String));
    expect(candidatePassesIntegrity(classified(eventClass))).toBe(false);
  });

  it("a debit/credit read from bare keywords needs review", () => {
    expect(candidateIntegrityReviewReason(classified("actualDebit", { directionEvidence: "keyword" }))).toEqual(expect.any(String));
  });
});

describe("deriveCandidateStatus with integrity fields", () => {
  it("a failed payment sits in Needs Review as 'nothing to import', even if it looks like a duplicate", () => {
    const status = deriveCandidateStatus(classified("failedTransaction"), {
      duplicateOfTransactionId: "txn-9",
      confidence: 0.9,
      reason: "same",
    });
    expect(status.lane).toBe("needsReview");
    expect(status.label).toContain("Failed payment");
    expect(status.label).toContain("nothing to import");
  });

  it("a reminder is never 'No issues flagged'", () => {
    expect(deriveCandidateStatus(classified("emiReminder"), null).lane).toBe("needsReview");
  });

  it("a refund needs review even when Android didn't flag it", () => {
    const status = deriveCandidateStatus(classified("creditCardRefund"), null);
    expect(status.lane).toBe("needsReview");
    expect(status.label).toBe("Needs Review");
  });

  it("a verified routine debit with a matched account is 'No issues flagged'", () => {
    expect(deriveCandidateStatus(classified("actualDebit"), null).lane).toBe("noIssues");
  });

  it("a legacy candidate keeps its previous lane", () => {
    expect(deriveCandidateStatus(candidate(), null).lane).toBe("noIssues");
  });
});

describe("bulk eligibility", () => {
  it("holds back non-routine and no-money-moved rows even when the account is matched", () => {
    const rows = [
      classified("actualDebit", { id: "ok" }),
      classified("failedTransaction", { id: "failed" }),
      classified("reversal", { id: "reversal" }),
      classified("actualDebit", { id: "keyword", directionEvidence: "keyword" }),
      candidate({ id: "legacy" }),
    ];
    const { eligible, blocked } = partitionBulkEligible(rows, () => true);
    expect(eligible.map((c) => c.id)).toEqual(["ok", "legacy"]);
    expect(blocked.map((c) => c.id)).toEqual(["failed", "reversal", "keyword"]);
  });
});

describe("import guard — a non-movement can never reach a balance", () => {
  it.each(NO_MONEY_MOVED)("importCandidate refuses %s with no writes", async (eventClass) => {
    const repos = mockRepos();
    const result = await importCandidate(
      { candidate: classified(eventClass, { id: `c-${eventClass}` }), accountId: "acc-boi", matchedCard: null, categoryId: "cat-1" },
      repos.transactionRepository,
      repos.candidateRepository,
      repos.expenseRepository,
    );
    expect(result.status).toBe("validation_failed");
    expect(repos.createTransaction).not.toHaveBeenCalled();
    expect(repos.markHandled).not.toHaveBeenCalled();
  });

  it("bulkImportCandidates (forced destination) still refuses them, and imports only the real movement", async () => {
    const repos = mockRepos();
    const results = await bulkImportCandidates(
      [classified("pendingTransaction", { id: "pending" }), classified("actualDebit", { id: "real" })],
      "cat-1",
      [],
      repos.transactionRepository,
      repos.candidateRepository,
      repos.expenseRepository,
      [],
      false,
      { accountId: "acc-boi", matchedCard: null },
    );
    expect(results.find((r) => r.candidateId === "pending")?.outcome.status).toBe("validation_failed");
    expect(results.find((r) => r.candidateId === "real")?.outcome.status).toBe("success");
    expect(repos.createTransaction).toHaveBeenCalledTimes(1);
  });

  it("a review-only class (reversal) can still be imported individually after review", async () => {
    const repos = mockRepos();
    const result = await importCandidate(
      { candidate: classified("reversal", { direction: "credit", id: "rev" }), accountId: "acc-boi", matchedCard: null, categoryId: "cat-1" },
      repos.transactionRepository,
      repos.candidateRepository,
      repos.expenseRepository,
    );
    expect(result.status).toBe("success");
  });
});

describe("Android ↔ Web contract (eventClass)", () => {
  // Mirrored exactly in Android: test/features/sms_inbox/sms_candidate_verification_test.dart
  // ("Android ↔ Web contract"), from `SmsEventClass` / `movesMoney` / `isRoutine` in sms_event_class.dart.
  it("the serialized names are exactly Android's", () => {
    expect(SMS_CANDIDATE_EVENT_CLASSES).toEqual([
      "actualCredit",
      "actualDebit",
      "scheduledCredit",
      "scheduledDebit",
      "creditCardPurchase",
      "creditCardRefund",
      "cardBillPayment",
      "emiReminder",
      "emiDebited",
      "failedTransaction",
      "pendingTransaction",
      "reversal",
      "balanceAlert",
      "thirdPartyEvent",
      "informational",
      "unknown",
    ]);
  });

  it("money-moving and routine sets match Android's movesMoney / isRoutine", () => {
    const moving = SMS_CANDIDATE_EVENT_CLASSES.filter((c) => candidateImportBlockReason(classified(c)) == null);
    expect(moving).toEqual(["actualCredit", "actualDebit", "creditCardPurchase", "creditCardRefund", "cardBillPayment", "emiDebited", "reversal"]);
    const routine = SMS_CANDIDATE_EVENT_CLASSES.filter((c) => candidatePassesIntegrity(classified(c)));
    expect(routine).toEqual(["actualCredit", "actualDebit", "creditCardPurchase", "emiDebited"]);
  });
});

describe("model — integrity fields", () => {
  const snapshot = (data: Record<string, unknown>) =>
    ({ id: "sms-1", data: () => data }) as unknown as Parameters<typeof smsTransactionCandidateFromFirestore>[0];
  const base = {
    amount: 350,
    direction: "debit",
    transactionDate: Timestamp.fromDate(new Date("2026-11-01T12:00:00.000Z")),
    createdAt: Timestamp.fromDate(new Date("2026-11-01T12:00:05.000Z")),
  };

  it("a legacy document reads back with no integrity keys at all (shape unchanged)", () => {
    const c = smsTransactionCandidateFromFirestore(snapshot(base));
    for (const key of ["eventClass", "moneyMovement", "transactionStatus", "directionEvidence", "ownership", "messageReceivedAt", "dateSource", "classificationVersion"]) {
      expect(c).not.toHaveProperty(key);
    }
  });

  it("reads Android's fields as-given", () => {
    const received = new Date("2026-11-01T17:46:00.000Z");
    const c = smsTransactionCandidateFromFirestore(
      snapshot({
        ...base,
        eventClass: "failedTransaction",
        moneyMovement: false,
        transactionStatus: "failed",
        directionEvidence: "contextual",
        ownership: "verified",
        messageReceivedAt: Timestamp.fromDate(received),
        dateSource: "messageBody",
        classificationVersion: 1,
      }),
    );
    expect(c.eventClass).toBe("failedTransaction");
    expect(c.moneyMovement).toBe(false);
    expect(c.transactionStatus).toBe("failed");
    expect(c.directionEvidence).toBe("contextual");
    expect(c.ownership).toBe("verified");
    expect(c.messageReceivedAt).toEqual(received);
    expect(c.dateSource).toBe("messageBody");
    expect(c.classificationVersion).toBe(1);
  });

  it("an event class from a newer app reads as 'unknown' — blocked, never importable", () => {
    const c = smsTransactionCandidateFromFirestore(snapshot({ ...base, eventClass: "somethingNew" }));
    expect(c.eventClass).toBe("unknown");
    expect(candidateImportBlockReason(c)).toEqual(expect.any(String));
  });

  it("toFirestore omits integrity fields a legacy candidate doesn't have", () => {
    const data = smsTransactionCandidateToFirestore(candidate());
    expect(data).not.toHaveProperty("eventClass");
    expect(data).not.toHaveProperty("classificationVersion");
    expect(smsTransactionCandidateToFirestore(classified("actualDebit"))).toMatchObject({ eventClass: "actualDebit", classificationVersion: 1 });
  });
});
