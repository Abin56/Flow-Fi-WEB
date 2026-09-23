/**
 * Cross-platform parity: both flowfi-web (this file) and Finance_App
 * (test/cross_platform_fixtures/golden_fixture_parity_test.dart) load the
 * SAME JSON fixtures (byte-identical copies in each repo, per this
 * codebase's established convention for shared Firestore contracts — see
 * FirestoreCollections' doc comment) and assert both platforms parse the
 * new Advance/Prepayment schema fields identically. A payment created on
 * one platform must be correctly understood by the other; this is the
 * direct evidence of that, not just matching field names in source code.
 */

import { readFileSync } from "node:fs";
import { Timestamp, type DocumentData, type QueryDocumentSnapshot } from "firebase/firestore";
import { describe, expect, it } from "vitest";
import { installmentPaymentFromFirestore } from "@/lib/models/payment-schedule";
import { transactionFromFirestore } from "@/lib/models/transaction";

function loadFixture(filename: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`tests/cross-platform-fixtures/${filename}`, "utf8"));
}

function fakeSnapshot(id: string, data: DocumentData): QueryDocumentSnapshot<DocumentData> {
  return {
    id,
    data: () => data,
  } as QueryDocumentSnapshot<DocumentData>;
}

describe("Golden fixture parity — InstallmentPayment (principalPrepayment)", () => {
  it("parses identically to Finance_App's Dart fromFirestore", () => {
    const fixture = loadFixture("installment-payment-advance-fixture.json");
    const expected = fixture.expected as Record<string, unknown>;

    const raw: DocumentData = {
      installmentId: fixture.installmentId,
      scheduleId: fixture.scheduleId,
      ownerType: fixture.ownerType,
      ownerId: fixture.ownerId,
      amount: fixture.amount,
      date: Timestamp.fromMillis(fixture.dateMillis as number),
      note: fixture.note,
      createdAt: Timestamp.fromMillis(fixture.createdAtMillis as number),
      settlementMethod: fixture.settlementMethod,
      billingCycleLabel: fixture.billingCycleLabel,
      remainingBalanceAfterPayment: fixture.remainingBalanceAfterPayment,
      allocationType: fixture.allocationType,
      prepaymentPrincipalAmount: fixture.prepaymentPrincipalAmount,
      prepaymentPolicyApplied: fixture.prepaymentPolicyApplied,
      reamortizationEventId: fixture.reamortizationEventId,
      transactionId: fixture.transactionId,
      deletedAt: fixture.deletedAt,
      lastEditedAt: fixture.lastEditedAt,
      editHistory: fixture.editHistory,
    };

    const payment = installmentPaymentFromFirestore(fakeSnapshot("p1", raw));

    expect(payment.amount).toBe(expected.amount);
    expect(payment.allocationType).toBe("principalPrepayment");
    expect(payment.prepaymentPrincipalAmount).toBe(expected.prepaymentPrincipalAmount);
    expect(payment.prepaymentPolicyApplied).toBe(expected.prepaymentPolicyApplied);
    expect(payment.reamortizationEventId).toBe(expected.reamortizationEventId);
    expect(payment.transactionId).toBe(expected.transactionId);
  });
});

describe("Golden fixture parity — Transaction (loan payment, principalPrepayment)", () => {
  it("parses identically to Finance_App's Dart fromFirestore", () => {
    const fixture = loadFixture("transaction-loan-payment-fixture.json");
    const expected = fixture.expected as Record<string, unknown>;

    const raw: DocumentData = {
      type: fixture.type,
      amount: fixture.amount,
      dateTime: Timestamp.fromMillis(fixture.dateTimeMillis as number),
      accountId: fixture.accountId,
      categoryId: fixture.categoryId,
      description: fixture.description,
      notes: fixture.notes,
      receiptPurpose: fixture.receiptPurpose,
      transferId: fixture.transferId,
      excludeFromCalculations: fixture.excludeFromCalculations,
      accountingMonth: fixture.accountingMonth,
      linkedPersonId: fixture.linkedPersonId,
      owesPersonToggle: fixture.owesPersonToggle,
      createdAt: Timestamp.fromMillis(fixture.createdAtMillis as number),
      source: fixture.source,
      loanId: fixture.loanId,
      emiId: fixture.emiId,
      installmentId: fixture.installmentId,
      installmentPaymentId: fixture.installmentPaymentId,
      paymentAllocationType: fixture.paymentAllocationType,
      deletedAt: fixture.deletedAt,
      lastEditedAt: fixture.lastEditedAt,
      editHistory: fixture.editHistory,
    };

    const transaction = transactionFromFirestore(fakeSnapshot("t1", raw));

    expect(transaction.type).toBe("expense");
    expect(transaction.amount).toBe(expected.amount);
    expect(transaction.accountId).toBe(expected.accountId);
    expect(transaction.loanId).toBe(expected.loanId);
    expect(transaction.emiId).toBe(expected.emiId);
    expect(transaction.installmentId).toBe(expected.installmentId);
    expect(transaction.installmentPaymentId).toBe(expected.installmentPaymentId);
    expect(transaction.paymentAllocationType).toBe("principalPrepayment");
  });
});
