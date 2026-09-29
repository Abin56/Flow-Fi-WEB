import { describe, expect, it } from "vitest";
import {
  buildPersonCycleStatement,
  cycleContaining,
  formatCycleLabel,
  reconciliationLines,
  shiftCycle,
  type PersonCycleStatementInput,
  type StatementEmiSource,
  type StatementInstallment,
  type StatementLedgerEntry,
  type StatementLoanSource,
} from "@/lib/engines/person-cycle-statement";
import { money, statementPdfModel, statementShareText } from "@/lib/engines/person-cycle-statement-share";
import { renderPersonStatementPdf } from "@/features/people/lib/person-statement-pdf";
import type { LedgerEntryType } from "@/lib/models/person";
import { emiReceivableThrough, personEmiObligations } from "@/lib/engines/person-emi-obligations";
import { personPosition } from "@/lib/engines/person-position";

const d = (month: number, day: number, year = 2026) => new Date(year, month - 1, day);
const CURRENT = cycleContaining(d(9, 28)); // 18 Sep – 17 Oct 2026
const NOW = d(9, 28);

let seq = 0;
function entry(type: LedgerEntryType, amount: number, date: Date, patch: Partial<StatementLedgerEntry> = {}): StatementLedgerEntry {
  seq += 1;
  return {
    id: `e${seq}`,
    personId: "A",
    type,
    amount,
    date,
    note: "",
    increasesBalance: true,
    transactionRef: null,
    parentEntryId: null,
    createdAt: new Date(date.getTime() + seq),
    deletedAt: null,
    ...patch,
  };
}
const split = (amount: number, date: Date, txn: string, note = "Dinner") => entry("gave", amount, date, { transactionRef: txn, sourceKind: "splitExpense", note: `Split: ${note}` });
const splitSettle = (amount: number, date: Date, txn: string) => entry("receivedBack", amount, date, { transactionRef: txn, note: "Split settlement: Dinner" });

/** Linked to A AND explicitly opted in — A repays me each installment. */
const phone: StatementEmiSource = {
  id: "emi1", name: "Phone EMI", scheduleId: "S1", beneficiaryPersonId: "A", beneficiaryRepaysInstallments: true, isClosed: false, deletedAt: null,
};
function inst(id: string, due: Date, amountDue: number, amountPaid = 0, seqNo = 1, patch: Partial<StatementInstallment> = {}): StatementInstallment {
  return { id, scheduleId: "S1", sequenceNumber: seqNo, dueDate: due, amountDue, amountPaid, isSkipped: false, deletedAt: null, createdAt: d(1, 1), ...patch };
}

function build(patch: Partial<PersonCycleStatementInput> = {}) {
  return buildPersonCycleStatement({
    person: { id: "A", name: "Arun", openingBalance: 0, createdAt: d(1, 1) },
    ledgerEntries: [],
    loanIds: new Set(),
    emis: [],
    loans: [],
    installments: [],
    cycle: CURRENT,
    now: NOW,
    ...patch,
  });
}

/** Closing = previous + every row — the invariant every output relies on. */
function expectReconciles(s: ReturnType<typeof build>) {
  const last = s.rows.at(-1)?.runningBalance ?? s.previousPending;
  expect(last).toBeCloseTo(s.currentPending, 2);
  expect(s.previousPending + s.cycleActivity + s.cycleSettlements).toBeCloseTo(s.currentPending, 2);
}

