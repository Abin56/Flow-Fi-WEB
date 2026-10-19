// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { groupRecordedPayments } from "@/features/loans/lib/recorded-payments";
import type { Installment, InstallmentPayment } from "@/lib/models/payment-schedule";
import { RecordedPaymentDialog, type RecordedPaymentTarget } from "./recorded-payment-dialog";

/**
 * "Mark as unpaid" on an OLDER Loan / EMI payment: the later payments are undone first, newest first, each with
 * the ordinary single reversal — a failure stops the run, and a retry continues with only what's left.
 */

const emiReverse = vi.fn(async (..._args: unknown[]) => ({ alreadyReversed: false }));
const loanReverse = vi.fn(async (..._args: unknown[]) => ({ scheduleRestorationSkippedReason: null }));
vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("@/features/emi/hooks/use-emi-data", () => ({ useEmiActions: () => ({ reversePayment: emiReverse }) }));
vi.mock("@/features/loans/hooks/use-loans-data", () => ({ useLoanActions: () => ({ reversePayment: loanReverse }) }));
vi.mock("@/features/emi/components/emi-card", () => ({ emiCardLabel: () => null }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn(async () => {}) }) }));
// Not a shared agreement here — the read-only People section stays empty.
vi.mock("@/features/loans/hooks/use-installment-breakdown", () => ({ useInstallmentBreakdown: () => ({ breakdown: null, isLoading: false }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/loans-installments", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: [{ id: "sbi", name: "SBI", isDefault: true, deletedAt: null }] }) }));
vi.mock("@/hooks/use-transactions", () => ({ useTransactions: () => ({ data: [1, 2, 3, 4].map((n) => ({ id: `t${n}`, accountId: "sbi", deletedAt: null })) }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);
beforeEach(() => {
  emiReverse.mockClear();
  loanReverse.mockClear();
});

const at = (day: number) => new Date(2026, 0, day, 10);
const inst = (n: number): Installment => ({
  id: `i${n}`, scheduleId: "s", ownerType: "emi", ownerId: "e", sequenceNumber: n, dueDate: new Date(2026, n - 1, 5), amountDue: 5000, amountPaid: 5000,
  isSkipped: false, principalPortion: null, interestPortion: null, createdAt: at(1), deletedAt: null, lastEditedAt: null, editHistory: [],
});
const pay = (n: number, source: "emi" | "loan"): InstallmentPayment => ({
  id: source === "emi" ? `emi_k${n}_p0` : `p${n}`, installmentId: `i${n}`, scheduleId: "s", ownerType: source, ownerId: "e", amount: 5000, date: new Date(2026, n - 1, 5),
  note: "", createdAt: at(n), settlementMethod: null, billingCycleLabel: null, remainingBalanceAfterPayment: 0, allocationType: "regularEmi",
  prepaymentPrincipalAmount: null, prepaymentPolicyApplied: null, reamortizationEventId: null, transactionId: source === "loan" ? `t${n}` : null,
  deletedAt: null, lastEditedAt: null, editHistory: [],
});
const installments = [1, 2, 3, 4].map(inst);

function emiTarget(seq: number): RecordedPaymentTarget {
  const all = groupRecordedPayments([1, 2, 3, 4].map((n) => pay(n, "emi")), installments, "emi");
  return {
    source: "emi",
    row: { emi: { id: "e", name: "Phone EMI", installmentCount: 12, isClosed: false }, installments, remainingBalance: 40000 } as never,
    action: all.find((a) => a.installmentSeqs[0] === seq)!,
    all,
    breakdowns: [],
  };
}
function loanTarget(seq: number): RecordedPaymentTarget {
  const all = groupRecordedPayments([1, 2, 3, 4].map((n) => pay(n, "loan")), installments, "loan");
  return {
    source: "loan",
    row: { loan: { id: "l", name: "Car loan" }, installments, direction: "taken", status: "active", totalInstallments: 12 } as never,
    action: all.find((a) => a.installmentSeqs[0] === seq)!,
    all,
  };
}
const renderDialog = (target: RecordedPaymentTarget) => render(<RecordedPaymentDialog target={target} open onOpenChange={() => {}} />);

describe("older payment → Mark as unpaid together with the later ones", () => {
  it("the latest payment keeps the ordinary Mark as unpaid (no chain offered)", () => {
    renderDialog(emiTarget(4));
    expect(screen.getByRole("button", { name: "Mark as unpaid" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /with \d+ later payment/ })).toBeNull();
  });

  it("EMI #1: lists #4 → #1 newest first, then undoes them in that order with the ordinary reversal", async () => {
    const user = userEvent.setup();
    renderDialog(emiTarget(1));
    expect(screen.getByText(/only the latest payment can be edited/i)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Mark as unpaid · with 3 later payments" }));
    const list = within(screen.getByTestId("undo-chain")).getAllByRole("listitem").map((li) => li.textContent);
    expect(list.map((t) => /Installment #(\d)/.exec(t ?? "")?.[1])).toEqual(["4", "3", "2", "1"]);
    await user.click(screen.getByRole("button", { name: "Mark 4 payments as unpaid" }));
    await waitFor(() => expect(emiReverse).toHaveBeenCalledTimes(4));
    expect(emiReverse.mock.calls.map((c) => (c[1] as { original: { installmentIds: string[] } }).original.installmentIds[0])).toEqual(["i4", "i3", "i2", "i1"]);
  });

  it("Loan: a failure stops the run; retry continues with only what's left, each reversal with its own stable key", async () => {
    const user = userEvent.setup();
    loanReverse.mockImplementationOnce(async () => ({ scheduleRestorationSkippedReason: null })).mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    renderDialog(loanTarget(2));
    await user.click(screen.getByRole("button", { name: "Mark as unpaid · with 2 later payments" }));
    await user.click(screen.getByRole("button", { name: "Mark 3 payments as unpaid" }));
    await waitFor(() => expect(loanReverse).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Continue (2 left)" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Continue (2 left)" }));
    await waitFor(() => expect(loanReverse).toHaveBeenCalledTimes(4));
    const calls = loanReverse.mock.calls.map((c) => c[0] as { transactionId: string; reversalIdempotencyKey: string });
    expect(calls.map((c) => c.transactionId)).toEqual(["t4", "t3", "t3", "t2"]);
    // The failed one is retried with the SAME key (a reversal that did land is recognised, never repeated).
    expect(calls[1].reversalIdempotencyKey).toBe(calls[2].reversalIdempotencyKey);
    expect(new Set(calls.map((c) => c.reversalIdempotencyKey)).size).toBe(3);
  });
});
