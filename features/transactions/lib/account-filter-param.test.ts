import { describe, expect, it } from "vitest";
import { accountIdFromParams, deriveAccountFilter, transactionsHrefForAccount } from "@/features/transactions/lib/account-filter-param";

const known = new Set(["sbi", "hdfc-card-account"]);
const none = new Set<string>();

describe("transactionsHrefForAccount", () => {
  it("links to the central Transactions page by stable id", () => {
    expect(transactionsHrefForAccount("sbi")).toBe("/transactions?account=sbi");
  });
  it("encodes ids safely", () => {
    expect(transactionsHrefForAccount("a b/c")).toBe("/transactions?account=a%20b%2Fc");
  });
});

describe("accountIdFromParams", () => {
  it("reads the id, trimming it, and treats blank as absent", () => {
    expect(accountIdFromParams(new URLSearchParams("account=sbi"))).toBe("sbi");
    expect(accountIdFromParams(new URLSearchParams("account=%20sbi%20"))).toBe("sbi");
    expect(accountIdFromParams(new URLSearchParams("account="))).toBeNull();
    expect(accountIdFromParams(new URLSearchParams(""))).toBeNull();
  });
});

describe("deriveAccountFilter", () => {
  it("no account in the URL → no filter", () => {
    expect(deriveAccountFilter({ urlId: null, signedIn: true, knownIds: known, lookup: "pending" })).toEqual({ status: "none", appliedId: null, contextId: null });
  });

  it("an id in the live account list is valid immediately and becomes Add Transaction context", () => {
    expect(deriveAccountFilter({ urlId: "sbi", signedIn: true, knownIds: known, lookup: "pending" })).toEqual({ status: "valid", appliedId: "sbi", contextId: "sbi" });
  });

  it("DIRECT NAVIGATION: before sign-in / before the lists load the id is KEPT, not dropped — and is not yet Add context", () => {
    expect(deriveAccountFilter({ urlId: "sbi", signedIn: false, knownIds: none, lookup: "pending" })).toEqual({ status: "checking", appliedId: "sbi", contextId: null });
    // An empty list while signed in is "not loaded yet" — never evidence the id is stale (the D-05 cause).
    expect(deriveAccountFilter({ urlId: "sbi", signedIn: true, knownIds: none, lookup: "pending" })).toEqual({ status: "checking", appliedId: "sbi", contextId: null });
    expect(deriveAccountFilter({ urlId: "sbi", signedIn: true, knownIds: none, lookup: "unavailable" })).toEqual({ status: "checking", appliedId: "sbi", contextId: null });
  });

  it("the direct lookup confirms an account that is the user's own and active", () => {
    expect(deriveAccountFilter({ urlId: "sbi", signedIn: true, knownIds: none, lookup: "valid" })).toEqual({ status: "valid", appliedId: "sbi", contextId: "sbi" });
  });

  it("a confirmed-invalid id (missing, deleted, someone else's) yields no filter and no context — never another account", () => {
    for (const urlId of ["deleted", "someone-elses", "../x"]) {
      const s = deriveAccountFilter({ urlId, signedIn: true, knownIds: known, lookup: "invalid" });
      expect(s).toEqual({ status: "invalid", appliedId: null, contextId: null });
    }
  });

  it("a known id wins over a stale lookup result", () => {
    expect(deriveAccountFilter({ urlId: "sbi", signedIn: true, knownIds: known, lookup: "invalid" }).status).toBe("valid");
  });
});