describe("cycle boundaries (18th → 17th)", () => {
  it("labels and navigates cycles, including across a year boundary", () => {
    expect(formatCycleLabel(CURRENT)).toBe("18 Sep – 17 Oct 2026");
    expect(formatCycleLabel(cycleContaining(d(1, 5, 2027)))).toBe("18 Dec 2026 – 17 Jan 2027");
    expect(CURRENT.start).toEqual(d(9, 18));
    expect(CURRENT.end).toEqual(d(10, 17));
    const jan = cycleContaining(d(1, 5, 2027));
    expect(jan.start).toEqual(d(12, 18, 2026));
    expect(jan.end).toEqual(d(1, 17, 2027));
    expect(shiftCycle(CURRENT, -1).start).toEqual(d(8, 18));
    expect(shiftCycle(CURRENT, 3)).toEqual(jan);
  });

  it("19. an entry on the 17th belongs to the old cycle, on the 18th to the new one", () => {
    const s = build({ ledgerEntries: [entry("gave", 1000, d(9, 17, 2026)), entry("gave", 300, d(9, 18))] });
    expect(s.previousPending).toBe(1000);
    expect(s.cycleActivity).toBe(300);
    expect(s.currentPending).toBe(1300);
  });
});

describe("PersonCycleStatement", () => {
  it("1. previous pending only", () => {
    const s = build({ ledgerEntries: [entry("gave", 2000, d(9, 1))] });
    expect(s.previousPending).toBe(2000);
    expect(s.rows).toHaveLength(0);
    expect(s.currentPending).toBe(2000);
    expect(s.direction).toBe("theyOwe");
    expectReconciles(s);
  });

  it("2. I gave", () => {
    const s = build({ ledgerEntries: [entry("gave", 500, d(9, 20))] });
    expect(s.cycleActivity).toBe(500);
    expect(s.activityBreakdown).toEqual([{ category: "gave", label: "Money I Gave", signedAmount: 500 }]);
    expect(s.amount).toBe(500);
    expect(s.direction).toBe("theyOwe");
  });

  it("3. I borrowed", () => {
    const s = build({ ledgerEntries: [entry("borrowed", 800, d(9, 20))] });
    expect(s.currentPending).toBe(-800);
    expect(s.direction).toBe("iOwe");
    expect(s.amount).toBe(800);
  });

  it("4. received back", () => {
    const g = entry("gave", 1000, d(9, 1));
    const s = build({ ledgerEntries: [g, entry("receivedBack", 600, d(9, 25), { parentEntryId: g.id })] });
    expect(s.previousPending).toBe(1000);
    expect(s.cycleSettlements).toBe(-600);
    expect(s.currentPending).toBe(400);
    expect(s.rows[0].settles).toEqual({ title: "Money I Gave", originalAmount: 1000, remainingAfter: 400 });
  });

  it("5. I repaid", () => {
    const b = entry("borrowed", 1000, d(9, 1));
    const s = build({ ledgerEntries: [b, entry("repaid", 1000, d(9, 22), { parentEntryId: b.id })] });
    expect(s.previousPending).toBe(-1000);
    expect(s.cycleSettlements).toBe(1000);
    expect(s.direction).toBe("settled");
    expect(s.amount).toBe(0);
  });

  it("6. split expense", () => {
    const s = build({ ledgerEntries: [split(750, d(9, 21), "T1")] });
    expect(s.rows[0]).toMatchObject({ title: "Dinner", typeLabel: "Split expense", amount: 750, category: "split" });
    expect(s.activityBreakdown).toEqual([{ category: "split", label: "Expense shares", signedAmount: 750 }]);
  });

  it("classifies only explicit splits as Split expense", () => {
    const assigned = entry("gave", 1000, d(9, 21), { transactionRef: "assigned", sourceKind: "assignedExpense", note: "Phone" });
    const legacy = entry("gave", 1000, d(9, 22), { transactionRef: "legacy", note: "Old phone" });
    const s = build({ ledgerEntries: [split(1000, d(9, 20), "split"), assigned, legacy] });
    expect(s.rows.map((r) => r.typeLabel)).toEqual(["Split expense", "Money I Gave", "Money I Gave"]);
  });

  it("7. partial split settlement — payment row carries the payment, remainder separately", () => {
    const s = build({ ledgerEntries: [split(2000, d(9, 19), "T1"), splitSettle(1500, d(9, 28), "T1")] });
    const payment = s.rows.find((r) => r.kind === "settlement")!;
    expect(payment.amount).toBe(1500);
    expect(payment.title).toBe("Payment received");
    expect(payment.settles).toEqual({ title: "Dinner", originalAmount: 2000, remainingAfter: 500 });
    expect(s.rows.find((r) => r.kind === "obligation")!.remainingNow).toBe(500);
    expect(s.currentPending).toBe(500);
  });

  it("8. full split settlement", () => {
    const s = build({ ledgerEntries: [split(2000, d(9, 19), "T1"), splitSettle(2000, d(9, 28), "T1")] });
    expect(s.currentPending).toBe(0);
    expect(s.direction).toBe("settled");
  });

  it("9. a settlement does not recreate the original obligation (₹2,000 − ₹1,500 = ₹500, not ₹2,500/₹4,000)", () => {
    const s = build({ ledgerEntries: [split(2000, d(9, 1), "T1"), splitSettle(1500, d(9, 20), "T1")] });
    expect(s.previousPending).toBe(2000);
    expect(s.cycleActivity).toBe(0);
    expect(s.cycleSettlements).toBe(-1500);
    expect(s.currentPending).toBe(500);
  });

  it("10. multiple carried obligations", () => {
    const s = build({
      ledgerEntries: [split(1200, d(7, 20), "T1"), entry("gave", 800, d(8, 25)), splitSettle(500, d(9, 2), "T1"), entry("gave", 400, d(10, 1))],
    });
    expect(s.previousPending).toBe(1500);
    expect(s.cycleActivity).toBe(400);
    expect(s.currentPending).toBe(1900);
  });

  it("11. person-linked EMI adds only the installment (never the financed principal)", () => {
    const s = build({ emis: [phone], installments: [inst("i1", d(10, 5), 2500, 0, 3), inst("i2", d(11, 5), 2500, 0, 4)] });
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ title: "Phone EMI", typeLabel: "EMI", amount: 2500, emi: { installmentNumber: 3, status: "upcoming" } });
    expect(s.currentPending).toBe(2500);
  });

  it("12. EMI paid to the lender still leaves the Person owing (bank status is context only)", () => {
    const s = build({ emis: [phone], installments: [inst("i1", d(10, 5), 2500, 2500)] });
    expect(s.rows.map((r) => [r.category, r.signedAmount])).toEqual([["emi", 2500]]);
    expect(s.rows[0].emi!.status).toBe("paid");
    expect(s.currentPending).toBe(2500);
  });

  it("13. partial Person repayment leaves only the remainder", () => {
    const s = build({ emis: [phone], installments: [inst("i1", d(10, 5), 2500, 1000)], ledgerEntries: [entry("receivedBack", 1000, d(10, 6))] });
    expect(s.rows.find((r) => r.category === "emi")!.emi!.status).toBe("partial");
    expect(s.currentPending).toBe(1500);
  });

  it("settles one EMI installment by its stable reference without changing lender payment state", () => {
    const repayment = (amount: number, date: Date) =>
      entry("receivedBack", amount, date, { sourceKind: "emiInstallment", obligationRef: "emi-inst:i1" });
    const emi = [phone];
    const installments = [inst("i1", d(10, 5), 2500, 0)];
    expect(build({ emis: emi, installments, ledgerEntries: [repayment(1000, d(10, 6))] }).rows.find((r) => r.category === "emi")?.remainingNow).toBe(1500);
    expect(build({ emis: emi, installments, ledgerEntries: [repayment(1000, d(10, 6)), repayment(500, d(10, 7))] }).rows.find((r) => r.category === "emi")?.remainingNow).toBe(1000);
    const final = build({ emis: emi, installments, ledgerEntries: [repayment(1000, d(10, 6)), repayment(500, d(10, 7)), repayment(1000, d(10, 8))] });
    expect(final.rows.find((r) => r.category === "emi")).toMatchObject({ remainingNow: 0, emi: { status: "upcoming" } });
    expect(final.currentPending).toBe(0);
  });

  it("14. overdue EMI from an earlier cycle carries into previous pending", () => {
    const s = build({ emis: [phone], installments: [inst("i0", d(9, 5), 2500, 0)] });
    expect(s.previousPending).toBe(2500);
    expect(s.rows).toHaveLength(0);
    const prev = build({ emis: [phone], installments: [inst("i0", d(9, 5), 2500, 0)], cycle: shiftCycle(CURRENT, -1) });
    expect(prev.rows[0].emi!.status).toBe("overdue");
  });

  it("15. EMI + split expense", () => {
    const s = build({ emis: [phone], installments: [inst("i1", d(10, 5), 2500)], ledgerEntries: [split(1250, d(9, 21), "T1")] });
    expect(s.activityBreakdown.map((b) => [b.label, b.signedAmount])).toEqual([["Expense shares", 1250], ["EMI", 2500]]);
    expect(s.currentPending).toBe(3750);
  });

  it("16. EMI + manual ledger activity (the headline example: ₹2,000 + ₹4,250 − ₹1,500 = ₹4,750)", () => {
    const s = build({
      emis: [phone],
      installments: [inst("i1", d(10, 5), 2500)],
      ledgerEntries: [entry("gave", 2000, d(9, 10)), split(750, d(9, 21), "T1"), split(500, d(9, 22), "T2", "Movie"), entry("receivedBack", 1500, d(9, 28)), entry("gave", 500, d(10, 1))],
    });
    expect(s.previousPending).toBe(2000);
    expect(s.cycleActivity).toBe(4250);
    expect(s.cycleSettlements).toBe(-1500);
    expect(s.currentPending).toBe(4750);
    expect(s.activityBreakdown.map((b) => [b.label, b.signedAmount])).toEqual([["Expense shares", 1250], ["EMI", 2500], ["Money I Gave", 500]]);
    expect(reconciliationLines(s).map((l) => [l.label, l.value])).toEqual([
      ["Previous pending", 2000], ["This cycle", 4250], ["Received", -1500], ["Current pending", 4750],
    ]);
    expectReconciles(s);
  });

  it("17. direction reversal within a cycle", () => {
    const s = build({ ledgerEntries: [entry("gave", 1000, d(9, 1)), entry("borrowed", 3000, d(9, 25))] });
    expect(s.previousPending).toBe(1000);
    expect(s.currentPending).toBe(-2000);
    expect(s.direction).toBe("iOwe");
    expect(reconciliationLines(s).map((l) => l.value)).toEqual([-1000, 3000, 2000]);
  });

  it("18. exactly ₹0 is Settled", () => {
    const s = build({ ledgerEntries: [entry("gave", 100.1, d(9, 20)), entry("receivedBack", 100.1, d(9, 21))] });
    expect(s.direction).toBe("settled");
    expect(s.amount).toBe(0);
    expect(statementShareText(s)).toContain("Settled — ₹0");
  });

  it("20. historical cycle is rebuilt from dated events, not today's balance", () => {
    const entries = [entry("gave", 1000, d(7, 25)), entry("gave", 600, d(8, 20)), entry("receivedBack", 400, d(9, 1)), entry("gave", 9000, d(9, 25))];
    const aug = build({ ledgerEntries: entries, cycle: shiftCycle(CURRENT, -1) });
    expect(aug.cycleLabel).toContain("18 Aug");
    expect(aug.previousPending).toBe(1000);
    expect(aug.currentPending).toBe(1200);
    const now = build({ ledgerEntries: entries });
    expect(now.previousPending).toBe(1200);
    expect(now.currentPending).toBe(10200);
  });

  it("21. no duplicate events — one installment once, legacy Loan entries and deleted entries excluded", () => {
    const s = build({
      emis: [phone, { ...phone, id: "emi-dup" }], // same schedule reachable twice → still one obligation
      installments: [inst("i1", d(10, 5), 2500), inst("i1", d(10, 5), 2500)],
      loanIds: new Set(["LOAN1"]),
      ledgerEntries: [
        entry("receivedBack", 2500, d(10, 2), { note: "Phone EMI" }),
        entry("gave", 50000, d(9, 20), { transactionRef: "LOAN1" }),
        entry("gave", 700, d(9, 20), { deletedAt: d(9, 21) }),
      ],
    });
    expect(s.rows.map((r) => r.category).sort()).toEqual(["emi", "received"]);
    expect(s.currentPending).toBe(0);
  });

  it("21b. identical amount/date/description events are both counted (dedupe is by id only)", () => {
    const s = build({ ledgerEntries: [entry("gave", 500, d(9, 20), { note: "Tea" }), entry("gave", 500, d(9, 20), { note: "Tea" })] });
    expect(s.currentPending).toBe(1000);
  });

  it("22. running balance of the last row equals the closing balance", () => {
    const s = build({
      emis: [phone],
      installments: [inst("i1", d(10, 5), 2500, 2500)],
      ledgerEntries: [entry("gave", 2000, d(9, 1)), split(750, d(9, 21), "T1"), splitSettle(300, d(9, 30), "T1"), entry("receivedBack", 1000, d(10, 6)), entry("borrowed", 200, d(10, 10))],
    });
    expect(s.rows.at(-1)!.runningBalance).toBe(s.currentPending);
    expect(s.currentPending).toBe(3750);
    expectReconciles(s);
  });

  it("an opted-in taken Loan participates; a given Loan's counterparty does not", () => {
    const loan: StatementLoanSource = {
      id: "L", name: "Bike", scheduleId: "S1", direction: "taken", beneficiaryPersonId: "A", beneficiaryRepaysInstallments: true, isClosed: false, deletedAt: null,
    };
    const s = build({ loans: [loan], installments: [inst("i1", d(10, 5), 3100)] });
    expect(s.rows[0]).toMatchObject({ title: "Bike", category: "emi", amount: 3100 });
    const other = build({ loans: [{ ...loan, direction: "given" }], installments: [inst("i1", d(10, 5), 3100)] });
    expect(other.rows).toHaveLength(0);
  });

  it("a legacy \"For someone else\" link WITHOUT the opt-in stays association-only", () => {
    const legacy = { ...phone, beneficiaryRepaysInstallments: undefined };
    const s = build({ emis: [legacy], installments: [inst("i1", d(10, 5), 2500)] });
    expect(s.rows).toHaveLength(0);
    expect(s.direction).toBe("settled");
  });
});

