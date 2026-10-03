// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLedgerRows, type LedgerRow } from "@/features/people/lib/person-ledger-rows";
import { statementView } from "@/features/people/lib/person-statement-pdf-model";
import type { SettlementLookups } from "@/features/people/lib/settlement-presentation";
import { buildPersonCycleStatement, cycleContaining } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import type { Expense, ExpenseParticipant } from "@/lib/models/expense";
import type { LedgerEntry, LedgerEntryType } from "@/lib/models/person";
import { SettlementTable } from "./settlement-table";

/**
 * The REAL People Ledger table (`SettlementTable`, the component both the compact Person view and the
 * expanded Transactions ledger mount) for split rows: the collapsed row's separate split facts, the row's
 * own chevron/expand, and the full stored allocation inside that row's expansion. Data flows through the
 * real engine (`buildPersonCycleStatement` → `buildLedgerRows`) and the lookups shape the hook builds.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
afterEach(cleanup);

const d = (month: number, day: number) => new Date(2026, month - 1, day);
const NOW = d(9, 30);

const part = (name: string, share: number, personId: string | null, isMe = false): ExpenseParticipant => ({
  personId,
  name,
  share,
  installmentId: isMe ? null : `i-${name}`,
  isMe,
  receivedStatus: isMe ? "notApplicable" : "yetToReceive",
});

const expense = (transactionId: string, totalAmount: number, participants: ExpenseParticipant[], description = "BEVCO - ONAM"): Expense =>
  ({
    id: `x-${transactionId}`,
    description,
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
  }) as Expense;

let seq = 0;
function entry(type: LedgerEntryType, amount: number, patch: Partial<LedgerEntry> = {}): LedgerEntry {
  seq += 1;
  return {
    id: `e${seq}`,
    personId: "S",
    type,
    amount,
    date: d(9, 21),
    note: "",
    increasesBalance: true,
    transactionRef: null,
    parentEntryId: null,
    createdAt: new Date(d(9, 21).getTime() + seq * 1000),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    receivedStatus: "yetToReceive",
    ...patch,
  };
}

/** Sojan's ledger with one split share (and optional payment), as the People workspace builds it. */
function sojanLedger(x: Expense, share: number, paid = 0) {
  const obligation = entry("gave", share, { note: `Split: ${x.description}`, sourceKind: "splitExpense", transactionRef: x.transactionId });
  const entries = paid > 0 ? [obligation, entry("receivedBack", paid, { date: d(9, 25), parentEntryId: obligation.id })] : [obligation];
  const statement = buildPersonCycleStatement({
    person: { id: "S", name: "Sojan", openingBalance: 0, createdAt: d(1, 1) },
    ledgerEntries: entries,
    loanIds: new Set(),
    emis: [],
    loans: [],
    installments: [],
    cycle: cycleContaining(NOW),
    now: NOW,
  });
  const rows = buildLedgerRows({ statement, history: statement, entries, pending: [], now: NOW });
  const lookups: SettlementLookups = { entriesById: new Map(entries.map((e) => [e.id, e])), expenseByTransactionId: new Map([[x.transactionId, x]]) };
  return { statement, rows, lookups, entries };
}

function renderTable(rows: LedgerRow[], lookups: SettlementLookups) {
  return render(<SettlementTable personId="S" personName="Sojan" rows={rows} isLoading={false} lookups={lookups} accountForEntry={() => null} handlers={{} as never} empty={null} />);
}

/** The desktop table row for a title (jsdom renders the md+ table and the mobile list side by side). */
const tableRow = (title: string) => screen.getAllByText(title).map((el) => el.closest("tr")).find(Boolean) as HTMLTableRowElement;
const expansionOf = (row: HTMLTableRowElement) => row.nextElementSibling as HTMLTableRowElement;
const cells = (scope: HTMLElement) =>
  [...scope.querySelectorAll("section dl > div")].map((c) => [c.querySelector("dt")!.textContent, c.querySelector("dd")!.firstChild!.textContent]);

// The screenshot's structure: ₹2,080 total, 4 people, Sojan's share ₹490 (others valid and summing to ₹2,080).
const BEVCO = expense("t-bevco", 2080, [part("Me", 520, null, true), part("AMMA", 520, "A"), part("Sojan", 490, "S"), part("Tripthee", 550, "T")]);

