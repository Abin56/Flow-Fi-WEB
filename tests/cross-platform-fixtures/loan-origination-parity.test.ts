/**
 * Cross-platform parity for unified-agreement origination. Finance_App's
 * `test/cross_platform_fixtures/loan_origination_parity_test.dart` loads a
 * byte-identical copy of `loan-origination-fixture.json` and asserts the same
 * ids, movement direction, schedule shape, principal effect and income/expense
 * classification — so an agreement created on one platform is understood
 * identically by the other.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_ATOMIC_ORIGINATION_INSTALLMENTS,
  assertValidOriginationKey,
  isOriginationTransactionId,
  originationKeyFromLoanId,
  originationMovementKindOf,
  originationReversalMessage,
  originationIdsFor,
  originationPrincipalEffect,
  originationScheduleShape,
  planOriginationMovement,
} from "@/lib/engines/loan-origination";
import { isNonIncomeExpenseMovement } from "@/lib/models/transaction";

interface ScenarioInput {
  agreementKind: "loan" | "installmentPurchase";
  direction: "taken" | "given";
  fundingSource: string | null;
  loanAmount: number;
  downPayment: number | null;
  movementAccountId: string | null;
  repaymentType: "installment" | "oneTime";
  installmentFrequency: "monthly" | null;
  installmentCount: number | null;
}
interface ScenarioExpected {
  movement: (ReturnType<typeof planOriginationMovement> & { countsAsIncomeExpense: boolean }) | null;
  schedule: ReturnType<typeof originationScheduleShape>;
  effect: ReturnType<typeof originationPrincipalEffect>;
}
interface Fixture {
  idempotencyKey: string;
  ids: { loanId: string; scheduleId: string; transactionId: string; installmentIds: Record<string, string> };
  invalidKeys: string[];
  maxAtomicInstallments: number;
  scenarios: { name: string; input: ScenarioInput; expected: ScenarioExpected }[];
  rejected: { name: string; input: ScenarioInput }[];
}

const fixture: Fixture = JSON.parse(readFileSync("tests/cross-platform-fixtures/loan-origination-fixture.json", "utf8"));

describe("origination golden fixture — ids", () => {
  it("derives every document id from the idempotency key", () => {
    const ids = originationIdsFor(fixture.idempotencyKey);
    expect([ids.loanId, ids.scheduleId, ids.transactionId]).toEqual([fixture.ids.loanId, fixture.ids.scheduleId, fixture.ids.transactionId]);
    for (const [seq, id] of Object.entries(fixture.ids.installmentIds)) expect(ids.installmentId(Number(seq))).toBe(id);
    expect(isOriginationTransactionId(ids.transactionId)).toBe(true);
    expect(isOriginationTransactionId("disb_x_txn")).toBe(false);
    expect(MAX_ATOMIC_ORIGINATION_INSTALLMENTS).toBe(fixture.maxAtomicInstallments);
  });

  it("rejects keys that are not safe, stable document-id fragments", () => {
    for (const key of fixture.invalidKeys) expect(() => assertValidOriginationKey(key)).toThrow();
  });
});

describe("origination golden fixture — scenarios", () => {
  for (const scenario of fixture.scenarios) {
    it(scenario.name, () => {
      const { input, expected } = scenario;
      const movement = planOriginationMovement(input);
      if (expected.movement == null) {
        expect(movement).toBeNull();
      } else {
        const { countsAsIncomeExpense, ...rest } = expected.movement;
        expect(movement).toEqual(rest);
        const counted = !isNonIncomeExpenseMovement({ transferId: null, loanId: "loan", paymentAllocationType: movement!.allocationType });
        expect(counted).toBe(countsAsIncomeExpense);
      }
      expect(originationScheduleShape(input.repaymentType, input.installmentFrequency, input.installmentCount)).toEqual(expected.schedule);
      expect(originationPrincipalEffect(input)).toEqual(expected.effect);
    });
  }

  for (const scenario of fixture.rejected) {
    it(`rejects: ${scenario.name}`, () => {
      expect(() => planOriginationMovement(scenario.input)).toThrow();
    });
  }
});

describe("origination golden fixture — reversal", () => {
  const extra = JSON.parse(readFileSync("tests/cross-platform-fixtures/loan-origination-fixture.json", "utf8")) as {
    loanIdKeys: { loanId: string; key: string | null }[];
    reversalMessages: {
      movement: { type: "income" | "expense"; paymentAllocationType: "additionalDisbursement" | null; amount: number; accountName: string } | null;
      message: string;
    }[];
  };

  it("recovers the origination key from a Loan id (and only from a wizard Loan id)", () => {
    for (const { loanId, key } of extra.loanIdKeys) expect(originationKeyFromLoanId(loanId)).toBe(key);
  });

  for (const { movement, message } of extra.reversalMessages) {
    it(`confirmation copy: ${message}`, () => {
      expect(
        originationReversalMessage(
          movement == null ? null : { kind: originationMovementKindOf(movement), amount: movement.amount, accountName: movement.accountName },
        ),
      ).toBe(message);
    });
  }
});
