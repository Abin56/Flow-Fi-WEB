// @vitest-environment jsdom
import { inflateSync } from "node:zlib";
import { cleanup, render } from "@testing-library/react";
import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFRef } from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatementDocument } from "@/features/people/components/workspace/share-statement-mode";
import { statementSummaryCells, statementView, type StatementViewOptions } from "@/features/people/lib/person-statement-pdf-model";
import { pdfSafe, renderPersonStatementPdf } from "@/features/people/lib/person-statement-pdf";
import type { SettlementLookups } from "@/features/people/lib/settlement-presentation";
import { buildPersonCycleStatement, cycleContaining } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import type { Expense, ExpenseParticipant } from "@/lib/models/expense";
import type { LedgerEntry, LedgerEntryType } from "@/lib/models/person";

/**
 * Statement information hierarchy (presentation only): the original total appears only where it differs from the
 * person's amount, an assigned expense reads as one clean amount, statuses share one vocabulary and colour family,
 * the summary reads as a sum, and the ending balance never stands alone on a page. Preview and PDF agree.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
afterEach(cleanup);

const d = (month: number, day: number) => new Date(2026, month - 1, day);
const NOW = d(9, 30);
const OWNER = "Abin John";

const part = (name: string, share: number, personId: string | null, isMe = false): ExpenseParticipant => ({
  personId,
  name,
  share,
  installmentId: isMe ? null : `inst-${name}`,
  isMe,
  receivedStatus: isMe ? "notApplicable" : "yetToReceive",
});
let tx = 0;
const expense = (total: number, participants: ExpenseParticipant[], description: string, date = d(9, 21)): Expense => {
  tx += 1;
  return { id: `x${tx}`, description, totalAmount: total, date, categoryId: "c", accountId: "a", transactionId: `t${tx}`, splitType: "custom", participants, scheduleId: "s", notes: "", createdAt: date, deletedAt: null } as Expense;
};
let seq = 0;
const entry = (type: LedgerEntryType, amount: number, date: Date, patch: Partial<LedgerEntry> = {}): LedgerEntry => {
  seq += 1;
  return {
    id: `e${seq}`,
    personId: "A",
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

type Item = { x: Expense; share: number; assigned?: boolean };
function amma(items: Item[], extra: (shares: LedgerEntry[]) => LedgerEntry[] = () => []) {
  const shares = items.map(({ x, share, assigned }) =>
    entry("gave", share, x.date, { note: x.description, sourceKind: assigned ? "assignedExpense" : "splitExpense", transactionRef: x.transactionId }),
  );
  const entries = [...shares, ...extra(shares)];
  const statement = buildPersonCycleStatement({
    person: { id: "A", name: "Amma", openingBalance: 0, createdAt: d(1, 1) },
    ledgerEntries: entries,
    loanIds: new Set(),
    emis: [],
    loans: [],
    installments: [],
    cycle: cycleContaining(NOW),
    now: NOW,
  });
  const lookups: SettlementLookups = { entriesById: new Map(entries.map((e) => [e.id, e])), expenseByTransactionId: new Map(items.map(({ x }) => [x.transactionId, x])) };
  const options: StatementViewOptions = { entries, lookups, now: NOW, ownerName: OWNER };
  return { statement, options, view: statementView(statement, options) };
}

async function pdfPages(s: ReturnType<typeof amma>): Promise<string[][]> {
  const doc = await PDFDocument.load(await renderPersonStatementPdf(s.statement, s.options));
  return doc.getPages().map((page) => {
    const c = page.node.Contents();
    const refs = c instanceof PDFArray ? c.asArray() : [c];
    const body = refs
      .map((r) => {
        const raw = Buffer.from(((r instanceof PDFRef ? doc.context.lookup(r) : r) as PDFRawStream).contents);
        try {
          return inflateSync(raw).toString("latin1");
        } catch {
          return raw.toString("latin1");
        }
      })
      .join("\n");
    return [...body.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((m) => Buffer.from(m[1], "hex").toString("latin1"));
  });
}
const pm = (n: number) => pdfSafe(money(n));
/** The transaction table's drawn strings: after its column header, before the ending balance. */
const tableOf = (page: string[]) => page.slice(page.indexOf("STATUS") + 1, page.indexOf("ENDING BALANCE"));
const me = (s: number) => part("Me", s, null, true);
const ammaPart = (s: number) => part("Amma", s, "A");

