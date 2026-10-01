import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  peopleDirectionSides,
  personBalanceBreakdown,
  personPosition,
  type BreakdownLedgerEntry,
  type PositionLoan,
} from "@/lib/engines/person-position";
import { signedAmount, type LedgerEntryType } from "@/lib/models/person";
import { KIND_LABEL, directionMessage, signedSideLabel, statementTypeLabel } from "@/features/people/lib/settlement-presentation";
import { DIRECTION_LABEL } from "@/features/people/lib/person-ledger-rows";

/**
 * Person borrowing in Month Cycle + standardized People wording. Month Cycle's "You need to give" /
 * "You need to receive" sides come from `peopleDirectionSides` over each person's gross breakdown — a
 * borrowing must never vanish because the same person also owes me something.
 */

let seq = 0;
function e(type: LedgerEntryType, amount: number, patch: Partial<BreakdownLedgerEntry> = {}): BreakdownLedgerEntry {
  seq += 1;
  return { id: `e${seq}`, type, amount, parentEntryId: null, transactionRef: null, isDeleted: false, ...patch };
}

const signed = (x: BreakdownLedgerEntry) => signedAmount({ type: x.type, amount: x.amount, increasesBalance: true } as never);

function row(name: string, entries: BreakdownLedgerEntry[], opts: { loans?: PositionLoan[]; emiReceivable?: number } = {}) {
  const active = entries.filter((x) => !x.isDeleted);
  const position = personPosition({
    personId: name,
    currentBalance: active.reduce((s, x) => s + signed(x), 0),
    loans: opts.loans ?? [],
    ledgerEntries: entries.map((x) => ({ transactionRef: x.transactionRef, signedAmount: signed(x), isDeleted: x.isDeleted })),
    loanIds: new Set((opts.loans ?? []).map((l) => l.id)),
    emiReceivable: opts.emiReceivable,
  });
  return { name, position, breakdown: personBalanceBreakdown(position, entries, new Set()) };
}

const give = (rows: ReturnType<typeof row>[]) => peopleDirectionSides(rows).toGive.map((x) => [x.row.name, x.amount]);
const receive = (rows: ReturnType<typeof row>[]) => peopleDirectionSides(rows).toReceive.map((x) => [x.row.name, x.amount]);

describe("Borrowing from a person → You need to give (People + Month Cycle)", () => {
  it("1–2. borrow ₹500 today → People: give ₹500; Month Cycle: ₹500 under You need to give", () => {
    const amma = row("AMMA", [e("borrowed", 500)]);
    expect(amma.breakdown).toMatchObject({ toGive: 500, toReceive: 0, net: -500 });
    expect(amma.position.iOwe).toBe(500);
    expect(give([amma])).toEqual([["AMMA", 500]]);
    expect(receive([amma])).toEqual([]);
    expect(peopleDirectionSides([amma]).totalToGive).toBe(500);
  });

  it("root cause: borrow ₹500 while AMMA owes me ₹500 (EMI share) → still under You need to give", () => {
    // The old Month Cycle filtered on the NET (−500 + 500 = 0) and dropped AMMA from both sides.
    const amma = row("AMMA", [e("borrowed", 500)], { emiReceivable: 500 });
    expect(amma.position.net).toBe(0);
    expect(give([amma])).toEqual([["AMMA", 500]]);
    expect(receive([amma])).toEqual([["AMMA", 500]]);
  });

  it("borrow ₹500 while AMMA owes me a ₹2,000 Loan → borrowing not swallowed by the receivable", () => {
    const loan: PositionLoan = { id: "L1", personId: "AMMA", direction: "given", outstandingPrincipal: 2000, isDeleted: false };
    const amma = row("AMMA", [e("borrowed", 500)], { loans: [loan] });
    expect(amma.position.iOwe).toBe(0);
    expect(give([amma])).toEqual([["AMMA", 500]]);
    expect(receive([amma])).toEqual([["AMMA", 2000]]);
  });

  it("3. borrow ₹1,000 + borrow ₹500 → You need to give ₹1,500", () => {
    const amma = row("AMMA", [e("borrowed", 1000), e("borrowed", 500)]);
    expect(give([amma])).toEqual([["AMMA", 1500]]);
  });

  it("4. borrow ₹1,000 + repay ₹500 → You need to give ₹500", () => {
    const b = e("borrowed", 1000);
    const amma = row("AMMA", [b, e("repaid", 500, { parentEntryId: b.id })]);
    expect(give([amma])).toEqual([["AMMA", 500]]);
  });

  it("5. money given to a person → You need to receive, not You need to give", () => {
    const amma = row("AMMA", [e("gave", 800)]);
    expect(give([amma])).toEqual([]);
    expect(receive([amma])).toEqual([["AMMA", 800]]);
  });

  it("6. opposite-direction gross obligations net correctly (give ₹1,000, receive ₹500 → net give ₹500)", () => {
    const amma = row("AMMA", [e("borrowed", 1000), e("gave", 500)]);
    expect(amma.breakdown).toMatchObject({ toGive: 1000, toReceive: 500, net: -500 });
    const sides = peopleDirectionSides([amma, row("RAVI", [e("gave", 300)])]);
    expect(sides.totalToGive).toBe(1000);
    expect(sides.totalToReceive).toBe(800);
    // Σ sides still equals Σ net — no second balance.
    expect(sides.totalToReceive - sides.totalToGive).toBe(-500 + 300);
  });

  it("a settled person appears on neither side", () => {
    const b = e("borrowed", 400);
    expect(peopleDirectionSides([row("AMMA", [b, e("repaid", 400, { parentEntryId: b.id })])]).toGive).toEqual([]);
  });
});

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const PEOPLE_UI = [
  "features/people/components/people-ledger-list.tsx",
  "features/people/components/person-detail-workspace.tsx",
  "features/people/components/person-activity-feed.tsx",
  "features/people/components/add-person-inline.tsx",
  "features/people/components/workspace/settle-up-panel.tsx",
  "features/people/components/workspace/transaction-ledger-mode.tsx",
  "features/people/components/workspace/record-payment-panel.tsx",
  "features/people/components/workspace/payment-extras.tsx",
  "features/people/components/workspace/settlement-summary.tsx",
  "features/month-cycle/components/month-cycle-workspace.tsx",
];

