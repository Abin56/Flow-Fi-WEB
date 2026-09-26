/**
 * Cross-platform parity for card-funded Loan liability ownership. Finance_App runs the same
 * byte-identical fixture (test/cross_platform_fixtures/card_funded_loan_parity_test.dart) through its
 * real repositories and Riverpod providers; this file runs it through the Web engines exactly as
 * `useCardUtilizationEmis` + `useLoanBalanceSheet` compose them.
 */

import { readFileSync } from "node:fs";
import { Timestamp, type DocumentData, type QueryDocumentSnapshot } from "firebase/firestore";
import { describe, expect, it } from "vitest";
import {
  cardFundedLoanCardId,
  cardFundedLoanUtilization,
  creditCardStanding,
  creditUtilizationPercent,
  emiPurchaseRepresentedOnCard,
} from "@/lib/engines/credit-utilization";
import { loanBalanceSheet, netWorthWithLoans } from "@/lib/engines/loan-balance-sheet";
import { outstandingPrincipalAfterPrepaymentsFor } from "@/lib/engines/loan-outstanding";
import { loanFromFirestore, loanToFirestore } from "@/lib/models/loan";

interface Fixture {
  creditLimit: number;
  bankBalance: number;
  principal: number;
  installmentCount: number;
  rawLoanDocWithBeneficiary: Record<string, unknown>;
  cases: {
    name: string;
    purchase: { amount: number; deleted: boolean } | null;
    paidInstallments: number;
    closed: boolean;
    expected: {
      outstanding: number;
      lockedEmiPrincipal: number;
      available: number;
      utilizationPercent: number;
      borrowedPrincipal: number;
      netWorth: number;
    };
  }[];
}

const fixture = JSON.parse(readFileSync("tests/cross-platform-fixtures/card-funded-loan-fixture.json", "utf8")) as Fixture;

function fakeSnapshot(id: string, data: DocumentData): QueryDocumentSnapshot<DocumentData> {
  return { id, data: () => data } as QueryDocumentSnapshot<DocumentData>;
}

describe("Golden fixture parity — card-funded Loan ownership", () => {
  it("a Flutter/Web Loan doc round-trips fundingSource, linkedCreditCardId and beneficiaryPersonId", () => {
    const raw = {
      ...fixture.rawLoanDocWithBeneficiary,
      loanDate: Timestamp.fromMillis(1_767_225_600_000),
      createdAt: Timestamp.fromMillis(1_767_225_600_000),
    };
    const loan = loanFromFirestore(fakeSnapshot("loan-1", raw));
    expect(cardFundedLoanCardId(loan)).toBe("card-1");
    expect(loan.beneficiaryPersonId).toBe("person-anu");
    const written = loanToFirestore(loan);
    expect(written.beneficiaryPersonId).toBe("person-anu");
    expect(written.fundingSource).toBe("creditCard");
    expect(written.linkedCreditCardId).toBe("card-1");
  });

  for (const c of fixture.cases) {
    it(c.name, () => {
      const cardAccountId = "card-acct";
      const purchase =
        c.purchase == null
          ? null
          : {
              id: "txn-purchase",
              accountId: cardAccountId,
              deletedAt: c.purchase.deleted ? new Date() : null,
              excludeFromCalculations: false,
              transferId: null,
            };
      const activePurchaseTotal = c.purchase != null && !c.purchase.deleted ? c.purchase.amount : 0;

      const share = fixture.principal / fixture.installmentCount;
      const installments = Array.from({ length: fixture.installmentCount }, (_, i) => ({
        amountDue: share,
        amountPaid: i < c.paidInstallments ? share : 0,
        isSkipped: false,
        principalPortion: null,
      }));
      const outstandingPrincipal = outstandingPrincipalAfterPrepaymentsFor(fixture.principal, installments, 0);
      const loan = { direction: "taken" as const, fundingSource: "creditCard", linkedCreditCardId: "card-1" };
      const cardId = cardFundedLoanCardId(loan)!;

      const standing = creditCardStanding({
        card: { id: "card-1", statementDay: 5, creditLimit: fixture.creditLimit },
        statements: [],
        currentCycleStatement: { periodStart: new Date(0), periodEnd: new Date(), totalAmount: activePurchaseTotal },
        emis: [
          cardFundedLoanUtilization({
            linkedCreditCardId: cardId,
            isClosed: c.closed,
            loanAmount: fixture.principal,
            outstandingPrincipal,
            purchaseRepresented: emiPurchaseRepresentedOnCard(
              purchase == null ? null : "txn-purchase",
              purchase?.deletedAt == null ? purchase : null,
              cardAccountId,
            ),
          }),
        ],
      });
      const sheet = loanBalanceSheet(
        [{ direction: "taken", outstandingPrincipal, ownedByTrackedCard: true }],
        [],
        standing.lockedEmiPrincipal,
      );

      expect(standing.outstanding).toBe(c.expected.outstanding);
      expect(standing.lockedEmiPrincipal).toBe(c.expected.lockedEmiPrincipal);
      expect(standing.available).toBe(c.expected.available);
      expect(
        creditUtilizationPercent(standing.outstanding + standing.lockedEmiPrincipal, fixture.creditLimit),
      ).toBeCloseTo(c.expected.utilizationPercent, 6);
      expect(sheet.borrowedPrincipal).toBe(c.expected.borrowedPrincipal);
      expect(netWorthWithLoans(fixture.bankBalance - activePurchaseTotal, sheet)).toBe(c.expected.netWorth);
    });
  }
});
