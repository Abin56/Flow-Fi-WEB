// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLedgerRows, type LedgerRow } from "@/features/people/lib/person-ledger-rows";
import { buildPersonCycleStatement, cycleContaining } from "@/lib/engines/person-cycle-statement";
import { reconcilePayment, round2 } from "@/lib/engines/person-payment";
import { STALE_MESSAGE } from "@/lib/engines/person-payment-deferral";
import type { LedgerEntry } from "@/lib/models/person";
import type { RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { DeferralContext, type DeferralContextValue, type DeferralSubmit } from "./payment-deferral";
import { RecordPaymentPanel } from "./record-payment-panel";

/**
 * The real case behind the redesign. AMMA owes ₹30,744.06 across five items and sends ₹29,444 into SBI.
 * Three items are settled now (₹15,436.06), two stay unpaid (₹15,308). Of the ₹14,007.94 left: ₹444 income,
 * ₹9,500 set aside for the SBI EMI, ₹4,063.94 set aside for monthly needs — nothing unassigned.
 * Real ledger rows (statement engine → `buildLedgerRows`); only the two writes are mocked: the payment
 * (`onSubmit`) and the existing deferral write (`DeferralContext.onApply`).
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: [{ id: "sbi", name: "SBI", isDefault: true, deletedAt: null }] }) }));
vi.mock("@/hooks/use-categories", () => ({ useCategories: () => ({ data: [{ id: "pocket", name: "Pocket money", type: "income", deletedAt: null }] }) }));
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

function gave(id: string, amount: number, date: Date, note: string): LedgerEntry {
  return {
    id,
    personId: "A",
    type: "gave",
    amount,
    date,
    note,
    increasesBalance: true,
    transactionRef: null,
    parentEntryId: null,
    createdAt: date,
    receivedStatus: "yetToReceive",
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
  };
}

const ENTRIES = [
  gave("power", 5000, d(9, 20), "Electricity"),
  gave("phone", 436.06, d(9, 22), "Phone recharge"),
  gave("grocery", 10000, d(9, 25), "Groceries"),
  gave("rent", 8000, d(10, 1), "Rent share"),
  gave("meds", 7308, d(10, 3), "Medicine"),
];

function rowsFor(entries: LedgerEntry[]): LedgerRow[] {
  const statement = buildPersonCycleStatement({
    person: { id: "A", name: "AMMA", openingBalance: 0, createdAt: d(1, 1) },
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

function ctx(patch: Partial<DeferralContextValue> = {}): DeferralContextValue {
  return { byKey: new Map(), revisionByKey: new Map(), cycleStartDay: SD, personName: "AMMA", onApply: vi.fn(async () => "written" as const), ...patch };
}

function setup({ value = ctx(), onSubmit = vi.fn(async (_i: RecordPaymentInput, _id: string | null, _o?: { keepOpen?: boolean }) => {}) } = {}) {
  const onCancel = vi.fn();
  const onComplete = vi.fn();
  render(
    <DeferralContext.Provider value={value}>
      <RecordPaymentPanel
        personName="AMMA"
        rows={rowsFor(ENTRIES)}
        cycle={CYCLE}
        cycleLabel="18 Sep – 17 Oct 2026"
        onCancel={onCancel}
        onSubmit={onSubmit}
        onComplete={onComplete}
        cycleStartDay={SD}
      />
    </DeferralContext.Provider>,
  );
  return { onSubmit, onCancel, onComplete, value };
}

const primary = () => screen.getAllByRole("button").find((b) => b.getAttribute("type") === "submit")! as HTMLButtonElement;
const fig = (id: string) => screen.getByTestId(id).textContent;
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const useFor = (i: number) => screen.getAllByLabelText(/^Use for —/)[i];
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));

/** ₹29,444 received; Rent share and Medicine skipped. */
function receiveAndChooseBills() {
  type(screen.getByLabelText("Amount received"), "29444");
  click("Skip Rent share");
  click("Skip Medicine");
}

describe("AMMA — ₹29,444 received against ₹30,744.06 outstanding", () => {
  it("settles only the chosen bills, splits the ₹14,007.94 left into income + two purposes, and records once", async () => {
    const { onSubmit, value } = setup();
    expect(fig("rp-due-total")).toBe("₹30,744.06");
    receiveAndChooseBills();

    // Two separate balances: what AMMA still owes, and received money still to use.
    expect(fig("rp-applied")).toBe("₹15,436.06");
    expect(fig("rp-still-owed")).toBe("₹15,308");
    expect(fig("rp-left-over")).toBe("₹14,007.94");
    expect(screen.getByText("₹8,000 unpaid")).toBeTruthy();
    expect(screen.getByText("₹7,308 unpaid")).toBeTruthy();
    expect(screen.getAllByText("Paid in full")).toHaveLength(3);

    // The default destination (advance) becomes the SBI EMI purpose…
    fireEvent.change(useFor(0), { target: { value: "purpose" } });
    type(screen.getByLabelText("What is this money for?"), "SBI EMI");
    type(screen.getByLabelText("Purpose amount"), "9500");
    expect(screen.getByTestId("rp-left-status").textContent).toBe("₹4,507.94 not yet assigned");
    // …each Add takes what is still unassigned.
    click("Add another purpose");
    expect((screen.getAllByLabelText("Purpose amount")[1] as HTMLInputElement).value).toBe("4507.94");
    type(screen.getAllByLabelText("What is this money for?")[1], "Monthly needs");
    type(screen.getAllByLabelText("Purpose amount")[1], "4063.94");
    click("Add income");
    expect((screen.getByLabelText("Income amount") as HTMLInputElement).value).toBe("444");
    fireEvent.change(screen.getByLabelText("Income category"), { target: { value: "pocket" } });

    expect(fig("rp-hero-amount")).toBe("₹29,444");
    expect(fig("rp-applied")).toBe("₹15,436.06");
    expect(fig("rp-income")).toBe("₹444");
    expect(fig("rp-set-aside")).toBe("₹13,563.94");
    expect(screen.queryByTestId("rp-advance")).toBeNull();
    expect(fig("rp-unassigned")).toBe("₹0");
    expect(fig("rp-still-owed")).toBe("₹15,308"); // unchanged by how the money left is used
    expect(primary().textContent).toBe("Record ₹29,444 received");

    await act(async () => {
      fireEvent.click(primary());
      fireEvent.click(primary()); // repeated submit
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [input, id, options] = onSubmit.mock.calls[0];
    expect(id).toBeNull();
    expect(options).toBeUndefined(); // nothing to postpone → the host closes as before
    expect(input.amount).toBe(29444);
    expect(input.accountId).toBe("sbi");
    expect(Object.fromEntries(input.lines.map((l) => [l.route.kind === "entry" ? l.route.parentEntryId : "?", l.amount]))).toEqual({ power: 5000, phone: 436.06, grocery: 10000 });
    expect(input.extra).toMatchObject({ kind: "income", amount: 444, categoryId: "pocket" });
    expect(input.extras).toBeUndefined();
    expect(input.purposes?.map((p) => [p.title, p.amount])).toEqual([
      ["SBI EMI", 9500],
      ["Monthly needs", 4063.94],
    ]);
    // Every rupee once: received = applied + income + set aside, to the paisa.
    const applied = round2(input.lines.reduce((t, l) => t + l.amount, 0));
    const purpose = round2(input.purposes!.reduce((t, p) => t + p.amount, 0));
    expect(reconcilePayment({ received: input.amount, allocated: applied, income: 444, purpose })).toMatchObject({ unallocated: 0, balanced: true });
    expect(value.onApply).not.toHaveBeenCalled(); // skipping is not postponing
  });

  it("partial payment + postpone the rest: the receipt first (kept open), then one deferral per item with the remaining after payment", async () => {
    const order: string[] = [];
    const onSubmit = vi.fn(async (_i: RecordPaymentInput, _id: string | null, _o?: { keepOpen?: boolean }) => void order.push("payment"));
    const onApply = vi.fn(async (r: DeferralSubmit) => (order.push(`postpone:${r.obligationKey}`), "written" as const));
    const { onComplete } = setup({ onSubmit, value: ctx({ onApply }) });
    type(screen.getByLabelText("Amount received"), "29444");
    click("Skip Rent share");
    click("Pay part of Medicine");
    expect(document.activeElement).toBe(screen.getByLabelText("Paying now for Medicine"));
    type(screen.getByLabelText("Paying now for Medicine"), "3000");
    expect(screen.getByText("₹4,308 left")).toBeTruthy();
    expect(fig("rp-still-owed")).toBe("₹12,308");

    fireEvent.click(screen.getByLabelText("Postpone the rest of Rent share"));
    fireEvent.click(screen.getByLabelText("Postpone the rest of Medicine"));
    expect(screen.getByTestId("rp-postpone-after")).toBeTruthy();
    expect(fig("rp-postpone-total")).toMatch(/₹12,308 to be moved to the Nov cycle/);
    expect(screen.getByTestId("postpone-preview").textContent).toMatch(/^₹12,308 will remain unpaid/);
    expect(primary().textContent).toBe("Record ₹29,444 received · postpone ₹12,308");

    await act(async () => fireEvent.click(primary()));
    expect(order).toEqual(["payment", "postpone:ledger:rent", "postpone:ledger:meds"]);
    expect(onSubmit.mock.calls[0][2]).toEqual({ keepOpen: true });
    expect(onSubmit.mock.calls[0][0].lines.map((l) => l.amount)).toEqual([5000, 436.06, 10000, 3000]);
    expect(onApply.mock.calls.map((c) => [c[0].obligationKey, (c[0] as Extract<DeferralSubmit, { action: "postpone" }>).remaining])).toEqual([
      ["ledger:rent", 8000],
      ["ledger:meds", 4308],
    ]);
    expect(onApply.mock.calls[0][0]).toMatchObject({ action: "postpone", target: { start: d(10, 18), end: d(11, 17) } });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("a postponement that fails after the receipt is saved: honest result, Retry re-sends only that deferral — never the payment", async () => {
    let failRent = true;
    const onApply = vi.fn(async (r: DeferralSubmit) => {
      if (r.obligationKey === "ledger:rent" && failRent) throw new Error(STALE_MESSAGE);
      return "written" as const;
    });
    const { onSubmit, onComplete } = setup({ value: ctx({ onApply }) });
    receiveAndChooseBills();
    fireEvent.click(screen.getByLabelText("Postpone the rest of Rent share"));
    fireEvent.click(screen.getByLabelText("Postpone the rest of Medicine"));
    await act(async () => fireEvent.click(primary()));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("₹29,444 received from AMMA is recorded.");
    const list = within(screen.getByRole("list", { name: "Postponements" }));
    expect(list.getByText("Postponed")).toBeTruthy(); // Medicine
    expect(list.getByText(`Not postponed — ${STALE_MESSAGE}`)).toBeTruthy(); // Rent share — never claimed as postponed
    expect(screen.getByRole("alert").textContent).toBe("1 payment postponed · 1 could not be postponed");
    expect(toasts.error).toHaveBeenCalledWith("1 payment postponed · 1 failed.", "Not postponed: Rent share. Retry from the panel.");
    expect(primary().textContent).toBe("Retry postponing ₹8,000");

    const firstId = onApply.mock.calls.find((c) => c[0].obligationKey === "ledger:rent")![0].requestId;
    failRent = false;
    await act(async () => fireEvent.click(primary()));
    expect(onApply).toHaveBeenCalledTimes(3);
    expect(onApply.mock.calls[2][0]).toMatchObject({ obligationKey: "ledger:rent", requestId: firstId });
    expect(onSubmit).toHaveBeenCalledTimes(1); // no second receipt
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("a payment that fails writes no postponement; the form stays as entered and can be submitted again", async () => {
    let fail = true;
    const onSubmit = vi.fn(async (_i: RecordPaymentInput, _id: string | null, _o?: { keepOpen?: boolean }) => {
      if (fail) throw new Error("Network down");
    });
    const { value, onComplete } = setup({ onSubmit });
    receiveAndChooseBills();
    fireEvent.click(screen.getByLabelText("Postpone the rest of Rent share"));
    await act(async () => fireEvent.click(primary()));
    expect(screen.getByRole("alert").textContent).toBe("Network down");
    expect(value.onApply).not.toHaveBeenCalled();
    expect(fig("rp-applied")).toBe("₹15,436.06");
    expect((screen.getByLabelText("Postpone the rest of Rent share") as HTMLInputElement).checked).toBe(true);
    fail = false;
    await act(async () => fireEvent.click(primary()));
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(value.onApply).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("an item paid in full offers no postpone; held advance stays separate from income", () => {
    setup();
    type(screen.getByLabelText("Amount received"), "30744.06");
    expect(screen.queryByLabelText(/^Postpone the rest of/)).toBeNull();
    type(screen.getByLabelText("Amount received"), "31000");
    expect(fig("rp-left-over")).toBe("₹255.94");
    expect(fig("rp-advance")).toBe("₹255.94");
    expect(screen.queryByTestId("rp-income")).toBeNull();
    expect(fig("rp-still-owed")).toBe("₹0");
  });
});
