// @vitest-environment jsdom
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { monthlySettlementView, paise, tidyTitle } from "@/features/people/lib/monthly-settlement-model";
import { monthlySettlementDetailedText, smartSettlementText, waSafe } from "@/features/people/lib/monthly-settlement-text";
import { statementShareText } from "@/lib/engines/person-cycle-statement-share";
import { renderMonthlySettlementPdf } from "@/features/people/lib/monthly-settlement-pdf";
import { renderPersonStatementPdf } from "@/features/people/lib/person-statement-pdf";
import { statementView, type StatementViewOptions } from "@/features/people/lib/person-statement-pdf-model";
import type { SettlementLookups } from "@/features/people/lib/settlement-presentation";
import {
  buildPersonCycleStatement,
  cycleContaining,
  type StatementCycle,
  type StatementEmiSource,
  type StatementInstallment,
  type StatementLedgerEntry,
} from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import type { Expense, ExpenseParticipant } from "@/lib/models/expense";
import type { LedgerEntry, LedgerEntryType } from "@/lib/models/person";

/**
 * The Monthly Settlement for ONE cycle — synthetic data only (no fixture is hard-coded in production). The SANJU-shaped
 * scenario: four Bajaj EMIs from Jun–Sep (₹6,575.52) fully cleared by a Record Payment in October, five October
 * obligations (₹19,828.88), ₹3,000 of that payment applied to October's Bajaj EMI → ₹16,828.88 outstanding.
 * Set MONTHLY_PDF_OUT=<dir> to also write each rendered PDF there (for visual inspection).
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

const d = (m: number, day: number, y = 2026) => new Date(y, m - 1, day);
const NOW = d(10, 20);
const OWNER = "Abin John";

let seq = 0;
function entry(type: LedgerEntryType, amount: number, date: Date, patch: Partial<StatementLedgerEntry> & Record<string, unknown> = {}): StatementLedgerEntry & LedgerEntry {
  seq += 1;
  return { id: `e${seq}`, personId: "S", type, amount, date, note: "", increasesBalance: type === "gave", transactionRef: null, parentEntryId: null, createdAt: new Date(date.getTime() + seq), deletedAt: null, lastEditedAt: null, editHistory: [], receivedStatus: "yetToReceive", ...patch } as StatementLedgerEntry & LedgerEntry;
}
const bajaj: StatementEmiSource = { id: "emi-b", name: "Bajaj Finance", scheduleId: "SB", beneficiaryPersonId: "S", beneficiaryRepaysInstallments: true, isClosed: false, deletedAt: null };
const superMoney: StatementEmiSource = { id: "emi-s", name: "Super Money", scheduleId: "SS", beneficiaryPersonId: "S", beneficiaryRepaysInstallments: true, isClosed: false, deletedAt: null };
const inst = (id: string, schedule: string, due: Date, amountDue: number, no: number): StatementInstallment => ({ id, scheduleId: schedule, sequenceNumber: no, dueDate: due, amountDue, amountPaid: 0, isSkipped: false, deletedAt: null, createdAt: d(1, 1) });
const repay = (installment: string, amount: number, date: Date, paymentId = "P1", patch: Record<string, unknown> = {}) =>
  entry("receivedBack", amount, date, { sourceKind: "emiInstallment", obligationRef: `emi-inst:${installment}`, paymentId, note: "Received: payment", ...patch });

interface Scenario {
  entries?: (StatementLedgerEntry & LedgerEntry)[];
  emis?: StatementEmiSource[];
  installments?: StatementInstallment[];
  startDay?: number;
  now?: Date;
  lookups?: SettlementLookups;
  deferralFor?: StatementViewOptions["deferralFor"];
  accountForEntry?: StatementViewOptions["accountForEntry"];
  /** The cycle shown (default: the one containing `now`). */
  cycleOf?: Date;
}
function scenario(o: Scenario) {
  const startDay = o.startDay ?? 1;
  const now = o.now ?? NOW;
  const entries = o.entries ?? [];
  const base = { person: { id: "S", name: "Sanju", openingBalance: 0, createdAt: d(1, 1) }, ledgerEntries: entries, loanIds: new Set<string>(), emis: o.emis ?? [], loans: [], installments: o.installments ?? [], now };
  const cycle: StatementCycle = cycleContaining(o.cycleOf ?? now, startDay);
  const statement = buildPersonCycleStatement({ ...base, cycle });
  const history = buildPersonCycleStatement({ ...base, cycle: { start: new Date(1970, 0, 1), end: cycleContaining(now, startDay).end } });
  const lookups = o.lookups ?? ({ entriesById: new Map(entries.map((e) => [e.id, e])), expenseByTransactionId: new Map() } as SettlementLookups);
  const options: StatementViewOptions = { entries, history, lookups, now, cycleStartDay: startDay, ownerName: OWNER, deferralFor: o.deferralFor, accountForEntry: o.accountForEntry };
  return { statement, options, monthly: monthlySettlementView(statement, options), ledger: statementView(statement, options) };
}

