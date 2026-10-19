// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLedgerRows, type LedgerRow } from "@/features/people/lib/person-ledger-rows";
import { buildPersonCycleStatement, cycleContaining } from "@/lib/engines/person-cycle-statement";
import type { LedgerEntry, LedgerEntryType } from "@/lib/models/person";
import type { RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { DeferralContext, type DeferralContextValue } from "./payment-deferral";
import { RecordPaymentPanel } from "./record-payment-panel";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: [{ id: "sbi", name: "SBI", isDefault: true, deletedAt: null }] }) }));
// These tests are about allocation, not the account step: SBI is chosen up front. Choosing the paying account
// explicitly (never a default) is covered in record-payment-panel.account.test.tsx.
vi.mock("./ledger-ui", async (orig) => {
  const actual = await orig<typeof import("./ledger-ui")>();
  const sbi = { id: "sbi", name: "SBI", type: "bank", currentBalance: 10_000_000, deletedAt: null };
  return { ...actual, useAccountChoice: () => ({ accounts: [sbi], accountId: "sbi", selected: sbi, setAccountId: () => {} }) };
});
vi.mock("@/hooks/use-categories", () => ({ useCategories: () => ({ data: [{ id: "gift", name: "Gift", type: "income", deletedAt: null }] }) }));
vi.mock("@/features/people/components/workspace/purpose-money", () => ({ usePurposeLinkOptions: () => [] }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("@/store/toast-store", () => ({ toast: toasts }));

const d = (month: number, day: number, year = 2026) => new Date(year, month - 1, day);
const NOW = d(10, 12);
const SD = 18;
const CYCLE = cycleContaining(NOW, SD); // 18 Sep – 17 Oct 2026

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
beforeEach(() => {
  Object.values(toasts).forEach((t) => t.mockClear());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function entry(id: string, type: LedgerEntryType, amount: number, date: Date, patch: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id,
    personId: "A",
    type,
    amount,
    date,
    note: "",
    increasesBalance: true,
    transactionRef: null,
    parentEntryId: null,
    createdAt: date,
    receivedStatus: "yetToReceive",
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...patch,
  };
}

function rowsFor(entries: LedgerEntry[]): LedgerRow[] {
  const statement = buildPersonCycleStatement({
    person: { id: "A", name: "SHAMBU", openingBalance: 0, createdAt: d(1, 1) },
    ledgerEntries: entries,
    loanIds: new Set(),
    emis: [],
    loans: [],
    installments: [],
    cycle: { start: d(1, 1, 1970), end: CYCLE.end },
    now: NOW,
  });
  return buildLedgerRows({ statement, history: statement, entries, pending: [], now: NOW, cashLegIds: new Set() });
}

const lent = entry("lent", "gave", 375, d(10, 5), { note: "Movie tickets" });

function ctx(patch: Partial<DeferralContextValue> = {}): DeferralContextValue {
  return { byKey: new Map(), revisionByKey: new Map(), cycleStartDay: SD, personName: "SHAMBU", onApply: vi.fn(async () => "written" as const), ...patch };
}

const primary = () => screen.getAllByRole("button").find((b) => b.getAttribute("type") === "submit")!;

/**
 * Record payment — "Already in my account balance": money SHAMBU paid before FlowFi tracked it. It settles what
 * they owe through the same payment write with `recordedEarlier` (the repository excludes the cash leg, so no
 * account moves). Money received only, settlement lines only, never future-dated — the UI mirrors those rules.
 * Also: a held advance is offered (Apply advance) before any new receipt, and "Postpone collection" can be opened directly.
 */

function setupWith(props: Partial<React.ComponentProps<typeof RecordPaymentPanel>> = {}) {
  const rows = rowsFor([lent]);
  const onSubmit = vi.fn(async (_i: RecordPaymentInput, _id: string | null) => {});
  render(
    <DeferralContext.Provider value={ctx()}>
      <RecordPaymentPanel
        personName="SHAMBU"
        rows={rows}
        preselectKey="ledger:lent"
        cycle={CYCLE}
        cycleLabel="18 Sep – 17 Oct 2026"
        onCancel={vi.fn()}
        onSubmit={onSubmit}
        cycleStartDay={SD}
        {...props}
      />
    </DeferralContext.Provider>,
  );
  return { onSubmit };
}
const inBalance = () => screen.getByRole("checkbox", { name: /already in my account balance/i });

describe("Already in my account balance (received before FlowFi)", () => {
  it("settles what they owe with recordedEarlier — the footer and the note say no account changes", async () => {
    const { onSubmit } = setupWith();
    expect(primary().textContent).toBe("Record ₹375 received");
    fireEvent.click(inBalance());
    expect(screen.getByText("Received into · for your records")).toBeTruthy();
    expect(screen.getByTestId("rp-in-balance-effect").textContent).toContain("no account changes");
    expect(primary().textContent).toBe("Record ₹375 received earlier");
    await act(async () => fireEvent.click(primary()));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const input = onSubmit.mock.calls[0][0];
    expect(input).toMatchObject({ direction: "theyPaid", amount: 375, accountId: "sbi", recordedEarlier: true, extra: null });
    expect(input.lines).toHaveLength(1);
    expect("dateKnown" in input).toBe(false);
  });

  it("date not known → stored on the item's own date (never later than today), flagged not known", async () => {
    const { onSubmit } = setupWith();
    fireEvent.click(inBalance());
    fireEvent.click(screen.getByRole("checkbox", { name: /don't know the exact date/i }));
    await act(async () => fireEvent.click(primary()));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ recordedEarlier: true, dateKnown: false, date: d(10, 5) });
  });

  it("more than they owe can't be 'already in the balance' (no advance / income from it) — blocked, nothing sent", async () => {
    const { onSubmit } = setupWith();
    fireEvent.click(inBalance());
    fireEvent.change(screen.getByLabelText(/amount received/i), { target: { value: "500" } });
    expect(screen.getByTestId("rp-blocker").textContent).toContain("can only settle what SHAMBU owes");
    expect((primary() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fireEvent.click(primary()));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("is offered for money received only — not when paying the person", () => {
    setupWith();
    fireEvent.click(screen.getByRole("radio", { name: /money paid to SHAMBU/i }));
    expect(screen.queryByRole("checkbox", { name: /already in my account balance/i })).toBeNull();
  });
});

describe("Held advance and direct Postpone", () => {
  it("a held advance is offered first: 'Apply advance instead' (no new money); nothing is recorded", async () => {
    const onApplyAdvance = vi.fn();
    const { onSubmit } = setupWith({ advanceHeld: 300, onApplyAdvance });
    expect(screen.getByTestId("rp-advance-held").textContent).toContain("SHAMBU already gave you ₹300");
    fireEvent.click(screen.getByRole("button", { name: "Apply advance instead" }));
    expect(onApplyAdvance).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("no advance held → no notice", () => {
    setupWith({ advanceHeld: 0, onApplyAdvance: vi.fn() });
    expect(screen.queryByTestId("rp-advance-held")).toBeNull();
  });

  it("opened with intent=postpone: titled 'Postpone collection', the no-money path is selected", () => {
    setupWith({ initialIntent: "postpone" });
    expect(screen.getByText("Postpone collection")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /not paid yet — postpone collection/i }).getAttribute("aria-checked")).toBe("true");
  });
});
