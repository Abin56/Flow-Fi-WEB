import { describe, expect, it } from "vitest";
import { defaultActionAxesFor } from "../src/staging/staging-writer";
import { ef } from "./fixtures/workspace/fixture-helpers";

function txn(direction: "debit" | "credit", overrides: { recurringDetected?: boolean; transferDetected?: boolean } = {}) {
  return {
    direction: ef(direction),
    recurringDetected: overrides.recurringDetected ?? false,
    transferDetected: overrides.transferDetected ?? false,
  };
}

describe("defaultActionAxesFor — B7 default-action-per-direction policy", () => {
  it("defaults a plain debit to expense/mine", () => {
    expect(defaultActionAxesFor(txn("debit"))).toEqual({
      flowType: "expense",
      ownership: "mine",
      modifiers: { business: false, recurring: false, splitByCategory: false },
    });
  });

  it("defaults a plain credit to income/mine", () => {
    expect(defaultActionAxesFor(txn("credit"))).toEqual({
      flowType: "income",
      ownership: "mine",
      modifiers: { business: false, recurring: false, splitByCategory: false },
    });
  });

  it("leaves flowType null when transferDetected — B7: a transfer needs a destination account the parser can't resolve, so it must not silently default", () => {
    expect(defaultActionAxesFor(txn("debit", { transferDetected: true }))).toEqual({
      flowType: null,
      ownership: null,
      modifiers: { business: false, recurring: false, splitByCategory: false },
    });
  });

  it("transferDetected overrides recurringDetected — never both", () => {
    expect(defaultActionAxesFor(txn("debit", { transferDetected: true, recurringDetected: true }))).toEqual({
      flowType: null,
      ownership: null,
      modifiers: { business: false, recurring: false, splitByCategory: false },
    });
  });
});

describe("defaultActionAxesFor — B16 standing instruction / auto-debit default", () => {
  it("defaults a recurring debit to expense/mine with the recurring modifier set", () => {
    expect(defaultActionAxesFor(txn("debit", { recurringDetected: true }))).toEqual({
      flowType: "expense",
      ownership: "mine",
      modifiers: { business: false, recurring: true, splitByCategory: false },
    });
  });

  it("does not set the recurring modifier on a recurring-flagged credit — recurringDetected only overrides the expense default", () => {
    expect(defaultActionAxesFor(txn("credit", { recurringDetected: true }))).toEqual({
      flowType: "income",
      ownership: "mine",
      modifiers: { business: false, recurring: false, splitByCategory: false },
    });
  });
});
