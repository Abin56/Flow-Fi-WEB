/**
 * Shared-loan installment shares vs the People position — the approved accounting contract
 * (audit findings F1 / F2, docs/shared-debt-ownership-audit.md):
 *
 *  - A person's allocated share of a due installment is a real receivable until they reimburse it.
 *  - Their reimbursement is an asset swap: cash in, THAT receivable out. Not income, never a payable,
 *    never a payment toward their unrelated card purchases, never a lender payment.
 *  - Paying more than is due keeps the excess as an advance (existing People policy): held money that is
 *    neither a payable nor a receivable, never netted against card ownership, and it settles a later share
 *    only when explicitly applied.
 *  - Gross card ownership and the People offset stay two facts: AMMA caused ₹8,000 of card debt and I owe
 *    her ₹5,000 — never rewritten to one ₹3,000 attribution.
 *
 * Everything is read through the canonical engines the hooks use: `personBalanceBreakdown` /
 * `personDirectGross` (People, Debt Planner) and `peopleNetWorthPosition` (Net Worth, Dashboard Debt).
 */

import { describe, expect, it } from "vitest";
import { splitByOwnership, allocateOwnership, type OwnershipShare } from "@/lib/engines/debt-ownership";
import { buildDebtSnapshot, cardPurchaseShares, personDirectPayable, type PersonDebtInput } from "@/lib/engines/debt-position";
import { liabilityTotals, loanBalanceSheet, netWorthWithLoans } from "@/lib/engines/loan-balance-sheet";
import { emiReceivableThrough, personEmiObligations, type EmiObligationInstallment } from "@/lib/engines/person-emi-obligations";
import {
  peopleNetWorthPosition,
  personBalanceBreakdown,
  personDirectGross,
  personPosition,
  type BreakdownAdvanceApplication,
  type BreakdownLedgerEntry,
} from "@/lib/engines/person-position";
import { cardInput, NOW } from "@/lib/engines/debt-planner.fixtures";

type Type = BreakdownLedgerEntry["type"];
let seq = 0;
function entry(type: Type, amount: number, extra: Partial<BreakdownLedgerEntry> = {}): BreakdownLedgerEntry {
  return { id: `e${++seq}`, type, amount, parentEntryId: null, transactionRef: null, obligationRef: null, sourceKind: null, isDeleted: false, ...extra };
}
const sign = (e: BreakdownLedgerEntry) => (e.type === "gave" || e.type === "repaid" || e.type === "adjustment" ? e.amount : -e.amount);
/** Record Payment allocated to one loan-installment share. */
const reimburse = (amount: number, inst = "i1") => entry("receivedBack", amount, { transactionRef: "cash", obligationRef: `loan-inst:${inst}` });
/** Record Payment's "keep the extra as advance". */
const advance = (amount: number) => entry("receivedBack", amount, { transactionRef: "cash", sourceKind: "advance" });
const apply = (adv: BreakdownLedgerEntry, obligationKey: string, amount: number): BreakdownAdvanceApplication => ({ advanceEntryId: adv.id, obligationKey, amount, deletedAt: null });

/** One person exactly as `usePersonPositions` + `usePeopleRows` / `useLoanBalanceSheet` / the planner read them. */
function person(id: string, entries: BreakdownLedgerEntry[], emiReceivable: number, applications: BreakdownAdvanceApplication[] = []) {
  const active = entries.filter((e) => !e.isDeleted);
  const position = personPosition({ personId: id, currentBalance: active.reduce((s, e) => s + sign(e), 0), loans: [], ledgerEntries: [], loanIds: new Set(), emiReceivable });
  const breakdown = personBalanceBreakdown(position, entries, new Set(), applications);
  const gross = personDirectGross(position, entries, new Set(), applications);
  const netWorth = peopleNetWorthPosition([{ position, entries, advanceApplications: applications }], new Set());
  return { id, position, entries, applications, breakdown, gross, netWorth };
}
type P = ReturnType<typeof person>;
/** The planner's `PersonDebtInput` (use-debt-planner-data). */
function plannerInput(p: P, name = p.id): PersonDebtInput {
  return {
    personId: p.id,
    name,
    directBalance: p.position.directBalance,
    emiReceivable: p.gross.emiReceivableOpen,
    loanReceivable: 0,
    loanPayable: 0,
    directToGive: p.gross.payable,
    directToReceive: p.gross.receivable,
  };
}

// ═══════════════════════ F1: receivable / payable ═══════════════════════

