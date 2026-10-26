import { describe, expect, it } from "vitest";
import { analyzeSession } from "./analyze";
import { buildApprovalPlan, changedEvidence, stagedRecordsForImport, RECONCILIATION_IMPORT_NOTE } from "./approval-plan";
import { importedTransactionIdsFor, reconciliationSessionId } from "./session-key";
import { importTransferKey } from "@/features/transaction-studio/lib/commit-review-import";
import { APPROVAL_NOW, reconData, reconRow, reconSession, txn } from "./test-fixtures";
import type { ReconRow, RowDecision } from "./types";

const plan = (rows: ReconRow[], decisions: Record<string, Partial<RowDecision>>, data = reconData(), accountId = "acc-card") => {
  const session = reconSession(rows, decisions, accountId);
  const a = analyzeSession(session, data, { now: APPROVAL_NOW });
  return buildApprovalPlan({ rows, matches: a.matches, decisions: session.decisions, gate: a.gate });
};

const OCT_24: [number, number, number] = [2026, 10, 24];

describe("approval plan — decision gates", () => {
  it("Link, Ignore and Handle-in-Inbox are resolved but never writes; only Import as new is", () => {
    const rows = [
      reconRow({ id: "link", day: OCT_24, description: "SWIGGY", amount: 452 }),
      reconRow({ id: "ign", day: OCT_24, description: "NOISE", amount: 11 }),
      reconRow({ id: "inb", day: OCT_24, description: "UBER TRIP", amount: 250 }),
      reconRow({ id: "new", day: OCT_24, description: "CAFE", amount: 90 }),
    ];
    const data = reconData({
      transactions: [txn({ id: "t-sw", amount: 452, description: "Swiggy", dateTime: new Date(2026, 9, 24, 13) })],
      smsCandidates: [{ id: "s1", amount: 250, direction: "debit", transactionDate: new Date(2026, 9, 24, 13), merchant: "UBER", bankName: null, cardId: "card1", accountId: null, rawLastFour: "4821" } as never],
    });
    const p = plan(rows, { link: { kind: "link", linkedRecordId: "t-sw" }, ign: { kind: "ignore" }, inb: { kind: "inbox" }, new: { kind: "import_new", category: "Food" } }, data);
    expect(p.rows.map((r) => [r.rowId, r.status])).toEqual([["link", "link"], ["ign", "ignore"], ["inb", "inbox"], ["new", "import"]]);
    expect(p.counts).toMatchObject({ captured: 4, linked: 1, ignored: 1, inbox: 1, newImports: 1, unresolved: 0 });
    expect(p.complete).toBe(true);
  });

  it("Investigate, an undecided row and an invalid decision all BLOCK approval", () => {
    const rows = [reconRow({ id: "a", day: OCT_24, amount: 10 }), reconRow({ id: "b", day: OCT_24, amount: 20 }), reconRow({ id: "c", day: OCT_24, amount: 30 })];
    const p = plan(rows, { a: { kind: "investigate" }, c: { kind: "import_new" } });
    expect(p.rows.map((r) => r.status)).toEqual(["blocked", "blocked", "blocked"]);
    expect(p.rows[0]!.investigate).toBe(true);
    expect(p.counts).toMatchObject({ unresolved: 3, investigate: 1, newImports: 0 });
    expect(p.complete).toBe(false);
  });

  it("card payments and EMI lines are never imported — and are never turned into an expense", () => {
    const rows = [reconRow({ id: "pay", day: OCT_24, kind: "payment", direction: "credit", description: "PAYMENT RECEIVED", amount: 5000 }), reconRow({ id: "emi", day: OCT_24, kind: "emi", description: "EMI PRINCIPAL", amount: 2000 })];
    const p = plan(rows, { pay: { kind: "import_new", category: "Salary", creditAs: "income" }, emi: { kind: "import_new", category: "Food" } });
    expect(p.rows.map((r) => r.status)).toEqual(["blocked", "blocked"]);
    expect(p.counts.newImports).toBe(0);
    expect(stagedRecordsForImport(rows, reconSession(rows, {}).decisions, new Set(p.rows.filter((r) => r.status === "import").map((r) => r.rowId)))).toEqual([]);
  });

  it("a credit needs an explicit Refund / Income choice — a credit on a card is never assumed to be a refund", () => {
    const rows = [reconRow({ id: "cr", day: OCT_24, direction: "credit", description: "CASHBACK CREDIT", amount: 75 })];
    expect(plan(rows, { cr: { kind: "import_new", category: "Salary" } }).rows[0]).toMatchObject({ status: "blocked", reasons: ["Say whether this credit is a refund or income."] });
    const asRefund = plan(rows, { cr: { kind: "import_new", category: "Salary", creditAs: "refund" } });
    expect(asRefund.rows[0]).toMatchObject({ status: "import", action: "refund" });
    expect(asRefund.refundsPaise).toBe(7500);
    expect(asRefund.incomePaise).toBe(0);
    const asIncome = plan(rows, { cr: { kind: "import_new", category: "Salary", creditAs: "income" } });
    expect(asIncome.rows[0]).toMatchObject({ status: "import", action: "income" });
    expect(asIncome.incomePaise).toBe(7500);
  });

  it("D10: a row dated in a closed card bill can't be imported; the same row on a bank account can", () => {
    const rows = [reconRow({ id: "old", day: [2026, 8, 1], description: "OLD STORE", amount: 999 })];
    const onCard = plan(rows, { old: { kind: "import_new", category: "Food" } });
    expect(onCard.rows[0]!.status).toBe("blocked");
    expect(onCard.rows[0]!.reasons[0]).toMatch(/already closed/);
    expect(plan(rows, { old: { kind: "import_new", category: "Food" } }, reconData(), "acc-bank").rows[0]!.status).toBe("import");
  });

  it("an Import-as-new row whose own import key is already a live transaction is 'already imported' — resolved, not written", () => {
    const rows = [reconRow({ id: "r1", day: OCT_24, description: "CAFE", amount: 90 })];
    const session = reconSession(rows, { r1: { kind: "import_new", category: "Food" } });
    const [importedId] = importedTransactionIdsFor("r1", { fingerprint: session.fingerprint, accountId: "acc-card", priorSessionIds: {} });
    const data = reconData({ transactions: [txn({ id: importedId!, amount: 90, description: "Cafe", dateTime: new Date(2026, 9, 24, 13) })] });
    const p = plan(rows, { r1: { kind: "import_new", category: "Food" } }, data);
    expect(p.rows[0]).toMatchObject({ status: "already_imported", recordId: importedId });
    expect(p.counts).toMatchObject({ alreadyImported: 1, newImports: 0, unresolved: 0 });
    expect(p.chargesPaise).toBe(0);
  });

  it("rows left out of the capture are counted separately and never imported", () => {
    const rows = [reconRow({ id: "x", day: OCT_24, amount: 10, include: false }), reconRow({ id: "y", day: OCT_24, amount: 20 })];
    const p = plan(rows, { y: { kind: "ignore" } });
    expect(p.counts).toMatchObject({ captured: 2, excluded: 1, ignored: 1 });
    expect(p.rows[0]!.status).toBe("excluded");
  });
});

