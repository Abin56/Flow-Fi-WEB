// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLedgerRows, type LedgerRow } from "@/features/people/lib/person-ledger-rows";
import { GENERAL_PAYMENT_KEY, overallDue } from "@/features/people/lib/person-payment-obligations";
import { buildPersonCycleStatement, cycleContaining } from "@/lib/engines/person-cycle-statement";
import type { LedgerEntry } from "@/lib/models/person";
import type { RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { paymentInitialFor, RecordPaymentPanel } from "./record-payment-panel";

/**
 * General payment — the default. SANJU owes ₹29,000 across three items and gives ₹20,000 now, promising the
 * remaining ₹9,000 next month. Nothing is allocated to an item: the payment is ONE line tied to no obligation,
 * the balance reads ₹9,000, and every item keeps its own amount. Real ledger rows (statement engine →
 * `buildLedgerRows`); only the write (`onSubmit`) is mocked.
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
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const base = { personId: "S", increasesBalance: true, deletedAt: null, lastEditedAt: null, editHistory: [] };
const gave = (id: string, amount: number, date: Date, note: string): LedgerEntry => ({
  ...base,
  id,
  type: "gave",
  amount,
  date,
  note,
  transactionRef: null,
  parentEntryId: null,
  createdAt: date,
  receivedStatus: "yetToReceive",
});
/** What the repository writes for a general payment: one settlement entry tied to no obligation. */
const generalReceipt = (id: string, amount: number, date: Date): LedgerEntry => ({
  ...base,
  id,
  type: "receivedBack",
  amount,
  date,
  note: "",
  transactionRef: "cash-1",
  parentEntryId: null,
  obligationRef: null,
  sourceKind: "manual",
  paymentId: "pay-1",
  createdAt: date,
  receivedStatus: "received",
});

const ITEMS = [gave("rent", 12_000, d(9, 20), "Rent share"), gave("fees", 10_000, d(9, 25), "College fees"), gave("phone", 7_000, d(10, 2), "Phone")];

function rowsFor(entries: LedgerEntry[]): LedgerRow[] {
  const statement = buildPersonCycleStatement({
    person: { id: "S", name: "SANJU", openingBalance: 0, createdAt: d(1, 1) },
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

function setup(entries: LedgerEntry[], props: Partial<React.ComponentProps<typeof RecordPaymentPanel>> = {}) {
  const onSubmit = vi.fn(async (_i: RecordPaymentInput, _id: string | null) => {});
  render(
    <RecordPaymentPanel
      personName="SANJU"
      rows={rowsFor(entries)}
      cycle={CYCLE}
      cycleLabel="18 Sep – 17 Oct 2026"
      onCancel={() => {}}
      onSubmit={onSubmit}
      cycleStartDay={SD}
      {...props}
    />,
  );
  return { onSubmit };
}

const fig = (id: string) => screen.getByTestId(id).textContent;
const amount = (v: string) => fireEvent.change(screen.getByLabelText(/^Amount (received|paid)$/), { target: { value: v } });
const submit = () => fireEvent.click(screen.getAllByRole("button").find((b) => b.getAttribute("type") === "submit")!);

describe("overallDue — the balance the statement engine reads, earlier general payments included", () => {
  it("₹29,000 owed, ₹20,000 received with no item → ₹9,000 left; every item keeps its own remaining", () => {
    const rows = rowsFor([...ITEMS, generalReceipt("g1", 20_000, d(10, 5))]);
    expect(overallDue(rows, CYCLE)).toEqual({ theyOwe: 9_000, iOwe: 0 });
    // Not one item is marked paid or part paid by it.
    const states = rows.filter((r) => r.state != null).map((r) => [r.key, r.state, r.remaining]);
    expect(states).toHaveLength(3);
    expect(states).toEqual(
      expect.arrayContaining([
        ["ledger:rent", "open", 12_000],
        ["ledger:fees", "open", 10_000],
        ["ledger:phone", "open", 7_000],
      ]),
    );
    // The payment itself stays a row of its own — "Received", not hidden inside an item's history.
    expect(rows.find((r) => r.key === "ledger:g1")?.statementRow?.settlesKey).toBeUndefined();
  });

  it("matches the engine's own figure (currentPending)", () => {
    const entries = [...ITEMS, generalReceipt("g1", 20_000, d(10, 5))];
    const statement = buildPersonCycleStatement({
      person: { id: "S", name: "SANJU", openingBalance: 0, createdAt: d(1, 1) },
      ledgerEntries: entries,
      loanIds: new Set(),
      emis: [],
      loans: [],
      installments: [],
      cycle: CYCLE,
      now: NOW,
    });
    expect(statement.currentPending).toBe(9_000);
    expect(statement.toReceive).toBe(9_000);
  });
});

describe("Record Payment — general payment (the default)", () => {
  it("₹20,000 of ₹29,000: one general line, no item, ₹9,000 remaining — never Full / Part / Skip", () => {
    const { onSubmit } = setup(ITEMS);
    expect(screen.getByTestId("rp-mode-general").getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("list", { name: "Items to pay" })).toBeNull();
    amount("20000");
    expect(fig("rp-general-due")).toBe("₹29,000");
    expect(fig("rp-general-paying")).toBe("₹20,000");
    expect(fig("rp-general-left")).toBe("₹9,000");
    expect(fig("rp-still-owed")).toBe("₹9,000");
    expect(screen.getByTestId("rp-general-note").textContent).toMatch(/no transaction is marked paid or part paid/);
    submit();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const input = onSubmit.mock.calls[0][0];
    expect(input.lines).toEqual([{ key: GENERAL_PAYMENT_KEY, amount: 20_000, route: { kind: "general" } }]);
    expect(input.amount).toBe(20_000);
    expect(input.extra).toBeNull();
  });

  it("after an earlier general ₹20,000, the outstanding is ₹9,000 — the first payment is never counted again; money beyond it is an explicit extra", () => {
    const { onSubmit } = setup([...ITEMS, generalReceipt("g1", 20_000, d(10, 5))]);
    expect(fig("rp-due-total")).toBe("₹9,000");
    amount("10000");
    expect(fig("rp-general-paying")).toBe("₹9,000");
    expect(fig("rp-general-left")).toBe("₹0");
    submit();
    const input = onSubmit.mock.calls[0][0];
    expect(input.lines).toEqual([{ key: GENERAL_PAYMENT_KEY, amount: 9_000, route: { kind: "general" } }]);
    // The ₹1,000 beyond the balance is held as advance (the default extra) — never silently over-settling.
    expect(input.extra).toEqual({ kind: "advance", amount: 1_000 });
  });

  it("choosing specific items still works and records item lines (backward compatible)", () => {
    const { onSubmit } = setup(ITEMS);
    fireEvent.click(screen.getByTestId("rp-mode-items"));
    expect(screen.getByRole("list", { name: "Items to pay" })).toBeTruthy();
    amount("12000");
    submit();
    const input = onSubmit.mock.calls[0][0];
    expect(input.lines.map((l) => [l.key, l.amount, l.route.kind])).toEqual([["ledger:rent", 12_000, "entry"]]);
  });

  it("a row's own Record payment (preselected item) opens on that item, not the general payment", () => {
    setup(ITEMS, { preselectKey: "ledger:fees" });
    expect(screen.getByTestId("rp-mode-items").getAttribute("aria-checked")).toBe("true");
  });

  it("editing a general payment reopens it as one: its own ₹20,000 counts as open again and the kind is locked", () => {
    const entries = [...ITEMS, generalReceipt("g1", 20_000, d(10, 5))];
    const initial = paymentInitialFor("pay-1", entries, () => "sbi");
    expect(initial?.lines).toEqual({ [GENERAL_PAYMENT_KEY]: 20_000 });
    const { onSubmit } = setup(entries, { initial });
    expect(screen.getByTestId("rp-mode-general").getAttribute("aria-checked")).toBe("true");
    expect((screen.getByTestId("rp-mode-items") as HTMLButtonElement).disabled).toBe(true);
    expect(fig("rp-general-due")).toBe("₹29,000");
    amount("25000");
    fireEvent.click(screen.getByRole("button", { name: /^Save changes/ }));
    const input = onSubmit.mock.calls[0][0];
    expect(onSubmit.mock.calls[0][1]).toBe("pay-1");
    expect(input.lines).toEqual([{ key: GENERAL_PAYMENT_KEY, amount: 25_000, route: { kind: "general" } }]);
  });

  it("money paid TO the person: a general payment lowers what you owe them", () => {
    const borrowed: LedgerEntry = { ...gave("loan", 5_000, d(9, 21), "Borrowed"), type: "borrowed" };
    const { onSubmit } = setup([borrowed]);
    amount("2000");
    expect(fig("rp-general-due")).toBe("₹5,000");
    expect(fig("rp-general-left")).toBe("₹3,000");
    submit();
    const input = onSubmit.mock.calls[0][0];
    expect(input.direction).toBe("iPaid");
    expect(input.lines).toEqual([{ key: GENERAL_PAYMENT_KEY, amount: 2_000, route: { kind: "general" } }]);
  });
});
