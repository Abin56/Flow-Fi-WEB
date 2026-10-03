// @vitest-environment jsdom
import { inflateSync } from "node:zlib";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SplitAllocationBreakdown } from "@/components/finance/split-allocation-breakdown";
import { statementView } from "@/features/people/lib/person-statement-pdf-model";
import { pdfSafe, renderPersonStatementPdf } from "@/features/people/lib/person-statement-pdf";
import type { SettlementLookups } from "@/features/people/lib/settlement-presentation";
import { buildPersonCycleStatement, cycleContaining } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import type { Expense, ExpenseParticipant } from "@/lib/models/expense";
import type { LedgerEntry } from "@/lib/models/person";

/**
 * Shared People statement (preview + PDF): a split row carries the expense's full stored allocation —
 * `Expense.totalAmount` and every `ExpenseParticipant.share` — so the recipient can verify how the bill was
 * divided. Preview and PDF read the same `statementView` row. Nothing else about other people is exposed.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
afterEach(cleanup);

const d = (month: number, day: number) => new Date(2026, month - 1, day);
const NOW = d(9, 30);

const part = (name: string, share: number, personId: string | null, isMe = false): ExpenseParticipant => ({
  personId,
  name,
  share,
  installmentId: isMe ? null : `inst-${name}`,
  isMe,
  receivedStatus: isMe ? "notApplicable" : "yetToReceive",
});

const expense = (tx: string, total: number, participants: ExpenseParticipant[], description = "BEVCO - ONAM", patch: Partial<Expense> = {}): Expense =>
  ({
    id: `x-${tx}`,
    description,
    totalAmount: total,
    date: d(9, 21),
    categoryId: "food",
    accountId: "acc-private",
    transactionId: tx,
    splitType: "custom",
    participants,
    scheduleId: "s1",
    notes: "PRIVATE NOTE",
    createdAt: d(9, 21),
    deletedAt: null,
    ...patch,
  }) as Expense;

let seq = 0;
const shareEntry = (x: Expense, amount: number): LedgerEntry => {
  seq += 1;
  return {
    id: `e${seq}`,
    personId: "S",
    type: "gave",
    amount,
    date: d(9, 21),
    note: `Split: ${x.description}`,
    increasesBalance: true,
    transactionRef: x.transactionId,
    parentEntryId: null,
    sourceKind: "splitExpense",
    createdAt: new Date(d(9, 21).getTime() + seq),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    receivedStatus: "yetToReceive",
  } as LedgerEntry;
};

/** Sojan's statement for the given split shares; `extra` expenses are loaded but unrelated to Sojan. */
function sojan(items: { x: Expense; share: number }[], extra: Expense[] = []) {
  const entries = items.map(({ x, share }) => shareEntry(x, share));
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
  const lookups: SettlementLookups = {
    entriesById: new Map(entries.map((e) => [e.id, e])),
    expenseByTransactionId: new Map([...items.map(({ x }) => x), ...extra].filter((x) => x.deletedAt == null).map((x) => [x.transactionId, x])),
  };
  const options = { entries, lookups, now: NOW, ownerName: "Ibin John" };
  return { statement, options, view: statementView(statement, options), entries };
}

/** Every string pdf-lib drew (its content streams hold hex-encoded WinAnsi text), joined in order. */
async function pdfText(statement: ReturnType<typeof sojan>["statement"], options: ReturnType<typeof sojan>["options"]): Promise<string> {
  const bytes = await renderPersonStatementPdf(statement, options);
  const buf = Buffer.from(bytes);
  const raw = buf.toString("latin1");
  // Content streams are Flate-compressed: inflate each "stream … endstream" body, keep uncompressed ones as-is.
  const bodies: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = raw.indexOf("endstream", start);
    const chunk = buf.subarray(start, end);
    try {
      bodies.push(inflateSync(chunk).toString("latin1"));
    } catch {
      bodies.push(chunk.toString("latin1"));
    }
  }
  const shown = [...bodies.join("\n").matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((m) => Buffer.from(m[1], "hex").toString("latin1"));
  return shown.join("\n");
}

const pdfMoney = (n: number) => pdfSafe(money(n));
const BEVCO = expense("t-bevco", 2080, [part("Me", 520, null, true), part("AMMA", 520, "A"), part("Sojan", 490, "S"), part("Tripthee", 550, "T")]);

