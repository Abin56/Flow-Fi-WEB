/**
 * Firestore Staging Writer — real Firestore Emulator test, same discipline
 * as document-analyzer-worker.test.ts. Proves the import doc + records
 * subcollection are written in the shape lib/models/document-import.ts
 * expects, and that re-running the writer for the same documentId is
 * idempotent (replaces, never duplicates).
 */

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeStagingDocuments } from "../src/staging/staging-writer";
import { runStatementIntelligencePipeline } from "../src/pipeline/statement-intelligence-pipeline";
import { NOT_YET_CHECKED_DUPLICATE_RESULT, type WorkspaceTransaction } from "../src/workspace/statement-workspace-model";
import { ef } from "./fixtures/workspace/fixture-helpers";

const PROJECT_ID = "flowfi-functions-test";
const UID = "owner-uid";
const DOCUMENT_ID = "doc-staging-1";
const ACCOUNT_ID = "acct-hdfc-regalia";

let db: Firestore;

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
  const app = getApps().length ? getApps()[0]! : initializeApp({ projectId: PROJECT_ID });
  db = getFirestore(app);
});

afterEach(async () => {
  const importRef = db.collection("users").doc(UID).collection("documentImports").doc(DOCUMENT_ID);
  const records = await importRef.collection("records").get();
  await Promise.all(records.docs.map((d) => d.ref.delete()));
  await importRef.delete();
});

afterAll(async () => {
  const { getApps: getAllApps, deleteApp } = await import("firebase-admin/app");
  await Promise.all(getAllApps().map((a) => deleteApp(a)));
});

function rawTxn(day: number, merchantRaw: string, amount: number, direction: "debit" | "credit", rowNumber: number): WorkspaceTransaction {
  return {
    date: ef(new Date(Date.UTC(2026, 5, day)), 0.99),
    merchantRaw: ef(merchantRaw, 0.97),
    description: ef(null, 0, "unavailable"),
    amount: ef(amount, 1.0),
    direction: ef(direction, 1.0),
    referenceNumber: ef(`REF${String(rowNumber).padStart(9, "0")}`, 0.95, "pattern_match"),
    currency: ef("INR", 1.0),
    sourcePage: 2,
    sourceLineIndex: rowNumber - 1,
    originalRawText: `${String(day).padStart(2, "0")}/06/2026 ${merchantRaw} ${amount.toFixed(2)}`,
    originalRowNumber: rowNumber,
    normalizedMerchant: null,
    suggestedCategory: null,
    suggestedAccount: null,
    suggestedPerson: null,
    suggestedTags: [],
    expenseType: null,
    transferDetected: false,
    recurringDetected: false,
    subscriptionDetected: false,
    duplicateCandidateOf: null,
    duplicateCheck: NOT_YET_CHECKED_DUPLICATE_RESULT,
    needsReview: false,
    warnings: [],
    confidence: 0,
  };
}

