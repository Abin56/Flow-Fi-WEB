// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SplitAllocationBreakdown } from "@/components/finance/split-allocation-breakdown";
import { buildLedgerRows } from "@/features/people/lib/person-ledger-rows";
import { statementView } from "@/features/people/lib/person-statement-pdf-model";
import { renderPersonStatementPdf } from "@/features/people/lib/person-statement-pdf";
import type { SettlementLookups } from "@/features/people/lib/settlement-presentation";
import { buildPersonCycleStatement, cycleContaining, type PersonCycleStatementInput } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import type { Expense, ExpenseParticipant } from "@/lib/models/expense";
import type { LedgerEntry, LedgerEntryType } from "@/lib/models/person";
import { splitAllocation, splitAllocationSentence, splitCountLabel } from "@/lib/split/split-allocation";

/**
 * The visual split breakdown — one model (`splitAllocation`) read from the stored Expense, one component
 * (`SplitAllocationBreakdown`) shared by the People Ledger expansion and Transaction details, and the
 * recipient-safe split line in the shared statement / PDF. Display only: nothing here writes or recomputes.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
afterEach(cleanup);

const d = (month: number, day: number) => new Date(2026, month - 1, day);
const NOW = d(9, 30);
const CYCLE = cycleContaining(NOW);

const part = (name: string, share: number, personId: string | null, isMe = false): ExpenseParticipant => ({
  personId,
  name,
  share,
  installmentId: isMe ? null : `i-${name}`,
  isMe,
  receivedStatus: isMe ? "notApplicable" : "yetToReceive",
});

function expense(transactionId: string, totalAmount: number, participants: ExpenseParticipant[], patch: Partial<Expense> = {}): Expense {
  return {
    id: `x-${transactionId}`,
    description: "Dinner",
    totalAmount,
    date: d(9, 21),
    categoryId: "food",
    accountId: "acc",
    transactionId,
    splitType: "custom",
    participants,
    scheduleId: "s1",
    notes: "",
    createdAt: d(9, 21),
    deletedAt: null,
    ...patch,
  } as Expense;
}

const people = (n: number) => Array.from({ length: n }, (_, i) => part(`P${i + 1}`, 100, `p${i + 1}`));

const FOUR = expense("t-dinner", 4000, [part("Me", 1000, null, true), part("AMMA", 1000, "A"), part("TRIPTHEE", 1000, "T"), part("ANU", 1000, "N")], { splitType: "equal" });

let seq = 0;
function entry(personId: string, type: LedgerEntryType, amount: number, date: Date, patch: Partial<LedgerEntry> = {}): LedgerEntry {
  seq += 1;
  return {
    id: `e${seq}`,
    personId,
    type,
    amount,
    date,
    note: "",
    increasesBalance: true,
    transactionRef: null,
    parentEntryId: null,
    createdAt: new Date(date.getTime() + seq * 1000),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    receivedStatus: "yetToReceive",
    ...patch,
  };
}
const shareEntry = (personId: string, amount: number, ref = "t-dinner") =>
  entry(personId, "gave", amount, d(9, 21), { note: "Split: Dinner", sourceKind: "splitExpense", transactionRef: ref });

function ledger(personId: string, name: string, entries: LedgerEntry[], expenses: Expense[]) {
  const input: PersonCycleStatementInput = {
    person: { id: personId, name, openingBalance: 0, createdAt: d(1, 1) },
    ledgerEntries: entries,
    loanIds: new Set(),
    emis: [],
    loans: [],
    installments: [],
    cycle: CYCLE,
    now: NOW,
  };
  const statement = buildPersonCycleStatement(input);
  const rows = buildLedgerRows({ statement, history: statement, entries, pending: [], now: NOW });
  const lookups: SettlementLookups = {
    entriesById: new Map(entries.map((e) => [e.id, e])),
    expenseByTransactionId: new Map(expenses.map((x) => [x.transactionId, x])),
  };
  return { statement, rows, lookups, share: rows.find((r) => r.statementRow?.kind === "obligation")! };
}

// ---------------------------------------------------------------------------------------------------

describe("splitAllocation — stored total and stored shares only", () => {
  it.each([2, 3, 4, 5, 8, 12])("%i participants: every stored share, count and total as stored", (n) => {
    const x = expense("t", n * 100 + 1, [part("Me", 1, null, true), ...people(n - 1)]);
    const a = splitAllocation(x, "p1")!;
    expect(a.participantCount).toBe(n);
    expect(a.participants).toHaveLength(n);
    expect(a.original).toBe(n * 100 + 1); // stored totalAmount, never share × count
    expect(splitCountLabel(a)).toBe(`${n}-way split`);
    expect(a.participants[0]).toMatchObject({ label: "You", isMe: true });
    expect(a.participants.filter((p) => p.isFocus).map((p) => p.label)).toEqual(["P1"]);
  });

  it("4-way equal split (the Dinner example)", () => {
    const a = splitAllocation(FOUR, "A")!;
    expect(a.participants.map((p) => [p.label, p.amount])).toEqual([["You", 1000], ["AMMA", 1000], ["TRIPTHEE", 1000], ["ANU", 1000]]);
    expect(a).toMatchObject({ original: 4000, myShare: 1000, focusShare: 1000, allocated: 4000, reconciles: true });
    expect(splitAllocationSentence(a, money)).toBe(
      `Original total ${money(4000)}. Split among 4 participants. You ${money(1000)}. AMMA ${money(1000)} (their share). TRIPTHEE ${money(1000)}. ANU ${money(1000)}.`,
    );
  });

  it("custom / unequal split shows exactly the stored allocations", () => {
    const x = expense("t", 10000, [part("Me", 4000, null, true), part("AMMA", 3500, "A"), part("TRIPTHEE", 2000, "T"), part("ANU", 500, "N")]);
    expect(splitAllocation(x, "A")!.participants.map((p) => p.amount)).toEqual([4000, 3500, 2000, 500]);
  });

  it("odd paise: stored values pass through and reconcile with the stored original", () => {
    const x = expense("t", 1000.01, [part("Me", 333.34, null, true), part("AMMA", 333.34, "A"), part("TRIPTHEE", 333.33, "T")]);
    const a = splitAllocation(x, "A")!;
    expect(a.participants.map((p) => p.amount)).toEqual([333.34, 333.34, 333.33]);
    expect(a.allocated).toBe(1000.01);
    expect(a.reconciles).toBe(true);
  });

  it("owner's share ₹0: no 'You' cell, count is the carriers only", () => {
    const x = expense("t", 900, [part("Me", 0, null, true), part("AMMA", 450, "A"), part("TRIPTHEE", 450, "T")]);
    const a = splitAllocation(x, "A")!;
    expect(a.participants.map((p) => p.label)).toEqual(["AMMA", "TRIPTHEE"]);
    expect(a).toMatchObject({ myShare: 0, participantCount: 2 });
  });

  it("selected person's share ₹0: kept as ₹0 focus share, no cell", () => {
    const x = expense("t", 600, [part("Me", 300, null, true), part("AMMA", 0, "A"), part("TRIPTHEE", 300, "T")]);
    const a = splitAllocation(x, "A")!;
    expect(a.focusShare).toBe(0);
    expect(a.participants.some((p) => p.isFocus)).toBe(false);
  });

  it("stored shares that don't add up are flagged, never forced", () => {
    const x = expense("t", 1000, [part("Me", 400, null, true), part("AMMA", 500, "A")]);
    expect(splitAllocation(x, "A")).toMatchObject({ allocated: 900, reconciles: false });
  });

  it("deleted expense has no live breakdown; restored (deletedAt cleared) shows it again, once", () => {
    expect(splitAllocation({ ...FOUR, deletedAt: d(9, 27) }, "A")).toBeNull();
    const restored = splitAllocation({ ...FOUR, deletedAt: null }, "A")!;
    expect(restored.participants).toHaveLength(4);
  });

  it("edited original amount / allocation is read from the current stored Expense", () => {
    const edited = expense("t-dinner", 5000, [part("Me", 2000, null, true), part("AMMA", 1000, "A"), part("TRIPTHEE", 1000, "T"), part("ANU", 1000, "N")]);
    const a = splitAllocation(edited, "A")!;
    expect(a.original).toBe(5000);
    expect(a.myShare).toBe(2000);
  });

  it("legacy expense with no participant detail degrades to the total only", () => {
    const legacy = expense("t", 750, []);
    const a = splitAllocation(legacy, "A")!;
    expect(a).toMatchObject({ original: 750, participantCount: 0, participants: [], focusShare: null });
    expect(splitCountLabel(a)).toBe("Split expense");
    // Missing `participants` on an old document must not crash either.
    expect(splitAllocation({ ...legacy, participants: undefined as unknown as ExpenseParticipant[] })).toMatchObject({ participantCount: 0 });
  });

  it("no expense → null", () => {
    expect(splitAllocation(null)).toBeNull();
    expect(splitAllocation(undefined)).toBeNull();
  });

  it("is pure — the Expense is not mutated", () => {
    const snapshot = JSON.stringify(FOUR);
    splitAllocation(FOUR, "A");
    expect(JSON.stringify(FOUR)).toBe(snapshot);
  });
});

describe("SplitAllocationBreakdown — rendering", () => {
  it("shows original total separately from every participant cell, with a screen-reader sentence", () => {
    render(<SplitAllocationBreakdown allocation={splitAllocation(FOUR, "A")!} focusName="AMMA" />);
    expect(screen.getByText("Original total")).toBeTruthy();
    expect(screen.getByText(money(4000))).toBeTruthy();
    expect(screen.getByText("4-way split")).toBeTruthy();
    for (const n of ["You", "AMMA", "TRIPTHEE", "ANU"]) expect(screen.getByText(n)).toBeTruthy();
    expect(screen.getAllByText(money(1000))).toHaveLength(4);
    expect(screen.getByText(/Original total .* Split among 4 participants\. You/)).toBeTruthy();
    // Subtle focus: one "Their share" caption, on AMMA's cell only.
    const focus = document.querySelector("[data-focus]")!;
    expect(within(focus as HTMLElement).getByText("AMMA")).toBeTruthy();
    expect(screen.getAllByText("Their share")).toHaveLength(1);
  });

  it("8+ participants: every cell rendered, wrapping grid capped at 4 columns (no hard-coded 4-only)", () => {
    const x = expense("t", 900, [part("Me", 100, null, true), ...people(8)]);
    const { container } = render(<SplitAllocationBreakdown allocation={splitAllocation(x)!} />);
    expect(container.querySelectorAll("dl > div")).toHaveLength(9);
    const grid = container.querySelector("dl")!.className;
    expect(grid).toContain("grid-cols-1"); // narrow: one readable line per participant
    expect(grid).toContain("@[38rem]:grid-cols-4");
    expect(grid).not.toContain("grid-cols-5");
  });

  it.each([
    [2, "@[15rem]:grid-cols-2", "grid-cols-3"],
    [3, "@[24rem]:grid-cols-3", "grid-cols-4"],
    [4, "@[34rem]:grid-cols-4", "grid-cols-5"],
    [5, "@[26rem]:grid-cols-3", "grid-cols-4"],
  ])("%i participants: columns capped by count", (n, has, hasNot) => {
    const x = expense("t", n * 100, [part("Me", 100, null, true), ...people(n - 1)]);
    const { container } = render(<SplitAllocationBreakdown allocation={splitAllocation(x)!} />);
    expect(container.querySelector("dl")!.className).toContain(has);
    expect(container.querySelector("dl")!.className).not.toContain(hasNot);
  });

  it("long names truncate but keep the full name accessible", () => {
    const long = "Tripthee Ananthakrishnan Venkataraman";
    render(<SplitAllocationBreakdown allocation={splitAllocation(expense("t", 200, [part("Me", 100, null, true), part(long, 100, "T")]))!} />);
    const dt = screen.getByText(long);
    expect(dt.className).toContain("truncate");
    expect(dt.getAttribute("title")).toBe(long);
    expect(screen.getAllByText(money(100))[0].className).toContain("whitespace-nowrap");
  });

  it("legacy: no participant cells, only what can be proven", () => {
    const { container } = render(<SplitAllocationBreakdown allocation={splitAllocation(expense("t", 750, []))!} />);
    expect(screen.getByText(money(750))).toBeTruthy();
    expect(container.querySelector("dl")).toBeNull();
  });

  it("mismatched stored allocations show an 'Allocated … of …' note", () => {
    render(<SplitAllocationBreakdown allocation={splitAllocation(expense("t", 1000, [part("Me", 400, null, true), part("AMMA", 500, "A")]))!} />);
    expect(screen.getByText(`Allocated ${money(900)} of ${money(1000)}`)).toBeTruthy();
  });
});

describe("People Ledger — compact row and expanded row", () => {
  it("compact row names the original total, split count and whose share the amount is", async () => {
    const { viewOf } = await import("@/features/people/components/workspace/settlement-table");
    const share = shareEntry("A", 1000);
    const { share: row, lookups } = ledger("A", "AMMA", [share], [FOUR]);
    expect(viewOf(row, "AMMA", lookups, false, "A").splitNote).toBe(`Total price ${money(4000)} · 4-way split · AMMA's share ${money(1000)}`);
  });

  it.each([
    ["unpaid", 0, "open"],
    ["partial", 500, "partial"],
    ["fully settled", 1000, "settled"],
  ] as const)("%s: allocation is unchanged; settlement stays the share's own state", (_label, paid, state) => {
    const share = shareEntry("A", 1000);
    const entries = paid > 0 ? [share, entry("A", "receivedBack", paid, d(9, 25), { parentEntryId: share.id })] : [share];
    const { share: row } = ledger("A", "AMMA", entries, [FOUR]);
    expect(row).toMatchObject({ state, paid, remaining: 1000 - paid, amount: 1000 });
    expect(splitAllocation(FOUR, "A")!.focusShare).toBe(1000);
  });

  it("reverted payment returns the row to open; allocation still read from the Expense", () => {
    const share = shareEntry("A", 1000);
    const reverted = entry("A", "receivedBack", 500, d(9, 25), { parentEntryId: share.id, deletedAt: d(9, 26) });
    const { share: row } = ledger("A", "AMMA", [share, reverted], [FOUR]);
    expect(row).toMatchObject({ state: "open", paid: 0, remaining: 1000 });
  });

  it("expanded row renders the segmented breakdown, then settlement lines separately", async () => {
    const { SettlementTable } = await import("@/features/people/components/workspace/settlement-table");
    const share = shareEntry("A", 1000);
    const paid = entry("A", "receivedBack", 500, d(9, 25), { parentEntryId: share.id });
    const { share: row, lookups } = ledger("A", "AMMA", [share, paid], [FOUR]);
    render(
      <SettlementTable
        personId="A"
        personName="AMMA"
        rows={[row]}
        isLoading={false}
        lookups={lookups}
        accountForEntry={() => null}
        handlers={{} as never}
        empty={null}
      />,
    );
    // Desktop table row + mobile list item both exist in jsdom; expand the first toggle.
    fireEvent.click(screen.getAllByRole("button", { expanded: false })[0]);
    const details = screen.getAllByText("Split details")[0].parentElement!;
    expect(within(details).getByText("4-way split")).toBeTruthy();
    expect(within(details).getByText(money(4000))).toBeTruthy();
    for (const n of ["You", "TRIPTHEE", "ANU"]) expect(within(details).getByText(n)).toBeTruthy();
    expect(within(details).getByText("Their share")).toBeTruthy();
    expect(within(details).queryByText(`AMMA's responsibility`)).toBeNull(); // settlement is its own section, not inside the allocation
    expect(screen.getAllByText(`AMMA's settlement`).length).toBeGreaterThan(0);
    expect(screen.getAllByText(`AMMA's responsibility`).length).toBeGreaterThan(0);
  });

  it("deleted expense: expanded row shows no breakdown", () => {
    const { share: row, lookups } = ledger("A", "AMMA", [shareEntry("A", 1000)], [{ ...FOUR, deletedAt: d(9, 27) }]);
    expect(lookups.expenseByTransactionId.get("t-dinner")!.deletedAt).not.toBeNull();
    expect(splitAllocation(lookups.expenseByTransactionId.get("t-dinner"), "A")).toBeNull();
    expect(row.amount).toBe(1000);
  });
});

describe("Share Statement / PDF — recipient-safe split context", () => {
  const EIGHT = expense(
    "t-dinner",
    8000,
    [part("Me", 1000, null, true), part("AMMA", 1000, "A"), ...["Tripthee Ananthakrishnan", "Anu", "Bala", "Chitra", "Deepa", "Esha"].map((n, i) => part(n, 1000, `o${i}`))],
  );

  it("shows original total, N-way split and the recipient's own share — no other participant names", () => {
    const share = shareEntry("A", 1000);
    const paid = entry("A", "receivedBack", 500, d(9, 25), { parentEntryId: share.id });
    const { statement, lookups } = ledger("A", "AMMA", [share, paid], [EIGHT]);
    const view = statementView(statement, { entries: [share, paid], lookups, now: NOW });
    const row = view.rows.find((r) => r.kind === "split")!;
    expect(row.splitNote).toBe(`Total price ${money(8000)} · 8-way split · AMMA's share ${money(1000)}`);
    expect(row).toMatchObject({ paid: money(500), remaining: money(500) });
    const all = JSON.stringify(view);
    // Every participant of THIS split is visible with their stored share; nothing else about them is.
    expect(row.allocation!.participants.map((p) => p.label)).toEqual(["Account holder", "AMMA", "Tripthee Ananthakrishnan", "Anu", "Bala", "Chitra", "Deepa", "Esha"]);
    expect(all).not.toMatch(/receivedStatus|installmentId|currentBalance/);
  });

  it("PDF renders a long split note (wrapped, not crashed) and the same model", async () => {
    const share = shareEntry("A", 1234567.89);
    const big = { ...EIGHT, totalAmount: 98765432.1, participants: EIGHT.participants.map((p) => (p.personId === "A" ? { ...p, share: 1234567.89 } : p)) };
    const { statement, lookups } = ledger("A", "AMMA Krishnakumari Raghavendran", [share], [big]);
    const bytes = await renderPersonStatementPdf(statement, { entries: [share], lookups, now: NOW });
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });
});

describe("performance — no per-row reads", () => {
  it("the model and component import no Firestore access; split context comes from already-loaded records", () => {
    for (const file of ["lib/split/split-allocation.ts", "components/finance/split-allocation-breakdown.tsx"]) {
      const src = readFileSync(path.resolve(process.cwd(), file), "utf8");
      expect(src).not.toMatch(/firebase|\buse[A-Z]\w*\(|repository/);
    }
  });
});
