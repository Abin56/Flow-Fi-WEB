import { describe, expect, it } from "vitest";
import type { Category } from "@/lib/models/category";
import { autoReadyDecisions, withAutoReady } from "./auto-ready";
import { EMPTY_DECISION, type RowGateContext } from "./decisions";
import { matchRows } from "./match-engine";
import { intelForRows } from "./row-intelligence";
import { rowStatus, statusCounts } from "./row-status";
import { record, reconRow } from "./test-fixtures";
import type { ReconRow, RowDecision } from "./types";

const OPEN: RowGateContext = { isCardAccount: true, cycle: null };
const BANK: RowGateContext = { isCardAccount: false, cycle: null, ownedAccounts: [] };
const CATS = [
  { id: "c-other", name: "Other", type: "both", isActive: true, deletedAt: null },
  { id: "c-food", name: "Food & Dining", type: "expense", isActive: true, deletedAt: null },
  { id: "c-mob", name: "Mobile & Internet", type: "expense", isActive: true, deletedAt: null },
  { id: "c-sal", name: "Salary", type: "income", isActive: true, deletedAt: null },
] as unknown as Category[];
const run = (rows: ReconRow[], records = [] as ReturnType<typeof record>[], decisions: Record<string, RowDecision> = {}) =>
  new Map(matchRows(rows, { accountId: "acc-card", records, decisions }).map((m) => [m.rowId, m]));
const intelOf = (rows: ReconRow[], index = new Map<string, string[]>(), cats = CATS) => intelForRows(rows, { categories: cats, descriptionHistory: null, categoryHistory: null, merchantIndex: index });
const auto = (rows: ReconRow[], matches: ReturnType<typeof run>, decisions: Record<string, RowDecision> = {}, gate: RowGateContext = OPEN, cats = CATS) =>
  autoReadyDecisions({ rows, matches, decisions, gate: () => gate, intel: intelOf(rows, new Map(), cats) });

describe("default Ready rows (2026-11-25: reliable categories only, never 'Other')", () => {
  it("a recognised merchant with no possible match is Ready with that merchant's category", () => {
    const rows = [reconRow({ id: "r1", description: "UPI/627632125367/DR/Jio Pr/YESB/paytm-jio/UPI", amount: 299 })];
    const m = run(rows);
    const a = auto(rows, m, {}, BANK);
    expect(a.r1).toMatchObject({ kind: "import_new", category: "Mobile & Internet" });
    expect(rowStatus(rows[0]!, m.get("r1"), withAutoReady({}, a), BANK)).toMatchObject({ kind: "ready", label: "Ready", next: "import" });
  });

  it("an unknown payee is not filed under 'Other' — it asks for a category", () => {
    const rows = [reconRow({ id: "r1", description: "SHOP ONE", amount: 120 })];
    const m = run(rows);
    expect(auto(rows, m)).toEqual({});
    expect(rowStatus(rows[0]!, m.get("r1"), {}, OPEN)).toMatchObject({ kind: "fix", next: "category" });
  });

  it("the user's category picked on the row makes it Ready — and is kept", () => {
    const rows = [reconRow({ id: "r1", description: "SHOP ONE", amount: 120 })];
    const m = run(rows);
    const picked = { r1: { ...EMPTY_DECISION, category: "Food & Dining", notes: "lunch" } };
    const a = auto(rows, m, picked);
    expect(a.r1).toMatchObject({ kind: "import_new", category: "Food & Dining", notes: "lunch" });
  });

  it("a credit is never Ready until the user says what it is — then it is", () => {
    const rows = [reconRow({ id: "cr", description: "UPI/627481159639/CR/MOHAN/BKID/mohankoda/UPI", amount: 2000, direction: "credit" })];
    const m = run(rows);
    expect(auto(rows, m, {}, BANK)).toEqual({});
    expect(rowStatus(rows[0]!, m.get("cr"), {}, BANK)).toMatchObject({ kind: "fix", next: "credit_type" });
    const typed = { cr: { ...EMPTY_DECISION, creditAs: "income" as const, notOwnTransferAck: true, category: "Salary" } };
    expect(auto(rows, m, typed, BANK).cr).toMatchObject({ kind: "import_new", creditAs: "income" });
  });

  it("a UPI payment to a person needs the 'paid to someone else' answer first", () => {
    const rows = [reconRow({ id: "p", description: "UPI/612345678901/DR/RAHUL K/SBIN/rahulk/UPI", amount: 500 })];
    const m = run(rows);
    const withCat = { p: { ...EMPTY_DECISION, category: "Food & Dining" } };
    expect(auto(rows, m, withCat, BANK)).toEqual({});
    expect(rowStatus(rows[0]!, m.get("p"), withCat, BANK)).toMatchObject({ kind: "fix", next: "own_transfer" });
    expect(auto(rows, m, { p: { ...withCat.p, notOwnTransferAck: true } }, BANK).p?.kind).toBe("import_new");
  });

  it("never defaults: a possible match or an explicit decision", () => {
    const rows = [reconRow({ id: "dup", description: "ZOMATO", amount: 300 }), reconRow({ id: "skip", description: "SWIGGY", amount: 90 })];
    const m = run(rows, [record({ id: "t1", amount: 300, description: "Zomato" })]);
    const a = auto(rows, m, { skip: { ...EMPTY_DECISION, kind: "ignore" } });
    expect(a.dup).toBeUndefined();
    expect(a.skip).toBeUndefined();
  });

  it("an explicit decision always wins over the default", () => {
    const explicit = { r1: { ...EMPTY_DECISION, kind: "ignore" as const } };
    const merged = withAutoReady(explicit, { r1: { ...EMPTY_DECISION, kind: "import_new", category: "Other" }, r2: { ...EMPTY_DECISION, kind: "import_new", category: "Other" } });
    expect(merged.r1!.kind).toBe("ignore");
    expect(merged.r2!.kind).toBe("import_new");
  });
});