describe("shared statement — split allocation is transparent", () => {
  it("1–4. ₹2,080 custom split: original + every stored share, recipient marked, unequal shares kept, sums to the total", async () => {
    const { view, statement, options } = sojan([{ x: BEVCO, share: 490 }]);
    const row = view.rows.find((r) => r.kind === "split")!;
    const a = row.allocation!;
    expect(a.original).toBe(2080);
    expect(a.participants.map((p) => [p.label, p.amount, p.isFocus])).toEqual([
      ["Ibin John", 520, false],
      ["AMMA", 520, false],
      ["Sojan", 490, true],
      ["Tripthee", 550, false],
    ]);
    expect(new Set(a.participants.map((p) => p.amount)).size).toBe(3); // not flattened to 2,080 ÷ 4
    expect(a).toMatchObject({ allocated: 2080, reconciles: true, participantCount: 4 });
    // Settlement columns keep their meaning: Sojan's obligation, not the purchase total.
    expect(row).toMatchObject({ original: money(490), paid: money(0), remaining: money(490) });

    const text = await pdfText(statement, options);
    expect(text).toContain(pdfMoney(2080));
    expect(text).toContain("4-way split");
    for (const [n, amt] of [["Ibin John", 520], ["AMMA", 520], ["Sojan", 490], ["Tripthee", 550]] as const) {
      expect(text).toContain(n);
      expect(text).toContain(pdfMoney(amt));
    }
    expect(text).toContain("Sojan's share");
  });

  it("5. odd paise remain exact in model, preview and PDF", async () => {
    const x = expense("t-odd", 1000.01, [part("Me", 333.34, null, true), part("Sojan", 333.34, "S"), part("Tripthee", 333.33, "T")]);
    const { view, statement, options } = sojan([{ x, share: 333.34 }]);
    const a = view.rows[0].allocation!;
    expect(a.participants.map((p) => p.amount)).toEqual([333.34, 333.34, 333.33]);
    expect(a.allocated).toBe(1000.01);
    const { container } = render(<SplitAllocationBreakdown allocation={a} variant="compact" focusCaption="Sojan's share" />);
    expect([...container.querySelectorAll("dd")].map((dd) => dd.firstChild!.textContent)).toEqual([money(333.34), money(333.34), money(333.33)]);
    const text = await pdfText(statement, options);
    expect(text).toContain(pdfMoney(1000.01));
    expect(text).toContain(pdfMoney(333.33));
  });

  it.each([2, 3, 4, 5, 8, 12])("6. %i participants: every allocation in preview and PDF", async (n) => {
    const others = Array.from({ length: n - 2 }, (_, i) => part(`Friend ${i + 1}`, 100 + i, `f${i}`));
    const x = expense(`t-${n}`, others.reduce((s, p) => s + p.share, 0) + 200, [part("Me", 100, null, true), part("Sojan", 100, "S"), ...others]);
    const { view, statement, options } = sojan([{ x, share: 100 }]);
    const a = view.rows[0].allocation!;
    expect(a.participants).toHaveLength(n);
    const { container } = render(<SplitAllocationBreakdown allocation={a} variant="compact" />);
    expect(container.querySelectorAll("dl > div")).toHaveLength(n);
    const text = await pdfText(statement, options);
    expect(text).toContain(`${n}-way split`);
    for (const p of a.participants) {
      expect(text).toContain(p.label);
      expect(text).toContain(pdfMoney(p.amount));
    }
  });

  it("7. long names wrap (never cut) and never hide the amount", async () => {
    const long = "Tripthee Ananthakrishnan Venkataraman Subramaniam Iyer";
    const x = expense("t-long", 1500, [part("Me", 500, null, true), part("Sojan", 500, "S"), part(long, 500, "T")]);
    const { view, statement, options } = sojan([{ x, share: 500 }]);
    const { getByText } = render(<SplitAllocationBreakdown allocation={view.rows[0].allocation!} variant="compact" />);
    const dt = getByText(long);
    expect(dt.className).toContain("break-words");
    expect(dt.className).not.toContain("truncate");
    expect(dt.nextElementSibling!.className).toContain("whitespace-nowrap");
    const text = await pdfText(statement, options);
    // Every word of the name is drawn (wrapped by word, no "..." truncation), and the amount too.
    for (const word of long.split(" ")) expect(text).toContain(word);
    expect(text).not.toMatch(/Subram\.\.\./);
  });

  it("8. preview and PDF read the same statement row", async () => {
    const { view, statement, options } = sojan([{ x: BEVCO, share: 490 }]);
    // The preview renders `view.rows[].allocation`; the PDF is built from `statementView(statement, options)` — same call.
    expect(statementView(statement, options).rows[0].allocation).toEqual(view.rows[0].allocation);
    const { container } = render(<SplitAllocationBreakdown allocation={view.rows[0].allocation!} variant="compact" focusCaption="Sojan's share" />);
    const previewCells = [...container.querySelectorAll("dl > div")].map((c) => [c.querySelector("dt")!.textContent!, c.querySelector("dd")!.firstChild!.textContent!] as const);
    const text = await pdfText(statement, options);
    for (const [name, amt] of previewCells) {
      expect(text).toContain(name);
      expect(text).toContain(pdfSafe(amt));
    }
    expect(container.textContent).toContain("Split between 4 people");
    expect(container.textContent).toContain("Sojan's share");
  });

  it("9. legacy Expense without participants: no invented cells, falls back to the proven original total", async () => {
    const legacy = expense("t-legacy", 750, []);
    const { view, statement, options } = sojan([{ x: legacy, share: 750 }]);
    const row = view.rows[0];
    expect(row.allocation!.participants).toEqual([]);
    expect(row.allocation!.original).toBe(750);
    // Preview: the proven total only — "Original ₹750 · Split expense", no participant cells.
    const { container } = render(<SplitAllocationBreakdown allocation={row.allocation!} variant="compact" />);
    expect(container.textContent).toContain("Split expense");
    expect(container.querySelector("dl")).toBeNull();
    const text = await pdfText(statement, options);
    expect(text).toContain("ORIGINAL PURCHASE");
    expect(text).toContain(pdfMoney(750));
    expect(text).toContain("Split expense");
    expect(text).not.toContain("-way split");
  });

  it("10. deleted split expense: no stale allocation", async () => {
    const { view, statement, options } = sojan([{ x: { ...BEVCO, deletedAt: d(9, 28) }, share: 490 }]);
    expect(view.rows[0].allocation ?? null).toBeNull();
    const text = await pdfText(statement, options);
    expect(text).not.toContain("Tripthee");
    expect(text).not.toContain("-way split");
  });

  it("11. an edited split shows the edited stored allocation in the next statement", () => {
    const edited = expense("t-bevco", 2080, [part("Me", 700, null, true), part("AMMA", 400, "A"), part("Sojan", 430, "S"), part("Tripthee", 550, "T")]);
    expect(sojan([{ x: BEVCO, share: 490 }]).view.rows[0].allocation!.participants.map((p) => p.amount)).toEqual([520, 520, 490, 550]);
    expect(sojan([{ x: edited, share: 430 }]).view.rows[0].allocation!.participants.map((p) => p.amount)).toEqual([700, 400, 430, 550]);
  });

  it("12. building, previewing and exporting performs no writes (inputs untouched)", async () => {
    const s = sojan([{ x: BEVCO, share: 490 }]);
    const snapshot = JSON.stringify({ entries: s.entries, expense: BEVCO });
    render(<SplitAllocationBreakdown allocation={s.view.rows[0].allocation!} variant="compact" />);
    await renderPersonStatementPdf(s.statement, s.options);
    expect(JSON.stringify({ entries: s.entries, expense: BEVCO })).toBe(snapshot);
  });

  it("13. unrelated private data stays out: other expenses, notes, accounts, statuses", async () => {
    const unrelated = expense("t-other", 9999, [part("Me", 4999, null, true), part("Ravi Secret", 5000, "R")], "Ravi private dinner");
    const { view, statement, options } = sojan([{ x: BEVCO, share: 490 }], [unrelated]);
    const all = JSON.stringify(view);
    for (const secret of ["Ravi", "9,999", "PRIVATE NOTE", "acc-private", "inst-", "receivedStatus", "yetToReceive"]) expect(all).not.toContain(secret);
    const text = await pdfText(statement, options);
    for (const secret of ["Ravi", "PRIVATE NOTE", "acc-private"]) expect(text).not.toContain(secret);
  });
});
