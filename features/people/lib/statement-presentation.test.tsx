// @vitest-environment jsdom
import { inflateSync } from "node:zlib";
import { cleanup, render } from "@testing-library/react";
import { PDFArray, PDFDocument, PDFRawStream, PDFRef } from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SplitAllocationBreakdown } from "@/components/finance/split-allocation-breakdown";
import { OWNER_FALLBACK, STATEMENT_COPY, statementView, type StatementViewOptions } from "@/features/people/lib/person-statement-pdf-model";
import { allocationColumns, pdfSafe, renderPersonStatementPdf } from "@/features/people/lib/person-statement-pdf";
import type { SettlementLookups } from "@/features/people/lib/settlement-presentation";
import { buildPersonCycleStatement, cycleContaining } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import type { Expense, ExpenseParticipant } from "@/lib/models/expense";
import type { LedgerEntry, LedgerEntryType } from "@/lib/models/person";
import { splitAllocation } from "@/lib/split/split-allocation";

/**
 * Recipient-facing statement presentation (Share preview + PDF): the owner is named (never "You"), the purchase
 * total and the recipient's share are labelled for what they are, every stored allocation is shown as stored,
 * and a split transaction is drawn as one unit that never breaks across pages. Presentation only — no figure
 * here is computed by the view; each comes from `Expense.totalAmount`, `ExpenseParticipant.share` or the engine.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
afterEach(cleanup);

const d = (month: number, day: number) => new Date(2026, month - 1, day);
const NOW = d(9, 30);
const OWNER = "Ibin John";

const part = (name: string, share: number, personId: string | null, isMe = false): ExpenseParticipant => ({
  personId,
  name,
  share,
  installmentId: isMe ? null : `inst-${name}`,
  isMe,
  receivedStatus: isMe ? "notApplicable" : "yetToReceive",
});

let txSeq = 0;
const expense = (total: number, participants: ExpenseParticipant[], description = "ZOMATO LTD", date = d(9, 21)): Expense => {
  txSeq += 1;
  return {
    id: `x-${txSeq}`,
    description,
    totalAmount: total,
    date,
    categoryId: "food",
    accountId: "acc-private",
    transactionId: `t-${txSeq}`,
    splitType: "custom",
    participants,
    scheduleId: "s1",
    notes: "PRIVATE NOTE",
    createdAt: date,
    deletedAt: null,
  } as Expense;
};

let seq = 0;
const entry = (type: LedgerEntryType, amount: number, date: Date, patch: Partial<LedgerEntry> = {}): LedgerEntry => {
  seq += 1;
  return {
    id: `e${seq}`,
    personId: "S",
    type,
    amount,
    date,
    note: "",
    increasesBalance: type === "gave",
    transactionRef: null,
    parentEntryId: null,
    createdAt: new Date(date.getTime() + seq * 1000),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    receivedStatus: "yetToReceive",
    ...patch,
  } as LedgerEntry;
};
const shareEntry = (x: Expense, amount: number) =>
  entry("gave", amount, x.date, { note: `Split: ${x.description}`, sourceKind: "splitExpense", transactionRef: x.transactionId });

/** Sojan's statement. `payments` maps an item index to an amount received back against it. */
function sojan(items: { x: Expense; share: number }[], opts: { payments?: Record<number, number>; extra?: Expense[]; ownerName?: string | null; history?: boolean } = {}) {
  const shares = items.map(({ x, share }) => shareEntry(x, share));
  const paid = Object.entries(opts.payments ?? {}).map(([i, amt]) => entry("receivedBack", amt, d(9, 26), { parentEntryId: shares[Number(i)].id }));
  const entries = [...shares, ...paid];
  const build = (cycle: ReturnType<typeof cycleContaining>) =>
    buildPersonCycleStatement({
      person: { id: "S", name: "Sojan", openingBalance: 0, createdAt: d(1, 1) },
      ledgerEntries: entries,
      loanIds: new Set(),
      emis: [],
      loans: [],
      installments: [],
      cycle,
      now: NOW,
    });
  const statement = build(cycleContaining(NOW));
  const lookups: SettlementLookups = {
    entriesById: new Map(entries.map((e) => [e.id, e])),
    expenseByTransactionId: new Map([...items.map(({ x }) => x), ...(opts.extra ?? [])].map((x) => [x.transactionId, x])),
  };
  const options: StatementViewOptions = {
    entries,
    lookups,
    now: NOW,
    ownerName: opts.ownerName === undefined ? OWNER : opts.ownerName,
    ...(opts.history ? { history: build({ start: d(1, 1), end: d(12, 31) } as ReturnType<typeof cycleContaining>) } : {}),
  };
  return { statement, options, view: statementView(statement, options) };
}