describe("one status per row", () => {
  it("Possible match → decide → Already recorded (skipped) / Keep both (ready); never two statuses at once", () => {
    const rows = [reconRow({ id: "r1", description: "ZOMATO", amount: 300 })];
    const records = [record({ id: "t1", amount: 300, description: "Zomato" })];
    const m = run(rows, records);
    expect(rowStatus(rows[0]!, m.get("r1"), {}, OPEN)).toMatchObject({ kind: "duplicate", label: "Possible match", next: "review" });
    const linked = { r1: { ...EMPTY_DECISION, kind: "link" as const, linkedRecordId: "t1" } };
    expect(rowStatus(rows[0]!, run(rows, records, linked).get("r1"), linked, OPEN)).toMatchObject({ kind: "skipped", label: "Already recorded" });
    const both = { r1: { ...EMPTY_DECISION, kind: "import_new" as const, notSameAck: true, category: "Food & Dining" } };
    expect(rowStatus(rows[0]!, run(rows, records, both).get("r1"), both, OPEN)).toMatchObject({ kind: "ready", next: "import" });
    const noAck = { r1: { ...EMPTY_DECISION, kind: "import_new" as const, category: "Food & Dining" } };
    expect(rowStatus(rows[0]!, run(rows, records, noAck).get("r1"), noAck, OPEN)?.kind).toBe("duplicate");
  });

  it("a row imported earlier is Imported; a skip recorded in People says so", () => {
    const rows = [reconRow({ id: "r1", description: "A", amount: 10, direction: "credit" })];
    const m = run(rows);
    const people = { r1: { ...EMPTY_DECISION, kind: "ignore" as const, skipReason: "people" as const } };
    expect(rowStatus(rows[0]!, m.get("r1"), people, OPEN)).toMatchObject({ kind: "skipped", label: "Record in People" });
    const imported = { ...m.get("r1")!, state: "already_imported" as const, alreadyImportedId: "txn_x" };
    expect(rowStatus(rows[0]!, imported, {}, OPEN)).toMatchObject({ kind: "imported", label: "Imported" });
  });

  it("a row with an unusable value is Fix required, and a status is never claimed before matching has run", () => {
    const bad = reconRow({ id: "r2", description: "BAD", amount: null });
    expect(rowStatus(bad, run([bad]).get("r2"), {}, OPEN)?.kind).toBe("fix");
    expect(rowStatus(reconRow({ id: "r1" }), undefined, {}, OPEN)).toBeNull();
  });

  it("counts add up to the captured rows", () => {
    const rows = [reconRow({ id: "r1", description: "SWIGGY", amount: 10 }), reconRow({ id: "r2", description: "B", amount: 20, direction: "credit" }), reconRow({ id: "r3", description: "C", amount: 30 })];
    const m = run(rows);
    const explicit = { r3: { ...EMPTY_DECISION, kind: "ignore" as const } };
    const eff = withAutoReady(explicit, auto(rows, m, explicit));
    expect(statusCounts(rows, m, eff, () => OPEN)).toEqual({ captured: 3, ready: 1, duplicate: 0, fix: 1, imported: 0, skipped: 1 });
  });
});
