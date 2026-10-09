import { describe, expect, it } from "vitest";
import { diffCardEdit, type CardEditableFields } from "@/lib/repositories/credit-card-save";
import { autoCardName, defaultSharedLimitName, freshCardSaveIds, suggestedDueDay } from "./shared-limit-save";

const HDFC = { id: "hdfc", shortCode: "HDFC", name: "HDFC Bank" };

describe("Add Card defaults", () => {
  it("names a card from bank + network, or bank + last 4", () => {
    expect(autoCardName(HDFC, "visa", "7960")).toBe("HDFC Visa");
    expect(autoCardName(HDFC, "rupay", "4321")).toBe("HDFC RuPay");
    expect(autoCardName(HDFC, null, "7960")).toBe("HDFC •••• 7960");
    expect(autoCardName(null, null, "7960")).toBe("Credit Card •••• 7960");
  });

  it("labels the shared limit from the bank", () => {
    expect(defaultSharedLimitName(HDFC)).toBe("HDFC Shared Limit");
    expect(defaultSharedLimitName(null)).toBe("Shared Limit");
    expect(defaultSharedLimitName({ id: "generic", shortCode: "BANK", name: "Other" })).toBe("Shared Limit");
  });

  it("suggests a due day ~20 days after the statement, wrapping the month", () => {
    expect(suggestedDueDay(1)).toBe(21);
    expect(suggestedDueDay(5)).toBe(25);
    expect(suggestedDueDay(20)).toBe(9);
  });

  it("gives every dialog session distinct ids for each document it may create", () => {
    const a = freshCardSaveIds();
    const b = freshCardSaveIds();
    expect(new Set(Object.values(a)).size).toBe(5);
    expect(a.primaryCardId).not.toBe(b.primaryCardId);
  });
});

describe("diffCardEdit (two-tab stale edits)", () => {
  const base: CardEditableFields = {
    name: "Freedom Visa",
    bankId: "hdfc",
    cardHolderName: "ABIN JOHN",
    lastFourDigits: "7960",
    cardNetwork: "visa",
    statementDay: 5,
    paymentDueDay: 25,
    creditLimit: 38000,
    colorValue: 0,
    sharedLimitId: null,
  };

  it("writes only fields the user changed", () => {
    const { changed, conflicts } = diffCardEdit(base, { ...base, name: "Freedom" }, base);
    expect(changed).toEqual(["name"]);
    expect(conflicts).toEqual([]);
  });

  it("flags a field the user changed that another tab also changed to something else", () => {
    const { conflicts } = diffCardEdit(base, { ...base, cardNetwork: "rupay" }, { ...base, cardNetwork: "mastercard" });
    expect(conflicts).toEqual(["cardNetwork"]);
  });

  it("ignores another tab's change to a field the user didn't touch", () => {
    const { changed, conflicts } = diffCardEdit(base, { ...base, name: "Freedom" }, { ...base, paymentDueDay: 28 });
    expect(changed).toEqual(["name"]);
    expect(conflicts).toEqual([]);
  });

  it("a retried save whose first attempt already landed is not a conflict", () => {
    const desired = { ...base, sharedLimitId: "sl-1" };
    expect(diffCardEdit(base, desired, desired).conflicts).toEqual([]);
  });
});