/** Each PDF page's drawn strings, in order (pdf-lib content streams hold hex WinAnsi text). */
async function pdfPages(s: ReturnType<typeof sojan>): Promise<string[]> {
  const bytes = await renderPersonStatementPdf(s.statement, s.options);
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const c = page.node.Contents();
    const refs = c instanceof PDFArray ? c.asArray() : [c];
    const body = refs
      .map((r) => {
        const stream = (r instanceof PDFRef ? doc.context.lookup(r) : r) as PDFRawStream;
        const raw = Buffer.from(stream.contents);
        try {
          return inflateSync(raw).toString("latin1");
        } catch {
          return raw.toString("latin1");
        }
      })
      .join("\n");
    return [...body.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((m) => Buffer.from(m[1], "hex").toString("latin1")).join("\n");
  });
}
const pdfText = async (s: ReturnType<typeof sojan>) => (await pdfPages(s)).join("\n");
const pm = (n: number) => pdfSafe(money(n));
const preview = (s: ReturnType<typeof sojan>, i = 0) => render(<SplitAllocationBreakdown allocation={s.view.rows[i].allocation!} variant="compact" focusCaption="Sojan's share" />);
const cellLines = (text: string) => text.split("\n");

const ZOMATO = () => expense(882.96, [part("Me", 220.74, null, true), part("Kannappan", 220.74, "K"), part("Shambu", 220.74, "H"), part("Sojan", 220.74, "S")]);

describe("owner and recipient identity", () => {
  it("S. the owner's cell is the profile name in model, preview and PDF — never \"You\"", async () => {
    const s = sojan([{ x: ZOMATO(), share: 220.74 }]);
    const a = s.view.rows[0].allocation!;
    expect(a.participants.map((p) => p.label)).toEqual([OWNER, "Kannappan", "Shambu", "Sojan"]);
    expect(s.view.ownerName).toBe(OWNER);
    const { container } = preview(s);
    const names = [...container.querySelectorAll("dt")].map((n) => n.textContent);
    expect(names).toEqual([OWNER, "Kannappan", "Shambu", "Sojan"]);
    expect(names).not.toContain("You");
    const lines = cellLines(await pdfText(s));
    expect(lines).toContain(OWNER);
    expect(lines).not.toContain("You");
    expect(lines.join("\n")).toContain(`Prepared by ${OWNER}`);
  });

  it("S. no profile name: a neutral fallback, still never \"You\" or \"Me\"", async () => {
    for (const ownerName of [null, "", "   "]) {
      const s = sojan([{ x: ZOMATO(), share: 220.74 }], { ownerName });
      expect(s.view.rows[0].allocation!.participants[0].label).toBe(OWNER_FALLBACK);
      const lines = cellLines(await pdfText(s));
      expect(lines).not.toContain("You");
      expect(lines).not.toContain("Me");
    }
  });

  it("private UI keeps \"You\" (no owner name passed to the allocation)", () => {
    expect(splitAllocation(ZOMATO(), "S")!.participants[0].label).toBe("You");
  });

  it("T. the recipient is the focus cell, captioned with their own name", async () => {
    const s = sojan([{ x: ZOMATO(), share: 220.74 }]);
    const a = s.view.rows[0].allocation!;
    expect(a.participants.filter((p) => p.isFocus).map((p) => p.label)).toEqual(["Sojan"]);
    expect(a.participants.find((p) => p.isMe)!.isFocus).toBe(false);
    expect(preview(s).container.querySelector("[data-focus] dt")!.textContent).toBe("Sojan");
    expect(await pdfText(s)).toContain("Sojan's share");
  });
});

