import { describe, expect, it } from "vitest";
import { accountAfterKindSwitch, initialAddAccountId } from "./initial-account";

const cash = { id: "cash", type: "cash" as const };
const bank = { id: "bank", type: "bank" as const };
const card = { id: "card", type: "card" as const };

/** Every ordering Firestore could return the three accounts in. */
const ORDERINGS = [
  [cash, bank, card],
  [cash, card, bank],
  [bank, cash, card],
  [bank, card, cash],
  [card, cash, bank],
  [card, bank, cash],
];
const KINDS = ["expense", "income", "transfer"] as const;

describe("initialAddAccountId — never chosen by query order", () => {
  it.each(ORDERINGS.map((o) => [o.map((a) => a.id).join(" > "), o] as const))("no context → no account, for every kind (%s)", (_name, accounts) => {
    for (const kind of KINDS) expect(initialAddAccountId({ kind, accounts })).toBe("");
  });

  it("an explicit account context is used regardless of where it sits in the list", () => {
    for (const accounts of ORDERINGS) {
      expect(initialAddAccountId({ kind: "expense", accounts, contextAccountId: "bank" })).toBe("bank");
      expect(initialAddAccountId({ kind: "expense", accounts, contextAccountId: "card" })).toBe("card");
      expect(initialAddAccountId({ kind: "income", accounts, contextAccountId: "cash" })).toBe("cash");
    }
  });

  it("eligibility stays intact: income never starts on a credit card; a transfer source is never pre-filled", () => {
    for (const accounts of ORDERINGS) {
      expect(initialAddAccountId({ kind: "income", accounts, contextAccountId: "card" })).toBe("");
      expect(initialAddAccountId({ kind: "transfer", accounts, contextAccountId: "bank" })).toBe("");
    }
  });

  it("a context account that no longer exists yields no account", () => {
    expect(initialAddAccountId({ kind: "expense", accounts: [cash, bank], contextAccountId: "gone" })).toBe("");
  });
});

describe("accountAfterKindSwitch", () => {
  it("keeps an eligible selection and clears an ineligible one — never substitutes another account", () => {
    for (const accounts of ORDERINGS) {
      expect(accountAfterKindSwitch({ next: "income", currentId: "bank", accounts })).toBe("bank");
      expect(accountAfterKindSwitch({ next: "income", currentId: "card", accounts })).toBe("");
      expect(accountAfterKindSwitch({ next: "expense", currentId: "card", accounts })).toBe("card");
      expect(accountAfterKindSwitch({ next: "income", currentId: "", accounts })).toBe("");
    }
  });
});
