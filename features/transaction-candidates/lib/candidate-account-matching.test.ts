import { describe, expect, it } from "vitest";
import type { Account } from "@/lib/models/account";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import {
  resolveMatchedIdentity,
  candidateDestinationGroupKey,
  candidateDestinationState,
  formatMatchedAccountLabel,
  formatUnresolvedAccountHint,
  resolveCandidateDestinationKey,
} from "./candidate-account-matching";

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
    bankAccountSubtype: null,
    minimumBalance: null,
    interestRatePercent: null,
    maturityDate: null,
    tenureMonths: null,
    cardSubtype: null,
    cardProvider: null,
    linkedAccountId: null,
    reloadable: null,
    currency: null,
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
    expect(formatUnresolvedAccountHint({ bankName: "HDFC Bank", rawLastFour: "4821" })).toBe("Not matched • •••• 4821");
  });

  it("falls back to the bank name when there's no last4", () => {
    expect(formatUnresolvedAccountHint({ bankName: "ICICI Bank", rawLastFour: null })).toBe("Not matched • ICICI Bank");
  });

  it("falls back to a bare 'Unmatched' when neither hint is present", () => {
    expect(formatUnresolvedAccountHint({ bankName: null, rawLastFour: null })).toBe("Not matched");
  });
});

describe("formatUnresolvedAccountHint — deleted account", () => {
  it("says the account no longer exists when Android's id stopped resolving", () => {
    expect(formatUnresolvedAccountHint({ bankName: "HDFC", rawLastFour: "4821" }, "missing")).toBe("Account no longer exists • •••• 4821");
  });
});

describe("formatMatchedAccountLabel — card whose account is gone", () => {
  it("returns null rather than a made-up 'Credit Card' name (it can't be imported to)", () => {
    expect(formatMatchedAccountLabel({ accountId: null, cardId: "card-1" }, [], [card()])).toBeNull();
  });
});

describe("resolveCandidateDestinationKey / candidateDestinationState", () => {
  const accounts = [account(), account({ id: "acc-card-1", name: "HDFC Card" })];
  const cards = [card()];

  it("echoes Android's card match first, then its account match, only when they still exist", () => {
    expect(resolveCandidateDestinationKey({ accountId: "acc-card-1", cardId: "card-1" }, accounts, cards)).toBe("card:card-1");
    expect(resolveCandidateDestinationKey({ accountId: "acc-1", cardId: null }, accounts, cards)).toBe("account:acc-1");
    expect(candidateDestinationState({ accountId: "acc-1", cardId: null }, accounts, cards)).toBe("matched");
  });

  it("never pre-selects an id that was deleted since the sync — it reads as 'missing'", () => {
    expect(resolveCandidateDestinationKey({ accountId: "gone", cardId: null }, accounts, cards)).toBeNull();
    expect(resolveCandidateDestinationKey({ accountId: null, cardId: "gone" }, accounts, cards)).toBeNull();
    expect(resolveCandidateDestinationKey({ accountId: null, cardId: "card-1" }, [account()], cards)).toBeNull(); // card exists, its account doesn't
    expect(candidateDestinationState({ accountId: "gone", cardId: null }, accounts, cards)).toBe("missing");
  });

  it("reads as 'unmatched' when Android sent no id at all", () => {
    expect(candidateDestinationState({ accountId: null, cardId: null }, accounts, cards)).toBe("unmatched");
  });
});

describe("candidateDestinationGroupKey", () => {
  const accounts = [account(), account({ id: "acc-2", name: "Other" })];

  it("is the destination key for resolved candidates, so two rows to one account share a group", () => {
    const a = { accountId: "acc-1", cardId: null, rawLastFour: "9981", bankName: "SBI" };
    const b = { accountId: "acc-1", cardId: null, rawLastFour: null, bankName: null };
    expect(candidateDestinationGroupKey(a, accounts, [])).toBe(candidateDestinationGroupKey(b, accounts, []));
    expect(candidateDestinationGroupKey(a, accounts, [])).not.toBe(candidateDestinationGroupKey({ ...a, accountId: "acc-2" }, accounts, []));
  });

  it("separates unresolved candidates by their raw hint, so two different unmatched accounts never share a batch", () => {
    const x = { accountId: null, cardId: null, rawLastFour: "1111", bankName: "HDFC" };
    const y = { accountId: null, cardId: null, rawLastFour: "2222", bankName: "HDFC" };
    expect(candidateDestinationGroupKey(x, accounts, [])).toBe(candidateDestinationGroupKey({ ...x }, accounts, []));
    expect(candidateDestinationGroupKey(x, accounts, [])).not.toBe(candidateDestinationGroupKey(y, accounts, []));
  });

  it("keeps a deleted-account candidate apart from a truly unmatched one", () => {
    const missing = { accountId: "gone", cardId: null, rawLastFour: "1111", bankName: "HDFC" };
    const unmatched = { accountId: null, cardId: null, rawLastFour: "1111", bankName: "HDFC" };
    expect(candidateDestinationGroupKey(missing, accounts, [])).not.toBe(candidateDestinationGroupKey(unmatched, accounts, []));
  });
});

describe("resolveMatchedIdentity", () => {
  const accounts = [
    { id: "a1", name: "HDFC Freedom", bankId: "hdfc", type: "card", accountNumberLast4: null },
    { id: "a2", name: "SBI Savings", bankId: "sbi", type: "bank", accountNumberLast4: "9981" },
  ] as unknown as Account[];
  const cards = [{ id: "c1", accountId: "a1", lastFourDigits: "4821" }] as unknown as CreditCardProfile[];

  it("names a matched card by its account (e.g. HDFC Freedom) with its masked last four and bank", () => {
    expect(resolveMatchedIdentity({ accountId: "a1", cardId: "c1" }, accounts, cards)).toMatchObject({ kind: "card", bankId: "hdfc", name: "HDFC Freedom", last4: "4821" });
  });
  it("describes a matched bank account", () => {
    expect(resolveMatchedIdentity({ accountId: "a2", cardId: null }, accounts, cards)).toMatchObject({ kind: "account", bankId: "sbi", name: "SBI Savings", last4: "9981" });
  });
  it("never invents an identity: unmatched, deleted account, or a card whose account is gone", () => {
    expect(resolveMatchedIdentity({ accountId: null, cardId: null }, accounts, cards)).toBeNull();
    expect(resolveMatchedIdentity({ accountId: "gone", cardId: null }, accounts, cards)).toBeNull();
    expect(resolveMatchedIdentity({ accountId: "a1", cardId: "c1" }, [], cards)).toBeNull();
  });
});