describe("original purchase vs recipient's share", () => {
  it("A. equal 4-way ₹882.96: original is Expense.totalAmount; the row's amount is labelled as Sojan's share", async () => {
    const s = sojan([{ x: ZOMATO(), share: 220.74 }]);
    const row = s.view.rows[0];
    expect(row.allocation!.original).toBe(882.96);
    expect(row).toMatchObject({ original: money(220.74), amountLabel: "Sojan's share", paid: money(0), remaining: money(220.74) });
    const text = await pdfText(s);
    expect(text).toContain("ORIGINAL PURCHASE");
    expect(text).toContain(pm(882.96));
    expect(text).toContain("4-way split");
    expect(text).not.toMatch(/\nOriginal\n/); // the old ambiguous column header is gone
  });

  it("B/V. unequal custom ₹2,080 (610 / 490 / 490 / 490) is shown as stored, never re-derived", async () => {
    const x = expense(2080, [part("Me", 610, null, true), part("Kannappan", 490, "K"), part("Shambu", 490, "H"), part("Sojan", 490, "S")]);
    const s = sojan([{ x, share: 490 }]);
    const a = s.view.rows[0].allocation!;
    expect(a.participants.map((p) => p.amount)).toEqual([610, 490, 490, 490]);
    expect(a.original).toBe(2080);
    expect(a.original).not.toBe(490 * 4);
    const text = await pdfText(s);
    expect(text).toContain(pm(610));
    expect(text).toContain(pm(2080));
  });

  it("C/U. odd paise: allocations sum to Expense.totalAmount exactly", async () => {
    const x = expense(100.01, [part("Me", 33.34, null, true), part("Kannappan", 33.34, "K"), part("Sojan", 33.33, "S")]);
    const s = sojan([{ x, share: 33.33 }]);
    const a = s.view.rows[0].allocation!;
    expect(a).toMatchObject({ allocated: 100.01, reconciles: true });
    expect(s.view.rows[0].amountLabel).toBe("Sojan's share");
    expect(await pdfText(s)).toContain(pm(33.33));
  });

  it("U. stored allocations that don't add up are shown as stored, with the discrepancy — never forced", async () => {
    const x = expense(1000, [part("Me", 300, null, true), part("Sojan", 300, "S")]);
    const s = sojan([{ x, share: 300 }]);
    expect(s.view.rows[0].allocation).toMatchObject({ allocated: 600, reconciles: false });
    expect(await pdfText(s)).toContain(`Allocated ${pm(600)} of ${pm(1000)}`);
  });

  it("D. owner share ₹0: no owner cell, recipient still identified", async () => {
    const x = expense(900, [part("Me", 0, null, true), part("Kannappan", 450, "K"), part("Sojan", 450, "S")]);
    const s = sojan([{ x, share: 450 }]);
    const a = s.view.rows[0].allocation!;
    expect(a.participants.map((p) => p.label)).toEqual(["Kannappan", "Sojan"]);
    expect(a.myShare).toBe(0);
    expect(s.view.rows[0].amountLabel).toBe("Sojan's share");
    const lines = cellLines(await pdfText(s));
    expect(lines).toContain("2-way split");
    // The owner is named only where the statement states the direction (header + ending), never as a split cell.
    expect(lines.filter((l) => l === OWNER)).toHaveLength(2);
  });

  it("E. recipient share ₹0 on the expense: no focus cell, no false \"Sojan's share\" label", () => {
    const x = expense(900, [part("Me", 450, null, true), part("Kannappan", 450, "K"), part("Sojan", 0, "S")]);
    const a = splitAllocation(x, "S", OWNER)!;
    expect(a.participants.some((p) => p.isFocus)).toBe(false);
    expect(a.focusShare).toBe(0);
    // A row whose amount matches neither stored share is a plain "Share", never mislabelled.
    const s = sojan([{ x, share: 125 }]);
    expect(s.view.rows[0].amountLabel).toBe("Share");
  });

  it("non-split rows keep a plain \"Amount\"", () => {
    const loanGiven = entry("gave", 5000, d(9, 22), { note: "Hand loan", sourceKind: "manual" } as Partial<LedgerEntry>);
    const statement = buildPersonCycleStatement({
      person: { id: "S", name: "Sojan", openingBalance: 0, createdAt: d(1, 1) },
      ledgerEntries: [loanGiven],
      loanIds: new Set(),
      emis: [],
      loans: [],
      installments: [],
      cycle: cycleContaining(NOW),
      now: NOW,
    });
    const view = statementView(statement, { entries: [loanGiven], now: NOW, ownerName: OWNER });
    expect(view.rows[0]).toMatchObject({ amountLabel: "Amount", allocation: null });
  });
});

