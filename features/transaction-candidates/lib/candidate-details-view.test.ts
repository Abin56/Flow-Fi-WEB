import { describe, expect, it } from "vitest";
import type { Account } from "@/lib/models/account";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import { buildDestinationOptions, initialImportDraft, initialNotes, isImportReady, resolveImportDestination } from "./candidate-details-view";

describe("initialNotes", () => {
  it("pre-fills from merchant when available", () => {
    expect(initialNotes({ merchant: "Amazon", bankName: "HDFC" })).toBe("Amazon");
  });

  it("falls back to bankName when merchant is null", () => {
    expect(initialNotes({ merchant: null, bankName: "HDFC" })).toBe("HDFC");
  });

  it("is empty when neither merchant nor bankName is available — never invents a name", () => {
    expect(initialNotes({ merchant: null, bankName: null })).toBe("");
  });
});

describe("initialImportDraft", () => {
  it("pre-fills destinationKey from a resolved cardId, preferring it over accountId", () => {
    const draft = initialImportDraft({ accountId: "acc-1", cardId: "card-1", merchant: null, bankName: null });
    expect(draft.destinationKey).toBe("card:card-1");
    expect(draft.categoryId).toBeNull();
    expect(draft.notes).toBe("");
  });

  it("pre-fills destinationKey from a resolved accountId when there's no card", () => {
    const draft = initialImportDraft({ accountId: "acc-1", cardId: null, merchant: null, bankName: null });
    expect(draft.destinationKey).toBe("account:acc-1");
  });

  it("leaves destinationKey null when neither is resolved — never invents an account", () => {
    const draft = initialImportDraft({ accountId: null, cardId: null, merchant: null, bankName: null });
    expect(draft.destinationKey).toBeNull();
  });

  it("pre-fills notes from the detected merchant", () => {
    const draft = initialImportDraft({ accountId: null, cardId: null, merchant: "Amazon", bankName: null });
    expect(draft.notes).toBe("Amazon");
  });
});

describe("buildDestinationOptions", () => {
  it("lists accounts and credit cards as separate keyed options", () => {
    const accounts = [{ id: "acc-1", name: "SBI Savings", accountNumberLast4: "1234" } as Account];
    const creditCards = [{ id: "card-1", lastFourDigits: "9981" } as CreditCardProfile];
    const options = buildDestinationOptions(accounts, creditCards);
    expect(options).toEqual([
      { key: "account:acc-1", label: "SBI Savings •••• 1234" },
      { key: "card:card-1", label: "Card •••• 9981" },
    ]);
  });
});

describe("resolveImportDestination", () => {
  it("resolves an account key to accountId with no matched card", () => {
    const result = resolveImportDestination("account:acc-1", []);
    expect(result).toEqual({ accountId: "acc-1", matchedCard: null });
  });

  it("resolves a card key to its CreditCardProfile, with no accountId set directly", () => {
    const creditCards = [{ id: "card-1", accountId: "acc-behind-card" } as CreditCardProfile];
    const result = resolveImportDestination("card:card-1", creditCards);
    expect(result).toEqual({ accountId: null, matchedCard: creditCards[0] });
  });

  it("returns nothing resolved for a null destinationKey", () => {
    expect(resolveImportDestination(null, [])).toEqual({ accountId: null, matchedCard: null });
  });

  it("returns nothing resolved for a card key that no longer matches any credit card", () => {
    expect(resolveImportDestination("card:missing", [])).toEqual({ accountId: null, matchedCard: null });
  });
});

describe("isImportReady", () => {
  const readyDraft = {
    categoryId: "cat-1",
    destinationKey: "account:acc-1",
    notes: "",
    personId: null,
    owesPersonToggle: false,
    splitOpen: false,
    splitType: "equal" as const,
    participants: [{ personId: null, name: "", value: "" }],
  };
  it("is false without a category", () => {
    expect(isImportReady({ ...readyDraft, categoryId: null })).toBe(false);
  });

  it("is false without a resolved destination", () => {
    expect(isImportReady({ ...readyDraft, destinationKey: null })).toBe(false);
  });

  it("is true once category and destination are both set", () => {
    expect(isImportReady(readyDraft)).toBe(true);
  });

  // Duplicate detection no longer gates this button — it runs fresh inside `importCandidate` at
  // import time and is surfaced via the shared `DuplicateWarningDialog` instead. See
  // `import-candidate.test.ts`'s "duplicate detection" suite for that behavior.
});
