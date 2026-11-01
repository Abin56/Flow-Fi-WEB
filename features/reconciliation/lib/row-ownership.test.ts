import { describe, expect, it } from "vitest";
import { analyzeSession } from "./analyze";
import { buildApprovalPlan, stagedRecordsForImport } from "./approval-plan";
import { decisionErrors, decisionFor, importActionFor, setDecision } from "./decisions";
import { describeOwnership, emptySplit, ownershipDetail, ownershipErrors, parseShareAmount, sharePaise } from "./row-ownership";
import { APPROVAL_NOW, reconData, reconRow, reconSession } from "./test-fixtures";
import type { RowOwnership, SplitShareDraft } from "./types";
import type { Person } from "@/lib/models/person";

const PEOPLE = [
  { id: "p-ravi", name: "Ravi", deletedAt: null },
  { id: "p-asha", name: "Asha", deletedAt: null },
];
const row = reconRow({ id: "r1", amount: 1000 });
const share = (over: Partial<SplitShareDraft> & { id: string }): SplitShareDraft => ({ personId: null, name: "", isMe: false, amount: "", ...over });
const me = (amount = "") => share({ id: "me", name: "Me", isMe: true, amount });
const split = (splitType: "equal" | "custom", shares: SplitShareDraft[]): RowOwnership => ({ kind: "split", splitType, shares });