describe("participant grid", () => {
  it.each([2, 3, 4, 8])("F–I. %i participants: every name and stored amount, in a balanced grid", async (n) => {
    const others = Array.from({ length: n - 2 }, (_, i) => part(`Friend ${i + 1}`, 100 + i, `f${i}`));
    const x = expense(200 + others.reduce((t, p) => t + p.share, 0), [part("Me", 100, null, true), part("Sojan", 100, "S"), ...others]);
    const s = sojan([{ x, share: 100 }]);
    const a = s.view.rows[0].allocation!;
    expect(a.participants).toHaveLength(n);
    expect(preview(s).container.querySelectorAll("dl > div")).toHaveLength(n);
    const text = await pdfText(s);
    expect(text).toContain(`${n}-way split`);
    for (const p of a.participants) {
      expect(text).toContain(p.label);
      expect(text).toContain(pm(p.amount));
    }
  });

  it("columns: one row up to 6, then two balanced rows capped at 6", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 12, 20].map(allocationColumns)).toEqual([1, 2, 3, 4, 5, 6, 4, 4, 6, 6]);
  });

  it("J. long names wrap by word in the PDF (never \"...\") and the amount is intact", async () => {
    const long = "Kannappan Ramachandran Venkatasubramanian Iyer";
    const x = expense(1500, [part("Me", 500, null, true), part(long, 500, "K"), part("Sojan", 500, "S")]);
    const text = await pdfText(sojan([{ x, share: 500 }]));
    for (const word of long.split(" ")) expect(text).toContain(word);
    expect(text).not.toMatch(/Venkata\w*\.\.\./);
    expect(text).toContain(pm(500));
  });

  it("K. very large values are drawn in full", async () => {
    const x = expense(98765432.1, [part("Me", 49382716.05, null, true), part("Sojan", 49382716.05, "S")]);
    const text = await pdfText(sojan([{ x, share: 49382716.05 }]));
    expect(text).toContain(pm(98765432.1));
    expect(text).toContain(pm(49382716.05));
  });
});

describe("settlement states", () => {
  it("L/M/N. unpaid, partly paid and fully paid keep their engine values and statuses", async () => {
    const xs = [ZOMATO(), ZOMATO(), ZOMATO()];
    const s = sojan(xs.map((x) => ({ x, share: 220.74 })), { payments: { 1: 100, 2: 220.74 } });
    const [unpaid, partial, full] = s.view.rows.filter((r) => r.kind === "split");
    expect(unpaid).toMatchObject({ paid: money(0), remaining: money(220.74) });
    expect(partial).toMatchObject({ paid: money(100), remaining: money(120.74), statusTone: "partial" });
    expect(full).toMatchObject({ paid: money(220.74), remaining: money(0), statusTone: "settled" });
    const text = await pdfText(s);
    for (const r of [unpaid, partial, full]) expect(text).toContain(pdfSafe(r.status));
  });

  it("O/P. a brought-forward split is secondary context with its allocation; the current-cycle split follows", async () => {
    const earlier = expense(400, [part("Me", 200, null, true), part("Sojan", 200, "S")], "BEVCO", d(8, 5));
    const current = ZOMATO();
    const s = sojan([{ x: earlier, share: 200 }, { x: current, share: 220.74 }], { history: true });
    expect(s.view.carried).toHaveLength(1);
    expect(s.view.carried[0]).toMatchObject({ carried: true, amountLabel: "Sojan's share" });
    expect(s.view.carried[0].allocation!.original).toBe(400);
    expect(s.view.rows.map((r) => r.title).join()).toContain("ZOMATO");
    const text = await pdfText(s);
    expect(text).toContain("PREVIOUS BALANCE");
    expect(text).toContain("Outstanding from earlier cycles");
    expect(text.indexOf("BEVCO")).toBeLessThan(text.indexOf("ZOMATO"));
  });

  it("Q. multiple split expenses each carry their own allocation", async () => {
    const a = ZOMATO();
    const b = expense(2080, [part("Me", 610, null, true), part("Kannappan", 490, "K"), part("Shambu", 490, "H"), part("Sojan", 490, "S")], "BEVCO");
    const s = sojan([{ x: a, share: 220.74 }, { x: b, share: 490 }]);
    expect(s.view.rows.map((r) => r.allocation!.original)).toEqual([882.96, 2080]);
    const text = await pdfText(s);
    expect(text.split("ORIGINAL PURCHASE").length - 1).toBe(2);
  });
});

