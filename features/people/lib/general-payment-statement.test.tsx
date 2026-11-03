import { inflateSync } from "node:zlib";
import { PDFArray, PDFDocument, type PDFRawStream, PDFRef } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { monthlySettlementView, paise } from "@/features/people/lib/monthly-settlement-model";
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

  it("Full statement: items keep original / nothing paid / full remaining, then one line for the ₹20,000, then the ₹9,000", () => {
    const { statement, options } = setup();
    const v = statementView(statement, options);
    expect(v.rows.map((r) => [r.title, r.original, r.paid, r.remaining])).toEqual([
      ["Rent share", "₹12,000", "₹0", "₹12,000"],
      ["College fees", "₹10,000", "₹0", "₹10,000"],
      ["Phone", "₹7,000", "₹0", "₹7,000"],
    ]);
    expect(v.rows.some((r) => /Paid in full|Partially paid/.test(r.status))).toBe(false);
    // Each item says it is part of the balance (₹9,000 owed overall) — not "Payment due ₹12,000", not paid.
    expect(v.rows.map((r) => [r.status, r.statusDetail])).toEqual(
      Array(3).fill(["Part of balance", "₹9,000 still owed overall — payments so far weren't tied to items"]),
    );
    expect(v.totals?.other).toEqual({ label: "Payments & adjustments not tied to one item", value: "₹20,000", op: "−" });
    expect(v.totals?.total).toEqual({ label: "Balance due", value: "₹9,000" });
    expect(v.payments[0].single).toBe("Toward the overall balance · not tied to one item");
  });

  it("Monthly settlement: Received ₹20,000, Remaining ₹9,000, and the item column adds up through the general line", () => {
    const { statement, options } = setup();
    const m = monthlySettlementView(statement, options);
    expect(m.lines.map((l) => [l.label, l.value])).toEqual([
      ["New this cycle", "₹29,000"],
      ["Received from SANJU", "₹20,000"],
      ["Remaining balance", "₹9,000"],
    ]);
    expect(m.items.map((i) => [i.title, i.amount, i.paid, i.remaining, i.status])).toEqual([
      ["Rent share", "₹12,000", "—", "₹12,000", "In balance"],
      ["College fees", "₹10,000", "—", "₹10,000", "In balance"],
      ["Phone", "₹7,000", "—", "₹7,000", "In balance"],
    ]);
    expect(m.unallocated).toEqual({ label: "Paid toward the balance · not tied to one item", amount: "₹20,000", op: "−", total: "₹9,000" });
    // Items − the general line = the outstanding, to the paisa.
    expect(m.items.reduce((s, i) => s + i.remainingPaise, 0) - paise(20_000)).toBe(paise(statement.amount));
  });

  it("Smart Settlement and Detailed texts state the general line and the remaining", () => {
    const { statement, options } = setup();
    const m = monthlySettlementView(statement, options);
    const smart = smartSettlementText(m);
    expect(smart).toContain("_Paid toward the balance · not tied to one item_\n−₹20,000.00");
    expect(smart).toContain("*REMAINING  →  ₹9,000.00*");
    expect(smart).not.toMatch(/Part paid|cleared/);
    const detailed = monthlySettlementDetailedText(m);
    expect(detailed).toContain("• Paid toward the balance · not tied to one item — −₹20,000.00");
    expect(detailed).toContain("= Remaining: ₹9,000.00");
  });

  it("both PDFs draw the general line and the ₹9,000", async () => {
    const { statement, options } = setup();
    const monthly = await pdfText(await renderMonthlySettlementPdf(statement, options));
    expect(monthly).toContain(pdfSafe("Paid toward the balance · not tied to one item"));
    expect(monthly).toContain(pdfSafe("−₹20,000.00"));
    expect(monthly).toContain("Remaining balance");
    const full = await pdfText(await renderPersonStatementPdf(statement, options));
    expect(full.join(" ")).toContain(pdfSafe("Payments & adjustments not tied to one item"));
  });

  it("the whole ₹29,000 paid in general payments: balance settled, items read 'Balance cleared' — never 'Paid in full'", () => {
    const entries = [...ENTRIES, { ...ENTRIES[3], id: "g2", amount: 9_000, paymentId: "p2", date: d(10, 8), createdAt: d(10, 8) }];
    const input = { person: { id: "S", name: "SANJU", openingBalance: 0, createdAt: d(1, 1) }, ledgerEntries: entries, loanIds: new Set<string>(), emis: [], loans: [], installments: [], now: NOW };
    const statement = buildPersonCycleStatement({ ...input, cycle: CYCLE });
    const history = buildPersonCycleStatement({ ...input, cycle: { start: new Date(1970, 0, 1), end: CYCLE.end } });
    expect(statement.direction).toBe("settled");
    const v = statementView(statement, { history, entries, now: NOW, ownerName: "Abin" });
    expect(new Set(v.rows.map((r) => r.status))).toEqual(new Set(["Balance cleared"]));
    const m = monthlySettlementView(statement, { history, entries, now: NOW, ownerName: "Abin" });
    expect(m.items.map((i) => i.status)).toEqual(["Bal. cleared", "Bal. cleared", "Bal. cleared"]);
    expect(m.unallocated).toMatchObject({ amount: "₹29,000", op: "−", total: "₹0" });
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

  it("a payment tied to items (existing behaviour) adds no general line", () => {
    const linked = ENTRIES.map((e) => (e.id === "g1" ? { ...e, amount: 12_000, parentEntryId: "rent" } : e));
    const input = { person: { id: "S", name: "SANJU", openingBalance: 0, createdAt: d(1, 1) }, ledgerEntries: linked, loanIds: new Set<string>(), emis: [], loans: [], installments: [], now: NOW };
    const statement = buildPersonCycleStatement({ ...input, cycle: CYCLE });
    const history = buildPersonCycleStatement({ ...input, cycle: { start: new Date(1970, 0, 1), end: CYCLE.end } });
    const m = monthlySettlementView(statement, { history, entries: linked, now: NOW, ownerName: "Abin" });
    expect(m.unallocated).toBeNull();
    expect(m.items.find((i) => i.title === "Rent share")?.status).toBe("Paid");
  });
});
