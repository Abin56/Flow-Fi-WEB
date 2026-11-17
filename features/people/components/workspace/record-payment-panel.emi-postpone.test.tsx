// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLedgerRows } from "@/features/people/lib/person-ledger-rows";
import { buildPersonCycleStatement, cycleContaining, type StatementInstallment, type StatementLoanSource } from "@/lib/engines/person-cycle-statement";
import { DeferralContext, type DeferralContextValue, type DeferralSubmit } from "./payment-deferral";
import { RecordPaymentPanel } from "./record-payment-panel";
import type { EmiHandle } from "./postpone-emi-handling";

/**
 * Record payment → "Not paid yet" on a person's Loan/EMI share, in the SHEET: the postponement and the bank-EMI step are one
 * confirm, in a fixed order — postpone first, then (only if chosen) the bank step. The bank step's own rules are pinned in
 * postpone-emi-panel.test.tsx; here the section is replaced by a stub so only the sheet's orchestration is under test.
 */

const h = vi.hoisted(() => ({ handle: null as null | { choice: "pay" | "paid" | "later"; blocker: string | null; action: string; run: () => Promise<void> } }));

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
// The real section reads Loan/EMI hooks — replaced by a stub that publishes whatever handle the test sets.
vi.mock("./postpone-emi-handling", async () => {
  const React = await import("react");
  return {
    EmiHandlingSection: ({ onHandle }: { onHandle: (hd: EmiHandle | null) => void }) => {
      React.useEffect(() => {
        onHandle(h.handle);
        return () => onHandle(null);
      }, [onHandle]);
      return <div data-testid="emi-handling-stub" />;
    },
  };
});

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
  h.handle = null;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const loan = {
  id: "L1", name: "Bike loan", scheduleId: "sch", direction: "taken", personId: null, isClosed: false, deletedAt: null,
  ownershipShares: [{ personId: null, amount: 20000 }, { personId: "B", amount: 20000 }, { personId: "C", amount: 20000 }],
} as unknown as StatementLoanSource;
const inst = { id: "i1", scheduleId: "sch", sequenceNumber: 1, dueDate: d(2, 10), amountDue: 3000, amountPaid: 0, isSkipped: false, deletedAt: null, createdAt: d(1, 1) } as StatementInstallment & { amountDue: number };

function setup(onApply: DeferralContextValue["onApply"]) {
  const statement = buildPersonCycleStatement({
    person: { id: "B", name: "Rahul", openingBalance: 0, createdAt: d(1, 1) },
    ledgerEntries: [], loanIds: new Set(), emis: [], loans: [loan], installments: [inst], cycle: { start: d(1, 1, 1970), end: CYCLE.end }, now: NOW,
  });
  const rows = buildLedgerRows({ statement, history: statement, entries: [], pending: [], now: NOW, cashLegIds: new Set() });
  const value: DeferralContextValue = { byKey: new Map(), revisionByKey: new Map(), cycleStartDay: 1, personName: "Rahul", onApply };
  const onCancel = vi.fn();
  const onSubmit = vi.fn(async () => {});
  render(
    <DeferralContext.Provider value={value}>
      <RecordPaymentPanel personName="Rahul" rows={rows} preselectKey="loan-inst:i1" initialIntent="postpone" cycle={CYCLE} cycleLabel="Feb" onCancel={onCancel} onSubmit={onSubmit} onSetReminder={vi.fn(async () => {})} cycleStartDay={1} />
    </DeferralContext.Provider>,
  );
  return { onCancel, onSubmit };
}

const confirm = () => screen.getAllByRole("button").find((b) => b.getAttribute("type") === "submit") as HTMLButtonElement;

describe("Record payment → Not paid yet on a Loan/EMI share (sheet)", () => {
  it("shows 'What about this EMI?' for the single installment share, and 'Pay later' writes nothing for the bank", async () => {
    const run = vi.fn(async () => {});
    h.handle = { choice: "later", blocker: null, action: "", run };
    const onApply = vi.fn(async (_r: DeferralSubmit) => "written" as const);
    const { onCancel, onSubmit } = setup(onApply);
    expect(screen.getByTestId("emi-handling-stub")).toBeTruthy();
    expect(confirm().textContent).toMatch(/^Postpone ₹1,000/);
    await act(async () => fireEvent.click(confirm()));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled(); // never a People payment write
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("a chosen bank step runs AFTER the postponement saved, in the same confirm — and the button says so", async () => {
    const order: string[] = [];
    h.handle = { choice: "pay", blocker: null, action: "pay ₹3,000", run: vi.fn(async () => void order.push("bank")) };
    const onApply = vi.fn(async (_r: DeferralSubmit) => (order.push("postponed"), "written" as const));
    const { onCancel } = setup(onApply);
    expect(confirm().textContent).toBe("Postpone & pay ₹3,000");
    await act(async () => fireEvent.click(confirm()));
    expect(order).toEqual(["postponed", "bank"]);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("an unmet requirement (e.g. no account) disables confirm and says what is still needed — nothing is written", () => {
    h.handle = { choice: "pay", blocker: "Choose account", action: "pay ₹3,000", run: vi.fn(async () => {}) };
    const onApply = vi.fn(async () => "written" as const);
    setup(onApply);
    expect(confirm().disabled).toBe(true);
    expect(screen.getByTestId("emi-still-needed").textContent).toBe("Still needed: Choose account");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("a postponement that fails never runs the bank step", async () => {
    const run = vi.fn(async () => {});
    h.handle = { choice: "pay", blocker: null, action: "pay ₹3,000", run };
    const { onCancel } = setup(vi.fn(async () => Promise.reject(new Error("changed elsewhere"))));
    await act(async () => fireEvent.click(confirm()));
    expect(run).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("changed elsewhere");
  });

  it("the bank step fails after the postponement saved: stays open, says so, and the retry runs ONLY the bank step", async () => {
    const run = vi.fn(async () => {});
    run.mockRejectedValueOnce(new Error("Network error"));
    h.handle = { choice: "pay", blocker: null, action: "pay ₹3,000", run };
    const onApply = vi.fn(async (_r: DeferralSubmit) => "written" as const);
    const { onCancel } = setup(onApply);
    await act(async () => fireEvent.click(confirm()));
    expect(screen.getByRole("alert").textContent).toBe("Postponed, but the EMI step wasn't saved: Network error");
    expect(onCancel).not.toHaveBeenCalled();
    expect(confirm().textContent).toBe("Retry: pay ₹3,000");
    expect(confirm().disabled).toBe(false);

    await act(async () => fireEvent.click(confirm()));
    expect(onApply).toHaveBeenCalledTimes(1); // never postponed twice
    expect(run).toHaveBeenCalledTimes(2);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