describe("pages", () => {
  it("R. a multi-page statement never splits a transaction from its allocation", async () => {
    const items = Array.from({ length: 24 }, (_, i) => ({
      x: expense(882.96, [part("Me", 220.74, null, true), part("Kannappan", 220.74, "K"), part("Shambu", 220.74, "H"), part("Sojan", 220.74, "S")], `MERCHANT ${String(i + 1).padStart(2, "0")}`),
      share: 220.74,
    }));
    const pages = await pdfPages(sojan(items));
    expect(pages.length).toBeGreaterThan(1);
    for (const [pi, page] of pages.entries()) {
      // Every transaction that starts on a page carries its whole breakdown on that same page.
      const titles = page.split("\n").filter((l) => l.startsWith("MERCHANT"));
      expect(page.split("ORIGINAL PURCHASE").length - 1).toBe(titles.length);
      expect(page.split("Sojan's share").length - 1).toBeGreaterThanOrEqual(titles.length);
      if (pi > 0) expect(page).toContain("continued");
      expect(page).toContain(`Page ${pi + 1} of ${pages.length}`);
    }
    expect(pages.join("\n").split("\n").filter((l) => l.startsWith("MERCHANT"))).toHaveLength(24);
  });

  it("density: a 4-way split row fits at least 6 transactions (was 4) on the first page", async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ x: expense(882.96, ZOMATO().participants, `MERCHANT ${i}`), share: 220.74 }));
    const [first] = await pdfPages(sojan(items));
    expect(first.split("\n").filter((l) => l.startsWith("MERCHANT")).length).toBeGreaterThanOrEqual(6);
  });
});

describe("preview ↔ PDF and privacy", () => {
  it("W. preview and PDF render the same view: names, amounts, original, recipient caption", async () => {
    const s = sojan([{ x: ZOMATO(), share: 220.74 }]);
    expect(statementView(s.statement, s.options)).toEqual(s.view);
    const { container } = preview(s);
    const text = await pdfText(s);
    for (const cell of container.querySelectorAll("dl > div")) {
      expect(text).toContain(cell.querySelector("dt")!.textContent!);
      expect(text).toContain(pdfSafe(cell.querySelector("dd")!.firstChild!.textContent!));
    }
    expect(container.textContent).toContain(money(882.96));
    expect(container.textContent).toContain("Sojan's share");
  });

  it("X. only this expense's participants and shares — no unrelated People data, notes, accounts or statuses", async () => {
    const unrelated = expense(9999, [part("Me", 4999, null, true), part("Ravi Secret", 5000, "R")], "Ravi private dinner");
    const s = sojan([{ x: ZOMATO(), share: 220.74 }], { extra: [unrelated] });
    const all = JSON.stringify(s.view);
    for (const secret of ["Ravi", "9,999", "PRIVATE NOTE", "acc-private", "inst-", "receivedStatus", "yetToReceive"]) expect(all).not.toContain(secret);
    const text = await pdfText(s);
    for (const secret of ["Ravi", "PRIVATE NOTE", "acc-private", "9,999"]) expect(text).not.toContain(secret);
  });
});

