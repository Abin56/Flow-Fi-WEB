/**
 * Isolated coverage for `reduceTenurePolicy` — the TS port of
 * `Finance_App/lib/core/payment_schedule/domain/prepayment_reamortization_policy.dart`'s
 * `ReduceTenurePolicy`. Mirrors that Dart file's own isolated test suite
 * (`test/core/payment_schedule/domain/prepayment_reamortization_policy_test.dart`)
 * scenario-for-scenario. Before this file, the Unsolvable path had zero
 * direct test coverage on Web — only exercised indirectly through the
 * repository-level "Solved" happy path.
 */

import { describe, expect, it } from "vitest";
import { reduceTenurePolicy } from "./prepayment-reamortization-policy";

describe("reduceTenurePolicy.solve — solved cases", () => {
  it("reducing-balance: solves to fewer installments at or under the target", () => {
    const outcome = reduceTenurePolicy.solve({
      outstandingPrincipalAfter: 6053.81,
      interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" },
      targetInstallmentAmount: 1066.19,
      frequency: "monthly",
    });

    expect(outcome.kind).toBe("solved");
    const solved = outcome as Extract<typeof outcome, { kind: "solved" }>;
    expect(solved.remainingInstallmentCount).toBeLessThan(11);
    expect(solved.installmentAmount).toBeLessThanOrEqual(1066.19);
  });

  it("zero-interest: solves via direct division", () => {
    const outcome = reduceTenurePolicy.solve({
      outstandingPrincipalAfter: 5000,
      interest: null,
      targetInstallmentAmount: 1000,
      frequency: "monthly",
    });

    expect(outcome.kind).toBe("solved");
    const solved = outcome as Extract<typeof outcome, { kind: "solved" }>;
    expect(solved.remainingInstallmentCount).toBe(5);
    expect(solved.installmentAmount).toBe(1000);
  });

  it("when outstanding already fits in 1 installment at/under target", () => {
    const outcome = reduceTenurePolicy.solve({
      outstandingPrincipalAfter: 500,
      interest: null,
      targetInstallmentAmount: 1000,
      frequency: "monthly",
    });

    expect(outcome.kind).toBe("solved");
    expect((outcome as Extract<typeof outcome, { kind: "solved" }>).remainingInstallmentCount).toBe(1);
  });
});

describe("reduceTenurePolicy.solve — unsolvable cases (never silently guesses)", () => {
  it("outstandingPrincipalAfter <= 0 is unsolvable", () => {
    const outcome = reduceTenurePolicy.solve({
      outstandingPrincipalAfter: 0,
      interest: null,
      targetInstallmentAmount: 1000,
      frequency: "monthly",
    });
    expect(outcome.kind).toBe("unsolvable");
  });

  it("negative outstandingPrincipalAfter is unsolvable", () => {
    const outcome = reduceTenurePolicy.solve({
      outstandingPrincipalAfter: -100,
      interest: null,
      targetInstallmentAmount: 1000,
      frequency: "monthly",
    });
    expect(outcome.kind).toBe("unsolvable");
  });

  it("targetInstallmentAmount <= 0 is unsolvable", () => {
    const outcome = reduceTenurePolicy.solve({
      outstandingPrincipalAfter: 5000,
      interest: null,
      targetInstallmentAmount: 0,
      frequency: "monthly",
    });
    expect(outcome.kind).toBe("unsolvable");
  });

  it("negative interest rate is unsolvable", () => {
    const outcome = reduceTenurePolicy.solve({
      outstandingPrincipalAfter: 5000,
      interest: { type: "reducingBalance", ratePercent: -5, period: "yearly" },
      targetInstallmentAmount: 1000,
      frequency: "monthly",
    });
    expect(outcome.kind).toBe("unsolvable");
  });

  it(
    "a target amount too small to ever cover the interest on a large principal is unsolvable " +
      "(never returns a guessed count)",
    () => {
      const outcome = reduceTenurePolicy.solve({
        outstandingPrincipalAfter: 10000000,
        interest: { type: "reducingBalance", ratePercent: 24, period: "yearly" },
        targetInstallmentAmount: 1,
        frequency: "monthly",
      });
      expect(outcome.kind).toBe("unsolvable");
    },
  );
});
