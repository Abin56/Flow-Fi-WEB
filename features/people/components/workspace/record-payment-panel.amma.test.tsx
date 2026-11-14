// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLedgerRows, type LedgerRow } from "@/features/people/lib/person-ledger-rows";
import { GENERAL_PAYMENT_KEY } from "@/features/people/lib/person-payment-obligations";
import { buildPersonCycleStatement, cycleContaining } from "@/lib/engines/person-cycle-statement";
import { reconcilePayment, round2 } from "@/lib/engines/person-payment";
import type { LedgerEntry } from "@/lib/models/person";
import type { RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { DeferralContext, type DeferralContextValue } from "./payment-deferral";
import { RecordPaymentPanel } from "./record-payment-panel";

/**
 * The real case behind the redesign. AMMA owes ₹30,744.06 across five items and sends ₹44,752 into SBI — the
 * whole balance, general (tied to no item), plus ₹14,007.94 left over: ₹444 income, ₹9,500 set aside for the
 * SBI EMI, ₹4,063.94 set aside for monthly needs — nothing unassigned. Real ledger rows (statement engine →
 * `buildLedgerRows`); only the write (`onSubmit`) is mocked.
 */

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

function setup({ value = ctx(), onSubmit = vi.fn(async (_i: RecordPaymentInput, _id: string | null) => {}) } = {}) {
  const onCancel = vi.fn();
  render(
    <DeferralContext.Provider value={value}>
      <RecordPaymentPanel
        personName="AMMA"
        rows={rowsFor(ENTRIES)}
        cycle={CYCLE}
        cycleLabel="18 Sep – 17 Oct 2026"
        onCancel={onCancel}
        onSubmit={onSubmit}
        cycleStartDay={SD}
      />
    </DeferralContext.Provider>,
  );
  return { onSubmit, onCancel, value };
}

const primary = () => screen.getAllByRole("button").find((b) => b.getAttribute("type") === "submit")! as HTMLButtonElement;
const fig = (id: string) => screen.getByTestId(id).textContent;
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const useFor = (i: number) => screen.getAllByLabelText(/^Use for —/)[i];
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));

describe("AMMA — ₹44,752 received against ₹30,744.06 outstanding (general, no item touched)", () => {
  it("settles the whole balance, splits the ₹14,007.94 left into income + two purposes, and records once", async () => {
    const { onSubmit, value } = setup();
    expect(fig("rp-due-total")).toBe("₹30,744.06");
    type(screen.getByLabelText("Amount received"), "44752");

    // Two separate balances: what AMMA still owes, and received money still to use.
    expect(fig("rp-applied")).toBe("₹30,744.06");
    expect(fig("rp-still-owed")).toBe("₹0");
    expect(fig("rp-left-over")).toBe("₹14,007.94");
    expect(screen.getByTestId("rp-general-note").textContent).toMatch(/no transaction is marked paid or part paid/);

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

    expect(fig("rp-hero-amount")).toBe("₹44,752");
    expect(fig("rp-applied")).toBe("₹30,744.06");
    expect(fig("rp-income")).toBe("₹444");
    expect(fig("rp-set-aside")).toBe("₹13,563.94");
    expect(screen.queryByTestId("rp-advance")).toBeNull();
    expect(fig("rp-unassigned")).toBe("₹0");
    expect(fig("rp-still-owed")).toBe("₹0");
    expect(primary().textContent).toBe("Record ₹44,752 received");

    await act(async () => {
      fireEvent.click(primary());
      fireEvent.click(primary()); // repeated submit
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [input, id] = onSubmit.mock.calls[0];
    expect(id).toBeNull();
    expect(input.amount).toBe(44752);
    expect(input.accountId).toBe("sbi");
    expect(input.lines).toEqual([{ key: GENERAL_PAYMENT_KEY, amount: 30744.06, route: { kind: "general" } }]);
    expect(input.extra).toMatchObject({ kind: "income", amount: 444, categoryId: "pocket" });
    expect(input.extras).toBeUndefined();
    expect(input.purposes?.map((p) => [p.title, p.amount])).toEqual([
      ["SBI EMI", 9500],
      ["Monthly needs", 4063.94],
    ]);
    // Every rupee once: received = applied + income + set aside, to the paisa.
    const applied = round2(input.lines.reduce((t, l) => t + l.amount, 0));
    const purpose = round2(input.purposes!.reduce((t, p) => t + p.amount, 0));
    const recon = reconcilePayment({ received: input.amount, allocated: applied, income: 444, purpose });
    expect(recon.balanced).toBe(true);
    expect(recon.unallocated).toBeCloseTo(0, 5);
    expect(value.onApply).not.toHaveBeenCalled(); // a general payment never postpones anything
  });

  it("beyond the full balance, the extra defaults to held advance — separate from income", () => {
    setup();
    type(screen.getByLabelText("Amount received"), "30744.06");
    expect(screen.queryByTestId("rp-left-over")).toBeNull();
    type(screen.getByLabelText("Amount received"), "31000");
    expect(fig("rp-left-over")).toBe("₹255.94");
    expect(fig("rp-advance")).toBe("₹255.94");
    expect(screen.queryByTestId("rp-income")).toBeNull();
    expect(fig("rp-still-owed")).toBe("₹0");
  });
});