// ---- The SANJU-shaped October ----
const SM_EMI = inst("sm1", "SS", d(10, 8), 2185, 1);
const EARLIER = [inst("b9", "SB", d(6, 5), 1643.88, 9), inst("b10", "SB", d(7, 5), 1643.88, 10), inst("b11", "SB", d(8, 5), 1643.88, 11), inst("b12", "SB", d(9, 5), 1643.88, 12)];
const OCT_BAJAJ = inst("b13", "SB", d(10, 5), 3643.88, 13);
function sanju(extra: Partial<Scenario> & { paid?: boolean; postpone?: boolean } = {}) {
  const given = entry("gave", 10000, d(10, 3), { note: "Given to Sanju" });
  const interest = entry("gave", 1000, d(10, 4), { note: "Interest for ₹10,000" });
  const groceries = entry("gave", 3000, d(10, 9), { note: "Groceries", sourceKind: "splitExpense", transactionRef: "T-groc" });
  const pays = extra.paid === false ? [] : [...EARLIER.map((i) => repay(i.id, 1643.88, d(10, 15))), repay("b13", 3000, d(10, 15))];
  const entries = [given, interest, groceries, ...pays];
  const postponed = new Set(extra.postpone === false ? [] : ["emi-inst:sm1", `ledger:${interest.id}`]);
  return scenario({
    entries,
    emis: [bajaj, superMoney],
    installments: [...EARLIER, OCT_BAJAJ, SM_EMI],
    deferralFor: (key) => (postponed.has(key) ? { status: "postponed", name: "Nov", from: "Oct" } : null),
    ...extra,
  });
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + paise(x), 0);