describe("Standardized money-direction wording", () => {
  it('7. "owns you" never appears on People / Month Cycle UI', () => {
    for (const f of PEOPLE_UI) expect(read(f), f).not.toMatch(/owns you/i);
  });

  it("8. person list: filter + cycle summary use You need to give / You need to receive", () => {
    const src = read("features/people/components/people-ledger-list.tsx");
    expect(src).toContain('label: "You need to receive"');
    expect(src).toContain('label: "You need to give"');
    expect(src).not.toMatch(/label: "They owe you"|label: "You owe them"|>You owe</);
    expect(DIRECTION_LABEL).toMatchObject({ theyOwe: "To receive", iOwe: "To give" });
  });

  it("9. person detail / headline wording", () => {
    expect(signedSideLabel(500, "AMMA K")).toBe("You need to receive from AMMA");
    expect(signedSideLabel(-500, "AMMA K")).toBe("You need to give to AMMA");
    expect(signedSideLabel(0, "AMMA")).toBeNull();
    const detail = read("features/people/components/person-detail-workspace.tsx");
    expect(detail).toContain('"Net you need to give"');
    expect(detail).toContain('"Net you need to receive"');
    expect(detail).not.toMatch(/" you owe"|" owed to you"/);
  });

  it("10. Month Cycle says You need to give / You need to receive (no Handover pending / owes you)", () => {
    const src = read("features/month-cycle/components/month-cycle-workspace.tsx");
    expect(src).toContain('label="You need to give"');
    expect(src).toContain('label="You need to receive"');
    expect(src).toContain(">You need to receive</p>");
    expect(src).not.toMatch(/Handover pending|owes you|You owe nobody/);
  });

  it("11–12. transaction rows keep their contextual labels and classifications", () => {
    const r = (category: string, signedAmount: number) => ({ kind: "obligation", category, signedAmount }) as never;
    expect(statementTypeLabel(r("borrowed", -500))).toBe(KIND_LABEL.moneyReceived);
    expect(statementTypeLabel(r("gave", 500))).toBe(KIND_LABEL.moneyGiven);
    expect(statementTypeLabel(r("emi", 500))).toBe("EMI");
    expect(statementTypeLabel(r("loan", 500))).toBe("Loan installment");
    expect(statementTypeLabel(r("split", 500))).toBe("Split expense");
    expect(KIND_LABEL.assigned).toBe("Assigned expense");
    expect(directionMessage({ kind: "settlement", category: "repaid", signedAmount: 500 } as never, "AMMA")).toBe("You paid AMMA back");
    expect(directionMessage({ kind: "settlement", category: "received", signedAmount: -500 } as never, "AMMA")).toBe("AMMA paid you back");
  });
});
