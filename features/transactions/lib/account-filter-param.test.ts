import { describe, expect, it } from "vitest";
import { resolveAccountFilter, transactionsHrefForAccount } from "@/features/transactions/lib/account-filter-param";

const accounts = [{ id: "sbi" }, { id: "hdfc-card-account" }];

describe("transactionsHrefForAccount", () => {
  it("links to the central Transactions page by stable id", () => {
    expect(transactionsHrefForAccount("sbi")).toBe("/transactions?account=sbi");
  });
  it("encodes ids safely", () => {
    expect(transactionsHrefForAccount("a b/c")).toBe("/transactions?account=a%20b%2Fc");
  });
});

describe("resolveAccountFilter", () => {
  it("keeps a known account or card id", () => {
    expect(resolveAccountFilter("sbi", accounts, false)).toBe("sbi");
    expect(resolveAccountFilter("hdfc-card-account", accounts, false)).toBe("hdfc-card-account");
  });
  it("drops an unknown / deleted id once loaded", () => {
    expect(resolveAccountFilter("deleted-account", accounts, false)).toBeNull();
  });
  it("does not drop the id while accounts are still loading", () => {
    expect(resolveAccountFilter("sbi", [], true)).toBe("sbi");
  });
  it("leaves no filter as no filter", () => {
    expect(resolveAccountFilter(null, accounts, false)).toBeNull();
  });
});