describe("F1 — a reimbursed loan share is an asset swap, never a payable", () => {
  it("1. ₹1,000 share due, unpaid → receivable ₹1,000, payable ₹0", () => {
    const a = person("a", [], 1_000);
    expect(a.netWorth).toEqual({ balance: 1_000, receivable: 1_000, payable: 0, advanceHeld: 0, advancePaid: 0 });
  });

  it("2. full ₹1,000 reimbursement → receivable ₹0, payable ₹0 — no phantom 'You owe A ₹1,000'", () => {
    const a = person("a", [reimburse(1_000)], 1_000);
    expect(a.netWorth).toEqual({ balance: 0, receivable: 0, payable: 0, advanceHeld: 0, advancePaid: 0 });
    expect([a.breakdown.toReceive, a.breakdown.toGive, a.position.net]).toEqual([0, 0, 0]);
    expect(personDirectPayable(plannerInput(a))).toBe(0);
  });

  it("3–5. ₹900 share: ₹500 → ₹400 owed; ₹200 → ₹200; ₹200 → ₹0; reverting the ₹500 restores ₹500 — payable ₹0 throughout", () => {
    const p500 = reimburse(500);
    const p200a = reimburse(200);
    const p200b = reimburse(200);
    const steps: [BreakdownLedgerEntry[], number][] = [
      [[], 900],
      [[p500], 400],
      [[p500, p200a], 200],
      [[p500, p200a, p200b], 0],
      [[{ ...p500, isDeleted: true }, p200a, p200b], 500],
    ];
    for (const [entries, owed] of steps) {
      const a = person("a", entries, 900);
      expect([a.netWorth.receivable, a.netWorth.payable, a.netWorth.balance]).toEqual([owed, 0, owed]);
      expect(a.breakdown.emiReceivableOpen).toBe(owed);
    }
  });

  it("Net Worth reconciles: each reimbursement is cash +x and receivable −x (Net Worth unchanged)", () => {
    const cashBefore = 5_000;
    const sheet = loanBalanceSheet([{ direction: "taken", outstandingPrincipal: 27_000 }], []);
    const before = person("a", [], 900);
    const after = person("a", [reimburse(500)], 900);
    const nw = (cash: number, p: P) => netWorthWithLoans(cash, sheet, p.netWorth.balance);
    expect(nw(cashBefore + 500, after)).toBe(nw(cashBefore, before));
  });

  it("10/11. the reimbursement moves the People balance by exactly the cash once — no income figure involved", () => {
    const before = person("a", [], 1_000);
    const after = person("a", [reimburse(1_000)], 1_000);
    expect(before.netWorth.balance - after.netWorth.balance).toBe(1_000); // = the single cash receipt
  });
});

// ═══════════════════════ overpayment / advance ═══════════════════════

