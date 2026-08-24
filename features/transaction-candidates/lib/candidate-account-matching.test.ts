import { describe, expect, it } from "vitest";
import type { Account } from "@/lib/models/account";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import { formatMatchedAccountLabel, formatUnresolvedAccountHint } from "./candidate-account-matching";

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc-1",
    name: "SBI Savings",
    type: "bank",
    openingBalance: 0,
    currentBalance: 0,
    colorValue: 0,
    isDefault: false,
    createdAt: new Date(),
    bankId: null,
    accountHolderName: null,
    notes: null,
    accountNumberLast4: "9981",
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

function card(overrides: Partial<CreditCardProfile> = {}): CreditCardProfile {
  return {
    id: "card-1",
    accountId: "acc-card-1",
    sharedLimitId: null,
    statementDay: 1,
    paymentDueDay: 15,
    creditLimit: 100000,
    minimumDuePercent: null,
    autoPay: false,
    status: "active",
    cardNetwork: null,
    lastFourDigits: "4821",
    issuer: "hdfc",
    annualFee: 0,
    joiningFee: 0,
    interestRatePercent: null,
    rewardNotes: null,
    autoDebitAccount: null,
    cardHolderName: null,
    createdAt: new Date(),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  } as CreditCardProfile;
}

describe("formatMatchedAccountLabel", () => {
  it("formats a resolved credit card as 'Account name •••• last4'", () => {
    const label = formatMatchedAccountLabel({ accountId: null, cardId: "card-1" }, [account({ id: "acc-card-1", name: "HDFC Card Account" })], [card()]);
    expect(label).toBe("HDFC Card Account •••• 4821");
  });

  it("formats a resolved bank account as 'Account name •••• last4'", () => {
    const label = formatMatchedAccountLabel({ accountId: "acc-1", cardId: null }, [account()], []);
    expect(label).toBe("SBI Savings •••• 9981");
  });

  it("returns null when cardId is set but no longer resolves to a real card (deleted since sync)", () => {
    const label = formatMatchedAccountLabel({ accountId: null, cardId: "missing-card" }, [], []);
    expect(label).toBeNull();
  });

  it("returns null when accountId is set but no longer resolves to a real account (deleted since sync)", () => {
    const label = formatMatchedAccountLabel({ accountId: "missing-acc", cardId: null }, [], []);
    expect(label).toBeNull();
  });

  it("returns null when neither accountId nor cardId is set", () => {
    const label = formatMatchedAccountLabel({ accountId: null, cardId: null }, [account()], [card()]);
    expect(label).toBeNull();
  });
});

describe("formatUnresolvedAccountHint", () => {
  it("shows the masked last4 when present, never inventing an account", () => {
    expect(formatUnresolvedAccountHint({ bankName: "HDFC Bank", rawLastFour: "4821" })).toBe("Unmatched • •••• 4821");
  });

  it("falls back to the bank name when there's no last4", () => {
    expect(formatUnresolvedAccountHint({ bankName: "ICICI Bank", rawLastFour: null })).toBe("Unmatched • ICICI Bank");
  });

  it("falls back to a bare 'Unmatched' when neither hint is present", () => {
    expect(formatUnresolvedAccountHint({ bankName: null, rawLastFour: null })).toBe("Unmatched");
  });
});