describe("EMI obligation, lender payment and Person repayment are independent", () => {
  const due = (paidToBank: number) => inst("i1", d(10, 5), 2500, paidToBank);

  it("Case A — EMI due, bank unpaid → Person owes ₹2,500", () => {
    const s = build({ emis: [phone], installments: [due(0)] });
    expect(s.currentPending).toBe(2500);
    expect(s.direction).toBe("theyOwe");
  });

  it("Case B — EMI due, I paid the bank → Person still owes ₹2,500 (not ₹0)", () => {
    const s = build({ emis: [phone], installments: [due(2500)] });
    expect(s.currentPending).toBe(2500);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].emi!.status).toBe("paid");
  });

  it("Case C — bank paid, Person repays ₹1,000 → ₹1,500", () => {
    const s = build({ emis: [phone], installments: [due(2500)], ledgerEntries: [entry("receivedBack", 1000, d(10, 8))] });
    expect(s.rows.map((r) => [r.title, r.signedAmount])).toEqual([["Phone EMI", 2500], ["Payment received", -1000]]);
    expect(s.currentPending).toBe(1500);
  });

  it("Case D — Person repays ₹2,500 → Settled", () => {
    const s = build({ emis: [phone], installments: [due(2500)], ledgerEntries: [entry("receivedBack", 2500, d(10, 8))] });
    expect(s.currentPending).toBe(0);
    expect(s.direction).toBe("settled");
  });

  it("Case E — bank installment still unpaid, Person already gave me ₹2,500 → Settled", () => {
    const s = build({ emis: [phone], installments: [due(0)], ledgerEntries: [entry("receivedBack", 2500, d(9, 30))] });
    expect(s.currentPending).toBe(0);
    expect(s.direction).toBe("settled");
    expect(s.rows.find((r) => r.category === "emi")!.emi!.status).toBe("upcoming"); // lender side unchanged
  });

  it("Case F — People list position and current-cycle statement agree for the same records", () => {
    const ledgerEntries = [entry("gave", 2000, d(9, 10)), split(750, d(9, 21), "T1"), entry("receivedBack", 1000, d(10, 8))];
    const installments = [inst("i0", d(9, 5), 2500, 2500, 1), inst("i1", d(10, 5), 2500, 0, 2), inst("i2", d(11, 5), 2500, 0, 3)];
    const s = build({ emis: [phone], installments, ledgerEntries });
    // The ledger-backed Person balance (what Person.currentBalance caches).
    const currentBalance = 2000 + 750 - 1000;
    const position = personPosition({
      personId: "A",
      currentBalance,
      loans: [],
      ledgerEntries: [],
      loanIds: new Set(),
      emiReceivable: emiReceivableThrough(personEmiObligations({ personId: "A", emis: [phone], loans: [], installments, now: NOW }), CURRENT.end),
    });
    expect(position.emiReceivable).toBe(5000); // Sep + Oct installments; Nov is a future cycle
    expect(position.net).toBe(6750);
    expect(s.currentPending).toBe(position.net);
    // Without the opt-in neither side counts the EMI.
    const legacy = { ...phone, beneficiaryRepaysInstallments: false };
    expect(personEmiObligations({ personId: "A", emis: [legacy], loans: [], installments })).toEqual([]);
    expect(build({ emis: [legacy], installments, ledgerEntries }).currentPending).toBe(currentBalance);
  });
});

