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

describe("Golden fixture parity — derived Loan figures (Phase 1-2)", () => {
  it("computes the same prepaid total, outstanding principal, count-once flags and Net Worth as Finance_App", async () => {
    const { principalPrepaidFor, outstandingPrincipalAfterPrepaymentsFor } = await import("@/lib/engines/loan-outstanding");
    const { countsFromSchedule } = await import("@/lib/engines/loan-cash-flow");
    const { loanBalanceSheet, netWorthWithLoans } = await import("@/lib/engines/loan-balance-sheet");
    const fixture = loadFixture("loan-derived-figures-fixture.json") as {
      loanAmount: number;
      installments: { amountDue: number; amountPaid: number; isSkipped: boolean; principalPortion: number | null }[];
      payments: { id: string; installmentId: string; amount: number; allocationType: string | null; prepaymentPrincipalAmount: number | null; transactionId: string | null; deleted: boolean }[];
      accountBalances: number;
      otherLoans: { direction: "given" | "taken"; outstandingPrincipal: number }[];
      emis: { outstandingPrincipal: number; ownedByTrackedCard: boolean }[];
      expected: Record<string, unknown>;
    };
    const payments = fixture.payments.map((p) =>
      installmentPaymentFromFirestore(
        fakeSnapshot(p.id, {
          installmentId: p.installmentId,
          scheduleId: "s1",
          ownerType: "loan",
          ownerId: "loan1",
          amount: p.amount,
          date: Timestamp.fromMillis(1_767_225_600_000),
          note: "",
          createdAt: Timestamp.fromMillis(1_767_225_600_000),
          allocationType: p.allocationType ?? undefined,
          prepaymentPrincipalAmount: p.prepaymentPrincipalAmount,
          transactionId: p.transactionId,
          deletedAt: p.deleted ? Timestamp.fromMillis(1_767_312_000_000) : null,
          editHistory: [],
        }),
        {},
      ),
    );
    const prepaid = principalPrepaidFor(payments);
    const outstanding = outstandingPrincipalAfterPrepaymentsFor(fixture.loanAmount, fixture.installments, prepaid);
    const sheet = loanBalanceSheet([{ direction: "taken", outstandingPrincipal: outstanding }, ...fixture.otherLoans], fixture.emis);
    expect(prepaid).toBe(fixture.expected.principalPrepaid);
    expect(outstanding).toBe(fixture.expected.outstandingPrincipal);
    expect(payments.map((p) => countsFromSchedule(p))).toEqual(fixture.expected.countsFromSchedule);
    expect(sheet.borrowedPrincipal).toBe(fixture.expected.borrowedPrincipal);
    expect(sheet.lentPrincipal).toBe(fixture.expected.lentPrincipal);
    expect(sheet.emiPrincipal).toBe(fixture.expected.emiPrincipal);
    expect(sheet.cardOwnedEmiPrincipal).toBe(fixture.expected.cardOwnedEmiPrincipal);
    expect(netWorthWithLoans(fixture.accountBalances, sheet)).toBe(fixture.expected.netWorth);
  });
});

describe("Golden fixture parity — card-linked EMI ownership (purchaseTransactionId)", () => {
  const fixture = loadFixture("card-emi-ownership-fixture.json") as {
    creditLimit: number;
    bankBalance: number;
    rawEmiDocWithLink: Record<string, unknown>;
    cases: {
      name: string;
      purchases: { key: string; amount: number; deleted: boolean }[];
      emis: { principal: number; purchaseKey: string | null; emiPaid: number; legacyNoField: boolean }[];
      expected: { outstanding: number; lockedEmiPrincipal: number; exposure: number; available: number; utilizationPercent: number; netWorth: number };
    }[];
  };
  const withDates = (raw: Record<string, unknown>) => ({
    ...raw,
    startDate: Timestamp.fromMillis(1_767_225_600_000),
    endDate: Timestamp.fromMillis(1_796_083_200_000),
    createdAt: Timestamp.fromMillis(1_767_225_600_000),
  });

  it("Flutter-shaped EMI doc → Web: purchaseTransactionId parses; a legacy doc without the key reads null", async () => {
    const { emiFromFirestore, emiToFirestore } = await import("@/lib/models/emi");
    const emi = emiFromFirestore(fakeSnapshot("emi-1", withDates(fixture.rawEmiDocWithLink)), {});
    expect(emi.purchaseTransactionId).toBe("txn-purchase-1");
    expect(emi.linkedCreditCardId).toBe("card-1");
    // Web → Flutter: Web writes the exact same key back.
    expect(emiToFirestore(emi).purchaseTransactionId).toBe("txn-purchase-1");
    const legacy = { ...fixture.rawEmiDocWithLink };
    delete legacy.purchaseTransactionId;
    expect(emiFromFirestore(fakeSnapshot("emi-legacy", withDates(legacy)), {}).purchaseTransactionId).toBeNull();
  });

  for (const c of fixture.cases) {
    it(`${c.name}`, async () => {
      const cu = await import("@/lib/engines/credit-utilization");
      const { loanBalanceSheet, netWorthWithLoans } = await import("@/lib/engines/loan-balance-sheet");
      const cardAccountId = "card-acct";
      const purchases = c.purchases.map((p) => ({
        id: `txn-${p.key}`,
        accountId: cardAccountId,
        amount: p.amount,
        deletedAt: p.deleted ? new Date() : null,
        excludeFromCalculations: false,
        transferId: null,
      }));
      const active = purchases.filter((p) => p.deletedAt == null);
      const activeById = new Map(active.map((p) => [p.id, p]));
      const emis = c.emis.map((e, i) => {
        const purchaseId = e.legacyNoField || e.purchaseKey == null ? null : `txn-${e.purchaseKey}`;
        const installments = [{ id: `i${i}`, amountDue: e.principal / 12, principalPortion: null }];
        const payments = e.emiPaid > 0 ? [{ id: `pay${i}`, installmentId: `i${i}`, amount: e.emiPaid, deletedAt: null }] : [];
        return {
          linkedCreditCardId: "card-1",
          isClosed: false,
          principalAmount: e.principal,
          principalPaid: cu.emiPrincipalRestored(installments, payments, new Map()),
          purchaseRepresented: cu.emiPurchaseRepresentedOnCard(purchaseId, purchaseId ? activeById.get(purchaseId) : null, cardAccountId),
        };
      });
      const standing = cu.creditCardStanding({
        card: { id: "card-1", statementDay: 5, creditLimit: fixture.creditLimit },
        statements: [],
        currentCycleStatement: { periodStart: new Date(0), periodEnd: new Date(), totalAmount: active.reduce((s, p) => s + p.amount, 0) },
        emis,
      });
      const exposure = standing.outstanding + standing.lockedEmiPrincipal;
      expect(standing.outstanding).toBe(c.expected.outstanding);
      expect(standing.lockedEmiPrincipal).toBe(c.expected.lockedEmiPrincipal);
      expect(exposure).toBe(c.expected.exposure);
      expect(standing.available).toBe(c.expected.available);
      expect(cu.creditUtilizationPercent(exposure, fixture.creditLimit)).toBeCloseTo(c.expected.utilizationPercent, 6);
      const accountBalances = fixture.bankBalance - active.reduce((s, p) => s + p.amount, 0);
      const sheet = loanBalanceSheet([], c.emis.map((e) => ({ outstandingPrincipal: e.principal - e.emiPaid, ownedByTrackedCard: true })), standing.lockedEmiPrincipal);
      expect(netWorthWithLoans(accountBalances, sheet)).toBe(c.expected.netWorth);
    });
  }
});
