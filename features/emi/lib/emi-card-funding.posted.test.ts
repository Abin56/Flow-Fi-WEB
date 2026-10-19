import { describe, expect, it } from "vitest";
import { describeEmiPostedFunding } from "@/features/emi/lib/emi-card-funding";

const CARD = "card";
const leg = (accountId: string, type: "income" | "expense", amount: number, transferId: string | null = null) => ({ accountId, type, amount, transferId });

describe("describeEmiPostedFunding — what a card-linked EMI payment actually posted", () => {
  it("no legs at all (Case A, zero interest, charge to card) → noCardCharge, never 'charged to card'", () => {
    expect(describeEmiPostedFunding({ legs: [], cardAccountId: CARD, paymentAmount: 3000 })).toEqual({ kind: "noCardCharge" });
  });
  it("interest-only card charge → cardPartial with the ACTUAL charge, not the EMI amount", () => {
    expect(describeEmiPostedFunding({ legs: [leg(CARD, "expense", 120)], cardAccountId: CARD, paymentAmount: 3075.37 })).toEqual({ kind: "cardPartial", cardCharge: 120 });
  });
  it("the whole installment on the card → card", () => {
    expect(describeEmiPostedFunding({ legs: [leg(CARD, "expense", 3075.37)], cardAccountId: CARD, paymentAmount: 3075.37 })).toEqual({ kind: "card", cardCharge: 3075.37 });
  });
  it("bank only (Case B direct) → bank with no principal to card", () => {
    expect(describeEmiPostedFunding({ legs: [leg("bank", "expense", 3075.37)], cardAccountId: CARD, paymentAmount: 3075.37 })).toEqual({ kind: "bank", bankAccountId: "bank", bankDebit: 3075.37, principalToCard: 0 });
  });
  it("Case A direct: bank interest + transfer out, card-side credit → bank debit is the sum, principal to card is the transfer", () => {
    const legs = [leg("bank", "expense", 120), leg("bank", "expense", 2955.37, "x"), leg(CARD, "income", 2955.37, "x")];
    expect(describeEmiPostedFunding({ legs, cardAccountId: CARD, paymentAmount: 3075.37 })).toEqual({ kind: "bank", bankAccountId: "bank", bankDebit: 3075.37, principalToCard: 2955.37 });
  });
  it("a transfer's card-side income leg alone is not a card CHARGE", () => {
    expect(describeEmiPostedFunding({ legs: [leg(CARD, "income", 100, "x")], cardAccountId: CARD, paymentAmount: 100 }).kind).toBe("noCardCharge");
  });
});
