import { describe, expect, it } from "vitest";
import { loanOriginationUi } from "@/features/loans/lib/loan-origination-ui";

const txn = (id: string, deletedAt: Date | null = null) => ({
  id, type: "income" as const, amount: 50000, accountId: "hdfc", paymentAllocationType: "additionalDisbursement" as const, deletedAt,
});
const names = (id: string) => (id === "hdfc" ? "HDFC" : undefined);

describe("loanOriginationUi", () => {
  it("wizard Loan with active money → Reverse & Delete with the real effect", () => {
    const ui = loanOriginationUi("orig_key-00000001_loan", [txn("orig_key-00000001_txn")], names);
    expect(ui).toEqual({
      idempotencyKey: "key-00000001",
      moneyActive: true,
      message: "This will remove the original ₹50,000 received into HDFC and reverse the loan creation.",
    });
  });

  it("wizard Loan without money (or already reversed) → plain trash allowed", () => {
    expect(loanOriginationUi("orig_key-00000001_loan", [], names).moneyActive).toBe(false);
    expect(loanOriginationUi("orig_key-00000001_loan", [txn("orig_key-00000001_txn", new Date())], names).moneyActive).toBe(false);
  });

  it("legacy Loan → nothing to reverse", () => {
    expect(loanOriginationUi("0b1c2d3e-uuid", [txn("orig_x_txn")], names)).toEqual({ idempotencyKey: null, moneyActive: false, message: "" });
  });
});
