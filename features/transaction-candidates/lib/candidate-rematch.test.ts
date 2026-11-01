import { describe, expect, it } from "vitest";
import type { Account } from "@/lib/models/account";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { applyAccountRematch, bankIdFromName, buildRematchTargets, rematchCandidate } from "./candidate-rematch";
import { candidateDestinationState, resolveCandidateDestinationKey } from "./candidate-account-matching";
import { deriveCandidateStatus } from "./candidate-status";

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
    accountNumberLast4: "9585",
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
  return { id: "card-1", accountId: "acc-card", lastFourDigits: "4821", issuer: "hdfc", ...overrides } as CreditCardProfile;
}

function candidate(overrides: Partial<SmsTransactionCandidate> = {}): SmsTransactionCandidate {
  return {
    id: "c1",
    amount: 100,
    direction: "debit",
    eventType: "bankDebit",
    transactionDate: new Date(),
    merchant: "Shop",
    bankName: null,
    rawLastFour: "9585",
    accountId: null,
    cardId: null,
    referenceNumber: null,
    confidenceLevel: "high",
    confidenceScore: 0.9,
    needsReview: false,
    needsReviewReasons: [],
    source: "sms",
    createdAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

const run = (c: SmsTransactionCandidate, accounts: Account[], cards: CreditCardProfile[] = []) => applyAccountRematch([c], accounts, cards);

describe("account re-matching after the user corrects a saved account", () => {
  it("matches a previously unmatched candidate once a unique account carries its last-4, and clears 'Needs account'", () => {
    const accounts = [account({ id: "acc-1", accountNumberLast4: "9585" })];
    const c = candidate();
    expect(deriveCandidateStatus(c, null, candidateDestinationState(c, accounts, [])).lane).toBe("needsAccount");

    const { candidates, rematched } = run(c, accounts);
    expect(candidates[0].accountId).toBe("acc-1");
    expect(candidates[0].cardId).toBeNull();
    expect(rematched.get("c1")?.reason).toBe("unmatched");
    expect(deriveCandidateStatus(candidates[0], null, candidateDestinationState(candidates[0], accounts, [])).lane).toBe("noIssues");
  });

  it("moves to 'Needs review' (not clean) when Android also flagged it", () => {
    const accounts = [account()];
    const { candidates } = run(candidate({ needsReview: true, confidenceLevel: "low" }), accounts);
    expect(deriveCandidateStatus(candidates[0], null, candidateDestinationState(candidates[0], accounts, [])).lane).toBe("needsReview");
  });

  it("matches a card by the CARD's own last-4 and posts to the card's account", () => {
    const accounts = [account({ id: "acc-card", name: "HDFC Card", accountNumberLast4: null, bankId: "hdfc" })];
    const { candidates } = run(candidate({ rawLastFour: "4821" }), accounts, [card()]);
    expect(candidates[0]).toMatchObject({ accountId: "acc-card", cardId: "card-1" });
  });

  it("never matches when two accounts/cards share the last-4 (ambiguous)", () => {
    const accounts = [account({ id: "a", accountNumberLast4: "9585" }), account({ id: "b", accountNumberLast4: "9585" })];
    const { candidates, rematched } = run(candidate(), accounts);
    expect(candidates[0].accountId).toBeNull();
    expect(rematched.size).toBe(0);
  });

  it("never matches an account and a card that share the last-4", () => {
    const accounts = [account({ id: "a", accountNumberLast4: "4821" }), account({ id: "acc-card", accountNumberLast4: null })];
    expect(run(candidate({ rawLastFour: "4821" }), accounts, [card()]).rematched.size).toBe(0);
  });

  it("never matches on bank alone, without a last-4, or when no account has that last-4", () => {
    const accounts = [account({ bankId: "hdfc" })];
    expect(run(candidate({ rawLastFour: null, bankName: "HDFC Bank" }), accounts).rematched.size).toBe(0);
    expect(run(candidate({ rawLastFour: "0000", bankName: "HDFC Bank" }), accounts).rematched.size).toBe(0);
    expect(run(candidate({ rawLastFour: "  " }), accounts).rematched.size).toBe(0);
  });

  it("rejects a last-4 match whose bank is clearly a different known bank", () => {
    const accounts = [account({ bankId: "sbi" })];
    expect(run(candidate({ bankName: "HDFC Bank" }), accounts).rematched.size).toBe(0);
    // Same bank (or an unrecognised bank name) is fine.
    expect(run(candidate({ bankName: "State Bank of India" }), accounts).rematched.get("c1")?.bankConfirmed).toBe(true);
    expect(run(candidate({ bankName: "Some Local Co-op" }), accounts).rematched.size).toBe(1);
  });

  it("a card-represented account is matched by its card's last-4, never by its own account number", () => {
    const accounts = [account({ id: "acc-card", accountNumberLast4: "9585" })];
    expect(run(candidate({ rawLastFour: "9585" }), accounts, [card({ lastFourDigits: "4821" })]).rematched.size).toBe(0);
  });

  it("does not match a credit-card account by its account number while its card profile is missing", () => {
    const accounts = [account({ id: "acc-cc", type: "card", cardSubtype: "credit", accountNumberLast4: "9585" })];
    expect(run(candidate(), accounts, []).rematched.size).toBe(0);
  });

  it("re-matches a candidate whose account was deleted, but only to a live account that carries the last-4", () => {
    const accounts = [account({ id: "acc-new", accountNumberLast4: "9585" })];
    const { candidates, rematched } = run(candidate({ accountId: "deleted-acc" }), accounts);
    expect(candidates[0].accountId).toBe("acc-new");
    expect(rematched.get("c1")?.reason).toBe("missing");
    expect(run(candidate({ accountId: "deleted-acc", rawLastFour: "1111" }), accounts).candidates[0].accountId).toBe("deleted-acc");
  });

  describe("an account that Android already matched", () => {
    it("is left alone while the account still carries the SMS's last-4", () => {
      const accounts = [account({ id: "acc-1", accountNumberLast4: "9585" }), account({ id: "acc-2", accountNumberLast4: "1234" })];
      const c = candidate({ accountId: "acc-1" });
      const { candidates, rematched } = run(c, accounts);
      expect(candidates[0]).toBe(c);
      expect(rematched.size).toBe(0);
    });

    it("moves to the right account when its own last-4 was corrected away and exactly one other account has the SMS's last-4", () => {
      // The user fixed acc-1 from 9585 → 7777; the SMS (…9585) belongs to acc-2.
      const accounts = [account({ id: "acc-1", accountNumberLast4: "7777" }), account({ id: "acc-2", name: "Other", accountNumberLast4: "9585" })];
      const { candidates, rematched } = run(candidate({ accountId: "acc-1" }), accounts);
      expect(candidates[0].accountId).toBe("acc-2");
      expect(rematched.get("c1")?.reason).toBe("stale");
    });

    it("keeps Android's match when no account has the SMS's last-4 (never un-matches or guesses)", () => {
      const accounts = [account({ id: "acc-1", accountNumberLast4: "7777" })];
      const c = candidate({ accountId: "acc-1" });
      expect(run(c, accounts).candidates[0]).toBe(c);
    });

    it("keeps Android's match when its account has no stored last-4 to disagree with", () => {
      const accounts = [account({ id: "acc-1", accountNumberLast4: null }), account({ id: "acc-2", accountNumberLast4: "9585" })];
      const c = candidate({ accountId: "acc-1" });
      expect(run(c, accounts).candidates[0]).toBe(c);
    });
  });

  it("does nothing until the accounts have loaded (an empty list is not 'no match')", () => {
    const c = candidate();
    expect(applyAccountRematch([c], [], [], false).candidates[0]).toBe(c);
    expect(applyAccountRematch([c], [account()], [], false).candidates[0]).toBe(c);
  });

  it("keeps object identity for untouched candidates and never mutates the input", () => {
    const accounts = [account()];
    const matchable = candidate({ id: "m" });
    const other = candidate({ id: "o", rawLastFour: "0000" });
    const { candidates } = applyAccountRematch([matchable, other], accounts, []);
    expect(candidates[1]).toBe(other);
    expect(candidates[0]).not.toBe(matchable);
    expect(matchable.accountId).toBeNull();
  });

  it("the corrected ids resolve to a real destination key (so the drawer and bulk import can use them)", () => {
    const accounts = [account({ id: "acc-1" })];
    const { candidates } = run(candidate(), accounts);
    expect(resolveCandidateDestinationKey(candidates[0], accounts, [])).toBe("account:acc-1");
  });

  it("tracks the LATEST accounts: correcting the last-4 again immediately changes the result", () => {
    const c = candidate();
    expect(run(c, [account({ accountNumberLast4: "9585" })]).rematched.size).toBe(1);
    expect(run(c, [account({ accountNumberLast4: "1111" })]).rematched.size).toBe(0);
  });
});

describe("building targets and reading bank names", () => {
  it("mirrors Android: cards without a last-4 are skipped and do not hide their account", () => {
    const targets = buildRematchTargets([account({ id: "acc-card", accountNumberLast4: "5555" })], [card({ lastFourDigits: null })]);
    expect(targets.map((t) => t.key)).toEqual(["account:acc-card"]);
  });

  it("recognises banks by name, short code or id, and returns null when it can't tell", () => {
    expect(bankIdFromName("HDFC Bank")).toBe("hdfc");
    expect(bankIdFromName("HDFC")).toBe("hdfc");
    expect(bankIdFromName("State Bank of India")).toBe("sbi");
    expect(bankIdFromName("ax")).toBeNull();
    expect(bankIdFromName(null)).toBeNull();
    expect(bankIdFromName("Mystery Credit Union")).toBeNull();
  });

  it("rematchCandidate is pure over targets", () => {
    const accounts = [account()];
    expect(rematchCandidate(candidate(), buildRematchTargets(accounts, []), accounts, [])?.key).toBe("account:acc-1");
  });
});
