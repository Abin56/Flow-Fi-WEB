// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RECORDED_EARLIER_DESCRIPTION_SUFFIX } from "@/lib/engines/recorded-earlier";
import type { Transaction } from "@/lib/models/transaction";
import { useAuthStore } from "@/store/auth-store";
import { useHistoricalPaymentFlags } from "./use-historical-payment-flags";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

// The payment documents, by id. Only the structured recordedEarlier field matters.
const paymentDocs = new Map<string, { recordedEarlier: { dateKnown: boolean } | null }>();
const getByKey = vi.fn(async (id: string) => paymentDocs.get(id) ?? null);
vi.mock("@/lib/repositories/repository-factory", () => ({
  createInstallmentRepositoryFor: () => ({}),
  createInstallmentPaymentRepositoryFor: () => ({ getByKey }),
}));

const loans = [{ id: "loan1", scheduleId: "sched1" }];
const txn = (over: Partial<Transaction>): Transaction =>
  ({ id: "t", loanId: "loan1", excludeFromCalculations: true, installmentId: "inst1", installmentPaymentId: "pay1", description: "Loan payment", ...over }) as Transaction;

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return Wrapper;
}

beforeEach(() => {
  paymentDocs.clear();
  getByKey.mockClear();
  useAuthStore.setState({ user: { uid: "u1" } as never, status: "signed-in" });
});

describe("useHistoricalPaymentFlags", () => {
  it("labels from the payment's structured flag — an edited description does not lose it", async () => {
    paymentDocs.set("pay1", { recordedEarlier: { dateKnown: true } });
    const edited = txn({ description: "Car loan, October" }); // marker text gone
    const { result } = renderHook(() => useHistoricalPaymentFlags([edited], loans), { wrapper: wrapper() });
    await waitFor(() => expect(result.current(edited)).toBe(true));
    expect(getByKey).toHaveBeenCalledWith("pay1");
  });

  it("a look-alike description on an ordinary (or legacy, flag-less) payment is not labelled once the read returns", async () => {
    paymentDocs.set("pay1", { recordedEarlier: null });
    const lookAlike = txn({ description: `Loan payment — Car${RECORDED_EARLIER_DESCRIPTION_SUFFIX}` });
    const { result } = renderHook(() => useHistoricalPaymentFlags([lookAlike], loans), { wrapper: wrapper() });
    // provisional hint first…
    expect(result.current(lookAlike)).toBe(true);
    // …then the structured answer takes over.
    await waitFor(() => expect(result.current(lookAlike)).toBe(false));
  });

  it("reads only candidates: ordinary transactions and non-excluded loan payments trigger no read", async () => {
    const { result } = renderHook(
      () => useHistoricalPaymentFlags([txn({ id: "a", loanId: null }), txn({ id: "b", excludeFromCalculations: false }), txn({ id: "c", installmentPaymentId: null })], loans),
      { wrapper: wrapper() },
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(getByKey).not.toHaveBeenCalled();
    expect(result.current(txn({ loanId: null }))).toBe(false);
  });

  it("one read per payment however many transactions share it", async () => {
    paymentDocs.set("pay1", { recordedEarlier: { dateKnown: false } });
    const { result } = renderHook(() => useHistoricalPaymentFlags([txn({ id: "a" }), txn({ id: "b" })], loans), { wrapper: wrapper() });
    await waitFor(() => expect(result.current(txn({ id: "a" }))).toBe(true));
    expect(getByKey).toHaveBeenCalledTimes(1);
  });
});