describe("People Ledger table — split row, collapsed", () => {
  it("1–5. shows split count, Original ₹2,080 and Sojan's share ₹490 as separate facts; never the share as the original", () => {
    const { rows, lookups } = sojanLedger(BEVCO, 490);
    renderTable(rows, lookups);
    const tr = tableRow("BEVCO - ONAM");
    expect(within(tr).getByText("Split expense · 4 people")).toBeTruthy();
    const original = within(tr).getByText("Original").parentElement!;
    expect(original.textContent!.replace(/\s/g, "")).toBe(`Original${money(2080)}`.replace(/\s/g, ""));
    const share = within(tr).getAllByText("Sojan's share")[0].parentElement!;
    expect(share.textContent!.replace(/\s/g, "")).toBe(`Sojan'sshare${money(490)}`.replace(/\s/g, ""));
    // The old one-sentence line is gone.
    expect(tr.textContent).not.toContain("Total price");
    // Amount column: header is "Amount" (not "Original"), and the ₹490 is captioned as Sojan's share.
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toContain("Amount");
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).not.toContain("Original");
    const amountCell = within(tr).getAllByText(money(490)).map((el) => el.closest("td")!).find((td) => td.textContent!.includes("Sojan's share") && !td.textContent!.includes("Original"))!;
    expect(amountCell).toBeTruthy();
    // Collapsed: no participant matrix yet.
    expect(within(expansionOf(tr)).queryByText("Tripthee")).toBeNull();
  });

  it("split rows sit on a neutral surface (no category tint)", () => {
    const { rows, lookups } = sojanLedger(BEVCO, 490);
    renderTable(rows, lookups);
    const tr = tableRow("BEVCO - ONAM");
    expect(tr.className).toContain("bg-card");
    expect(tr.className).not.toContain("bg-settle-split-tint");
  });
});

