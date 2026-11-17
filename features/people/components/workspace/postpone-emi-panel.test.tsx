// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLedgerRows, type LedgerRow } from "@/features/people/lib/person-ledger-rows";
import { buildPersonCycleStatement, type StatementInstallment, type StatementLoanSource } from "@/lib/engines/person-cycle-statement";
import { RECORDED_EARLIER_PEOPLE_ACK } from "@/lib/engines/recorded-earlier";
import { bankEmiState, PostponeEmiPanel } from "./postpone-emi-panel";
import { DeferralContext, type DeferralContextValue, type DeferralSubmit } from "./payment-deferral";

/**
 * "Postpone payment" on a person's Loan-EMI share is ONE panel: the person's cycle (its date is derived, no picker), then —
 * revealed in the same panel — what happens to the BANK EMI. These tests pin the promises: "Pay later" is the default and
 * writes nothing for the bank; the bank is written only AFTER the postponement saved, only when chosen, through the existing
 * Loan write (funds re-checked, one idempotency key across retries); and a failure of either step says exactly what saved.
 */

const h = vi.hoisted(() => ({
  installments: [] as unknown[],
  loanRows: [] as unknown[],
  recordPayment: vi.fn(async (..._args: unknown[]) => ({})),
  accounts: [] as unknown[],
}));
vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: async () => undefined }) }));
vi.mock("@/hooks/use-emis", () => ({ useAllEmiInstallments: () => ({ data: [] }) }));
vi.mock("@/hooks/use-loans", () => ({ useAllLoanInstallments: () => ({ data: h.installments }) }));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: h.accounts }) }));
vi.mock("@/hooks/use-transactions", () => ({ useTransactions: () => ({ data: [] }) }));
vi.mock("@/features/emi/hooks/use-emi-data", () => ({ useEmiRows: () => ({ rows: [] }), useEmiActions: () => ({ recordPayment: vi.fn() }) }));
vi.mock("@/features/loans/hooks/use-loans-data", () => ({ useLoanRows: () => ({ rows: h.loanRows }), useLoanActions: () => ({ recordPayment: h.recordPayment }) }));
vi.mock("@/features/people/hooks/use-linked-people-readiness", () => ({ useLinkedPeopleReadiness: () => ({ readiness: null, isLoading: false }) }));
vi.mock("@/features/loans/lib/record-payment", async (orig) => ({
  ...(await orig<typeof import("@/features/loans/lib/record-payment")>()),
  loanPaymentFigures: () => ({ next: null, dueAmount: 3000, dueCount: 1, totalRemaining: 3000, payableCount: 1 }),
  planLoanPayment: () => ({ ok: true, amount: 3000, includeUpcomingInstallments: false, extra: 0 }),
}));
vi.mock("@/lib/engines/loan-payment-core", () => ({ planLoanPaymentCore: () => ({ installmentIds: ["i1"], overflow: 0, payments: [{ installmentId: "i1" }] }) }));
// The Radix account picker is not what is under test — a native select with the same contract.
vi.mock("@/components/finance/account-label", () => ({
  AccountSelect: ({ accounts, value, onChange, ariaLabel }: { accounts: { id: string; name: string }[]; value: string; onChange: (v: string) => void; ariaLabel?: string }) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  ),
  AccountMark: () => null,
}));

const d = (month: number, day: number, year = 2026) => new Date(year, month - 1, day);
const NOW = d(2, 12); // the bank EMI fell due on 10 Feb — two days ago
const ALL = { start: d(1, 1, 1970), end: d(12, 31, 2200) };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.recordPayment.mockReset();
  h.recordPayment.mockImplementation(async () => ({}));
  h.accounts = [
    { id: "hdfc", name: "HDFC", type: "bank", deletedAt: null, currentBalance: 10000 },
    { id: "low", name: "Low", type: "bank", deletedAt: null, currentBalance: 1000 },
    { id: "cc", name: "Card", type: "card", deletedAt: null, currentBalance: 0 },
  ];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const loan = {
  id: "L1", name: "Bike loan", scheduleId: "sch", direction: "taken", personId: null, isClosed: false, deletedAt: null,
  ownershipShares: [{ personId: null, amount: 20000 }, { personId: "B", amount: 20000 }, { personId: "C", amount: 20000 }],
} as unknown as StatementLoanSource;
const inst = (amountPaid = 0) => ({ id: "i1", scheduleId: "sch", sequenceNumber: 1, dueDate: d(2, 10), amountDue: 3000, amountPaid, isSkipped: false, deletedAt: null, createdAt: d(1, 1) }) as StatementInstallment & { amountDue: number };

function shareRow(): LedgerRow {
  const statement = buildPersonCycleStatement({
    person: { id: "B", name: "Rahul", openingBalance: 0, createdAt: d(1, 1) },
    ledgerEntries: [], loanIds: new Set(), emis: [], loans: [loan], installments: [inst()], cycle: ALL, now: NOW,
  });
  const rows = buildLedgerRows({ statement, history: statement, entries: [], pending: [], now: NOW, cashLegIds: new Set() });
  return rows.find((r) => r.key === "loan-inst:i1")!;
}

