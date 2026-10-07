// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { timingOf, type ObligationTiming, type PayableObligation } from "@/features/people/lib/person-payment-obligations";
import type { RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { RecordPaymentPanel } from "./record-payment-panel";

/**
 * Record Payment launched from a SELECTED People cycle (Settings → Month Cycle, 17 Sep – 16 Oct).
 * AMMA: ₹1,000 brought forward (Aug) + ₹3,000 added this cycle = ₹4,000 due; ₹2,000 belongs to the NEXT
 * cycle (20 Oct). All-time outstanding ₹6,000. The default scope is the ₹4,000 — never the ₹6,000.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: [{ id: "sbi", name: "SBI", isDefault: true, deletedAt: null }] }) }));
vi.mock("@/hooks/use-categories", () => ({ useCategories: () => ({ data: [{ id: "gift", name: "Gift", type: "income", deletedAt: null }] }) }));
vi.mock("@/features/people/components/workspace/purpose-money", () => ({ usePurposeLinkOptions: () => [] }));

let payable: PayableObligation[] = [];
vi.mock("@/features/people/lib/person-payment-obligations", async (orig) => {
  const actual = await orig<typeof import("@/features/people/lib/person-payment-obligations")>();
  return { ...actual, settlementProjection: () => ({ payable, elsewhere: [] }) };
});

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture ??= () => false;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

const CYCLE = { start: new Date(2026, 8, 17), end: new Date(2026, 9, 16) };

function obligation(key: string, outstanding: number, date: Date, category: PayableObligation["category"] = "gave"): PayableObligation {
  return {
    key,
    title: key,
    date,
    createdAt: date,
    amount: outstanding,
    outstanding,
    side: "theyOwe",
    typeLabel: "Item",
    category,
    target: { kind: "entry", entry: { id: key.replace("ledger:", ""), sourceKind: "manual" }, max: outstanding } as never,
    isEmi: false,
    timing: timingOf(date, CYCLE) as ObligationTiming,
  };
}

beforeEach(() => {
  payable = [
    obligation("ledger:aug-carried", 1000, new Date(2026, 7, 25)),
    obligation("ledger:sep-share", 3000, new Date(2026, 8, 20), "split"),
    obligation("ledger:oct-next", 2000, new Date(2026, 9, 20)),
  ];
});

function setup() {
  const onSubmit = vi.fn(async (_i: RecordPaymentInput, _id: string | null) => {});
  const onSetReminder = vi.fn(async () => {});
  const user = userEvent.setup();
  render(
    <RecordPaymentPanel
      personName="AMMA"
      rows={[]}
      cycle={CYCLE}
      cycleLabel="17 Sep – 16 Oct 2026"
      cycleStartDay={17}
      onCancel={() => {}}
      onSubmit={onSubmit}
      onSetReminder={onSetReminder}
    />,
  );
  return { user, onSubmit, onSetReminder };
}

const amountInput = () => screen.getByLabelText(/^Amount received$/);
const applyInput = () => screen.getByLabelText("Apply to balance") as HTMLInputElement;
const cta = () => screen.getByRole("button", { name: /^Record|Saving/ });
const linesOf = (input: RecordPaymentInput) => Object.fromEntries(input.lines.map((l) => [l.key, l.amount]));

describe("timingOf — selected People cycle (inclusive boundaries)", () => {
  it("before start = carried, inside (incl. 17 Sep and 16 Oct) = cycle, after 16 Oct = later", () => {
    expect(timingOf(new Date(2026, 8, 16, 23), CYCLE)).toBe("carried");
    expect(timingOf(new Date(2026, 8, 17), CYCLE)).toBe("cycle");
    expect(timingOf(new Date(2026, 9, 16, 23), CYCLE)).toBe("cycle");
    expect(timingOf(new Date(2026, 9, 17), CYCLE)).toBe("later");
  });
});

describe("Record Payment from a selected cycle — scope is that cycle's due, never all-time", () => {
  it("Due shows ₹4,000 (carried ₹1,000 + this cycle ₹3,000), not the ₹6,000 all-time balance", () => {
    setup();
    expect(screen.getByText("Due from AMMA").parentElement?.textContent).toContain("4,000");
    expect(screen.queryByText(/6,000/)).toBeNull();
  });

  it("full cycle payment ₹4,000 settles carried + current; the next-cycle ₹2,000 is untouched", async () => {
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "4000");
    expect(applyInput().value).toBe("4000");
    expect(screen.getByTestId("rp-still-owed").textContent).toContain("0");
    await user.click(cta());
    const input = onSubmit.mock.calls[0][0];
    expect(linesOf(input)).toEqual({ "ledger:aug-carried": 1000, "ledger:sep-share": 3000 });
    expect(input.extra).toBeNull();
  });

  it("partial ₹2,500: brought-forward settles first, ₹1,500 stays on this cycle's item, future untouched", async () => {
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "2500");
    expect(screen.getByTestId("rp-still-owed").textContent).toContain("1,500");
    await user.click(cta());
    const input = onSubmit.mock.calls[0][0];
    expect(linesOf(input)).toEqual({ "ledger:aug-carried": 1000, "ledger:sep-share": 1500 });
    expect(input.lines.some((l) => l.key === "ledger:oct-next")).toBe(false);
    expect(input.extra).toBeNull();
  });

  it("₹10,000 received: ₹4,000 applied to the cycle, ₹6,000 kept as advance — NOT applied to the future ₹2,000", async () => {
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "10000");
    expect(applyInput().value).toBe("4000");
    expect(screen.getByTestId("rp-left-over").textContent).toContain("6,000");
    await user.click(cta());
    const input = onSubmit.mock.calls[0][0];
    expect(linesOf(input)).toEqual({ "ledger:aug-carried": 1000, "ledger:sep-share": 3000 });
    expect(input.extra).toEqual({ kind: "advance", amount: 6000 });
  });

  it("paying the next-cycle item early is an explicit opt-in (Show upcoming → tick)", async () => {
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "6000");
    expect(applyInput().value).toBe("4000");
    await user.click(screen.getByRole("button", { name: /Show 1 upcoming item/ }));
    await user.click(screen.getByLabelText("Apply to ledger:oct-next"));
    expect(applyInput().value).toBe("6000");
    await user.click(cta());
    expect(linesOf(onSubmit.mock.calls[0][0])).toEqual({ "ledger:aug-carried": 1000, "ledger:sep-share": 3000, "ledger:oct-next": 2000 });
  });

  it("edit: the payment's own lines reopen and stay selected; the future item stays out", async () => {
    const onSubmit = vi.fn(async (_i: RecordPaymentInput, _id: string | null) => {});
    // After a ₹2,500 payment: carried ₹0 (no longer payable), current ₹1,500 open.
    payable = [obligation("ledger:sep-share", 1500, new Date(2026, 8, 20), "split"), obligation("ledger:oct-next", 2000, new Date(2026, 9, 20))];
    const user = userEvent.setup();
    render(
      <RecordPaymentPanel
        personName="AMMA"
        rows={[{ key: "ledger:aug-carried", title: "aug", date: new Date(2026, 7, 25), createdAt: new Date(2026, 7, 25), amount: 1000, remaining: 0, direction: "theyOwe", typeLabel: "Item", category: "gave", statementRow: {} } as never]}
        cycle={CYCLE}
        cycleLabel="17 Sep – 16 Oct 2026"
        initial={{ paymentId: "p1", direction: "theyPaid", amount: 2500, accountId: "sbi", date: new Date(2026, 10, 5), lines: { "ledger:aug-carried": 1000, "ledger:sep-share": 1500 }, advance: 0 }}
        onCancel={() => {}}
        onSubmit={onSubmit}
      />,
    );
    await user.clear(amountInput());
    await user.type(amountInput(), "3000");
    await user.click(screen.getByRole("button", { name: /Settle full/ }));
    await user.click(screen.getByRole("button", { name: /^Save|^Update|Saving/ }));
    const [input, id] = onSubmit.mock.calls[0];
    expect(id).toBe("p1");
    expect(linesOf(input)).toEqual({ "ledger:aug-carried": 1000, "ledger:sep-share": 2000 });
    // Payment date (5 Nov) is the cash date; the lines still settle the Aug / Sep obligations by key.
    expect(input.date.getMonth()).toBe(10);
  });
});

describe("Due breakdown — presentation of the same Due, future excluded", () => {
  it("previous ₹1,000 + added this cycle ₹3,000 = due through this cycle ₹4,000", () => {
    setup();
    const box = within(screen.getByTestId("rp-due-breakdown"));
    expect(box.getByText("Previous pending").nextElementSibling?.textContent).toMatch(/1,000/);
    expect(box.getByText("Added this cycle").nextElementSibling?.textContent).toMatch(/3,000/);
    expect(box.getByText("Due through this cycle").nextElementSibling?.textContent).toMatch(/4,000/);
    expect(screen.getByTestId("rp-due-breakdown").textContent).not.toMatch(/2,000|6,000/);
  });

  it("no previous pending → no breakdown clutter", () => {
    payable = payable.filter((o) => o.timing !== "carried");
    setup();
    expect(screen.queryByTestId("rp-due-breakdown")).toBeNull();
  });
});

describe("Remainders and reminders from the selected cycle — future ₹2,000 always untouched", () => {
  it("A. reminder: partial ₹2,500 → reminder on the still-open current item only, never the future one", async () => {
    const { user, onSubmit, onSetReminder } = setup();
    await user.type(amountInput(), "2500");
    await user.click(within(screen.getByRole("radiogroup", { name: "Reminder" })).getByRole("radio", { name: /Next cycle/ }));
    await user.click(cta());
    expect(linesOf(onSubmit.mock.calls[0][0])).toEqual({ "ledger:aug-carried": 1000, "ledger:sep-share": 1500 });
    const [targets] = onSetReminder.mock.calls[0] as unknown as [{ key: string }[]];
    expect(targets.map((t) => t.key)).toEqual(["ledger:sep-share"]);
  });

  it("B. income remainder: ₹10,000 → ₹4,000 settles the cycle, ₹6,000 recorded as income", async () => {
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "10000");
    await user.click(screen.getByRole("radio", { name: /Record as income/ }));
    await user.selectOptions(screen.getByLabelText("Category *"), "gift");
    await user.click(cta());
    const input = onSubmit.mock.calls[0][0];
    expect(linesOf(input)).toEqual({ "ledger:aug-carried": 1000, "ledger:sep-share": 3000 });
    expect(input.extra).toMatchObject({ kind: "income", amount: 6000, categoryId: "gift" });
  });

  it("C. purpose remainder: ₹10,000 → ₹4,000 settles the cycle, ₹6,000 set aside", async () => {
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "10000");
    await user.click(screen.getByRole("radio", { name: /Set aside for something/ }));
    await user.type(screen.getByLabelText("What is this money for? *"), "Hospital");
    await user.clear(screen.getByLabelText("Purpose amount"));
    await user.type(screen.getByLabelText("Purpose amount"), "6000");
    await user.click(cta());
    const input = onSubmit.mock.calls[0][0];
    expect(linesOf(input)).toEqual({ "ledger:aug-carried": 1000, "ledger:sep-share": 3000 });
    expect(input.purposes?.map((p) => [p.title, p.amount])).toEqual([["Hospital", 6000]]);
    expect(input.lines.some((l) => l.key === "ledger:oct-next")).toBe(false);
  });
});