describe("6 / 17 — overpayment: ₹900 settled + ₹300 advance, applied only explicitly", () => {
  it("₹1,200 against ₹900 → receivable ₹0, payable ₹0, ₹300 held as advance; Net Worth unchanged by the receipt", () => {
    const before = person("a", [], 900);
    const a = person("a", [reimburse(900), advance(300)], 900);
    expect(a.netWorth).toEqual({ balance: -300, receivable: 0, payable: 0, advanceHeld: 300, advancePaid: 0 });
    expect([a.breakdown.toReceive, a.breakdown.toGive, a.breakdown.advance, a.position.net]).toEqual([0, 0, -300, -300]);
    expect(personDirectPayable(plannerInput(a))).toBe(0); // no planner "You owe A"
    // cash +1,200 and People balance −1,200 → Net Worth unchanged; not income.
    expect(1_200 + (a.netWorth.balance - before.netWorth.balance)).toBe(0);
  });

  it("the advance never reduces unrelated card attribution (AMMA ₹8,000 stays ₹8,000)", () => {
    const amma = person("amma", [entry("gave", 8_000, { sourceKind: "splitExpense" }), reimburse(900), advance(300)], 900);
    expect(amma.gross).toEqual({ receivable: 8_000, payable: 0, emiReceivableOpen: 0, advanceHeld: 300, advancePaid: 0 });
    const byFacility = cardPurchaseShares([{ facilityId: "card", personId: "amma", name: "AMMA", unrecovered: 8_000, dueDate: NOW }], { amma: amma.gross.receivable });
    expect(byFacility.card[0].amount).toBe(8_000);
  });

  it("next month's ₹900 share is NOT settled by the ₹300 on its own; applying it explicitly leaves ₹600", () => {
    const adv = advance(300);
    const entries = [reimburse(900, "i1"), adv];
    const unapplied = person("a", entries, 1_800);
    expect([unapplied.netWorth.receivable, unapplied.netWorth.advanceHeld, unapplied.netWorth.payable]).toEqual([900, 300, 0]);
    const applied = person("a", entries, 1_800, [apply(adv, "loan-inst:i2", 300)]);
    expect([applied.netWorth.receivable, applied.netWorth.advanceHeld, applied.netWorth.payable]).toEqual([600, 0, 0]);
    // Applying moves no money: the balance is identical.
    expect(applied.netWorth.balance).toBe(unapplied.netWorth.balance);
  });

  it("applied early (share not yet due) the advance stays held until the share falls due", () => {
    const adv = advance(300);
    const app = apply(adv, "loan-inst:i2", 300);
    const early = person("a", [reimburse(900, "i1"), adv], 900, [app]);
    expect([early.netWorth.receivable, early.netWorth.advanceHeld, early.netWorth.payable]).toEqual([0, 300, 0]);
    const due = person("a", [reimburse(900, "i1"), adv], 1_800, [app]);
    expect([due.netWorth.receivable, due.netWorth.advanceHeld, due.netWorth.payable]).toEqual([600, 0, 0]);
  });

  it("an application is never beyond its advance, never on a deleted advance, never against the wrong side", () => {
    const adv = advance(300);
    const tooMuch = person("a", [adv], 1_000, [apply(adv, "loan-inst:i1", 500)]);
    expect([tooMuch.netWorth.receivable, tooMuch.netWorth.advanceHeld]).toEqual([700, 0]);
    const gone = person("a", [{ ...adv, isDeleted: true }], 1_000, [apply(adv, "loan-inst:i1", 300)]);
    expect([gone.netWorth.receivable, gone.netWorth.advanceHeld]).toEqual([1_000, 0]);
    const borrowed = entry("borrowed", 500);
    const wrongSide = person("a", [borrowed, adv], 0, [apply(adv, `ledger:${borrowed.id}`, 300)]);
    expect([wrongSide.netWorth.payable, wrongSide.netWorth.advanceHeld]).toEqual([500, 300]);
  });

  it("revoking an application returns the advance and reopens the share", () => {
    const adv = advance(300);
    const revoked = person("a", [adv], 900, [{ ...apply(adv, "loan-inst:i1", 300), deletedAt: NOW }]);
    expect([revoked.netWorth.receivable, revoked.netWorth.advanceHeld]).toEqual([900, 300]);
  });

  it("an advance applied to a direct 'gave' entry settles that entry only", () => {
    const gave = entry("gave", 1_000);
    const adv = advance(300);
    const a = person("a", [gave, adv], 0, [apply(adv, `ledger:${gave.id}`, 300)]);
    expect([a.gross.receivable, a.gross.advanceHeld, a.gross.payable]).toEqual([700, 0, 0]);
  });

  it("an advance I paid them ahead is neither receivable nor payable", () => {
    const mine = entry("repaid", 400, { sourceKind: "advance" });
    const a = person("a", [mine], 0);
    expect(a.netWorth).toEqual({ balance: 400, receivable: 0, payable: 0, advanceHeld: 0, advancePaid: 400 });
  });
});

// ═══════════════════════ F2: gross card ownership ═══════════════════════

describe("F2 — card attribution is gross ownership, never shrunk by unrelated People activity", () => {
  const ammaCard = [{ facilityId: "card", personId: "amma", name: "AMMA", unrecovered: 8_000, dueDate: NOW }];

  it("7. AMMA ₹8,000 card purchases + reimbursing a ₹1,000 loan share → card attribution stays ₹8,000", () => {
    const amma = person("amma", [entry("gave", 8_000, { sourceKind: "splitExpense" }), reimburse(1_000)], 1_000);
    const byFacility = cardPurchaseShares(ammaCard, { amma: amma.gross.receivable });
    expect(byFacility.card).toEqual([{ personId: "amma", name: "AMMA", amount: 8_000 }]);
    expect(amma.netWorth).toEqual({ balance: 8_000, receivable: 8_000, payable: 0, advanceHeld: 0, advancePaid: 0 });
  });

  it("8. AMMA ₹8,000 card + I separately owe AMMA ₹5,000 → gross ₹8,000 kept, ₹5,000 offset separate, net ₹3,000", () => {
    const amma = person("amma", [entry("gave", 8_000, { sourceKind: "splitExpense" }), entry("borrowed", 5_000)], 0);
    expect([amma.gross.receivable, amma.gross.payable]).toEqual([8_000, 5_000]);
    expect(amma.breakdown.net).toBe(3_000); // net economic position

    const byFacility = cardPurchaseShares(ammaCard, { amma: amma.gross.receivable });
    const snap = buildDebtSnapshot({
      loans: [],
      emis: [],
      cards: [cardInput({ id: "card", outstanding: 8_000, purchaseShares: byFacility.card })],
      people: [plannerInput(amma, "AMMA")],
      personNames: { amma: "AMMA" },
      now: NOW,
    });
    const card = snap.positions.find((p) => p.sourceType === "creditCard")!;
    const owed = snap.positions.find((p) => p.sourceType === "person")!;
    // Gross card attribution: AMMA caused ₹8,000; the card payment itself is unchanged.
    expect(card.outstanding).toBe(8_000);
    expect(card.ownership.others).toEqual([{ personId: "amma", name: "AMMA", amount: 8_000 }]);
    expect(card.ownership.mine).toBe(0);
    // Separate People offset: I owe AMMA ₹5,000.
    expect(owed.outstanding).toBe(5_000);
    // My debt = ₹5,000 (what I really owe), never ₹0 and never double-counted.
    expect(snap.ownership.mine).toBe(5_000);
    // Card: my share + others' share reconciles to the card amount.
    expect(card.ownership.mine + card.ownership.othersTotal + card.ownership.unallocated).toBe(card.outstanding);
  });
});