function setBank(amountPaid: number) {
  h.installments = [inst(amountPaid)];
  h.loanRows = [{ installments: [inst(amountPaid)], loan }];
}

function ctx(onApply: DeferralContextValue["onApply"]): DeferralContextValue {
  return { byKey: new Map(), revisionByKey: new Map(), cycleStartDay: 1, personName: "Rahul", onApply };
}

function renderPanel(onApply: DeferralContextValue["onApply"], onDone = vi.fn()) {
  const row = shareRow();
  render(
    <DeferralContext.Provider value={ctx(onApply)}>
      <PostponeEmiPanel row={row} title="Bike loan" onDone={onDone} />
    </DeferralContext.Provider>,
  );
  return { row, onDone };
}

const confirm = () => screen.getByTestId("postpone-emi-confirm") as HTMLButtonElement;

describe("bankEmiState — the bank side, independent of the person", () => {
  const base = { amountDue: 5000, isSkipped: false };
  it("paid / part paid / overdue / due today / not due yet", () => {
    expect(bankEmiState({ ...base, amountPaid: 5000, dueDate: d(2, 1) }, NOW)).toMatchObject({ kind: "paid", remaining: 0 });
    expect(bankEmiState({ ...base, amountPaid: 2000, dueDate: d(2, 1) }, NOW)).toMatchObject({ kind: "partial", remaining: 3000 });
    expect(bankEmiState({ ...base, amountPaid: 0, dueDate: d(2, 10) }, NOW)).toMatchObject({ kind: "overdue", daysOverdue: 2, label: "Unpaid · overdue by 2 days" });
    expect(bankEmiState({ ...base, amountPaid: 0, dueDate: d(2, 12) }, NOW)).toMatchObject({ kind: "due", label: "Unpaid · due today" });
    expect(bankEmiState({ ...base, amountPaid: 0, dueDate: d(3, 1) }, NOW)).toMatchObject({ kind: "upcoming", label: "Unpaid · not due yet" });
  });
});

