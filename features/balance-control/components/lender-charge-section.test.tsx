// @vitest-environment jsdom
/**
 * The read-only "Record a lender charge" section: payoff shows principal / unpaid charges / total separately, the
 * preview moves only the charge figures (never principal), duplicates and card-linked evidence raise reviews, and
 * the Record button is permanently disabled — there is no write path behind this screen.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LenderCharge } from "@/lib/models/lender-charge";

const state: { charges: LenderCharge[]; cards: { id: string; accountId: string }[]; transactions: unknown[] } = vi.hoisted(() => ({ charges: [], cards: [], transactions: [] }));
vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));
vi.mock("@/hooks/use-lender-charges", () => ({ useLenderCharges: () => ({ charges: state.charges, isLoading: false }) }));
vi.mock("@/hooks/use-credit-cards", () => ({ useCreditCards: () => ({ data: state.cards }), useEmis: () => ({ data: [] }) }));
vi.mock("@/hooks/use-transactions", () => ({ useTransactions: () => ({ data: state.transactions }) }));

import type { LoanReconciliationContext } from "../lib/build-balance-control";
import { LenderChargeSection } from "./lender-charge-section";

const NOW = new Date(2026, 9, 28);
const g = (id: string) => screen.getByTestId(id);
const q = (id: string) => screen.queryByTestId(id);
const text = (id: string) => g(id).textContent ?? "";
const digits = (s: string) => s.replace(/[^\d.]/g, "");

function context(over: Partial<LoanReconciliationContext> = {}): LoanReconciliationContext {
  return {
    agreementId: "e1", source: { kind: "emi", row: {} as never }, principalAmount: 20000, outstandingPrincipal: 15000, ratePercent: null, installments: [], principalPrepaid: 0,
    cardLinkedName: null, cardEmiCase: null, supportsPrepaymentAndDisbursement: false, ...over,
  };
}
const existing = (over: Partial<LenderCharge> = {}): LenderCharge => ({
  id: "c1", agreementKind: "emi", agreementId: "e1", type: "penalty", amount: 500, billedDate: new Date(2026, 9, 5), lenderReference: "INV-1", reason: "late", categoryId: null,
  settlements: [], reversedAt: null, reversalReason: null, cardReview: null, idempotencyKey: "k", createdAt: new Date(2026, 9, 6), deletedAt: null, lastEditedAt: null, editHistory: [], ...over,
});
const fill = (id: string, value: string) => fireEvent.change(g(id), { target: { value } });
function enter(over: { type?: string; amount?: string; date?: string; ref?: string; reason?: string } = {}) {
  fill("lender-charge-type", over.type ?? "penalty");
  fill("lender-charge-amount", over.amount ?? "1000");
  fill("lender-charge-date", over.date ?? "2026-10-20");
  fill("lender-charge-reference", over.ref ?? "NEW-9");
  fill("lender-charge-reason", over.reason ?? "late payment");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  state.charges = [];
  state.cards = [];
  state.transactions = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("lender charge section (read-only)", () => {
  it("shows principal, unpaid charges and total payoff as three separate figures", () => {
    state.charges = [existing(), existing({ id: "c2", amount: 300, settlements: [{ id: "s", transactionId: "t", amount: 300, date: NOW, reversedAt: null }] })];
    render(<LenderChargeSection context={context()} now={NOW} />);
    expect(digits(text("payoff-principal"))).toBe("15000.00");
    expect(digits(text("payoff-charges"))).toBe("500.00");
    expect(digits(text("payoff-total"))).toBe("15500.00");
    expect(text("payoff-total")).not.toBe(text("payoff-principal"));
  });

  it("with no charges the total payoff equals principal and nothing else changes", () => {
    render(<LenderChargeSection context={context()} now={NOW} />);
    expect(digits(text("payoff-charges"))).toBe("0.00");
    expect(digits(text("payoff-total"))).toBe("15000.00");
    expect(q("lender-charge-preview")).toBeNull();
  });

  it("previews: principal unchanged, charges and payoff +amount, Net Worth down, one expense, no cash or transaction", () => {
    render(<LenderChargeSection context={context()} now={NOW} />);
    enter({ amount: "1180.50" });
    expect(digits(text("preview-principal-after"))).toBe("15000.00");
    expect(text("preview-principal-after")).toMatch(/unchanged/);
    expect(digits(text("preview-charges-after"))).toBe("1180.50");
    expect(digits(text("preview-payoff-after"))).toBe("16180.50");
    const effects = text("lender-charge-effects");
    expect(effects).toMatch(/Net Worth: −/);
    expect(effects).toMatch(/recognised once/);
    expect(effects).toMatch(/Loan & EMI Charges/);
    expect(effects).toMatch(/No cash moves and no transaction is created/);
    expect(g("lender-charge-preview").getAttribute("data-blocked")).toBe("false");
  });

  it("accrued unbilled interest is never part of the payoff", () => {
    render(<LenderChargeSection context={context()} now={NOW} />);
    expect(text("lender-payoff")).toMatch(/not yet billed is not included/);
  });

  it("validates: missing reason, future date, bad amount", () => {
    render(<LenderChargeSection context={context()} now={NOW} />);
    enter({ reason: "" });
    expect(text("lender-charge-errors")).toMatch(/why/);
    enter({ date: "2026-11-30" });
    expect(text("lender-charge-errors")).toMatch(/future/);
    enter({ amount: "0" });
    expect(text("lender-charge-errors")).toMatch(/billed amount/);
    expect(g("lender-charge-preview").getAttribute("data-blocked")).toBe("true");
  });

  it("blocks an exact duplicate and warns about a possible one", () => {
    state.charges = [existing()];
    render(<LenderChargeSection context={context()} now={NOW} />);
    enter({ type: "penalty", amount: "500", date: "2026-10-05", ref: "INV-1" });
    expect(text("lender-charge-errors")).toMatch(/already recorded/);
    expect(g("lender-charge-preview").getAttribute("data-blocked")).toBe("true");
    enter({ type: "penalty", amount: "500", date: "2026-10-06", ref: "" });
    expect(q("lender-charge-possible-duplicate")).not.toBeNull();
  });

  it("a charge on another agreement does not count", () => {
    state.charges = [existing({ agreementId: "other" })];
    render(<LenderChargeSection context={context()} now={NOW} />);
    expect(digits(text("payoff-charges"))).toBe("0.00");
  });

  it("the Record button is disabled and explains why — nothing can be saved", () => {
    render(<LenderChargeSection context={context()} now={NOW} />);
    enter();
    const btn = g("lender-charge-record-disabled") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(text("lender-charge-disabled-reason")).toMatch(/not enabled yet/);
  });

  describe("card-linked", () => {
    const linked = () => context({ cardLinkedName: "QA EMI Card", source: { kind: "emi", row: { linkedCard: { accountId: "card-acc" } } as never } });
    const cardTx = (over: Record<string, unknown> = {}) => ({ id: "ct1", accountId: "card-acc", type: "expense", amount: 1000, dateTime: new Date(2026, 9, 21), description: "LATE PAYMENT CHARGES", notes: "", deletedAt: null, ...over });

    it("a standalone agreement shows no card review", () => {
      render(<LenderChargeSection context={context()} now={NOW} />);
      expect(q("lender-charge-card-review")).toBeNull();
    });

    it("no match still requires a confirmation — absence is not proof", () => {
      render(<LenderChargeSection context={linked()} now={NOW} />);
      enter();
      expect(q("lender-charge-card-nomatch")).not.toBeNull();
      expect(g("lender-charge-card-gate").getAttribute("data-allowed")).toBe("false");
      fireEvent.click(g("lender-charge-not-on-card"));
      expect(g("lender-charge-card-gate").getAttribute("data-allowed")).toBe("true");
    });

    it("a matching card transaction needs review; 'already on the card' blocks", () => {
      state.transactions = [cardTx()];
      render(<LenderChargeSection context={linked()} now={NOW} />);
      enter();
      expect(screen.getAllByTestId("lender-charge-card-match")).toHaveLength(1);
      fireEvent.click(g("lender-charge-not-on-card"));
      expect(g("lender-charge-card-gate").getAttribute("data-allowed")).toBe("false"); // match not yet reviewed
      fireEvent.click(screen.getByRole("checkbox"));
      expect(g("lender-charge-card-gate").getAttribute("data-allowed")).toBe("true");
      fireEvent.click(g("lender-charge-on-card"));
      expect(g("lender-charge-card-gate").getAttribute("data-allowed")).toBe("false");
      expect(text("lender-charge-card-gate")).toMatch(/already on the credit card/);
    });

    it("transactions on other accounts are not evidence", () => {
      state.transactions = [cardTx({ accountId: "someone-else" })];
      render(<LenderChargeSection context={linked()} now={NOW} />);
      enter();
      expect(q("lender-charge-card-matches")).toBeNull();
    });
  });
});