describe("original amount vs the person's share", () => {
  it("split where the total differs: Original ₹340 (2-way split) beside Amma's share ₹170", async () => {
    const s = amma([{ x: expense(340, [me(170), ammaPart(170)], "Shampoo"), share: 170 }]);
    expect(s.view.rows[0]).toMatchObject({ original: money(170), purchase: money(340), purchaseNote: "2-way split", shareLabel: null, metaLine: "Split expense" });
    expect(s.view.amountHeader).toBe("Amma's share");
    const page = (await pdfPages(s))[0];
    expect(page).toContain("AMMA'S SHARE");
    const table = tableOf(page);
    expect(table[table.indexOf(pm(340)) + 1]).toBe("2-way split");
    expect(table).toContain("SHARES");
  });

  it("assigned in full (original == amount): one clean amount — no Original, no share caption, no split panel", async () => {
    const s = amma([{ x: expense(170, [ammaPart(170)], "Shampoo"), share: 170, assigned: true }]);
    const row = s.view.rows[0];
    expect(row).toMatchObject({ kind: "assigned", original: money(170), purchase: null, purchaseNote: null, shareLabel: null });
    expect(row.metaLine).toBe(`Assigned expense · Amma owes Abin for this`);
    const [page] = await pdfPages(s);
    for (const absent of ["SHARES", "Assigned in full", "Amma's share", "ORIGINAL PURCHASE"]) expect(page).not.toContain(absent);
    // In the table ₹170 appears as the Amount and the Remaining only — never a third time as an "original".
    expect(tableOf(page).filter((l) => l === pm(170))).toHaveLength(2);
  });

  it("the description line never restates a figure the columns show", () => {
    const entries = [entry("borrowed", 1023.41, d(9, 20), { note: "Concert tickets" }), entry("gave", 500, d(9, 22), { note: "Hand loan" })];
    const statement = buildPersonCycleStatement({
      person: { id: "A", name: "Amma", openingBalance: 0, createdAt: d(1, 1) },
      ledgerEntries: entries,
      loanIds: new Set(),
      emis: [],
      loans: [],
      installments: [],
      cycle: cycleContaining(NOW),
      now: NOW,
    });
    const view = statementView(statement, { entries, now: NOW, ownerName: OWNER });
    expect(view.rows.map((r) => r.metaLine)).toEqual(["Lent by Amma · Abin owes Amma", "Lent by Abin · Amma owes Abin"]);
    for (const r of view.rows) expect(r.metaLine).not.toContain(r.original);
  });
});

describe("status vocabulary and colour families", () => {
  it("due / partly paid / paid / advance each map to one chip family", () => {
    const xs = [0, 1, 2].map((i) => expense(340, [me(170), ammaPart(170)], `Item ${i}`));
    const s = amma(
      xs.map((x) => ({ x, share: 170 })),
      (sh) => [
        entry("receivedBack", 70, d(9, 25), { parentEntryId: sh[1].id }),
        entry("receivedBack", 170, d(9, 25), { parentEntryId: sh[2].id }),
        entry("receivedBack", 500, d(9, 26), { sourceKind: "advance", transactionRef: "cash" }),
      ],
    );
    const by = (title: string) => s.view.rows.find((r) => r.title === title)!;
    expect([by("Item 0"), by("Item 1"), by("Item 2")].map((r) => [r.status, r.chip])).toEqual([
      ["Payment due", "due"],
      ["Partially paid", "partial"],
      ["Paid in full", "paid"],
    ]);
    const advance = s.view.rows.find((r) => r.kind === "advance")!;
    expect([advance.status, advance.chip, advance.statusNote]).toEqual(["Advance held", "advance", ""]);
    // A detail that only restates the direction and Paid / Remaining is not repeated under the chip.
    expect(by("Item 1").statusNote).toBe("");
  });
});

describe("summary reads as one sum ending in the balance", () => {
  it("previous + new = total due − paid = balance due; the advance is held apart after it", () => {
    const s = amma([{ x: expense(340, [me(170), ammaPart(170)], "Groceries"), share: 170 }], (sh) => [
      entry("receivedBack", 100, d(9, 25), { parentEntryId: sh[0].id }),
      entry("receivedBack", 300, d(9, 26), { sourceKind: "advance", transactionRef: "cash" }),
    ]);
    const cells = statementSummaryCells(s.view);
    expect(cells.map((c) => [c.label, c.op])).toEqual([
      ["Previous balance", null],
      ["New this cycle", "+"],
      ["Total due", "="],
      ["Paid by Amma", "−"],
      ["Balance due", "="],
      ["Advance from Amma", null],
    ]);
    expect(cells.filter((c) => c.current)).toHaveLength(1);
    expect(cells.find((c) => c.current)!.note).toBe(`Amma owes ${OWNER}`);
  });
});

describe("pagination", () => {
  it.each([6, 7, 8, 9, 10, 11, 12, 14, 16])("%i transactions: the ending balance always shares its page with the last item", async (n) => {
    const items = Array.from({ length: n }, (_, i) => ({ x: expense(882.96, [me(220.74), ammaPart(220.74), part("K", 220.74, "K"), part("H", 220.74, "H")], `M${String(i + 1).padStart(2, "0")}`), share: 220.74 }));
    const pages = await pdfPages(amma(items));
    const last = pages[pages.length - 1];
    expect(last).toContain("ENDING BALANCE");
    expect(last.some((l) => /^M\d\d$/.test(l))).toBe(true);
  });
});

