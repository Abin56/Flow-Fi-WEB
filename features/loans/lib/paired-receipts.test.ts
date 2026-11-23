import { describe, expect, it } from "vitest";
import type { InstallmentPayment } from "@/lib/models/payment-schedule";
import { lenderActionForReceipt, receiptsPairedWithPayment, type PairingEntry } from "./paired-receipts";
import type { RecordedPaymentAction } from "./recorded-payments";

const at = (min: number) => new Date(2026, 10, 20, 10, min);
const action = (over: Partial<RecordedPaymentAction> = {}): RecordedPaymentAction =>
  ({ source: "loan", portions: [{ installmentId: "i5" } as InstallmentPayment], createdAt: at(0), reversed: false, ...over }) as RecordedPaymentAction;
const entry = (over: Partial<PairingEntry> = {}): PairingEntry => ({
  personId: "p1",
  paymentId: "pp_hist_b1_p1_i5",
  obligationRef: "loan-inst:i5",
  createdAt: at(1),
  deletedAt: null,
  ...over,
});

describe("receiptsPairedWithPayment", () => {
  it("pairs the receipt written right after the lender payment, for a covered installment", () => {
    expect(receiptsPairedWithPayment([entry()], action())).toEqual([{ personId: "p1", paymentId: "pp_hist_b1_p1_i5" }]);
  });

  it("never pairs a receipt typed in People later (no hist key), another installment, another source, a deleted entry or a distant time", () => {
    const a = action();
    expect(receiptsPairedWithPayment([entry({ paymentId: "pp_abc" })], a)).toEqual([]);
    expect(receiptsPairedWithPayment([entry({ obligationRef: "loan-inst:i9" })], a)).toEqual([]);
    expect(receiptsPairedWithPayment([entry({ obligationRef: "emi-inst:i5" })], a)).toEqual([]);
    expect(receiptsPairedWithPayment([entry({ deletedAt: at(2) })], a)).toEqual([]);
    expect(receiptsPairedWithPayment([entry({ createdAt: at(90) })], a)).toEqual([]);
  });

  it("returns each person's payment once and every person who paid", () => {
    const rows = [entry(), entry(), entry({ personId: "p2", paymentId: "pp_hist_b1_p2_i5" })];
    expect(receiptsPairedWithPayment(rows, action()).map((r) => r.personId)).toEqual(["p1", "p2"]);
  });
});

describe("lenderActionForReceipt", () => {
  it("finds the live payment covering the receipt's installment, closest in time", () => {
    const near = action({ id: "near", createdAt: at(0) });
    const far = action({ id: "far", createdAt: at(20) });
    expect(lenderActionForReceipt([entry({ createdAt: at(1) })], "pp_hist_b1_p1_i5", [far, near])?.id).toBe("near");
  });

  it("ignores reversed payments and other installments", () => {
    expect(lenderActionForReceipt([entry()], "pp_hist_b1_p1_i5", [action({ reversed: true })])).toBeNull();
    expect(lenderActionForReceipt([entry()], "pp_hist_b1_p1_i5", [action({ portions: [{ installmentId: "i6" } as InstallmentPayment] })])).toBeNull();
  });

  it("a receipt that isn't from the dialog has no lender payment", () => {
    expect(lenderActionForReceipt([entry({ paymentId: "pp_abc" })], "pp_abc", [action()])).toBeNull();
  });
});