describe("ownershipErrors — person", () => {
  it("mine (no ownership) has nothing to check", () => {
    expect(ownershipErrors(row, null, PEOPLE)).toEqual([]);
    expect(ownershipErrors(row, undefined, PEOPLE)).toEqual([]);
  });
  it("needs a person, accepts a picked one, refuses one that no longer exists", () => {
    expect(ownershipErrors(row, { kind: "person", personId: null, name: "" }, PEOPLE)).toEqual(["Choose a person, or type a name."]);
    expect(ownershipErrors(row, { kind: "person", personId: "p-ravi", name: "Ravi" }, PEOPLE)).toEqual([]);
    expect(ownershipErrors(row, { kind: "person", personId: "p-gone", name: "Gone" }, PEOPLE)[0]).toMatch(/isn't in People any more/);
    // A deleted person is as gone as a missing one.
    expect(ownershipErrors(row, { kind: "person", personId: "p-x", name: "X" }, [{ id: "p-x", name: "X", deletedAt: new Date() }])[0]).toMatch(/isn't in People any more/);
  });
  it("a typed name is allowed for someone new, but not for someone already in People, nor for 'Me'", () => {
    expect(ownershipErrors(row, { kind: "person", personId: null, name: "Newcomer" }, PEOPLE)).toEqual([]);
    expect(ownershipErrors(row, { kind: "person", personId: null, name: "  ravi " }, PEOPLE)[0]).toMatch(/already in People/);
    expect(ownershipErrors(row, { kind: "person", personId: null, name: "me" }, PEOPLE)[0]).toMatch(/is you/);
  });
  it("without a loaded People list a picked person is not reported missing (the approval re-checks on the server)", () => {
    expect(ownershipErrors(row, { kind: "person", personId: "p-ravi", name: "Ravi" }, undefined)).toEqual([]);
  });
  it("only charges can be assigned, and only once the amount is known", () => {
    expect(ownershipErrors({ amount: 100, direction: "credit" }, { kind: "person", personId: "p-ravi", name: "Ravi" }, PEOPLE)[0]).toMatch(/Only expenses/);
    expect(ownershipErrors({ amount: null, direction: "debit" }, { kind: "person", personId: "p-ravi", name: "Ravi" }, PEOPLE)[0]).toMatch(/amount first/);
  });
});

describe("ownershipErrors — split", () => {
  it("a fresh split asks for the other person", () => {
    expect(ownershipErrors(row, emptySplit(), PEOPLE)).toContain("Choose a person, or type a name.");
  });
  it("custom amounts must add up exactly — in paise, never float", () => {
    const ok = split("custom", [me("700.10"), share({ id: "a", personId: "p-ravi", name: "Ravi", amount: "299.90" })]);
    expect(ownershipErrors(row, ok, PEOPLE)).toEqual([]);
    const under = split("custom", [me("500"), share({ id: "a", personId: "p-ravi", name: "Ravi", amount: "400" })]);
    expect(ownershipErrors(row, under, PEOPLE)).toEqual(["₹100.00 left to assign — the amounts must add up to ₹1,000.00."]);
    const over = split("custom", [me("500"), share({ id: "a", personId: "p-ravi", name: "Ravi", amount: "500.01" })]);
    expect(ownershipErrors(row, over, PEOPLE)).toEqual(["₹0.01 over — the amounts must add up to ₹1,000.00."]);
    // 0.1 + 0.2 style drift: three tenths of a rupee add to exactly ₹0.30.
    expect(ownershipErrors({ amount: 0.3, direction: "debit" }, split("custom", [me("0.1"), share({ id: "a", personId: "p-ravi", name: "Ravi", amount: "0.2" })]), PEOPLE)).toEqual([]);
  });
  it("rejects unreadable and over-precise amounts, and a zero share for someone else (but allows ₹0 for me)", () => {
    expect(ownershipErrors(row, split("custom", [me("abc"), share({ id: "a", personId: "p-ravi", name: "Ravi", amount: "1000" })]), PEOPLE)[0]).toMatch(/at most two decimals/);
    expect(ownershipErrors(row, split("custom", [me("0"), share({ id: "a", personId: "p-ravi", name: "Ravi", amount: "1000" })]), PEOPLE)).toEqual([]);
    expect(ownershipErrors(row, split("custom", [me("1000"), share({ id: "a", personId: "p-ravi", name: "Ravi", amount: "0" })]), PEOPLE)).toContain("Ravi needs an amount above ₹0.");
    expect(parseShareAmount("1,250.50")).toBe(1250.5);
    expect(parseShareAmount("1.234")).toBeNull();
    expect(parseShareAmount("-5")).toBeNull();
  });
  it("the same person twice is refused — picked twice, typed twice, or picked and typed (the duplicate-participant ledger blocker)", () => {
    const pickedTwice = split("equal", [me(), share({ id: "a", personId: "p-ravi", name: "Ravi" }), share({ id: "b", personId: "p-ravi", name: "Ravi" })]);
    expect(ownershipErrors(row, pickedTwice, PEOPLE).join(" ")).toMatch(/Ravi is already in this split/);
    const typedTwice = split("equal", [me(), share({ id: "a", name: "Newcomer" }), share({ id: "b", name: " newcomer " })]);
    expect(ownershipErrors(row, typedTwice, PEOPLE).join(" ")).toMatch(/Newcomer is already in this split|newcomer is already in this split/i);
    const pickedAndTyped = split("equal", [me(), share({ id: "a", personId: "p-ravi", name: "Ravi" }), share({ id: "b", name: "RAVI" })]);
    expect(ownershipErrors(row, pickedAndTyped, PEOPLE).join(" ")).toMatch(/RAVI is already in People/);
  });
  it("needs exactly one 'Me' row and at least one other person", () => {
    expect(ownershipErrors(row, split("equal", [me()]), PEOPLE)).toContain("Add at least one other person to split with.");
    expect(ownershipErrors(row, split("equal", [share({ id: "a", personId: "p-ravi", name: "Ravi" })]), PEOPLE)).toContain("A split needs exactly one row for you.");
  });
  it("an amount too small to split is refused", () => {
    expect(ownershipErrors({ amount: 0.02, direction: "debit" }, split("equal", [me(), share({ id: "a", personId: "p-ravi", name: "Ravi" }), share({ id: "b", personId: "p-asha", name: "Asha" })]), PEOPLE)[0]).toMatch(/too small/);
  });
});

describe("shares and the staged detail", () => {
  it("equal shares follow the repository rule: each rounded, the last takes the remainder", () => {
    const three = [me(), share({ id: "a", personId: "p-ravi", name: "Ravi" }), share({ id: "b", personId: "p-asha", name: "Asha" })];
    expect(sharePaise(three, "equal", 10000)).toEqual([3333, 3333, 3334]);
    expect(sharePaise(three, "equal", 10000).reduce((a: number, b) => a + (b ?? 0), 0)).toBe(10000);
  });
  it("maps a person onto someone_elses_expense and a split onto shared_expense with the exact shares", () => {
    expect(ownershipDetail(row, { kind: "person", personId: "p-ravi", name: " Ravi " })).toEqual({ action: "someone_elses_expense", detail: { kind: "someone_elses_expense", personId: "p-ravi", personName: "Ravi" } });
    const { action, detail } = ownershipDetail(row, split("custom", [me("250"), share({ id: "a", personId: "p-ravi", name: "Ravi", amount: "750" })]));
    expect(action).toBe("shared_expense");
    expect(detail).toEqual({
      kind: "shared_expense",
      splitType: "custom",
      participants: [
        { personId: null, name: "Me", share: 250, isMe: true, receivedStatus: "notApplicable" },
        { personId: "p-ravi", name: "Ravi", share: 750, isMe: false, receivedStatus: "yetToReceive" },
      ],
    });
  });
  it("describes it in one line", () => {
    expect(describeOwnership(row, null)).toBeNull();
    expect(describeOwnership(row, { kind: "person", personId: "p-ravi", name: "Ravi" })).toBe("For Ravi — they owe the full amount");
    expect(describeOwnership(row, split("custom", [me("250"), share({ id: "a", personId: "p-ravi", name: "Ravi", amount: "750" })]))).toBe("Split with Ravi · your share ₹250.00");
  });
});

describe("the decision gate, the plan and the staged records", () => {
  const data = reconData({ people: PEOPLE as unknown as Person[] });
  const rows = [reconRow({ id: "r1", amount: 1000, description: "DINNER", day: [2026, 10, 24] })];
  const base = { kind: "import_new" as const, category: "Food" };
  const analyze = (decisions: Record<string, Partial<import("./types").RowDecision>>, d = data) => {
    const session = reconSession(rows, decisions);
    const a = analyzeSession(session, d, { now: APPROVAL_NOW });
    return { session, a, plan: buildApprovalPlan({ rows, matches: a.matches, decisions: session.decisions, gate: a.gate }) };
  };

  it("importActionFor follows the ownership; a credit never takes one", () => {
    expect(importActionFor(rows[0], decisionFor({}, "r1"))).toBe("normal_expense");
    expect(importActionFor(rows[0], { ...decisionFor({}, "r1"), ownership: { kind: "person", personId: "p-ravi", name: "Ravi" } })).toBe("someone_elses_expense");
    expect(importActionFor(rows[0], { ...decisionFor({}, "r1"), ownership: emptySplit() })).toBe("shared_expense");
    expect(importActionFor(reconRow({ id: "c", direction: "credit" }), { ...decisionFor({}, "c"), creditAs: "income", ownership: emptySplit() })).toBe("income");
  });

  it("a valid person assignment plans as an import with its ownership line; an invalid split blocks the row", () => {
    const ok = analyze({ r1: { ...base, ownership: { kind: "person", personId: "p-ravi", name: "Ravi" } } });
    expect(ok.plan.rows[0]).toMatchObject({ status: "import", action: "someone_elses_expense", ownership: "For Ravi — they owe the full amount" });
    expect(ok.plan.chargesPaise).toBe(100000);
    const bad = analyze({ r1: { ...base, ownership: split("custom", [me("100"), share({ id: "a", personId: "p-ravi", name: "Ravi", amount: "100" })]) } });
    expect(bad.plan.rows[0].status).toBe("blocked");
    expect(bad.plan.rows[0].reasons.join(" ")).toMatch(/left to assign/);
    expect(bad.plan.complete).toBe(false);
  });

  it("a person who disappeared from People blocks the row against the fresh data", () => {
    const decisions = { r1: { ...base, ownership: { kind: "person" as const, personId: "p-ravi", name: "Ravi" } } };
    expect(analyze(decisions, reconData({ people: [PEOPLE[1]] as unknown as Person[] })).plan.rows[0].status).toBe("blocked");
  });

  it("stages the rows for the engine: ownership axes + detail for assigned rows, plain expenses untouched", () => {
    const decisions = { r1: { ...base, ownership: split("custom", [me("400"), share({ id: "a", personId: "p-ravi", name: "Ravi", amount: "600" })]) } };
    const { session } = analyze(decisions);
    const [record] = stagedRecordsForImport(session.rows, session.decisions, new Set(["r1"]));
    expect(record).toMatchObject({ flowType: "expense", ownership: "shared", direction: "debit", amount: 1000 });
    expect(record.actionDetail).toMatchObject({ kind: "shared_expense", splitType: "custom" });
    const [plain] = stagedRecordsForImport(session.rows, reconSession(rows, { r1: base }).decisions, new Set(["r1"]));
    expect(plain).toMatchObject({ flowType: "expense", ownership: "mine", actionDetail: null });
  });

  it("changing the row's kind away from Import clears the ownership", () => {
    const withOwnership = reconSession(rows, { r1: { ...base, ownership: emptySplit() } }).decisions;
    expect(setDecision(withOwnership, "r1", { kind: "ignore" }).r1.ownership).toBeNull();
    expect(decisionErrors(rows[0], analyze({}).a.matches.get("r1")!, { ...decisionFor({}, "r1"), ...base, ownership: emptySplit() }, analyze({}).a.gate(rows[0])).length).toBeGreaterThan(0);
  });
});