// ═══════════════════════ Dashboard / multi-person ═══════════════════════

describe("13 / 14 — Dashboard Debt and multi-person", () => {
  it("13. Dashboard Debt (`liabilityTotals.total + peoplePayable`) has no phantom person debt after a reimbursement", () => {
    const sheet = loanBalanceSheet([{ direction: "taken", outstandingPrincipal: 30_000 }], []);
    const a = person("a", [reimburse(1_000)], 1_000);
    const b = person("b", [], 1_000);
    const people = peopleNetWorthPosition(
      [a, b].map((p) => ({ position: p.position, entries: p.entries })),
      new Set(),
    );
    const debt = liabilityTotals(sheet, 0).total + people.payable;
    expect(debt).toBe(30_000); // lender liability only — A has reimbursed, nobody is owed
    expect(people.receivable).toBe(1_000); // B's share
    // Net Worth: cash 36,000 + B's 1,000 − liability 30,000; Dashboard Assets (= Net Worth + Debt) is the cash
    // plus B's receivable — no phantom ₹1,000 debt inflating it.
    const nw = netWorthWithLoans(36_000, sheet, people.balance);
    expect([nw, nw + debt]).toEqual([7_000, 37_000]);
  });

  it("14. A's reimbursement never touches B's receivable", () => {
    const bBefore = person("b", [], 1_000);
    const a = person("a", [reimburse(1_000)], 1_000);
    const bAfter = person("b", [], 1_000);
    expect(bAfter.netWorth).toEqual(bBefore.netWorth);
    const all = peopleNetWorthPosition([a, bAfter].map((p) => ({ position: p.position, entries: p.entries })), new Set());
    expect(all).toEqual({ balance: 1_000, receivable: 1_000, payable: 0, advanceHeld: 0, advancePaid: 0 });
  });
});

// ═══════════════════════ paise ═══════════════════════

describe("15 — paise-exact shares and settlements", () => {
  const d = (m: number, day: number) => new Date(2026, m - 1, day);
  const inst = (id: string, amountDue: number, due: Date): EmiObligationInstallment => ({
    id,
    scheduleId: "s",
    sequenceNumber: Number(id.slice(1)),
    dueDate: due,
    amountDue,
    amountPaid: 0,
    isSkipped: false,
    deletedAt: null,
    createdAt: d(1, 1),
  });
  const loanWith = (ownershipShares: OwnershipShare[]) => ({ id: "l", scheduleId: "s", direction: "taken" as const, ownershipShares, isClosed: false, deletedAt: null });

  for (const amountDue of [999.99, 1_000.01]) {
    it(`₹${amountDue} installment, thirds: shares sum to the installment; reimbursing A's exact share leaves ₹0 / ₹0`, () => {
      const shares = allocateOwnership(30_000, "equal", [{ personId: null, value: 0 }, { personId: "a", value: 0 }, { personId: "b", value: 0 }]).shares;
      const parts = splitByOwnership(amountDue, shares);
      expect(parts.reduce((s, p) => s + Math.round(p.amount * 100), 0)).toBe(Math.round(amountDue * 100));
      const owed = emiReceivableThrough(personEmiObligations({ personId: "a", emis: [], loans: [loanWith(shares)], installments: [inst("i1", amountDue, d(2, 10))], now: d(2, 15) }), d(2, 15));
      expect(owed).toBe(parts.find((p) => p.personId === "a")!.amount);
      const half = Math.round((owed / 2) * 100) / 100;
      const partial = person("a", [reimburse(half)], owed);
      expect(partial.netWorth.receivable).toBe(Math.round((owed - half) * 100) / 100);
      expect(partial.netWorth.payable).toBe(0);
      const full = person("a", [reimburse(half), reimburse(Math.round((owed - half) * 100) / 100)], owed);
      expect([full.netWorth.receivable, full.netWorth.payable]).toEqual([0, 0]);
    });
  }

  it("percentage 37.5 / 25 / 37.5 of ₹1,000.01: A's share settled in odd paise, advance kept to the paisa", () => {
    const shares = allocateOwnership(48_123.45, "percentage", [
      { personId: null, value: 37.5 },
      { personId: "a", value: 25 },
      { personId: "b", value: 37.5 },
    ]).shares;
    const owed = splitByOwnership(1_000.01, shares).find((p) => p.personId === "a")!.amount;
    const a = person("a", [reimburse(owed), advance(0.03)], owed);
    expect(a.netWorth).toEqual({ balance: -0.03, receivable: 0, payable: 0, advanceHeld: 0.03, advancePaid: 0 });
  });
});