describe("People Ledger table — split row, expanded through the row's own toggle", () => {
  it("6–13. click the row → full stored allocation under THAT row; settlement separate; click again collapses", () => {
    const { rows, lookups } = sojanLedger(BEVCO, 490);
    renderTable(rows, lookups);
    const tr = tableRow("BEVCO - ONAM");
    expect(tr.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(tr);
    expect(tr.getAttribute("aria-expanded")).toBe("true");
    const exp = expansionOf(tr);
    expect(within(exp).getByText("Split details")).toBeTruthy();
    const section = exp.querySelector("section")!;
    expect(within(section).getByText("Original total")).toBeTruthy();
    expect(within(section).getByText(money(2080))).toBeTruthy();
    expect(within(section).getByText("4-way split")).toBeTruthy();
    expect(cells(exp)).toEqual([
      ["You", money(520)],
      ["AMMA", money(520)],
      ["Sojan", money(490)],
      ["Tripthee", money(550)],
    ]);
    // Subtle focus on Sojan only.
    const focus = section.querySelectorAll("[data-focus]");
    expect(focus).toHaveLength(1);
    expect(focus[0].querySelector("dt")!.textContent).toBe("Sojan");
    expect(within(focus[0] as HTMLElement).getByText("Their share")).toBeTruthy();
    // 11. allocations reconcile (no "Allocated … of …" mismatch note).
    expect(within(section).queryByText(/Allocated/)).toBeNull();
    // 12–13. settlement is its own block, outside the allocation section.
    expect(within(exp).getByText("Sojan's settlement")).toBeTruthy();
    expect(within(section).queryByText("Remaining")).toBeNull();
    expect(within(section).queryByText(/paid/i)).toBeNull();
    fireEvent.click(tr);
    expect(tr.getAttribute("aria-expanded")).toBe("false");
  });

  it("partial payment: allocation stays ₹490; Paid ₹200 / Remaining ₹290 only in settlement", () => {
    const { rows, lookups } = sojanLedger(BEVCO, 490, 200);
    renderTable(rows, lookups);
    const tr = tableRow("BEVCO - ONAM");
    fireEvent.click(tr);
    const exp = expansionOf(tr);
    expect(cells(exp).find(([n]) => n === "Sojan")![1]).toBe(money(490));
    const settlement = within(exp).getByText("Sojan's settlement").parentElement!;
    expect(within(settlement).getByText("Sojan paid").nextElementSibling!.textContent).toBe(money(200));
    expect(within(settlement).getByText("Remaining").nextElementSibling!.textContent).toBe(money(290));
    expect(exp.querySelector("section")!.textContent).not.toContain(money(290));
  });

  it("14. custom unequal split shows exactly the stored shares", () => {
    const x = expense("t-c", 10000, [part("Me", 4000, null, true), part("AMMA", 3500, "A"), part("Sojan", 2000, "S"), part("ANU", 500, "N")]);
    const { rows, lookups } = sojanLedger(x, 2000);
    renderTable(rows, lookups);
    fireEvent.click(tableRow("BEVCO - ONAM"));
    expect(cells(expansionOf(tableRow("BEVCO - ONAM"))).map(([, a]) => a)).toEqual([money(4000), money(3500), money(2000), money(500)]);
  });

  it("15. odd-paise split shows exactly the stored paise", () => {
    const x = expense("t-p", 1000.01, [part("Me", 333.34, null, true), part("Sojan", 333.34, "S"), part("Tripthee", 333.33, "T")]);
    const { rows, lookups } = sojanLedger(x, 333.34);
    renderTable(rows, lookups);
    fireEvent.click(tableRow("BEVCO - ONAM"));
    expect(cells(expansionOf(tableRow("BEVCO - ONAM"))).map(([, a]) => a)).toEqual([money(333.34), money(333.34), money(333.33)]);
  });

  it.each([
    [5, "@[26rem]:grid-cols-3"],
    [8, "@[38rem]:grid-cols-4"],
  ])("16–19. %i participants: every participant rendered; narrow = one per line, wider = wrapped grid", (n, wide) => {
    const others = Array.from({ length: n - 2 }, (_, i) => part(`Friend ${i + 1}`, 100, `f${i}`));
    const x = expense("t-n", 100 * n, [part("Me", 100, null, true), part("Sojan", 100, "S"), ...others]);
    const { rows, lookups } = sojanLedger(x, 100);
    renderTable(rows, lookups);
    fireEvent.click(tableRow("BEVCO - ONAM"));
    const exp = expansionOf(tableRow("BEVCO - ONAM"));
    expect(within(tableRow("BEVCO - ONAM")).getByText(`Split expense · ${n} people`)).toBeTruthy();
    expect(cells(exp)).toHaveLength(n);
    const grid = exp.querySelector("section dl")!.className;
    expect(grid).toContain("grid-cols-1"); // very narrow: vertical list, nobody hidden
    expect(grid).toContain("@[15rem]:grid-cols-2"); // narrow: 2 columns
    expect(grid).toContain(wide);
  });

  it("breakdown spans the expansion's full width (outside the 3-column detail grid)", () => {
    const { rows, lookups } = sojanLedger(BEVCO, 490);
    renderTable(rows, lookups);
    fireEvent.click(tableRow("BEVCO - ONAM"));
    const section = expansionOf(tableRow("BEVCO - ONAM")).querySelector("section")!;
    expect(section.closest('[class*="md:grid-cols-2"]')).toBeNull();
  });
});

describe("Shared statement — this split's full allocation, nothing else", () => {
  it("20. Sojan's shared statement has Original ₹2,080, 4-way split, Sojan's share ₹490 — and every stored share of this split", () => {
    const { statement, lookups, entries } = sojanLedger(BEVCO, 490);
    const view = statementView(statement, { entries, lookups, now: NOW });
    expect(view.rows.find((r) => r.kind === "split")!.splitNote).toBe(`Total price ${money(2080)} · 4-way split · Sojan's share ${money(490)}`);
    const all = JSON.stringify(view);
    expect(view.rows.find((r) => r.kind === "split")!.allocation!.participants.map((p) => [p.label, p.amount, p.isFocus])).toEqual([
      ["Account holder", 520, false],
      ["AMMA", 520, false],
      ["Sojan", 490, true],
      ["Tripthee", 550, false],
    ]);
    expect(all).not.toMatch(/receivedStatus|installmentId|currentBalance/);
  });
});