describe("outputs share the engine total", () => {
  const s = build({
    emis: [phone],
    installments: [inst("i1", d(10, 5), 2500)],
    ledgerEntries: [entry("gave", 2000, d(9, 10)), split(750, d(9, 21), "T1"), split(500, d(9, 22), "T2"), entry("receivedBack", 1500, d(9, 28)), entry("gave", 500, d(10, 1))],
  });

  it("23. preview reconciliation total = engine total", () => {
    const lines = reconciliationLines(s);
    expect(lines.at(-1)!.value).toBe(s.currentPending);
    expect(lines.slice(0, -1).reduce((a, l) => a + l.value, 0)).toBe(4750);
  });

  it("24. WhatsApp text total = engine total", () => {
    const text = statementShareText(s);
    expect(text).toContain(`*Current pending: ${money(4750)}*`);
    expect(text).toContain(`*You owe me ${money(4750)}*`);
    expect(text).toContain(`Received: ${money(1500)}`);
    expect(text).not.toContain("Dinner");
    const iOwe = build({ ledgerEntries: [entry("borrowed", 900, d(9, 20))] });
    expect(statementShareText(iOwe)).toContain(`*I owe you ${money(900)}*`);
  });

  it("25. PDF total = engine total", async () => {
    const model = statementPdfModel(s);
    expect(model.currentPending).toBe(4750);
    expect(model.closingRow.balance).toBe(money(4750));
    expect(model.rows.at(-1)!.balance).toBe(money(4750));
    expect(model.summary.at(-1)).toEqual({ label: "Current Pending", value: money(4750) });
    expect(model.positionHeadline).toBe("They owe you");
    expect(model.rows.find((r) => r.isEmi)).toMatchObject({ type: "EMI", added: money(2500) });
    const bytes = await renderPersonStatementPdf(s);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });
});
