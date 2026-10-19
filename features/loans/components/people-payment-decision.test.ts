import { describe, expect, it } from "vitest";
import { ownMoneyPaymentNote, ownMoneyReasonLabel, peopleNames } from "./people-payment-decision";

describe("Pay using my own money — what is saved and shown", () => {
  it("the payment note always says it was paid from own money; reason and note only when given", () => {
    expect(ownMoneyPaymentNote(null, "")).toBe("Paid from my own money");
    expect(ownMoneyPaymentNote("couldNotPay", "  ")).toBe("Paid from my own money — Person could not pay");
    expect(ownMoneyPaymentNote("collectLater", "after salary")).toBe("Paid from my own money — I will collect later: after salary");
    expect(ownMoneyPaymentNote(null, "Sanju on leave")).toBe("Paid from my own money: Sanju on leave");
  });

  it("reason labels", () => {
    expect(ownMoneyReasonLabel("delayed")).toBe("Payment delayed");
    expect(ownMoneyReasonLabel(null)).toBeNull();
  });

  it("names read naturally", () => {
    expect(peopleNames(["Sanju"])).toBe("Sanju");
    expect(peopleNames(["Sanju", "AMMA"])).toBe("Sanju and AMMA");
    expect(peopleNames(["Sanju", "AMMA", "Ravi"])).toBe("Sanju and 2 others");
  });
});