/** Ibin owes Sojan: Sojan paid for things (borrowed entries) — the reverse direction of every split above. */
function ownerOwes() {
  const entries = [entry("borrowed", 1023.41, d(9, 20), { note: "Concert tickets" }), entry("borrowed", 500, d(9, 24), { note: "Cab" })];
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
  const options: StatementViewOptions = { entries, now: NOW, ownerName: OWNER };
  return { statement, options, view: statementView(statement, options) };
}
/** A drawn string that addresses the reader as "you" — the person reading the shared statement would take it as themselves. */
const YOU = /\b(you|your)\b/i;

describe("recipient-safe wording (the person reads this statement)", () => {
  it("A. person owes owner: both named, direction Sojan → Ibin John, no \"you\" anywhere", async () => {
    const s = sojan([{ x: ZOMATO(), share: 220.74 }]);
    expect(s.view.headline).toBe(`Sojan owes ${OWNER}`);
    expect(s.view.flow).toEqual({ from: "Sojan", to: OWNER });
    expect(s.view.current.label).toBe("Balance due");
    expect(s.view.reconciliation.map((l) => l.label)).toEqual(["Previous balance", "New this cycle", "Total due", "Paid by Sojan"]);
    // The header states the direction, so same-direction lines carry no side sentence.
    expect(s.view.reconciliation.every((l) => l.side === null)).toBe(true);
    expect(s.view.rows[0]).toMatchObject({ relation: "Sojan's share of a split expense", status: "Payment due", statusDetail: `Sojan owes Ibin ${money(220.74)}` });
    const lines = cellLines(await pdfText(s));
    expect(lines.filter((l) => YOU.test(l))).toEqual([]);
    expect(lines).toContain("BALANCE DUE");
    expect(lines).toContain("ENDING BALANCE");
    expect(lines).toContain(`${pm(220.74)} due`);
  });

  it("B. owner owes person: direction Ibin John → Sojan; rows, types and statuses name the owner", async () => {
    const s = ownerOwes();
    expect(s.view.direction).toBe("iOwe");
    expect(s.view.headline).toBe(`${OWNER} owes Sojan`);
    expect(s.view.flow).toEqual({ from: OWNER, to: "Sojan" });
    expect(s.view.rows.map((r) => r.typeLabel)).toEqual(["Lent by Sojan", "Lent by Sojan"]);
    expect(s.view.rows[0].relation).toBe(`Sojan gave Ibin ${money(1023.41)} · Ibin owes Sojan`);
    expect(s.view.rows[0]).toMatchObject({ status: "Payment due", statusDetail: `Ibin owes Sojan ${money(1023.41)}` });
    // Nothing paid either way: the paid line names whoever owes the balance.
    expect(s.view.reconciliation.map((l) => l.label)).toContain("Paid by Ibin");
    const lines = cellLines(await pdfText(s));
    expect(lines.filter((l) => YOU.test(l))).toEqual([]);
    expect(lines).toContain(OWNER);
  });

  it("C. settled: \"Settled\", no direction, ₹0 due, and no redundant side sentences", async () => {
    const s = sojan([{ x: ZOMATO(), share: 220.74 }], { payments: { 0: 220.74 } });
    expect(s.view).toMatchObject({ direction: "settled", headline: "Settled", flow: null, current: { label: "Settled", value: money(0) } });
    expect(s.view.reconciliation.every((l) => l.side === null)).toBe(true);
    expect(s.view.payments[0].label).toBe("Sojan paid Ibin");
    const lines = cellLines(await pdfText(s));
    expect(lines).toContain("SETTLED");
    expect(lines).toContain(`${pm(0)} due`);
    expect(lines).toContain("Total paid by Sojan  " + pm(220.74));
    expect(lines.filter((l) => YOU.test(l))).toEqual([]);
  });

  it("no profile name: the neutral fallback is named whole in sentences (never cut to \"Account\")", () => {
    const s = sojan([{ x: ZOMATO(), share: 220.74 }], { ownerName: null });
    expect(s.view.headline).toBe(`Sojan owes ${OWNER_FALLBACK}`);
    expect(s.view.rows[0].statusDetail).toBe(`Sojan owes ${OWNER_FALLBACK} ${money(220.74)}`);
  });

  it("private UI wording is unchanged when no owner is passed", async () => {
    const { kindLabel, paymentGroupLabel } = await import("@/features/people/lib/settlement-presentation");
    expect(kindLabel("paymentReceived", "Sojan")).toBe("Paid back to you");
    expect(kindLabel("paymentMade", "Sojan")).toBe("You paid back");
    expect(kindLabel("moneyGiven", "Sojan")).toBe("Given · to collect");
    expect(paymentGroupLabel(sojan([{ x: ZOMATO(), share: 220.74 }], { payments: { 0: 100 } }).statement.rows.filter((r) => r.kind === "settlement"), "Sojan")).toBe("Received from Sojan");
  });
});