describe("approval plan — totals and staged records", () => {
  it("sums in integer paise (no float drift) and nets credits against charges", () => {
    const rows = [
      reconRow({ id: "a", day: OCT_24, description: "A", amount: 0.1 }),
      reconRow({ id: "b", day: OCT_24, description: "B", amount: 0.2 }),
      reconRow({ id: "c", day: OCT_24, description: "C", direction: "credit", amount: 0.25 }),
    ];
    const p = plan(rows, { a: { kind: "import_new", category: "Food" }, b: { kind: "import_new", category: "Food" }, c: { kind: "import_new", category: "Salary", creditAs: "refund" } });
    expect(p.chargesPaise).toBe(30);
    expect(p.creditsPaise).toBe(25);
    expect(p.balanceDeltaPaise).toBe(-5);
  });

  it("builds the exact StagedRecords the engine takes: expense / income / refund only, category, note, no committed id", () => {
    const rows = [
      reconRow({ id: "e", day: OCT_24, description: "CAFE", amount: 90 }),
      reconRow({ id: "r", day: OCT_24, description: "REFUND AMAZON", direction: "credit", amount: 300 }),
      reconRow({ id: "i", day: OCT_24, description: "IGNORED", amount: 5 }),
    ];
    const session = reconSession(rows, { e: { kind: "import_new", category: "Food", notes: "team lunch" }, r: { kind: "import_new", category: "Salary", creditAs: "refund" }, i: { kind: "ignore" } });
    const staged = stagedRecordsForImport(rows, session.decisions, new Set(["e", "r"]));
    expect(staged.map((s) => [s.id, s.flowType, s.direction, s.amount, s.category, s.committedTransactionId])).toEqual([
      ["e", "expense", "debit", 90, "Food", null],
      ["r", "reversal", "credit", 300, "Salary", null],
    ]);
    expect(staged[0]!.notes).toBe(`team lunch · ${RECONCILIATION_IMPORT_NOTE}`);
    expect(staged[1]!.notes).toBe(RECONCILIATION_IMPORT_NOTE);
  });
});

describe("evidence", () => {
  it("a new possible match changes the row's evidence; unrelated records don't", () => {
    const rows = [reconRow({ id: "r1", day: OCT_24, description: "CAFE", amount: 90 })];
    const decisions = { r1: { kind: "import_new" as const, category: "Food" } };
    const before = plan(rows, decisions);
    const unrelated = plan(rows, decisions, reconData({ transactions: [txn({ id: "other", amount: 7777, dateTime: new Date(2026, 9, 24, 13) })] }));
    expect(changedEvidence(before.evidence, unrelated.evidence)).toEqual([]);
    const lookalike = plan(rows, decisions, reconData({ transactions: [txn({ id: "t-cafe", amount: 90, description: "Cafe", dateTime: new Date(2026, 9, 24, 13) })] }));
    expect(changedEvidence(before.evidence, lookalike.evidence)).toEqual(["r1"]);
  });

  it("the key Already-imported detection looks up IS the key the commit engine writes (txn_ + importTransferKey)", () => {
    const sessionId = reconciliationSessionId("fp:phase4", "acc-card");
    expect(importedTransactionIdsFor("r9", { fingerprint: "fp:phase4", accountId: "acc-card", priorSessionIds: {} })).toEqual([`txn_${importTransferKey("r9", sessionId)}`]);
  });
});