describe("preview ↔ PDF", () => {
  it("the preview shows the same original / share / status hierarchy as the PDF", async () => {
    const s = amma([
      { x: expense(340, [me(170), ammaPart(170)], "Shampoo"), share: 170 },
      { x: expense(1840, [ammaPart(1840)], "KSEB bill"), share: 1840, assigned: true },
    ]);
    const { container } = render(<StatementDocument view={s.view} />);
    const rows = [...container.querySelectorAll("li > div[class]")].filter((el) => el.querySelector("[data-chip]"));
    expect(rows).toHaveLength(2);
    const [split, assigned] = rows;
    expect(split.getAttribute("data-split")).toBe("true");
    expect(split.textContent).toContain(money(340));
    expect(split.textContent).toContain("2-way split");
    expect(container.textContent).toContain("Amma's share"); // the Amount column header
    expect(assigned.getAttribute("data-split")).toBeNull();
    expect(assigned.textContent).not.toContain("Assigned in full");
    expect(assigned.textContent).not.toContain("share");
    const page = (await pdfPages(s)).flat();
    for (const r of s.view.rows) {
      expect(container.querySelector(`[data-chip="${r.chip}"]`)?.textContent).toBe(r.status);
      expect(page).toContain(pdfSafe(r.status));
      // A meta line may wrap in the narrower portrait column; joined back it reads the same.
      expect(page.join(" ")).toContain(pdfSafe(r.metaLine));
    }
  });
});

describe("amount figures in Geist Mono", () => {
  it("embeds the figure face (with ₹) and lays out the same pages as the Helvetica fallback", async () => {
    const { readFileSync } = await import("node:fs");
    const dir = "public/fonts/geist-mono";
    const bytesOf = (file: string) => new Uint8Array(readFileSync(`${dir}/${file}`));
    const amountFonts = { regular: bytesOf("GeistMono-Regular.ttf"), bold: bytesOf("GeistMono-SemiBold.ttf") };
    const items = Array.from({ length: 12 }, (_, i) => ({ x: expense(882.96, [me(220.74), ammaPart(220.74)], `M${i}`), share: 220.74 }));
    const s = amma(items);
    const plainBytes = await renderPersonStatementPdf(s.statement, s.options);
    const plain = await PDFDocument.load(plainBytes);
    const bytes = await renderPersonStatementPdf(s.statement, { ...s.options, amountFonts });
    const withFont = await PDFDocument.load(bytes);
    expect(withFont.getPageCount()).toBe(plain.getPageCount());
    // The subset font program is embedded (several KB), not referenced.
    expect(bytes.byteLength).toBeGreaterThan(plainBytes.byteLength + 4000);
  });
});

describe("opening view", () => {
  it("opens on page 1 fitted to the page width, with no script embedded", async () => {
    const s = amma([{ x: expense(340, [me(170), ammaPart(170)], "Shampoo"), share: 170 }]);
    const doc = await PDFDocument.load(await renderPersonStatementPdf(s.statement, s.options));
    const open = doc.catalog.get(PDFName.of("OpenAction"))!.toString();
    expect(open).toContain("/FitH");
    expect(doc.catalog.get(PDFName.of("Names"))?.toString() ?? "").not.toContain("JavaScript");
    const [page] = doc.getPages();
    expect(page.getWidth()).toBeGreaterThan(page.getHeight()); // landscape by default
  });
});

describe("progress cues", () => {
  it("summary bar: the share of the total due already cleared, worded with figures the statement shows", () => {
    const s = amma([{ x: expense(400, [me(200), ammaPart(200)], "Groceries"), share: 200 }], (sh) => [entry("receivedBack", 50, d(9, 25), { parentEntryId: sh[0].id })]);
    expect(s.view.settleProgress).toEqual({ ratio: 0.25, label: `${money(150)} of ${money(200)} still to settle` });
    // The partly paid row carries its own paid-down fraction for the bar under Remaining.
    expect(s.view.rows.find((r) => r.kind === "split")!.progress).toBe(0.25);
  });

  it("fully settled reads as such; unpaid rows carry no row bar", () => {
    const settled = amma([{ x: expense(400, [me(200), ammaPart(200)], "Groceries"), share: 200 }], (sh) => [entry("receivedBack", 200, d(9, 25), { parentEntryId: sh[0].id })]);
    expect(settled.view.settleProgress).toEqual({ ratio: 1, label: "Fully settled" });
    const unpaid = amma([{ x: expense(400, [me(200), ammaPart(200)], "Groceries"), share: 200 }]);
    expect(unpaid.view.settleProgress!.ratio).toBe(0);
    expect(unpaid.view.rows[0].progress).toBeNull();
  });
});