describe("Monthly Settlement — the SANJU-shaped October (01 Oct – 31 Oct)", () => {
  it("engine figures: previous ₹6,575.52 + new ₹19,828.88 − applied ₹9,575.52 = ₹16,828.88", () => {
    const { statement } = sanju();
    expect(statement.cycleLabel).toBe("01 Oct – 31 Oct 2026");
    expect([statement.previousPending, statement.cycleActivity, statement.cycleSettlements, statement.amount]).toEqual([6575.52, 19828.88, -9575.52, 16828.88]);
  });

  it("the four fully cleared Jun–Sep EMIs are not rows at all (the reconciliation states them); October's five obligations stay", () => {
    const { monthly } = sanju();
    const titles = monthly.items.map((i) => i.title);
    expect(monthly.items.filter((i) => i.group === "earlier")).toHaveLength(0);
    expect(monthly.cleared).toEqual({ count: 4, amount: money(6575.52), range: "Jun–Sep" });
    expect(monthly.lines[0]).toMatchObject({ key: "previous", value: money(6575.52), note: "Open on 01 Oct · 4 items (Jun–Sep) cleared this cycle" });
    expect(titles.filter((t) => /EMI #(9|10|11|12)$/.test(t))).toEqual([]);
    expect(monthly.items.filter((i) => i.group === "cycle").map((i) => i.title)).toEqual(
      expect.arrayContaining(["Bajaj Finance · EMI #13", "Super Money · EMI #1", "Given to Sanju", "Interest for ₹10,000", "Groceries"]),
    );
    expect(monthly.items.filter((i) => i.group === "cycle")).toHaveLength(5);
    expect(monthly.items).toHaveLength(5);
    expect(monthly.clearedCount).toBe(4);
  });

  it("the summary keeps previous / new / applied / total apart, and says where the payment went", () => {
    const { monthly } = sanju();
    expect(monthly.outstanding).toBe(money(16828.88));
    expect(monthly.headline).toBe("Sanju owes Abin John");
    expect(monthly.lines.map((l) => [l.key, l.value, l.op])).toEqual([
      ["previous", money(6575.52), null],
      ["new", money(19828.88), "+"],
      ["applied", money(9575.52), "−"],
      ["outstanding", money(16828.88), "="], // labelled "Remaining balance" — the big card says "Total outstanding" once
    ]);
    expect(monthly.lines.find((l) => l.key === "applied")!.note).toBe(`${money(6575.52)} to earlier balance · ${money(3000)} to this cycle`);
  });

  it("Bajaj EMI #13: ₹3,000 applied, ₹643.88 left, partly paid", () => {
    const { monthly } = sanju();
    expect(monthly.items.find((i) => i.title === "Bajaj Finance · EMI #13")).toMatchObject({ amount: money(3643.88), paid: money(3000), remaining: money(643.88), status: "Part paid", chip: "partial" });
  });

  it("postponed obligations stay owed: total unchanged, collectible now ≠ total", () => {
    const { monthly } = sanju();
    expect(monthly.split).toEqual({ dueNow: money(13643.88), postponed: money(3185), postponedTo: "Moved to November" });
    expect(monthly.outstanding).toBe(money(16828.88));
    expect(monthly.items.find((i) => i.title === "Super Money · EMI #1")).toMatchObject({ status: "Moved to Nov", postponed: true, remaining: money(2185) });
    expect(sum([13643.88, 3185])).toBe(paise(16828.88));
  });

  it("no postponement → no split strip", () => {
    expect(sanju({ postpone: false }).monthly.split).toBeNull();
  });

  it("payments: one receipt, earlier balance as one line, October's Bajaj by name", () => {
    const { monthly } = sanju();
    expect(monthly.payments).toHaveLength(1);
    const [p] = monthly.payments;
    expect(p).toMatchObject({ amount: money(9575.52), inbound: true });
    expect(p.lines.map((l) => [l.label, l.amount, l.tail])).toEqual([
      ["Earlier balance · 4 items", money(6575.52), "cleared"],
      ["Bajaj Finance · EMI #13", money(3000), `${money(643.88)} left`],
    ]);
  });

  it("agrees with the People Ledger for the same cycle and as-of date", () => {
    const { monthly, ledger, statement } = sanju();
    expect(monthly.outstanding).toBe(ledger.amount);
    expect(monthly.asOf).toBe(ledger.asOf);
    // Every monthly line's Remaining is the ledger row's Remaining; the column adds up to the balance.
    const ledgerRows = [...ledger.carried, ...ledger.rows];
    for (const it of monthly.items) {
      const row = ledgerRows.find((r) => (r.emiLabel ?? r.title) === it.title)!;
      expect([it.amount, it.paid === "—" ? "" : it.paid, it.remaining]).toEqual([row.original, row.paid === money(0) ? "" : row.paid, row.remaining]);
    }
    expect(monthly.items.reduce((s, i) => s + i.remainingPaise, 0)).toBe(paise(statement.amount));
    expect(monthly.checks).toEqual({ reconciles: true, itemsAddUp: true, unitemisedPaise: 0 });
  });

  it("renders a one-page A4 portrait PDF", async () => {
    const { statement, options } = sanju();
    const doc = await PDFDocument.load(await renderMonthlySettlementPdf(statement, options));
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([595, 842]);
    write("sanju-oct", await renderMonthlySettlementPdf(statement, { ...options, ...fonts() }));
    write("sanju-oct-sbi", await renderMonthlySettlementPdf(statement, { ...options, accountForEntry: () => "SBI", ...fonts() }));
    write("sanju-oct-spaced-account", await renderMonthlySettlementPdf(statement, { ...options, accountForEntry: () => "S B I", ...fonts() }));
  });
});

describe("cycle boundaries", () => {
  it("a custom 17th–16th cycle uses exactly that boundary, not the calendar month", async () => {
    // Cycle 17 Sep – 16 Oct: an item on 16 Oct belongs here, one on 17 Oct to the next cycle.
    const a = entry("gave", 500, d(10, 16), { note: "On the 16th" });
    const b = entry("gave", 700, d(10, 17), { note: "On the 17th" });
    const s = scenario({ entries: [a, b], startDay: 17, now: d(10, 20), cycleOf: d(10, 10) });
    expect(s.statement.cycleLabel).toBe("17 Sep – 16 Oct 2026");
    expect(s.monthly.items.map((i) => i.title)).toEqual(["On the 16th"]);
    expect(s.monthly.outstanding).toBe(money(500)); // the 17th is a later cycle, outside this statement's balance
    expect(s.monthly.asOf).toBe("16 Oct 2026");
    write("custom-17-16", await renderMonthlySettlementPdf(s.statement, { ...s.options, ...fonts() }));
  });

  it("the cycle is the selected one, never derived from the generation date", () => {
    const entries = [entry("gave", 400, d(9, 10), { note: "September loan" }), entry("gave", 600, d(10, 10), { note: "October loan" })];
    const sep = scenario({ entries, now: d(10, 25), cycleOf: d(9, 15) });
    expect(sep.monthly.cycleLabel).toBe("01 Sep – 30 Sep 2026");
    expect(sep.monthly.items.map((i) => i.title)).toEqual(["September loan"]);
    const later = scenario({ entries, now: d(12, 1), cycleOf: d(9, 15) });
    expect(later.monthly.items.map((i) => i.title)).toEqual(["September loan"]);
    expect(later.monthly.outstanding).toBe(money(400));
  });
});

describe("previous balance", () => {
  it("an unpaid earlier obligation stays on the statement as a real row (never silently hidden)", async () => {
    const s = scenario({ entries: [entry("gave", 2500, d(8, 12), { note: "Old loan" }), entry("gave", 300, d(10, 5), { note: "Lunch" })] });
    expect(s.monthly.items.map((i) => [i.group, i.title, i.remaining, i.status])).toEqual([
      ["earlier", "Old loan", money(2500), "Due"],
      ["cycle", "Lunch", money(300), "Due"],
    ]);
    expect(s.monthly.items[0].note).toContain("From 01 Aug – 31 Aug");
    expect(s.monthly.lines.map((l) => l.key)).toEqual(["previous", "new", "outstanding"]);
    expect(s.monthly.outstanding).toBe(money(2800));
    write("earlier-open", await renderMonthlySettlementPdf(s.statement, { ...s.options, ...fonts() }));
  });

  it("a part-paid earlier item stays at what's left, and the payment is split correctly", () => {
    const old = entry("gave", 2500, d(8, 12), { note: "Old loan" });
    const s = scenario({ entries: [old, entry("receivedBack", 1000, d(10, 6), { parentEntryId: old.id, note: "Received: part", paymentId: "P2" })] });
    expect(s.monthly.items.map((i) => [i.title, i.amount, i.paid, i.remaining])).toEqual([["Old loan", money(2500), money(1000), money(1500)]]);
    expect(s.monthly.lines.find((l) => l.key === "applied")!.note).toBeNull(); // a single destination needs no breakdown
    expect(s.monthly.outstanding).toBe(money(1500));
    expect(s.monthly.checks.reconciles).toBe(true);
  });

  it("an earlier item settled in a PRIOR cycle is not listed at all", () => {
    const old = entry("gave", 800, d(7, 3), { note: "July loan" });
    const s = scenario({ entries: [old, entry("receivedBack", 800, d(8, 9), { parentEntryId: old.id }), entry("gave", 100, d(10, 2), { note: "Tea" })] });
    expect(s.monthly.items.map((i) => i.title)).toEqual(["Tea"]);
    expect(s.monthly.lines.map((l) => l.key)).toEqual(["new", "outstanding"]);
  });
});

describe("current cycle states", () => {
  it("partial payment, full payment, no payment — each with the right status", () => {
    const a = entry("gave", 1000, d(10, 3), { note: "A" });
    const b = entry("gave", 2000, d(10, 4), { note: "B" });
    const c = entry("gave", 500, d(10, 5), { note: "C" });
    const s = scenario({ entries: [a, b, c, entry("receivedBack", 400, d(10, 8), { parentEntryId: a.id }), entry("receivedBack", 2000, d(10, 8), { parentEntryId: b.id })] });
    expect(s.monthly.items.map((i) => [i.title, i.status, i.remaining])).toEqual([["A", "Part paid", money(600)], ["B", "Paid", money(0)], ["C", "Due", money(500)]]);
    expect(s.monthly.outstanding).toBe(money(1100));
  });

  it("a no-payment month has no payments section and no applied line", () => {
    const s = scenario({ entries: [entry("gave", 900, d(10, 3), { note: "Rent share" })] });
    expect(s.monthly.payments).toHaveLength(0);
    expect(s.monthly.lines.map((l) => l.key)).toEqual(["new", "outstanding"]);
  });

  it("zero outstanding: settled, nothing due, still a valid statement", async () => {
    const a = entry("gave", 1000, d(10, 3), { note: "A" });
    const s = scenario({ entries: [a, entry("receivedBack", 1000, d(10, 9), { parentEntryId: a.id })] });
    expect(s.monthly.direction).toBe("settled");
    expect(s.monthly.lines.at(-1)).toMatchObject({ label: "Settled", value: money(0) });
    expect(s.monthly.split).toBeNull();
    const doc = await PDFDocument.load(await renderMonthlySettlementPdf(s.statement, s.options));
    expect(doc.getPageCount()).toBe(1);
    write("zero-outstanding", await renderMonthlySettlementPdf(s.statement, { ...s.options, ...fonts() }));
  });

  it("an empty cycle says so", async () => {
    const s = scenario({ entries: [] });
    expect(s.monthly.items).toEqual([]);
    write("empty-cycle", await renderMonthlySettlementPdf(s.statement, { ...s.options, ...fonts() }));
  });
});

describe("payments: historical records vs new bank receipts", () => {
  it("a receipt recorded after the fact and linked to no account is a record, not a new bank receipt; an account-linked one names the account", async () => {
    const a = entry("gave", 1000, d(10, 3), { note: "A" });
    const b = entry("gave", 800, d(10, 4), { note: "B" });
    const hist = entry("receivedBack", 1000, d(10, 6), { parentEntryId: a.id, recordedEarlier: true, receivedDateKnown: false, note: "Received: earlier" });
    const bank = entry("receivedBack", 300, d(10, 12), { parentEntryId: b.id, note: "Received: UPI" });
    const s = scenario({ entries: [a, b, hist, bank], accountForEntry: (id) => (id === bank.id ? "HDFC Savings" : null) });
    const byAmount = Object.fromEntries(s.monthly.payments.map((p) => [p.amount, p]));
    expect(byAmount[money(1000)]).toMatchObject({ date: "Date not known", source: "Received earlier · recorded later · no new bank receipt" });
    expect(byAmount[money(300)]).toMatchObject({ source: "Received in HDFC Savings" });
    // The financial effect is identical either way: both reduce what's owed.
    expect(s.monthly.outstanding).toBe(money(500));
    write("historical-receipts", await renderMonthlySettlementPdf(s.statement, { ...s.options, ...fonts() }));
  });
});

describe("multiple people & split shares", () => {
  it("a split share keeps the person's share as the amount and says what the bill was", async () => {
    const part = (name: string, share: number, personId: string | null): ExpenseParticipant => ({ personId, name, share, installmentId: null, isMe: personId === null, receivedStatus: personId === null ? "notApplicable" : "yetToReceive" });
    const expense = { id: "x1", description: "Pizza night", totalAmount: 600, date: d(10, 12), categoryId: "c", accountId: "a", transactionId: "T-pz", splitType: "custom", participants: [part(OWNER, 200, null), part("Sanju", 200, "S"), part("Ravi", 200, "R")], scheduleId: "s", notes: "", createdAt: d(10, 12), deletedAt: null } as unknown as Expense;
    const share = entry("gave", 200, d(10, 12), { note: "Split: Pizza night", sourceKind: "splitExpense", transactionRef: "T-pz" });
    const lookups = { entriesById: new Map([[share.id, share]]), expenseByTransactionId: new Map([["T-pz", expense]]) } as unknown as SettlementLookups;
    const s = scenario({ entries: [share], lookups });
    expect(s.monthly.items).toHaveLength(1);
    expect(s.monthly.items[0]).toMatchObject({ title: "Pizza night", amount: money(200), remaining: money(200) });
    expect(s.monthly.items[0].note).toContain(`Total ${money(600)} · 3-way split`);
    write("split-shares", await renderMonthlySettlementPdf(s.statement, { ...s.options, ...fonts() }));
  });
});

describe("length", () => {
  it("a short statement is one page; a long one flows onto more pages without clipping a row", async () => {
    const many = Array.from({ length: 40 }, (_, i) => entry("gave", 100 + i, d(10, 1 + (i % 19)), { note: `Shared expense number ${i + 1} with a reasonably long description to wrap` }));
    const short = scenario({ entries: many.slice(0, 5) });
    const long = scenario({ entries: many });
    expect((await PDFDocument.load(await renderMonthlySettlementPdf(short.statement, short.options))).getPageCount()).toBe(1);
    const bytes = await renderMonthlySettlementPdf(long.statement, { ...long.options, ...fonts() });
    const pages = (await PDFDocument.load(bytes)).getPageCount();
    expect(pages).toBeGreaterThan(1);
    expect(pages).toBeLessThanOrEqual(4);
    expect(long.monthly.items).toHaveLength(40);
    write("long", bytes);
  });
});

describe("display-only description tidy", () => {
  it("collapses spaces and fixes only unambiguous capitalization; never rewords", () => {
    expect(tidyTitle("  Given   to Sanju ")).toBe("Given to Sanju");
    expect(tidyTitle("interest for ₹10,000")).toBe("Interest for ₹10,000");
    expect(tidyTitle("BEVCO - ONAM - VODKA")).toBe("Bevco - Onam - Vodka");
    expect(tidyTitle("SBI EMI")).toBe("SBI EMI"); // short tokens stay as typed
    expect(tidyTitle("Shai Ganesh - fish")).toBe("Shai Ganesh - fish"); // mixed case is the user's own
    expect(tidyTitle("Bajaj Finance · EMI #13")).toBe("Bajaj Finance · EMI #13");
  });
});

describe("the full-history statement is unchanged", () => {
  it("still lists every earlier cleared item (the complete People Ledger statement)", async () => {
    const { ledger, statement, options } = sanju();
    expect(ledger.carried).toHaveLength(4);
    expect(ledger.carried.every((r) => r.remainingValue === 0)).toBe(true);
    const full = await renderPersonStatementPdf(statement, { ...options, ...fonts() });
    expect((await PDFDocument.load(full)).getPageCount()).toBeGreaterThanOrEqual(1);
    write("before-full-statement", full);
  });
});

describe("copied WhatsApp message (same view model as the PDF)", () => {
  const forSanju: StatementEmiSource = { ...bajaj, id: "emi-f", name: "For Sanju", scheduleId: "SF" };
  /** Shaped like the reference SANJU October PDF: ₹16,828.88 = ₹10,380 due now + ₹6,448.88 moved to November. */
  function referenceOctober() {
    const b13 = inst("b13", "SB", d(10, 2), 4630, 13);
    const sm1 = inst("sm1", "SS", d(10, 5), 3175, 1);
    const f5 = inst("f5", "SF", d(10, 5), 1643.88, 5);
    const entries = [
      entry("gave", 10000, d(10, 16), { note: "Gived to sanju" }),
      entry("gave", 380, d(10, 16), { note: "Interest for 10k" }),
      ...EARLIER.map((i) => repay(i.id, 1643.88, d(10, 19))),
      repay("b13", 3000, d(10, 19)),
    ];
    const moved = new Set(["emi-inst:b13", "emi-inst:sm1", "emi-inst:f5"]);
    return scenario({
      entries,
      emis: [bajaj, superMoney, forSanju],
      installments: [...EARLIER, b13, sm1, f5],
      deferralFor: (key) => (moved.has(key) ? { status: "postponed", name: "Nov", from: "Oct" } : null),
      accountForEntry: () => "S B I",
    });
  }
  const text = (s: ReturnType<typeof scenario>) => smartSettlementText(s.monthly);
  /** Visible width of a copied line on the phone, without WhatsApp's bold/italic markers. */
  const visible = (line: string) => [...line.replace(/^[*_]+|[*_]+$/g, "")].length;
  /** The block under a numbered section heading, up to the next divider. */
  const sectionOf = (t: string, title: string) => t.split(/\n━+\n/).map((b) => b.trim()).find((b) => new RegExp(`^\\*\\d{2} {2}/ {2}${title}\\*`).test(b)) ?? "";

  it("Smart Settlement V2 — the SANJU reference message, exactly", () => {
    const t = text(referenceOctober());
    writeText("copy-smart-reference-october", t);
    expect(t).toBe(
      [
        "*FlowFi  /  SMART SETTLEMENT*",
        "*SANJU*  •  OCT 2026",
        "01–31 Oct  |  Updated 20 Oct",
        "",
        "━━━━━━━━━━━━━━━━━━━━",
        "*PAYMENT DUE NOW*",
        "*₹10,380.00*",
        "",
        "Total outstanding  ₹16,828.88",
        "Moved to November  ₹6,448.88",
        "━━━━━━━━━━━━━━━━━━━━",
        "",
        "*01  /  PAY THIS CYCLE*",
        "",
        "*Gived to sanju*",
        "₹10,000.00",
        "",
        "*Interest for 10k*",
        "₹380.00",
        "",
        "*TOTAL DUE  →  ₹10,380.00*",
        "",
        "━━━━━━━━━━━━━━━━━━━━",
        "*02  /  MOVED TO NOVEMBER*",
        "",
        "*Bajaj Finance · EMI #13*",
        "₹1,630.00 remaining",
        "_Paid ₹3,000.00 / ₹4,630.00_",
        "",
        "*Super Money · EMI #1*",
        "₹3,175.00 remaining",
        "",
        "*For Sanju · EMI #5*",
        "₹1,643.88 remaining",
        "",
        "*TOTAL MOVED  →  ₹6,448.88*",
        "_Postponed, not cancelled._",
        "",
        "━━━━━━━━━━━━━━━━━━━━",
        "*03  /  PAYMENTS RECEIVED*",
        "",
        "✓ ₹6,575.52  •  19 Oct",
        "   SBI  /  Previous balance cleared",
        "",
        "✓ ₹3,000.00  •  19 Oct",
        "   SBI  /  Bajaj Finance · EMI #13",
        "",
        "*TOTAL RECEIVED  ₹9,575.52*",
        "",
        "━━━━━━━━━━━━━━━━━━━━",
        "*04  /  BALANCE SUMMARY*",
        "",
        "Previous balance  ₹6,575.52",
        "New this cycle  ₹19,828.88",
        "Received  −₹9,575.52",
        "────────────────────",
        "*OUTSTANDING  ₹16,828.88*",
        "",
        "*SANJU  →  ABIN JOHN*",
        "_Powered by FlowFi_",
      ].join("\n"),
    );
  });

  it("narrow phone: no code blocks, no padded columns, no stacked blank lines, short lines", () => {
    const t = text(referenceOctober());
    expect(t).not.toContain("```");
    expect(t).not.toMatch(/\S {3,}\S/); // label/amount gaps are two spaces, never padding
    expect(t).not.toMatch(/\n\n\n/);
    for (const line of t.split("\n")) expect(visible(line)).toBeLessThanOrEqual(36);
    for (const d of t.match(/^[━─]+$/gm) ?? []) expect([...d].length).toBe(20);
    expect((t.match(/[✓↗]/g) ?? []).length).toBe(2); // the only symbols: one tick per receipt line
  });

  it("due now is the headline; due-now and moved items never mix; section totals are the model's split", () => {
    const s = referenceOctober();
    const t = text(s);
    expect(t.indexOf("*PAYMENT DUE NOW*\n*₹10,380.00*")).toBeLessThan(t.indexOf("Total outstanding"));
    const pay = sectionOf(t, "PAY THIS CYCLE");
    const moved = sectionOf(t, "MOVED TO NOVEMBER");
    expect(pay).toContain("Gived to sanju");
    expect(pay).not.toMatch(/EMI #/);
    expect(moved).toMatch(/EMI #13[\s\S]*EMI #1\*[\s\S]*EMI #5/);
    expect(moved).not.toMatch(/Gived|Interest/);
    // Grouping follows the model's own postponed flag, item for item.
    for (const it of s.monthly.items.filter((i) => i.remainingPaise > 0)) expect((it.postponed ? moved : pay).includes(it.title)).toBe(true);
    expect(pay).toContain("*TOTAL DUE  →  ₹10,380.00*");
    expect(moved).toContain("*TOTAL MOVED  →  ₹6,448.88*");
    expect(t.match(/₹16,828\.88/g)).toHaveLength(2); // secondary total + the balance summary's result
    expect(t).not.toMatch(/EMI #(9|10|11|12)\b/); // earlier items cleared this cycle are not listed
  });

  it("the moved-to cycle label is dynamic, never a hardcoded November", () => {
    const b = inst("bx", "SB", d(10, 2), 1000, 14);
    const s = scenario({ entries: [entry("gave", 500, d(10, 3), { note: "Lunch" })], emis: [bajaj], installments: [b], deferralFor: (k) => (k === "emi-inst:bx" ? { status: "postponed", name: "Dec", from: "Oct" } : null) });
    const t = text(s);
    expect(s.monthly.split!.postponedTo).toBe("Moved to December");
    expect(t).toContain("Moved to December  ₹1,000.00");
    expect(t).toContain(`*02  /  ${s.monthly.split!.postponedTo.toUpperCase()}*`);
    expect(t).not.toMatch(/November/i);
  });

  it("no postponement → total outstanding is the headline and items are listed as open items", () => {
    const t = text(sanju({ postpone: false }));
    expect(t).not.toMatch(/PAYMENT DUE NOW|PAY THIS CYCLE|MOVED TO|TOTAL DUE|Postponed/);
    expect(t).toContain("*TOTAL OUTSTANDING*\n*₹16,828.88*");
    expect(t).toContain("*01  /  OPEN ITEMS*");
  });

  it("custom 17th–16th cycle", () => {
    const t = text(scenario({ entries: [entry("gave", 500, d(10, 16), { note: "On the 16th" })], startDay: 17, now: d(10, 20), cycleOf: d(10, 10) }));
    expect(t).toContain("*SANJU*  •  OCT 2026\n17 Sep – 16 Oct  |  Updated 16 Oct");
    expect(t).toContain("*On the 16th*\n₹500.00\n");
  });

  it("a genuinely open earlier balance stays (item + balance summary)", () => {
    const t = text(scenario({ entries: [entry("gave", 2500, d(8, 12), { note: "Old loan" }), entry("gave", 300, d(10, 5), { note: "Lunch" })] }));
    expect(t).toContain("*Old loan*\n₹2,500.00  •  earlier balance");
    expect(t).toContain("Previous balance  ₹2,500.00");
  });

  it("partial payments only where relevant; fully paid items not listed; several receipts total up", () => {
    const a = entry("gave", 1000, d(10, 3), { note: "A" });
    const b = entry("gave", 2000, d(10, 4), { note: "B" });
    const c = entry("gave", 700, d(10, 5), { note: "C" });
    const t = text(scenario({ entries: [a, b, c, entry("receivedBack", 400, d(10, 8), { parentEntryId: a.id }), entry("receivedBack", 2000, d(10, 9), { parentEntryId: b.id })], accountForEntry: () => "HDFC Savings" }));
    expect(t).toContain("*A*\n₹600.00 remaining\n_Paid ₹400.00 / ₹1,000.00_");
    expect(t).toContain("*C*\n₹700.00\n\n");
    expect(t).not.toContain("*B*");
    expect(t).toContain("✓ ₹2,000.00  •  09 Oct\n   HDFC Savings  /  B · cleared");
    expect(t).toContain("*TOTAL RECEIVED  ₹2,400.00*");
  });

  it("a historical receipt with no account is a record, not a new bank receipt", () => {
    const a = entry("gave", 1000, d(10, 3), { note: "A" });
    const b = entry("gave", 500, d(10, 4), { note: "B" });
    const t = text(scenario({ entries: [a, b, entry("receivedBack", 1000, d(10, 6), { parentEntryId: a.id, recordedEarlier: true, receivedDateKnown: false })] }));
    expect(t).toContain("✓ ₹1,000.00  •  Date not known\n   _Received earlier · recorded later · no new bank receipt_\n   A · cleared");
    expect(t).not.toContain("TOTAL RECEIVED");
  });

  it("the owner owes the person", () => {
    const t = text(scenario({ entries: [entry("borrowed", 1500, d(10, 5), { note: "Borrowed for rent" })] }));
    expect(t).toContain("*ABIN JOHN  →  SANJU*");
  });

  it("owed both ways: each side named, a net — never one payable amount", () => {
    const t = text(scenario({ entries: [entry("gave", 1000, d(10, 3), { note: "Lent" }), entry("borrowed", 300, d(10, 5), { note: "Borrowed" })] }));
    expect(t).toContain("*NET BALANCE*\n*₹700.00*\n\nSanju owes  ₹1,000.00\nAbin owes  ₹300.00");
    expect(t).toContain("₹300.00  •  Abin owes");
    expect(t).toContain("*NET  SANJU  →  ABIN JOHN*");
    expect(t).not.toMatch(/PAYMENT DUE NOW|TOTAL OUTSTANDING|BALANCE SUMMARY/);
  });

  it("zero outstanding", () => {
    const a = entry("gave", 1000, d(10, 3), { note: "A" });
    const t = text(scenario({ entries: [a, entry("receivedBack", 1000, d(10, 9), { parentEntryId: a.id })] }));
    expect(t).toContain("*ALL SETTLED*\n*₹0.00*");
    expect(t).toContain("*Nothing to pay — all settled.*");
    expect(t).not.toMatch(/OPEN ITEMS|PAYMENT DUE NOW|  →  /);
  });

  it("WhatsApp markers in stored text can't break the formatting; the stored text is unchanged", () => {
    const note = "50% *off* _deal_ ~x~ `code`";
    const e = entry("gave", 100, d(10, 3), { note });
    const t = text(scenario({ entries: [e] }));
    expect(t).toContain("*50% ∗off∗ ˍdealˍ ∼x∼ ˋcodeˋ*");
    expect(e.note).toBe(note);
    expect(waSafe("a*b")).toBe("a∗b");
  });

  it("long names and descriptions stay inside a phone line; amounts are never shortened", () => {
    const long = "Venkataraghavan Subramaniam Iyer";
    const base = scenario({ entries: [entry("gave", 123456.78, d(10, 3), { note: "A very long description that keeps going well past what fits" }), entry("borrowed", 10, d(10, 4), { note: "Tiny" })] });
    const view = { ...base.monthly, personName: long, ownerName: "Abhilash Krishnankutty" };
    const t = smartSettlementText(view);
    expect(t).toContain("*VENKATARAGHAVAN SUBRAMANIAM IYER*  •  OCT 2026");
    expect(t).toContain("*A very long description that keep…*");
    expect(t).toContain("Venkataraghavan owes  ₹1,23,456.78");
    expect(t).toContain("*NET  VENKATARAGHAVAN SUBRAMANIAM IYER  →  ABHILASH KRISHNANKUTTY*");
  });

  it("Detailed and Summary formats are kept", () => {
    const s = referenceOctober();
    const detailed = monthlySettlementDetailedText(s.monthly);
    writeText("copy-detailed-reference-october", detailed);
    expect(detailed).toContain("*FlowFi Monthly Settlement*");
    expect(detailed).toContain("*Due now:* ₹10,380.00");
    expect(detailed).toContain("*Moved to November:* ₹6,448.88 (postponed — still owed, not cancelled)");
    expect(detailed).toContain("19 Oct · ₹9,575.52 · received in SBI");
    const summary = statementShareText(s.statement);
    writeText("copy-summary-reference-october", summary);
    expect(summary.startsWith("*FlowFi — Cycle Statement*")).toBe(true);
  });
});

// ---- optional: write the PDFs for visual inspection ----
function fonts() {
  try {
    const f = (dir: string, file: string) => new Uint8Array(readFileSync(join(process.cwd(), "public", "fonts", dir, file)));
    const t = (w: string) => f("plus-jakarta-sans", `PlusJakartaSans-${w}.ttf`);
    return {
      textFonts: { regular: t("Regular"), medium: t("Medium"), semibold: t("SemiBold"), bold: t("Bold"), extrabold: t("ExtraBold") },
      amountFonts: { regular: f("geist-mono", "GeistMono-Regular.ttf"), bold: f("geist-mono", "GeistMono-SemiBold.ttf") },
    };
  } catch {
    return {};
  }
}
function write(name: string, bytes: Uint8Array) {
  const dir = process.env.MONTHLY_PDF_OUT;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.pdf`), bytes);
}

function writeText(name: string, text: string) {
  const dir = process.env.MONTHLY_PDF_OUT;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.txt`), text);
}
