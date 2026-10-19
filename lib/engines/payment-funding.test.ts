import { describe, expect, it } from "vitest";
import { InsufficientFundsError, accountAllowsNegative, assertFundsAvailable, isInsufficientFundsError, previewFunds, type FundingAccount } from "@/lib/engines/payment-funding";

const bank = (currentBalance: number, extra: Partial<FundingAccount> = {}): FundingAccount => ({ type: "bank", bankAccountSubtype: "savings", currentBalance, ...extra });

describe("previewFunds", () => {
  it("₹100,000 balance, ₹100,000 payment → ₹0 and still ok", () => {
    expect(previewFunds(bank(100000), 100000)).toMatchObject({ before: 100000, amount: 100000, after: 0, status: "ok", shortfall: 0 });
  });
  it("one rupee more than the balance is insufficient with the exact shortfall", () => {
    expect(previewFunds(bank(100000), 100001)).toMatchObject({ after: -1, status: "insufficient", shortfall: 1 });
  });
  it("zero balance cannot pay anything", () => {
    expect(previewFunds(bank(0), 500).status).toBe("insufficient");
    expect(previewFunds(bank(0), 0).status).toBe("ok");
  });
  it("is paisa-exact (no float drift)", () => {
    expect(previewFunds(bank(0.3), 0.1 + 0.2).status).toBe("ok");
  });
  it("an account already negative cannot be made worse", () => {
    expect(previewFunds(bank(-50), 1).status).toBe("insufficient");
  });
  it("a prepaid / forex / gift card holds a real balance and is checked; a credit or older subtype-less card is not", () => {
    expect(previewFunds({ type: "card", cardSubtype: "prepaid", currentBalance: 100 }, 500).status).toBe("insufficient");
    expect(previewFunds({ type: "card", cardSubtype: null, currentBalance: 0 }, 500).status).toBe("ok");
  });
  it("no overdraft is assumed for any bank account (the model has no overdraft flag) — Current is checked; credit and debit cards are not", () => {
    expect(accountAllowsNegative(bank(0, { bankAccountSubtype: "current" }))).toBe(false);
    expect(previewFunds(bank(10, { bankAccountSubtype: "current" }), 500).status).toBe("insufficient");
    expect(previewFunds({ type: "card", cardSubtype: "debit", currentBalance: 0 }, 500).status).toBe("ok");
    expect(previewFunds({ type: "card", cardSubtype: "credit", currentBalance: 0 }, 500).status).toBe("ok");
  });
  it("flags dropping under the minimum balance without blocking", () => {
    const p = previewFunds(bank(1000, { minimumBalance: 500 }), 700);
    expect(p).toMatchObject({ status: "ok", belowMinimum: true });
  });
});

describe("assertFundsAvailable", () => {
  it("throws InsufficientFundsError naming the account and fresh balance", () => {
    try {
      assertFundsAvailable({ ...bank(32000), name: "SBI" }, 32500);
      expect.unreachable();
    } catch (e) {
      expect(isInsufficientFundsError(e)).toBe(true);
      expect(e).toBeInstanceOf(InsufficientFundsError);
      expect((e as InsufficientFundsError).available).toBe(32000);
      expect((e as Error).message).toContain("SBI");
    }
  });
  it("passes on exact balance and ignores non-outflows", () => {
    expect(() => assertFundsAvailable(bank(32000), 32000)).not.toThrow();
    expect(() => assertFundsAvailable(bank(0), 0)).not.toThrow();
    expect(() => assertFundsAvailable(bank(0), -100)).not.toThrow();
  });
});