// ═══════════════════════ legacy ═══════════════════════

describe("16 — legacy loans keep their compatibility rules", () => {
  const d = (m: number, day: number) => new Date(2026, m - 1, day);
  const i1: EmiObligationInstallment = { id: "i1", scheduleId: "s", sequenceNumber: 1, dueDate: d(2, 10), amountDue: 3_000, amountPaid: 0, isSkipped: false, deletedAt: null, createdAt: d(1, 1) };
  const owedBy = (loan: Record<string, unknown>) =>
    emiReceivableThrough(
      personEmiObligations({ personId: "a", emis: [], loans: [{ id: "l", scheduleId: "s", direction: "taken", isClosed: false, deletedAt: null, ...loan }], installments: [i1], now: d(2, 15) }),
      d(2, 15),
    );

  it("no ownership shares = 100% mine; bare 'for someone' creates no receivable; repay opt-in owes the whole installment", () => {
    expect(owedBy({ ownershipShares: null })).toBe(0);
    expect(owedBy({ ownershipShares: null, beneficiaryPersonId: "a" })).toBe(0);
    expect(owedBy({ ownershipShares: null, beneficiaryPersonId: "a", beneficiaryRepaysInstallments: true })).toBe(3_000);
  });

  it("repay opt-in, reimbursed in full → receivable ₹0, payable ₹0", () => {
    const a = person("a", [reimburse(3_000)], owedBy({ beneficiaryPersonId: "a", beneficiaryRepaysInstallments: true }));
    expect([a.netWorth.receivable, a.netWorth.payable]).toEqual([0, 0]);
  });

  it("a legacy unlinked payment (no obligationRef, no advance marker) keeps its existing netting", () => {
    const a = person("a", [entry("receivedBack", 1_000)], 1_000);
    expect([a.netWorth.receivable, a.netWorth.payable, a.netWorth.advanceHeld]).toEqual([0, 0, 0]);
  });
});

// ═══════════════════════ lifecycle ═══════════════════════

describe("18 — edit / revert / delete / cancel", () => {
  it("editing a reimbursement from ₹500 to ₹700 on a ₹900 share → ₹200 owed", () => {
    const p = reimburse(500);
    expect(person("a", [{ ...p, amount: 700 }], 900).netWorth.receivable).toBe(200);
  });

  it("reverting the payment that carried an advance removes both the settlement and the advance", () => {
    const s = reimburse(900);
    const adv = advance(300);
    const reverted = person("a", [{ ...s, isDeleted: true }, { ...adv, isDeleted: true }], 900);
    expect(reverted.netWorth).toEqual({ balance: 900, receivable: 900, payable: 0, advanceHeld: 0, advancePaid: 0 });
  });

  it("loan cancelled after A reimbursed: the share is gone, the ₹1,000 is a refund owed to A — never netted against A's card", () => {
    const amma = person("amma", [entry("gave", 8_000, { sourceKind: "splitExpense" }), reimburse(1_000)], 0);
    expect([amma.gross.receivable, amma.gross.payable]).toEqual([8_000, 1_000]);
    expect(amma.breakdown.net).toBe(7_000);
  });

  it("an advance-applied share whose installment is later removed returns the money to the advance", () => {
    const adv = advance(300);
    const a = person("a", [adv], 0, [apply(adv, "loan-inst:i2", 300)]);
    expect([a.netWorth.receivable, a.netWorth.payable, a.netWorth.advanceHeld]).toEqual([0, 0, 300]);
  });
});