describe("statement grouping", () => {
  it("month headings appear only when the statement spans months; sections use plain words", async () => {
    const carried = sojan([{ x: expense(882.96, ZOMATO().participants, "SWIGGY", d(7, 3)), share: 220.74 }, { x: expense(882.96, ZOMATO().participants, "BEVCO", d(8, 2)), share: 220.74 }], { history: true });
    const lines = cellLines(await pdfText(carried));
    expect(lines).toContain("JULY 2026");
    expect(lines).toContain("AUGUST 2026");
    expect(lines).toContain("PREVIOUS BALANCE");
    expect(lines).toContain("THIS CYCLE");
    // Nothing new this cycle: said on the THIS CYCLE band itself, not as a separate line.
    expect(lines.some((l) => l.endsWith(`·  ${STATEMENT_COPY.empty}`))).toBe(true);
    expect(lines.indexOf("JULY 2026")).toBeLessThan(lines.indexOf("SWIGGY"));
    expect(lines.indexOf("AUGUST 2026")).toBeLessThan(lines.indexOf("BEVCO"));

    const single = cellLines(await pdfText(sojan([{ x: ZOMATO(), share: 220.74 }])));
    expect(single.some((l) => /^[A-Z]+ 2026$/.test(l))).toBe(false);
  });

  it("a month heading is never stranded at a page foot: it starts the page with its first transaction", async () => {
    const items = Array.from({ length: 14 }, (_, i) => ({
      x: expense(882.96, ZOMATO().participants, `M${String(i + 1).padStart(2, "0")}`, i < 6 ? d(8, 1 + i) : d(9, 1 + i)),
      share: 220.74,
    }));
    const pages = await pdfPages(sojan(items, { history: true }));
    for (const page of pages) {
      const l = page.split("\n");
      const at = l.indexOf("SEPTEMBER 2026");
      if (at >= 0) expect(l.slice(at + 1).some((x) => /^M\d\d$/.test(x))).toBe(true);
    }
  });
});

describe("page utilization", () => {
  it("5 brought-forward splits with nothing new this cycle fit one page, ending balance included", async () => {
    const at = (desc: string, date: Date) => expense(882.96, ZOMATO().participants, desc, date);
    const s = sojan(
      [
        { x: at("ZOMATO LTD", d(8, 21)), share: 220.74 },
        { x: at("SWIGGY", d(8, 27)), share: 220.74 },
        { x: expense(1960, [part("Me", 490, null, true), part("Sojan", 490, "S"), part("Kannappan", 490, "K"), part("Shambu", 490, "H")], "BEVCO", d(9, 2)), share: 490 },
        { x: at("NIGHT SNACKS", d(9, 9)), share: 220.74 },
        { x: expense(182.38, [part("Me", 91.19, null, true), part("Sojan", 91.19, "S")], "TEA", d(9, 14)), share: 91.19 },
      ],
      { history: true },
    );
    expect(s.view.carried).toHaveLength(5);
    expect(s.view.rows).toHaveLength(0);
    const pages = await pdfPages(s);
    // Was 2 pages: the content floor reserved 70pt above the page edge while the footer rule sits at 30pt,
    // pushing "This cycle" + the ending block onto a page of their own.
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain("ENDING BALANCE");
    expect(pages[0]).toContain("THIS CYCLE");
  });
});
