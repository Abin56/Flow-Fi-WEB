// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLedgerRows } from "@/features/people/lib/person-ledger-rows";
import { agreementPeople } from "@/features/loans/lib/agreement-people";
import { installmentTableRows } from "@/features/loans/lib/installment-table";
import { installmentBreakdown } from "@/lib/engines/installment-participants";
import { buildPersonCycleStatement, cycleContaining, type StatementInstallment, type StatementLoanSource } from "@/lib/engines/person-cycle-statement";
import type { Installment } from "@/lib/models/payment-schedule";
import type { LedgerEntry } from "@/lib/models/person";
import type { RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { DeferralContext, type DeferralContextValue } from "./payment-deferral";
import { RecordPaymentPanel } from "./record-payment-panel";

/**
 * People Ledger → Open Item (an EMI / Loan installment share) → Received → "Already in my account balance": the receipt is
 * written AGAINST THAT INSTALLMENT (derived route + its obligation key), never as a general payment — so Loan & EMI shows the
 * person's share as received while the lender installment (still unpaid, past due) stays Overdue. No account moves.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: [{ id: "sbi", name: "SBI", isDefault: true, deletedAt: null }] }) }));
vi.mock("./ledger-ui", async (orig) => {
  const actual = await orig<typeof import("./ledger-ui")>();
  const sbi = { id: "sbi", name: "SBI", type: "bank", currentBalance: 10_000_000, deletedAt: null };
  return { ...actual, useAccountChoice: () => ({ accounts: [sbi], accountId: "sbi", selected: sbi, setAccountId: () => {} }) };
});
vi.mock("@/hooks/use-categories", () => ({ useCategories: () => ({ data: [] }) }));
vi.mock("@/features/people/components/workspace/purpose-money", () => ({ usePurposeLinkOptions: () => [] }));
vi.mock("@/store/toast-store", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("./postpone-emi-handling", () => ({ EmiHandlingSection: () => null }));

const d = (month: number, day: number, year = 2026) => new Date(year, month - 1, day);
const NOW = d(2, 12);
const CYCLE = cycleContaining(NOW, 1);

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const loan = {
  id: "L1", name: "Bike loan", scheduleId: "sch", direction: "taken", personId: null, isClosed: false, deletedAt: null,
  ownershipShares: [{ personId: null, amount: 2000 }, { personId: "B", amount: 1000 }],
} as unknown as StatementLoanSource;
const inst = { id: "i1", scheduleId: "sch", sequenceNumber: 1, dueDate: d(2, 1), amountDue: 3000, amountPaid: 0, isSkipped: false, deletedAt: null, createdAt: d(1, 1) } as unknown as Installment & StatementInstallment;

const statementOf = (ledgerEntries: LedgerEntry[]) =>
  buildPersonCycleStatement({
    person: { id: "B", name: "Rahul", openingBalance: 0, createdAt: d(1, 1) },
    ledgerEntries, loanIds: new Set(), emis: [], loans: [loan], installments: [inst], cycle: { start: d(1, 1, 1970), end: CYCLE.end }, now: NOW,
  });

function openItemReceived() {
  const statement = statementOf([]);
  const rows = buildLedgerRows({ statement, history: statement, entries: [], pending: [], now: NOW, cashLegIds: new Set() });
  const onSubmit = vi.fn(async (_i: RecordPaymentInput, _id: string | null) => {});
  const value: DeferralContextValue = { byKey: new Map(), revisionByKey: new Map(), cycleStartDay: 1, personName: "Rahul", onApply: vi.fn(async () => "written" as const) };
  render(
    <DeferralContext.Provider value={value}>
      <RecordPaymentPanel personName="Rahul" rows={rows} preselectKey="loan-inst:i1" cycle={CYCLE} cycleLabel="Feb" onCancel={vi.fn()} onSubmit={onSubmit} cycleStartDay={1} />
    </DeferralContext.Provider>,
  );
  return { onSubmit };
}

describe("Received on an EMI/Loan Open Item → Already in my account", () => {
  it("is written against that installment (derived route, its key) — not as a general payment — with recordedEarlier", async () => {
    const { onSubmit } = openItemReceived();
    fireEvent.click(screen.getByRole("checkbox", { name: /already in my account balance/i }));
    const submit = screen.getAllByRole("button").find((b) => b.getAttribute("type") === "submit") as HTMLButtonElement;
    await act(async () => fireEvent.click(submit));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const input = onSubmit.mock.calls[0][0];
    expect(input).toMatchObject({ direction: "theyPaid", amount: 1000, recordedEarlier: true, extra: null });
    expect(input.lines).toEqual([{ key: "loan-inst:i1", amount: 1000, route: { kind: "derived", obligationRef: "loan-inst:i1", sourceKind: "loanInstallment" } }]);
  });

  it("the ledger entry that write makes marks the person's share Received while the lender installment stays Overdue", () => {
    const receipt = {
      id: "r1", personId: "B", type: "receivedBack", amount: 1000, date: d(2, 10), note: "", increasesBalance: true, transactionRef: "cash1", parentEntryId: null,
      obligationRef: "loan-inst:i1", sourceKind: "loanInstallment", recordedEarlier: true, createdAt: d(2, 10), receivedStatus: "received", deletedAt: null, lastEditedAt: null, editHistory: [],
    } as unknown as LedgerEntry;
    const before = installmentBreakdown({ statements: [statementOf([])], installments: [inst], installmentId: "i1", sourceKind: "loan", source: loan });
    expect(before?.participants[0].current).toMatchObject({ share: 1000, received: 0, remaining: 1000 });
    const after = installmentBreakdown({ statements: [statementOf([receipt])], installments: [inst], installmentId: "i1", sourceKind: "loan", source: loan });
    expect(after?.participants[0].current).toMatchObject({ share: 1000, received: 1000, remaining: 0 });
    expect(after?.participants[0].generalCredit).toBe(0);
    // Person side: Received. Lender side: untouched — still unpaid and past due.
    const [rahul] = agreementPeople({ participantsByInstallment: new Map([["i1", after!.participants]]), installments: [inst], deferralsByPerson: {}, startDay: 1 });
    expect(rahul.lines[0]).toMatchObject({ status: "received", received: 1000, bankPaid: false });
    const [row] = installmentTableRows({ installments: [inst], actions: [], closed: false, now: NOW });
    expect(row).toMatchObject({ status: "overdue", paid: 0, left: 3000 });
  });
});
