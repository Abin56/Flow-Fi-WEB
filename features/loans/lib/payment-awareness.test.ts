import { describe, expect, it } from "vitest";
import { deriveAwareness, type AwarenessInput } from "./payment-awareness";

const sbi = (currentBalance: number) => ({ name: "SBI", type: "bank" as const, currentBalance });

const base: AwarenessInput = {
  earlier: false,
  directPayer: false,
  lent: false,
  debitsAccount: true,
  creditsAccount: false,
  cardLabel: null,
  account: sbi(5000),
  amount: 2500,
  payerName: "Shambu",
  agreement: "Loan",
  success: false,
};

describe("deriveAwareness", () => {
  it("I pay with enough balance: money leaves the chosen account, no warning", () => {
    const m = deriveAwareness(base)!;
    expect(m.kind).toBe("pay");
    expect(m.from).toBe("SBI");
    expect(m.amount).toBe("₹2,500");
  });

  it("balance exactly equal to the payment is not short", () => {
    expect(deriveAwareness({ ...base, account: sbi(2500) })!.kind).toBe("pay");
  });

  it("insufficient balance: Low balance · Short by the exact difference, from the account's own balance", () => {
    const m = deriveAwareness({ ...base, account: sbi(1500) })!;
    expect(m.kind).toBe("low");
    expect(m.title).toBe("Low balance · Short by ₹1,000");
    expect(m.detail).toBe("SBI has ₹1,500");
  });

  it("the warning follows the amount and the account", () => {
    expect(deriveAwareness({ ...base, account: sbi(1500), amount: 1000 })!.kind).toBe("pay");
    expect(deriveAwareness({ ...base, account: sbi(1500), amount: 4000 })!.title).toBe("Low balance · Short by ₹2,500");
    expect(deriveAwareness({ ...base, account: sbi(9000) })!.kind).toBe("pay");
  });

  it("a credit card (may run negative) never warns, like the write layer", () => {
    const card = { name: "HDFC card", type: "card" as const, currentBalance: 0, cardSubtype: "credit" as const };
    expect(deriveAwareness({ ...base, account: card })!.kind).toBe("pay");
  });

  it("no account chosen: asks for one, never invents a balance", () => {
    const m = deriveAwareness({ ...base, account: null })!;
    expect(m.kind).toBe("choose");
    expect(m.detail).toBe("Choose the paying account");
  });

  it("no valid amount: no figure and no shortfall", () => {
    const m = deriveAwareness({ ...base, account: sbi(0), amount: null })!;
    expect(m.kind).toBe("pay");
    expect(m.amount).toBeNull();
  });

  it("already paid earlier: no debit, and never a low-balance warning even with an empty account", () => {
    const m = deriveAwareness({ ...base, earlier: true, debitsAccount: false, account: sbi(0) })!;
    expect(m.kind).toBe("recorded");
    expect(m.title).toBe("Already recorded · No new debit");
  });

  it("paid directly: nothing leaves my account, no warning", () => {
    const m = deriveAwareness({ ...base, earlier: true, directPayer: true, debitsAccount: false, account: sbi(0) })!;
    expect(m.kind).toBe("direct");
    expect(m.title).toBe("Paid directly · My account unchanged");
    expect(m.detail).toBe("Shambu paid the lender");
  });

  it("a lent loan's repayment is money received, not a debit", () => {
    const m = deriveAwareness({ ...base, lent: true, debitsAccount: false, creditsAccount: true })!;
    expect(m.kind).toBe("receive");
    expect(m.title).toBe("₹2,500 received into SBI");
  });

  it("a card-billed EMI is not a bank debit", () => {
    const m = deriveAwareness({ ...base, debitsAccount: false, account: null, cardLabel: "HDFC card" })!;
    expect(m.kind).toBe("card");
    expect(m.detail).toBe("Bank balance unchanged");
  });

  it("says nothing when no money movement is recognised", () => {
    expect(deriveAwareness({ ...base, debitsAccount: false, account: null })).toBeNull();
  });

  it("the done text only exists on the model — success is carried from the dialog's own flag", () => {
    expect(deriveAwareness(base)!.success).toBe(false);
    const m = deriveAwareness({ ...base, success: true })!;
    expect(m.success).toBe(true);
    expect(m.doneText).toBe("Payment recorded · ₹2,500 from SBI");
  });
});
