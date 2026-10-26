import { describe, expect, it } from "vitest";
import { matchRows } from "./match-engine";
import {
  EMPTY_DECISION,
  applyBulkLink,
  bulkLinkEligible,
  confirmRowValues,
  decisionErrors,
  editRow,
  importBlockReasons,
  invalidateAfterEdit,
  rejectCandidate,
  reviewSummary,
  setDecision,
  undoBulk,
  type RowGateContext,
} from "./decisions";
import { record, reconRow } from "./test-fixtures";
import type { CycleInfo, ExistingRecord, ReconRow, RowDecision } from "./types";

const OPEN: RowGateContext = { isCardAccount: true, cycle: null };
const cycle = (status: CycleInfo["status"]): RowGateContext => ({ isCardAccount: true, cycle: { status, periodStart: new Date(2026, 7, 18), periodEnd: new Date(2026, 8, 17), dueDate: new Date(2026, 9, 5) } });

function matches(rows: ReconRow[], records: ExistingRecord[], decisions: Record<string, RowDecision> = {}) {
  return new Map(matchRows(rows, { accountId: "acc-card", records, decisions }).map((m) => [m.rowId, m]));
}

describe("Import as new — eligibility gates", () => {
  it("needs the 'different transaction' confirmation when any candidate exists, and a category", () => {
    const row = reconRow({ id: "r1" });
    const m = matches([row], [record({ id: "t1" })]).get("r1")!;
    const d = { ...EMPTY_DECISION, kind: "import_new" as const };
    expect(decisionErrors(row, m, d, OPEN)).toEqual(["Confirm this is a different transaction from the possible matches.", "Choose a category."]);
    expect(decisionErrors(row, m, { ...d, notSameAck: true, category: "Food" }, OPEN)).toEqual([]);
  });

  it("a pending SMS also requires the confirmation", () => {
    const row = reconRow({ id: "r1" });
    const m = matches([row], [record({ id: "sms:1", kind: "sms_pending" })]).get("r1")!;
    expect(decisionErrors(row, m, { ...EMPTY_DECISION, kind: "import_new", category: "Food" }, OPEN)).toContain("Confirm this is a different transaction from the possible matches.");
  });

  it("D10: blocked in a closed or already-paid card bill", () => {
    const row = reconRow({ id: "r1" });
    const m = matches([row], []).get("r1")!;
    expect(importBlockReasons(row, m, cycle("closed"))[0]).toMatch(/already closed/);
    expect(importBlockReasons(row, m, cycle("paid"))[0]).toMatch(/already paid/);
    expect(importBlockReasons(row, m, cycle("open"))).toEqual([]);
  });

  it("D8: a card payment can't be imported; EMI lines neither", () => {
    const payment = reconRow({ id: "r1", kind: "payment", direction: "credit" });
    const emi = reconRow({ id: "r2", kind: "emi" });
    const m = matches([payment, emi], []);
    expect(importBlockReasons(payment, m.get("r1")!, OPEN)[0]).toMatch(/Card payments/);
    expect(importBlockReasons(payment, m.get("r1")!, { isCardAccount: false, cycle: null })).toEqual([]);
    expect(importBlockReasons(emi, m.get("r2")!, OPEN)[0]).toMatch(/EMI/);
  });

  it("an already-imported row can only be linked", () => {
    const row = reconRow({ id: "r1" });
    const m = matchRows([row], { accountId: "acc-card", records: [record({ id: "txn_k_r1" })], decisions: {}, importedIdsForRow: () => ["txn_k_r1"] })[0]!;
    expect(importBlockReasons(row, m, OPEN)).toContain("This row is already imported — link it to that transaction instead.");
    expect(decisionErrors(row, m, { ...EMPTY_DECISION, kind: "link", linkedRecordId: "txn_k_r1" }, OPEN)).toEqual([]);
  });
});

describe("D6 — editing captured values requires re-confirmation", () => {
  it("an edit marks the row and withdraws that field's confirmation; 'Values are correct' clears it", () => {
    const row = reconRow({ id: "r1", confirmedFields: ["amount"], confirmed: true });
    const edited = editRow(row, { amount: 501 });
    expect(edited).toMatchObject({ amount: 501, needsReconfirm: true, confirmed: false, edited: true });
    expect(edited.confirmedFields).not.toContain("amount");
    const m = matches([edited], []).get("r1")!;
    expect(importBlockReasons(edited, m, OPEN)).toContain("You changed this row — confirm the values are correct.");
    expect(confirmRowValues(edited).needsReconfirm).toBe(false);
  });

  it("toggling include isn't a value edit", () => {
    expect(editRow(reconRow({ id: "r1" }), { include: false }).needsReconfirm).toBe(false);
  });

  it("a Link or Import decision made against old values is withdrawn after an edit; Ignore stays", () => {
    const decisions = { r1: { ...EMPTY_DECISION, kind: "link" as const, linkedRecordId: "t1" }, r2: { ...EMPTY_DECISION, kind: "ignore" as const } };
    expect(invalidateAfterEdit(decisions, "r1").r1).toMatchObject({ kind: null, linkedRecordId: null });
    expect(invalidateAfterEdit(decisions, "r2").r2!.kind).toBe("ignore");
  });
});

