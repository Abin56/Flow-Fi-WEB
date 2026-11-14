import { inflateSync } from "node:zlib";
import { PDFArray, PDFDocument, type PDFRawStream, PDFRef } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { monthlySettlementView } from "@/features/people/lib/monthly-settlement-model";
import { renderMonthlySettlementPdf } from "@/features/people/lib/monthly-settlement-pdf";
import { monthlySettlementDetailedText, smartSettlementText } from "@/features/people/lib/monthly-settlement-text";
import { pdfSafe, renderPersonStatementPdf } from "@/features/people/lib/person-statement-pdf";
import { statementView, type StatementViewOptions } from "@/features/people/lib/person-statement-pdf-model";
import { tableStatus } from "@/features/people/components/workspace/settlement-table";
import { buildLedgerRows } from "@/features/people/lib/person-ledger-rows";
import { generalCreditOf } from "@/features/people/lib/settlement-presentation";
import { buildPersonCycleStatement, cycleContaining } from "@/lib/engines/person-cycle-statement";
import type { LedgerEntry } from "@/lib/models/person";

/**
 * Shared statements after a GENERAL payment: SANJU owed ₹29,000 across three items and paid ₹20,000 toward the
 * balance with no item chosen. Every statement shows the original ₹29,000, the ₹20,000 received and the ₹9,000
 * remaining — and no item reads as paid or part paid, because none was.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

const d = (m: number, day: number) => new Date(2026, m - 1, day);
const NOW = d(10, 12);
const CYCLE = cycleContaining(NOW, 18);
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
const ENTRIES: LedgerEntry[] = [
  gave("rent", 12_000, d(9, 20), "Rent share"),
  gave("fees", 10_000, d(9, 25), "College fees"),
  gave("phone", 7_000, d(10, 2), "Phone"),
  // What `PersonPaymentRepository` writes for a general payment: one settlement entry tied to no obligation.
  { ...base, id: "g1", type: "receivedBack", amount: 20_000, date: d(10, 5), note: "", transactionRef: "cash", parentEntryId: null, obligationRef: null, sourceKind: "manual", paymentId: "p1", createdAt: d(10, 5), receivedStatus: "received" },
];

function setup() {
  const input = { person: { id: "S", name: "SANJU", openingBalance: 0, createdAt: d(1, 1) }, ledgerEntries: ENTRIES, loanIds: new Set<string>(), emis: [], loans: [], installments: [], now: NOW };
  const statement = buildPersonCycleStatement({ ...input, cycle: CYCLE });
  const history = buildPersonCycleStatement({ ...input, cycle: { start: new Date(1970, 0, 1), end: CYCLE.end } });
  const options: StatementViewOptions = { history, entries: ENTRIES, now: NOW, ownerName: "Abin" };
  return { statement, options };
}

async function pdfText(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().flatMap((page) => {
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

describe("general payment on the shared statements", () => {
  it("engine: ₹29,000 − ₹20,000 = ₹9,000; no item carries any of it", () => {
    const { statement } = setup();
    expect([statement.cycleActivity, statement.cycleSettlements, statement.currentPending]).toEqual([29_000, -20_000, 9_000]);
    const items = statement.rows.filter((r) => r.kind === "obligation");
    expect(items.map((r) => r.remainingNow)).toEqual([12_000, 10_000, 7_000]);
    expect(statement.rows.find((r) => r.kind === "settlement")?.settlesKey).toBeUndefined();
  });

  it("Full statement: items keep their original amount and a plain kind tag — never a paid/remaining figure", () => {
    const { statement, options } = setup();
    const v = statementView(statement, options);
    expect(v.rows.map((r) => [r.title, r.original])).toEqual([
      ["Rent share", "₹12,000"],
      ["College fees", "₹10,000"],
      ["Phone", "₹7,000"],
    ]);
    // Each item reads the same plain "Given" kind tag — nothing says it was paid or part paid, because
    // nothing is tied to any item anymore.
    expect(v.rows.map((r) => [r.tag, r.chip])).toEqual(Array(3).fill(["Given", "due"]));
    expect(v.closing).toEqual({ label: "Balance due", value: "₹9,000", direction: "theyOwe" });
    expect(v.payments[0].toward).toBeNull();
  });

  it("Monthly settlement: Received ₹20,000, and the one closing line is ₹9,000 — never summed from the items", () => {
    const { statement, options } = setup();
    const m = monthlySettlementView(statement, options);
    expect(m.lines.map((l) => [l.label, l.value])).toEqual([
      ["New this cycle", "₹29,000"],
      ["Received from SANJU", "₹20,000"],
      ["Remaining balance", "₹9,000"],
    ]);
    expect(m.items.map((i) => [i.title, i.amount, i.tag])).toEqual([
      ["Rent share", "₹12,000", "Given"],
      ["College fees", "₹10,000", "Given"],
      ["Phone", "₹7,000", "Given"],
    ]);
    expect(m.closing).toEqual({ label: "Remaining balance", value: "₹9,000" });
  });

  it("Smart Settlement and Detailed texts state the total outstanding, never a per-item paid/remaining figure", () => {
    const { statement, options } = setup();
    const m = monthlySettlementView(statement, options);
    const smart = smartSettlementText(m);
    expect(smart).toContain("*TOTAL OUTSTANDING*\n*₹9,000.00*");
    expect(smart).not.toMatch(/Part paid|cleared|not tied to one item/);
    const detailed = monthlySettlementDetailedText(m);
    expect(detailed).toContain("*Total outstanding: ₹9,000.00*");
  });

  it("both PDFs draw the one closing balance, never a per-item breakdown", async () => {
    const { statement, options } = setup();
    const monthly = await pdfText(await renderMonthlySettlementPdf(statement, options));
    expect(monthly).toContain("Remaining balance");
    expect(monthly.join(" ")).not.toContain(pdfSafe("not tied to one item"));
    const full = await pdfText(await renderPersonStatementPdf(statement, options));
    expect(full).toContain("BALANCE DUE");
    expect(full.join(" ")).not.toContain(pdfSafe("Payments & adjustments not tied to one item"));
  });

  it("the whole ₹29,000 paid in general payments: balance settled, items still read the plain kind tag", () => {
    const entries = [...ENTRIES, { ...ENTRIES[3], id: "g2", amount: 9_000, paymentId: "p2", date: d(10, 8), createdAt: d(10, 8) }];
    const input = { person: { id: "S", name: "SANJU", openingBalance: 0, createdAt: d(1, 1) }, ledgerEntries: entries, loanIds: new Set<string>(), emis: [], loans: [], installments: [], now: NOW };
    const statement = buildPersonCycleStatement({ ...input, cycle: CYCLE });
    const history = buildPersonCycleStatement({ ...input, cycle: { start: new Date(1970, 0, 1), end: CYCLE.end } });
    expect(statement.direction).toBe("settled");
    const v = statementView(statement, { history, entries, now: NOW, ownerName: "Abin" });
    expect(new Set(v.rows.map((r) => r.tag))).toEqual(new Set(["Given"]));
    expect(v.closing).toMatchObject({ label: "Settled", value: "₹0" });
    const m = monthlySettlementView(statement, { history, entries, now: NOW, ownerName: "Abin" });
    expect(m.items.map((i) => i.tag)).toEqual(["Given", "Given", "Given"]);
    expect(m.closing).toMatchObject({ label: "Settled", value: "₹0" });
  });

  it("People Ledger table: open items say 'Part of balance' with the overall figure; without general payments the old wording stays", () => {
    const input = { person: { id: "S", name: "SANJU", openingBalance: 0, createdAt: d(1, 1) }, ledgerEntries: ENTRIES, loanIds: new Set<string>(), emis: [], loans: [], installments: [], now: NOW };
    const history = buildPersonCycleStatement({ ...input, cycle: { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) } });
    const credit = generalCreditOf(history);
    expect(credit).toEqual({ theyOwe: { credit: 20_000, owed: 9_000 }, iOwe: { credit: 0, owed: 0 } });
    const rows = buildLedgerRows({ statement: history, history, entries: ENTRIES, pending: [], now: NOW });
    const rent = rows.find((r) => r.key === "ledger:rent")!;
    expect(tableStatus(rent, "moneyGiven", "SANJU", credit)).toMatchObject({ label: "Part of balance", tone: "due" });
    expect(tableStatus(rent, "moneyGiven", "SANJU", null).label).toBe("₹12,000 to receive");
    const noGeneral = buildPersonCycleStatement({ ...input, ledgerEntries: ENTRIES.filter((e) => e.id !== "g1"), cycle: { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) } });
    expect(generalCreditOf(noGeneral)).toBeNull();
  });

  it("a payment tied to items (legacy, still editable/displayable) shows the same plain kind tag as any other item", () => {
    // Part-paid, not fully settled, so the item still appears in this cycle's short summary.
    const linked = ENTRIES.map((e) => (e.id === "g1" ? { ...e, amount: 5_000, parentEntryId: "rent" } : e));
    const input = { person: { id: "S", name: "SANJU", openingBalance: 0, createdAt: d(1, 1) }, ledgerEntries: linked, loanIds: new Set<string>(), emis: [], loans: [], installments: [], now: NOW };
    const statement = buildPersonCycleStatement({ ...input, cycle: CYCLE });
    const history = buildPersonCycleStatement({ ...input, cycle: { start: new Date(1970, 0, 1), end: CYCLE.end } });
    const m = monthlySettlementView(statement, { history, entries: linked, now: NOW, ownerName: "Abin" });
    expect(m.items.find((i) => i.title === "Rent share")?.tag).toBe("Given");
  });
});