describe("PostponeEmiPanel — one panel: the person's cycle, then (revealed) the bank EMI", () => {
  it("shows the cycle with its derived date and the bank EMI side by side — no date picker, 'Pay later' preselected", () => {
    setBank(0);
    renderPanel(vi.fn(async () => "written" as const));
    expect(screen.getByTestId("postpone-heading").textContent).toBe("Rahul · ₹1,000 pending");
    expect(screen.queryByLabelText("Postpone until date")).toBeNull();
    expect(screen.getByTestId("postpone-preview").textContent).toMatch(/Selected .*Expected from \d\d \w{3}/);
    const bank = screen.getByTestId("emi-handling").textContent!;
    expect(bank).toContain("What about this EMI?");
    expect(bank).toContain("₹3,000");
    expect(bank).toContain("due 10 Feb");
    expect(screen.getByTestId("emi-bank-state").textContent).toBe("Overdue 2d");
    expect(screen.getByTestId("emi-handling-pending").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("emi-handling-payNow").getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByTestId("emi-pay-fields")).toBeNull(); // nothing expanded until chosen
  });

  it("Pay later: one postponement request, NOTHING written for the bank", async () => {
    setBank(0);
    const onApply = vi.fn(async (_r: DeferralSubmit) => "written" as const);
    const { onDone } = renderPanel(onApply);
    await act(async () => fireEvent.click(confirm()));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toMatchObject({ action: "postpone", obligationKey: "loan-inst:i1", remaining: 1000, targetDate: null });
    expect(h.recordPayment).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  it("a custom date is a secondary option and travels as targetDate", async () => {
    setBank(0);
    const onApply = vi.fn(async (_r: DeferralSubmit) => "written" as const);
    renderPanel(onApply);
    fireEvent.click(screen.getByRole("button", { name: "Custom date" }));
    fireEvent.change(screen.getByLabelText("Postpone until date"), { target: { value: "25/02/2026" } });
    await act(async () => fireEvent.click(confirm()));
    expect((onApply.mock.calls[0][0] as { targetDate: Date }).targetDate).toEqual(d(2, 25));
    expect(h.recordPayment).not.toHaveBeenCalled();
  });

  it("Pay from my account: account → balance, EMI, balance after; blocked until chosen; postpones FIRST, then pays once with funds re-checked", async () => {
    setBank(0);
    const calls: string[] = [];
    const onApply = vi.fn(async (_r: DeferralSubmit) => (calls.push("postponed"), "written" as const));
    h.recordPayment.mockImplementation(async () => (calls.push("paid"), {}));
    renderPanel(onApply);
    fireEvent.click(screen.getByTestId("emi-handling-payNow"));
    expect(confirm().disabled).toBe(true);
    expect(screen.getByTestId("emi-still-needed").textContent).toBe("Still needed: Choose account");
    fireEvent.change(screen.getByLabelText("Pay the EMI from account"), { target: { value: "hdfc" } });
    const summary = screen.getByTestId("payment-source-summary").textContent!;
    expect(summary).toContain("HDFC");
    expect(summary).toContain("₹10,000"); // balance
    expect(summary).toContain("₹3,000"); // the EMI
    expect(screen.getByTestId("payment-source-after").textContent).toBe("₹7,000"); // projected balance
    expect(confirm().textContent).toBe("Postpone & pay ₹3,000");
    expect(screen.queryByRole("option", { name: "Card" })).toBeNull(); // a credit card is never offered as the paying account

    await act(async () => fireEvent.click(confirm()));
    expect(calls).toEqual(["postponed", "paid"]);
    expect(h.recordPayment).toHaveBeenCalledTimes(1);
    expect(h.recordPayment.mock.calls[0][2]).toMatchObject({ accountId: "hdfc", amount: 3000, enforceFunds: true, recordedEarlier: null, linkedTransactionId: null, expectedAllocation: { installmentIds: ["i1"], overflow: 0 } });
  });

  it("an account that can't cover the EMI blocks confirming — nothing is written at all", () => {
    setBank(0);
    const onApply = vi.fn(async () => "written" as const);
    renderPanel(onApply);
    fireEvent.click(screen.getByTestId("emi-handling-payNow"));
    fireEvent.change(screen.getByLabelText("Pay the EMI from account"), { target: { value: "low" } });
    expect(screen.getByTestId("emi-still-needed").textContent).toBe("Still needed: Not enough balance");
    expect(confirm().disabled).toBe(true);
    expect(onApply).not.toHaveBeenCalled();
    expect(h.recordPayment).not.toHaveBeenCalled();
  });

  it("a failed postponement never pays the bank", async () => {
    setBank(0);
    renderPanel(vi.fn(async () => Promise.reject(new Error("This payment's timing was just changed elsewhere"))));
    fireEvent.click(screen.getByTestId("emi-handling-payNow"));
    fireEvent.change(screen.getByLabelText("Pay the EMI from account"), { target: { value: "hdfc" } });
    await act(async () => fireEvent.click(confirm()));
    expect(h.recordPayment).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("just changed elsewhere");
  });

  it("the bank step fails after the postponement saved: says so, and the retry pays only the EMI, with the SAME idempotency key", async () => {
    setBank(0);
    const onApply = vi.fn(async (_r: DeferralSubmit) => "written" as const);
    const { onDone } = renderPanel(onApply);
    fireEvent.click(screen.getByTestId("emi-handling-payNow"));
    fireEvent.change(screen.getByLabelText("Pay the EMI from account"), { target: { value: "hdfc" } });
    h.recordPayment.mockRejectedValueOnce(new Error("Network error"));
    await act(async () => fireEvent.click(confirm()));
    expect(screen.getByRole("alert").textContent).toContain("Postponed, but the EMI step wasn't saved");
    expect(onDone).not.toHaveBeenCalled();
    expect(confirm().textContent).toBe("Retry: pay ₹3,000");

    await act(async () => fireEvent.click(confirm()));
    expect(onApply).toHaveBeenCalledTimes(1); // never postponed twice
    expect(h.recordPayment).toHaveBeenCalledTimes(2);
    const keys = h.recordPayment.mock.calls.map((c) => (c[2] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(onDone).toHaveBeenCalled();
  });

  it("Already paid: a date (no future), no balance change — recorded as an earlier payment of exactly this installment", async () => {
    setBank(0);
    const onApply = vi.fn(async (_r: DeferralSubmit) => "written" as const);
    renderPanel(onApply);
    fireEvent.click(screen.getByTestId("emi-handling-paidEarlier"));
    expect(screen.getByTestId("emi-paid-fields").textContent).toContain("No balance changes");
    // A Loan's past payment names an account only as its record's anchor.
    expect(screen.getByTestId("emi-still-needed").textContent).toBe("Still needed: Choose account");
    fireEvent.change(screen.getByLabelText("Account the EMI was paid from"), { target: { value: "hdfc" } });
    fireEvent.change(screen.getByLabelText("Date paid"), { target: { value: "11/02/2026" } });
    expect(confirm().textContent).toBe("Postpone & mark EMI paid");
    await act(async () => fireEvent.click(confirm()));
    expect(h.recordPayment).toHaveBeenCalledTimes(1);
    expect(h.recordPayment.mock.calls[0][2]).toMatchObject({
      accountId: "hdfc",
      amount: 3000,
      enforceFunds: false,
      recordedEarlier: { dateKnown: true },
      peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK,
      onlyInstallmentId: "i1",
    });
    expect((h.recordPayment.mock.calls[0][2] as { linkedTransactionId?: string }).linkedTransactionId).toBeUndefined();
    expect((h.recordPayment.mock.calls[0][2] as { date: Date }).date.getDate()).toBe(11);
  });

  it("the bank EMI is already paid: no options are offered and nothing is written for the bank", async () => {
    setBank(3000);
    const onApply = vi.fn(async () => "written" as const);
    renderPanel(onApply);
    expect(screen.getByTestId("emi-handling-paid")).toBeTruthy();
    expect(screen.queryByTestId("emi-handling-payNow")).toBeNull();
    await act(async () => fireEvent.click(confirm()));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(h.recordPayment).not.toHaveBeenCalled();
  });
});