describe("Link validity", () => {
  it("must point at a current candidate, not one claimed by another row", () => {
    const rows = [reconRow({ id: "r1" }), reconRow({ id: "r2" })];
    const decisions = { r1: { ...EMPTY_DECISION, kind: "link" as const, linkedRecordId: "t1" }, r2: { ...EMPTY_DECISION, kind: "link" as const, linkedRecordId: "t1" } };
    const m = matches(rows, [record({ id: "t1" })], decisions);
    expect(decisionErrors(rows[0]!, m.get("r1")!, decisions.r1, OPEN)).toEqual([]);
    expect(decisionErrors(rows[1]!, m.get("r2")!, decisions.r2, OPEN)).toEqual(["That transaction is already linked to another row."]);
  });

  it("a link to a transaction that was deleted since is no longer valid", () => {
    const row = reconRow({ id: "r1" });
    const d = { ...EMPTY_DECISION, kind: "link" as const, linkedRecordId: "t1" };
    const m = matches([row], [record({ id: "t1", deleted: true })], { r1: d }).get("r1")!;
    expect(decisionErrors(row, m, d, OPEN)[0]).toMatch(/no longer a possible match/);
  });

  it("'Not this one' withdraws a link to that record", () => {
    const decisions = { r1: { ...EMPTY_DECISION, kind: "link" as const, linkedRecordId: "t1" } };
    expect(rejectCandidate(decisions, "r1", "t1").r1).toMatchObject({ kind: null, rejectedRecordIds: ["t1"] });
  });
});

describe("review summary", () => {
  it("is complete only when every included row has a valid decision and nothing is under investigation", () => {
    const rows = [reconRow({ id: "r1" }), reconRow({ id: "r2", description: "ZOMATO", amount: 700 }), reconRow({ id: "r3", include: false })];
    const records = [record({ id: "t1" })];
    let decisions: Record<string, RowDecision> = { r1: { ...EMPTY_DECISION, kind: "link", linkedRecordId: "t1" }, r2: { ...EMPTY_DECISION, kind: "investigate" } };
    let s = reviewSummary(rows, matches(rows, records, decisions), decisions, () => OPEN);
    expect(s).toMatchObject({ included: 2, decided: 1, investigate: 1, open: 0, complete: false });
    decisions = setDecision(decisions, "r2", { kind: "ignore" });
    s = reviewSummary(rows, matches(rows, records, decisions), decisions, () => OPEN);
    expect(s).toMatchObject({ decided: 2, complete: true });
  });
});

describe("D5 — bulk Link", () => {
  it("only unique exact candidates without a decision; Undo reverts exactly that batch", () => {
    const rows = [reconRow({ id: "r1" }), reconRow({ id: "r2", amount: 700, description: "ZOMATO" }), reconRow({ id: "r3", amount: 900, description: "UBER" }), reconRow({ id: "r4", amount: 300, description: "OLA" })];
    const records = [
      record({ id: "t1" }),
      record({ id: "t2", amount: 700.02, description: "Zomato", iso: "2026-09-06T10:00:00+05:30" }), // near only
      record({ id: "t3", amount: 900, description: "Uber" }),
      record({ id: "t4", amount: 300, description: "Ola" }),
    ];
    let decisions: Record<string, RowDecision> = { r4: { ...EMPTY_DECISION, kind: "ignore" } };
    const eligible = bulkLinkEligible(rows, matches(rows, records, decisions), decisions);
    expect(eligible).toEqual([
      { rowId: "r1", recordId: "t1" },
      { rowId: "r3", recordId: "t3" },
    ]);
    decisions = applyBulkLink(decisions, eligible, "b1");
    // The user changes r3 by hand afterwards — Undo must leave that alone.
    decisions = setDecision(decisions, "r3", { kind: "investigate" });
    decisions = undoBulk(decisions, "b1");
    expect(decisions.r1).toMatchObject({ kind: null, linkedRecordId: null });
    expect(decisions.r3!.kind).toBe("investigate");
    expect(decisions.r4!.kind).toBe("ignore");
  });
});