function buildWorkspace() {
  const transactions = [rawTxn(1, "AMZN", 2499, "debit", 1), rawTxn(2, "SWIGGY", 450, "debit", 2)];
  const totalDebits = transactions.reduce((s, t) => s + t.amount.value, 0);
  const openingBalance = 15000;
  const closingBalance = openingBalance + totalDebits;

  return runStatementIntelligencePipeline({
    statementInfo: {
      statementNumber: ef("HDFC-REG-2026-06-118273", 0.95),
      statementDate: ef(new Date(Date.UTC(2026, 5, 20)), 0.99),
      billingPeriodStart: ef(new Date(Date.UTC(2026, 4, 21)), 0.97),
      billingPeriodEnd: ef(new Date(Date.UTC(2026, 5, 20)), 0.97),
      paymentDueDate: ef(new Date(Date.UTC(2026, 6, 8)), 0.98),
    },
    cardInfo: {
      bankName: ef("HDFC Bank", 0.99),
      cardName: ef("HDFC Regalia", 0.95),
      cardLast4: ef("7788", 0.99),
      network: ef("Visa", 0.9, "pattern_match"),
    },
    billingSummary: {
      openingBalance: ef(openingBalance, 0.95),
      closingBalance: ef(closingBalance, 0.98),
      minimumDue: ef(Math.round(closingBalance * 0.05), 0.97),
      totalDue: ef(closingBalance, 0.98),
      creditLimit: ef(150000, 0.98),
      availableCredit: ef(150000 - closingBalance, 0.95),
      rewardPointsEarned: ef(0, 0.85, "fuzzy_match"),
      cashback: ef(0, 0.9),
      interestCharged: ef(0, 0.9),
      gst: ef(0, 0.9),
      lateFee: ef(0, 0.9),
    },
    transactions,
    diagnostics: { detectedSource: "hdfc", detectionConfidence: 0.97, tierUsed: "rule_based", transactionTableFound: true },
    accountId: ACCOUNT_ID,
    duplicateContext: {
      statementMeta: { documentHash: "hash-abc", billingPeriodStart: new Date(Date.UTC(2026, 4, 21)), billingPeriodEnd: new Date(Date.UTC(2026, 5, 20)), cardId: ACCOUNT_ID, closingBalance },
      existingStatements: [],
      existingTransactions: [],
    },
  });
}

describe("writeStagingDocuments", () => {
  it("writes the documentImports doc and one record per transaction", async () => {
    const workspace = buildWorkspace();
    const result = await writeStagingDocuments(db, { uid: UID, documentId: DOCUMENT_ID, accountId: ACCOUNT_ID, workspace });

    expect(result.recordCount).toBe(2);

    const importSnap = await db.collection("users").doc(UID).collection("documentImports").doc(DOCUMENT_ID).get();
    expect(importSnap.exists).toBe(true);
    expect(importSnap.get("status")).toBe("draft");
    expect(importSnap.get("accountId")).toBe(ACCOUNT_ID);

    const recordsSnap = await db.collection("users").doc(UID).collection("documentImports").doc(DOCUMENT_ID).collection("records").get();
    expect(recordsSnap.size).toBe(2);

    const amazonRecord = recordsSnap.docs.find((d) => d.id === "1")!;
    expect(amazonRecord.get("counterpartyNormalized")).toBe("Amazon");
    expect(amazonRecord.get("category")).toBe("Shopping");
    expect(amazonRecord.get("recordType")).toBe("transaction");
  });

  it("writes the Action model fields (flowType/ownership/modifiers/actionDetail) rather than the legacy owner/action shape", async () => {
    const workspace = buildWorkspace();
    await writeStagingDocuments(db, { uid: UID, documentId: DOCUMENT_ID, accountId: ACCOUNT_ID, workspace });

    const recordsSnap = await db.collection("users").doc(UID).collection("documentImports").doc(DOCUMENT_ID).collection("records").get();
    const amazonRecord = recordsSnap.docs.find((d) => d.id === "1")!;
    const data = amazonRecord.data();

    // B7: a plain debit with no recurring/transfer signal defaults to expense/mine, not null.
    expect(data).toHaveProperty("flowType", "expense");
    expect(data).toHaveProperty("ownership", "mine");
    expect(data).toHaveProperty("modifiers", { business: false, recurring: false, splitByCategory: false });
    expect(data).toHaveProperty("actionDetail", null);
    expect(data).toHaveProperty("include", true);
    expect(data).toHaveProperty("committedTransactionId", null);

    expect(data).not.toHaveProperty("owner");
    expect(data).not.toHaveProperty("action");
  });

  it("is idempotent — re-running for the same documentId replaces rather than duplicates", async () => {
    const workspace = buildWorkspace();
    await writeStagingDocuments(db, { uid: UID, documentId: DOCUMENT_ID, accountId: ACCOUNT_ID, workspace });
    await writeStagingDocuments(db, { uid: UID, documentId: DOCUMENT_ID, accountId: ACCOUNT_ID, workspace });

    const recordsSnap = await db.collection("users").doc(UID).collection("documentImports").doc(DOCUMENT_ID).collection("records").get();
    expect(recordsSnap.size).toBe(2);
  });
});
