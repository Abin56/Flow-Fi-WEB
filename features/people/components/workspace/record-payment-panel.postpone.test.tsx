// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLedgerRows, type LedgerRow } from "@/features/people/lib/person-ledger-rows";
import { buildPersonCycleStatement, cycleContaining } from "@/lib/engines/person-cycle-statement";
import { deferralView, planDeferralWrite, STALE_MESSAGE } from "@/lib/engines/person-payment-deferral";
import type { LedgerEntry, LedgerEntryType } from "@/lib/models/person";
import type { RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { DeferralContext, type DeferralContextValue, type DeferralSubmit } from "./payment-deferral";
import { RecordPaymentPanel } from "./record-payment-panel";

/**
 * Record payment — "Money received" vs "Hasn't paid yet". SHAMBU owes ₹375 (a REAL ledger row). A no-money
 * postponement must go through the existing deferral write only — never `onSubmit` (the payment write that
 * moves an account and creates receipts / advance / income). Real received payments keep today's allocation.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: [{ id: "sbi", name: "SBI", isDefault: true, deletedAt: null }] }) }));
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

function setup({ entries = [lent], value = ctx(), preselectKey = "ledger:lent" as string | null, withContext = true } = {}) {
  const rows = rowsFor(entries);
  const onSubmit = vi.fn(async (_i: RecordPaymentInput, _id: string | null) => {});
  const onCancel = vi.fn();
  const onSetReminder = vi.fn(async () => {});
  const panel = (
    <RecordPaymentPanel
      personName="SHAMBU"
      rows={rows}
      preselectKey={preselectKey}
      cycle={CYCLE}
      cycleLabel="18 Sep – 17 Oct 2026"
      onCancel={onCancel}
      onSubmit={onSubmit}
      onSetReminder={onSetReminder}
      cycleStartDay={SD}
    />
  );
  render(withContext ? <DeferralContext.Provider value={value}>{panel}</DeferralContext.Provider> : panel);
  return { onSubmit, onCancel, onSetReminder, value };
}

const primary = () => screen.getAllByRole("button").find((b) => b.getAttribute("type") === "submit")!;
const hasntPaid = () => screen.getByRole("radio", { name: /hasn't paid yet/i });

describe("No money received — postpone (case 1, 7, 8, 9, 12)", () => {
  it("₹375 owed, ₹0 received, Next cycle → one deferral request; no payment, account, advance or income", async () => {
    let release!: () => void;
    const onApply = vi.fn((_r: DeferralSubmit) => new Promise<"written">((r) => (release = () => r("written"))));
    const { onSubmit, onCancel } = setup({ value: ctx({ onApply }) });

    // Default stays "Money received" with the row's ₹375 prefilled — the old trap is still a real payment.
    expect(primary().textContent).toBe("Record ₹375 received");
    fireEvent.click(hasntPaid());

    // The no-money path hides every money field.
    expect(screen.queryByLabelText(/amount received/i)).toBeNull();
    expect(screen.queryByText(/receive into account/i)).toBeNull();
    expect(screen.queryByText(/settle nothing now/i)).toBeNull();
    expect(screen.queryByText(/what should happen to this money/i)).toBeNull();
    expect(screen.queryByText(/advance/i)).toBeNull();

    expect(screen.getByRole("radio", { name: /next cycle · nov/i }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("postpone-preview").textContent).toBe(
      "₹375 will remain unpaid and will be expected in the Nov cycle (18 Oct – 17 Nov 2026). No money will be recorded and your balances will not change.",
    );
    expect(screen.getByTestId("rp-hero-amount").textContent).toBe("₹0");
    expect(screen.getByText("No money recorded")).toBeTruthy();
    expect(primary().textContent).toBe("Postpone ₹375");

    fireEvent.click(primary());
    fireEvent.click(primary()); // repeated submit while in flight
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toMatchObject({
      action: "postpone",
      obligationKey: "ledger:lent",
      expectedRevision: 0,
      remaining: 375,
      reminder: null,
      target: { start: d(10, 18), end: d(11, 17) },
    });
    await act(async () => release());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1); // closes on success
  });

  it("with a reminder at the cycle start: the reminder travels with the deferral (still no payment)", async () => {
    const { onSubmit, onSetReminder, value } = setup();
    fireEvent.click(hasntPaid());
    fireEvent.click(screen.getByRole("radio", { name: /when the cycle starts/i }));
    await act(async () => fireEvent.click(primary()));
    expect(value.onApply).toHaveBeenCalledWith(expect.objectContaining({ reminder: { kind: "nextCycle", remindOn: d(10, 18) } }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onSetReminder).not.toHaveBeenCalled();
  });

  it("Enter in a field never records a payment while postponing", async () => {
    const { onSubmit, value } = setup();
    fireEvent.click(hasntPaid());
    fireEvent.click(screen.getByRole("radio", { name: "Other" }));
    const note = screen.getByLabelText("Reason note");
    await act(async () => fireEvent.submit(note.closest("form")!));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(value.onApply).toHaveBeenCalledTimes(1);
  });

  it("a conflict (another tab moved it) is shown; the panel stays open and nothing is recorded", async () => {
    const { onSubmit, onCancel } = setup({ value: ctx({ onApply: vi.fn(async () => Promise.reject(new Error(STALE_MESSAGE))) }) });
    fireEvent.click(hasntPaid());
    await act(async () => fireEvent.click(primary()));
    expect(screen.getByRole("alert").textContent).toBe(STALE_MESSAGE);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(primary().textContent).toBe("Postpone ₹375");
  });

  it("repeated postpone: an already postponed item moves one cycle further, with its stored revision", async () => {
    const plan = planDeferralWrite(null, null, {
      action: "postpone", requestId: "x", expectedRevision: 0, personId: "A", obligationKey: "ledger:lent", obligationTitle: "Movie tickets",
      now: NOW, startDay: SD, obligationDate: d(10, 5), remaining: 375, target: cycleContaining(d(11, 1), SD), reason: null, note: null, reminder: null,
    });
    if (plan.kind !== "write") throw new Error(plan.kind);
    const value = ctx({ byKey: new Map([["ledger:lent", deferralView(plan.deferral, 375, SD, NOW)!]]), revisionByKey: new Map([["ledger:lent", 1]]) });
    setup({ value });
    fireEvent.click(hasntPaid());
    expect(screen.getByRole("radio", { name: "Dec cycle" }).getAttribute("aria-checked")).toBe("true");
    await act(async () => fireEvent.click(primary()));
    expect(value.onApply).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 1, target: { start: d(11, 18), end: d(12, 17) } }));
  });

  it("several open items: each is postponed once, and an unticked one is left alone", async () => {
    const other = entry("lunch", "gave", 125, d(10, 7), { note: "Lunch" });
    const { value } = setup({ entries: [lent, other], preselectKey: null });
    fireEvent.click(hasntPaid());
    expect(primary().textContent).toBe("Postpone ₹500");
    fireEvent.click(screen.getByRole("checkbox", { name: /lunch/i }));
    expect(primary().textContent).toBe("Postpone ₹375");
    await act(async () => fireEvent.click(primary()));
    expect(value.onApply).toHaveBeenCalledTimes(1);
    expect(value.onApply).toHaveBeenCalledWith(expect.objectContaining({ obligationKey: "ledger:lent" }));
  });

  it("several items, one fails: an honest summary names it, and Retry re-sends only that one with the same request id", async () => {
    const lunch = entry("lunch", "gave", 125, d(10, 7), { note: "Lunch" });
    const taxi = entry("taxi", "gave", 60, d(10, 8), { note: "Taxi" });
    let failLunch = true;
    const onApply = vi.fn(async (r: DeferralSubmit) => {
      if (r.obligationKey === "ledger:lunch" && failLunch) throw new Error(STALE_MESSAGE);
      return "written" as const;
    });
    const { onSubmit, onCancel } = setup({ entries: [lent, lunch, taxi], preselectKey: null, value: ctx({ onApply }) });
    fireEvent.click(hasntPaid());
    expect(primary().textContent).toBe("Postpone ₹560");
    await act(async () => fireEvent.click(primary()));
    expect(onApply).toHaveBeenCalledTimes(3); // a failure doesn't stop the others
    // Each save is silent; one consolidated notification names the failure.
    expect(onApply.mock.calls.every((c) => (c as unknown[])[1] && ((c as unknown[])[1] as { silent?: boolean }).silent === true)).toBe(true);
    expect(toasts.success).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.error).toHaveBeenCalledWith("2 payments postponed · 1 failed.", "Not postponed: Lunch. Retry from the panel.");
    expect(screen.getByRole("alert").textContent).toBe("2 payments postponed · 1 could not be postponed");
    expect(within(screen.getByRole("list", { name: "Not postponed" })).getByText("Lunch")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /movie tickets/i }) as HTMLInputElement).disabled).toBe(true);
    expect(primary().textContent).toBe("Retry ₹125");
    expect(onCancel).not.toHaveBeenCalled();

    const firstId = onApply.mock.calls.find((c) => c[0].obligationKey === "ledger:lunch")![0].requestId;
    failLunch = false;
    await act(async () => fireEvent.click(primary()));
    expect(onApply).toHaveBeenCalledTimes(4);
    expect(onApply.mock.calls[3][0]).toMatchObject({ obligationKey: "ledger:lunch", requestId: firstId });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(toasts.success).toHaveBeenCalledTimes(1);
    expect(toasts.success.mock.calls[0][0]).toBe("3 payments postponed successfully."); // the whole operation, after the retry
  });

  it("not offered when paying the person, when editing, or outside a ledger (no deferral context)", () => {
    setup({ entries: [entry("b", "borrowed", 300, d(10, 3))], preselectKey: null });
    expect(screen.queryByRole("radio", { name: /hasn't paid yet/i })).toBeNull();
    cleanup();
    setup({ withContext: false });
    expect(screen.queryByRole("radio", { name: /hasn't paid yet/i })).toBeNull();
  });
});

describe("Money received — existing allocation preserved (cases 2–6, 10)", () => {
  const amountField = () => screen.getByLabelText(/amount received/i);

  it("₹375 received and settled: one payment, no extra", async () => {
    const { onSubmit, value } = setup();
    await act(async () => fireEvent.click(primary()));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ direction: "theyPaid", amount: 375, accountId: "sbi", extra: null });
    expect(value.onApply).not.toHaveBeenCalled();
  });

  it("₹100 received: ₹100 settled, ₹275 still owed", async () => {
    const { onSubmit } = setup();
    fireEvent.change(amountField(), { target: { value: "100" } });
    expect(screen.getByTestId("rp-still-owed").textContent).toBe("₹275");
    await act(async () => fireEvent.click(primary()));
    const input = onSubmit.mock.calls[0][0];
    expect(input).toMatchObject({ amount: 100, extra: null });
    expect(input.lines.reduce((t, l) => t + l.amount, 0)).toBe(100);
  });

  it("₹500 received: ₹375 settled, ₹125 kept as advance", async () => {
    const { onSubmit } = setup();
    fireEvent.change(amountField(), { target: { value: "500" } });
    await act(async () => fireEvent.click(primary()));
    const input = onSubmit.mock.calls[0][0];
    expect(input.lines.reduce((t, l) => t + l.amount, 0)).toBe(375);
    expect(input.extra).toEqual({ kind: "advance", amount: 125 });
  });

  it("money entered + Skip all is still a legitimate receipt — but the screen says so and offers Postpone", async () => {
    const { onSubmit } = setup();
    fireEvent.change(amountField(), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "Skip all" }));
    const note = screen.getByTestId("rp-settle-nothing-note");
    expect(note.textContent).toContain("₹500 will still be recorded as received from SHAMBU");
    expect(primary().textContent).toBe("Record ₹500 received");
    // The follow-up reminder is described as a reminder, not a postponement.
    expect(screen.getByTestId("rp-reminder-note").textContent).toContain("A reminder only — it doesn't postpone what is owed.");
    fireEvent.click(screen.getByRole("radio", { name: /next cycle/i }));
    expect(screen.getByTestId("rp-reminder-note").textContent).toMatch(/^You'll be reminded on 18 Oct/);
    await act(async () => fireEvent.click(primary()));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ amount: 500, lines: [], extra: { kind: "advance", amount: 500 } });
  });

  it("the prefilled ₹375 + Skip all (the reported trap): Postpone instead switches to the no-money path", async () => {
    const { onSubmit, value } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Skip all" }));
    fireEvent.click(within(screen.getByTestId("rp-settle-nothing-note")).getByRole("button", { name: /postpone instead/i }));
    expect(hasntPaid().getAttribute("aria-checked")).toBe("true");
    expect(primary().textContent).toBe("Postpone ₹375");
    await act(async () => fireEvent.click(primary()));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(value.onApply).toHaveBeenCalledTimes(1);
  });

  it("payment after postpone: recording money is the normal payment (the deferral resolves from the live remaining)", async () => {
    const plan = planDeferralWrite(null, null, {
      action: "postpone", requestId: "x", expectedRevision: 0, personId: "A", obligationKey: "ledger:lent", obligationTitle: "Movie tickets",
      now: NOW, startDay: SD, obligationDate: d(10, 5), remaining: 375, target: cycleContaining(d(11, 1), SD), reason: null, note: null, reminder: null,
    });
    if (plan.kind !== "write") throw new Error(plan.kind);
    const value = ctx({ byKey: new Map([["ledger:lent", deferralView(plan.deferral, 375, SD, NOW)!]]), revisionByKey: new Map([["ledger:lent", 1]]) });
    const { onSubmit } = setup({ value });
    await act(async () => fireEvent.click(primary()));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ amount: 375, extra: null });
    expect(value.onApply).not.toHaveBeenCalled();
  });
});
