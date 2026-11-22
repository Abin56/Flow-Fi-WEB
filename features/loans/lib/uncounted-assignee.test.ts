import { describe, expect, it } from "vitest";
import { uncountedAssigneeId } from "@/features/loans/lib/uncounted-assignee";

describe("uncountedAssigneeId — assigned person with no repay opt-in", () => {
  it("linked person, no opt-in → the person (association only, nothing in People)", () => {
    expect(uncountedAssigneeId({ beneficiaryPersonId: "amma" })).toBe("amma");
    expect(uncountedAssigneeId({ beneficiaryPersonId: "amma", beneficiaryRepaysInstallments: false })).toBe("amma");
  });
  it("opted in → null (their installments are People obligations already)", () => {
    expect(uncountedAssigneeId({ beneficiaryPersonId: "amma", beneficiaryRepaysInstallments: true })).toBeNull();
  });
  it("no person, or a split agreement → null", () => {
    expect(uncountedAssigneeId(null)).toBeNull();
    expect(uncountedAssigneeId({})).toBeNull();
    expect(uncountedAssigneeId({ beneficiaryPersonId: "amma", ownershipShares: [{ personId: "amma", amount: 100 }] })).toBeNull();
  });
});
