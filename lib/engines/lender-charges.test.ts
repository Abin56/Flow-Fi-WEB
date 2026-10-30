import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));

import type { LenderCharge } from "@/lib/models/lender-charge";
import {
  allocateToCharges, chargeFingerprint, chargeIdempotencyKey, chargeReversalBlocker, chargeStatus, checkDuplicateCharge, lenderPayoff,
  previewBilling, previewSettlement, reversedCharge, settledAmount, unpaidAmount, type LenderChargeInput,
} from "./lender-charges";
import { cardChargeGate, reviewCardRepresentation, type CardTransactionEvidence } from "./lender-charge-card-review";
import {
  isLenderChargeSettlement, lenderChargeBillingAsSpend, lenderChargeExpenseEvents, lenderChargeNetWorthChangeFrom, lenderChargeNetWorthEvents,
  netWorthWithLenderCharges, unpaidLenderChargeTotal, withLenderChargeLiability,
} from "./lender-charge-accounting";
import { buildMySpendContext, classifyForMySpend } from "./my-spend";

const NOW = new Date(2026, 9, 28);
const d = (m: number, day: number) => new Date(2026, m, day);

function charge(over: Partial<LenderCharge> = {}): LenderCharge {
  return {
    id: "c1", agreementKind: "emi", agreementId: "e1", type: "penalty", amount: 1000, billedDate: d(9, 10), lenderReference: "INV-001", reason: "late payment",
    categoryId: null, settlements: [], reversedAt: null, reversalReason: null, cardReview: null, idempotencyKey: "k", createdAt: d(9, 11),
    deletedAt: null, lastEditedAt: null, editHistory: [], ...over,
  };
}
const input = (over: Partial<LenderChargeInput> = {}): LenderChargeInput => ({
  agreementKind: "emi", agreementId: "e1", type: "penalty", amount: 1000, billedDate: d(9, 10), lenderReference: "INV-001", reason: "late payment", ...over,
});
const pay = (amount: number, over = {}) => ({ id: `s${amount}`, transactionId: "t", amount, date: d(9, 12), reversedAt: null, ...over });

describe("amounts, status and payoff", () => {
  it("derives paid / unpaid from live settlements only", () => {
    const c = charge({ settlements: [pay(400), pay(100, { reversedAt: d(9, 13) })] });
    expect(settledAmount(c)).toBe(400);
    expect(unpaidAmount(c)).toBe(600);
    expect(chargeStatus(c)).toBe("partlyPaid");
    expect(chargeStatus(charge())).toBe("unpaid");
    expect(chargeStatus(charge({ settlements: [pay(1000)] }))).toBe("paid");
  });
  it("a payment that is later reversed makes the charge unpaid again", () => {
    expect(chargeStatus(charge({ settlements: [pay(1000, { reversedAt: d(9, 14) })] }))).toBe("unpaid");
  });
  it("a reversed charge owes nothing", () => {
    const c = charge({ reversedAt: d(9, 20) });
    expect(unpaidAmount(c)).toBe(0);
    expect(chargeStatus(c)).toBe("reversed");
  });
  it("payoff keeps principal, unpaid charges and the total separate; unbilled interest stays out of both", () => {
    const p = lenderPayoff({ principal: 20000, charges: [charge(), charge({ id: "c2", type: "processingFee", amount: 250, settlements: [pay(250)] }), charge({ id: "c3", reversedAt: d(9, 20) })], accruedUnbilledInterest: 333 });
    expect(p).toMatchObject({ principal: 20000, unpaidCharges: 1000, totalPayoff: 21000, accruedUnbilledInterest: 333, unpaidByType: { penalty: 1000 } });
  });
});

describe("billing preview", () => {
  const base = { principal: 20000, existing: [] as LenderCharge[], now: NOW };
  it("principal never changes; payoff and Net Worth move by the amount; no cash, no transaction", () => {
    const p = previewBilling({ input: input({ amount: 1180.5 }), ...base });
    expect(p.errors).toEqual([]);
    expect(p.principal).toEqual({ before: 20000, after: 20000 });
    expect(p.unpaidCharges).toEqual({ before: 0, after: 1180.5 });
    expect(p.payoff).toEqual({ before: 20000, after: 21180.5 });
    expect(p.netWorthDelta).toBe(-1180.5);
    expect(p.expense).toEqual({ amount: 1180.5, month: d(9, 1) });
    expect(p.cashDelta).toBe(0);
    expect(p.createsTransaction).toBe(false);
    expect(p.blocked).toBe(false);
  });
  it("validates type, amount, decimals, date and reason", () => {
    const e = (over: Partial<LenderChargeInput>) => previewBilling({ input: input(over), ...base }).errors.join(" ");
    expect(e({ amount: 0 })).toMatch(/billed amount/);
    expect(e({ amount: 10.123 })).toMatch(/2 decimals/);
    expect(e({ billedDate: d(10, 5) })).toMatch(/future/);
    expect(e({ reason: "  " })).toMatch(/why/);
    expect(e({ type: "bogus" as never })).toMatch(/kind of charge/);
    expect(previewBilling({ input: input({ amount: Number.NaN }), ...base }).blocked).toBe(true);
  });
  it("an exact duplicate is blocked", () => {
    const p = previewBilling({ input: input(), principal: 20000, existing: [charge()], now: NOW });
    expect(p.blocked).toBe(true);
    expect(p.duplicate.verdict).toBe("duplicate");
  });
});

describe("duplicate protection", () => {
  it("treats reference spelling as the same reference", () => {
    expect(chargeFingerprint(input({ lenderReference: "inv 001" }))).toBe(chargeFingerprint(input({ lenderReference: "INV/001" })));
  });
  it("same reference with a different amount or type conflicts", () => {
    expect(checkDuplicateCharge(input({ amount: 900 }), [charge()]).verdict).toBe("referenceConflict");
    expect(checkDuplicateCharge(input({ type: "gst" }), [charge()]).verdict).toBe("referenceConflict");
  });
  it("same type and amount within 3 days with a missing reference is only a possible duplicate", () => {
    expect(checkDuplicateCharge(input({ lenderReference: "", billedDate: d(9, 12) }), [charge()]).verdict).toBe("possibleDuplicate");
    expect(checkDuplicateCharge(input({ lenderReference: "", billedDate: d(9, 20) }), [charge()]).verdict).toBe("none");
  });
  it("another agreement, or a different date with a different reference, is independent", () => {
    expect(checkDuplicateCharge(input({ agreementId: "other" }), [charge()]).verdict).toBe("none");
    expect(checkDuplicateCharge(input({ lenderReference: "INV-002", billedDate: d(9, 11) }), [charge()]).verdict).toBe("none");
  });
  it("a reversed charge does not block re-billing, but raises the generation so the key is new", () => {
    const reversed = charge({ reversedAt: d(9, 15) });
    const check = checkDuplicateCharge(input(), [reversed]);
    expect(check.verdict).toBe("none");
    expect(check.generation).toBe(2);
    expect(chargeIdempotencyKey(input(), 1)).not.toBe(chargeIdempotencyKey(input(), 2));
  });
  it("the key is deterministic: a retry is the same recording", () => {
    expect(chargeIdempotencyKey(input(), 1)).toBe(chargeIdempotencyKey(input(), 1));
  });
});

describe("settlement", () => {
  it("a partial payment lowers the liability and the account, never recognises another expense, and leaves Net Worth alone", () => {
    const p = previewSettlement(charge(), 400);
    expect(p).toMatchObject({ errors: [], unpaidBefore: 1000, unpaidAfter: 600, accountDelta: -400, liabilityDelta: -400, expenseRecognised: 0, netWorthDelta: 0, statusAfter: "partlyPaid" });
  });
  it("paying the rest settles it", () => {
    expect(previewSettlement(charge({ settlements: [pay(400)] }), 600).statusAfter).toBe("paid");
  });
  it("refuses overpayment, zero, a paid charge and a reversed charge", () => {
    expect(previewSettlement(charge(), 1000.5).errors.join()).toMatch(/Only/);
    expect(previewSettlement(charge(), 0).errors.length).toBe(1);
    expect(previewSettlement(charge({ settlements: [pay(1000)] }), 10).errors.join()).toMatch(/already fully paid/);
    expect(previewSettlement(charge({ reversedAt: d(9, 20) }), 10).errors.join()).toMatch(/reversed/);
  });
  it("allocates one payment oldest-billed-first across charges, with the remainder left over", () => {
    const a = charge({ id: "a", billedDate: d(9, 1), amount: 300 });
    const b = charge({ id: "b", billedDate: d(9, 5), amount: 500, settlements: [pay(100)] });
    const c = charge({ id: "c", billedDate: d(9, 9), amount: 200 });
    const r = allocateToCharges([c, b, a], 650);
    expect(r.allocations).toEqual([{ chargeId: "a", amount: 300 }, { chargeId: "b", amount: 350 }]);
    expect(r.remainder).toBe(0);
    expect(allocateToCharges([a, b, c], 1200).remainder).toBe(300); // 300 + 400 + 200 are owed
  });
});

describe("reversal", () => {
  it("an unpaid charge reverses and keeps its audit history", () => {
    const r = reversedCharge(charge(), "billed in error", d(9, 20));
    expect(r.reversedAt).toEqual(d(9, 20));
    expect(r.reversalReason).toBe("billed in error");
    expect(r.editHistory.length).toBe(1);
    expect(unpaidAmount(r)).toBe(0);
  });
  it("a charge with a live payment cannot be reversed — reverse the payment first", () => {
    expect(chargeReversalBlocker(charge({ settlements: [pay(100)] }))).toMatch(/Reverse that payment first/);
    expect(() => reversedCharge(charge({ settlements: [pay(100)] }), "x", d(9, 20))).toThrow();
    expect(chargeReversalBlocker(charge({ settlements: [pay(100, { reversedAt: d(9, 14) })] }))).toBeNull();
  });
  it("needs a reason, and cannot be reversed twice", () => {
    expect(() => reversedCharge(charge(), " ", d(9, 20))).toThrow(/why/);
    expect(chargeReversalBlocker(charge({ reversedAt: d(9, 20) }))).toMatch(/already reversed/);
  });
});

describe("card-linked duplicate protection", () => {
  const candidate = { type: "penalty" as const, amount: 1000, billedDate: d(9, 10), lenderReference: "INV-001" };
  const cardTx = (over: Partial<CardTransactionEvidence> = {}): CardTransactionEvidence => ({ id: "ct1", accountId: "card", type: "expense", amount: 1000, dateTime: d(9, 11), notes: "LATE PAYMENT CHARGES", deletedAt: null, ...over });

  it("finds a strong match on amount + date, and a reference match", () => {
    const r = reviewCardRepresentation({ candidate, cardTransactions: [cardTx()] });
    expect(r.verdict).toBe("possibleMatch");
    expect(r.matches[0]).toMatchObject({ id: "ct1", strength: "strong" });
    const byRef = reviewCardRepresentation({ candidate, cardTransactions: [cardTx({ amount: 1180, notes: "Ref INV-001" })] });
    expect(byRef.matches[0]!.reasons).toContain("carries the lender reference");
  });
  it("uses statement lines as evidence too", () => {
    const r = reviewCardRepresentation({ candidate, cardTransactions: [], statementLines: [{ id: "sl1", amount: 1000, date: d(9, 9), description: "PENALTY" }] });
    expect(r.matches).toEqual([expect.objectContaining({ source: "statementLine", id: "sl1", strength: "strong" })]);
  });
  it("ignores deleted rows, income rows and unrelated amounts", () => {
    const r = reviewCardRepresentation({ candidate, cardTransactions: [cardTx({ deletedAt: d(9, 12) }), cardTx({ id: "x", type: "income" }), cardTx({ id: "y", amount: 77, notes: "coffee" })] });
    expect(r.matches).toEqual([]);
    expect(r.verdict).toBe("noEvidenceFound");
  });
  it("no evidence still requires an explicit confirmation — absence is not proof", () => {
    const r = reviewCardRepresentation({ candidate, cardTransactions: [] });
    expect(r.confirmationRequired).toBe(true);
    expect(cardChargeGate(r, null).allowed).toBe(false);
    expect(cardChargeGate(r, { decision: "notOnCard", reviewedTransactionIds: [], confirmedAt: NOW }).allowed).toBe(true);
  });
  it("'already on the card' blocks the Loan/EMI liability", () => {
    const r = reviewCardRepresentation({ candidate, cardTransactions: [cardTx()] });
    const g = cardChargeGate(r, { decision: "alreadyOnCard", reviewedTransactionIds: ["ct1"], confirmedAt: NOW });
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/already on the credit card/);
  });
  it("'not on the card' with matches needs every match reviewed", () => {
    const r = reviewCardRepresentation({ candidate, cardTransactions: [cardTx(), cardTx({ id: "ct2" })] });
    expect(cardChargeGate(r, { decision: "notOnCard", reviewedTransactionIds: ["ct1"], confirmedAt: NOW }).allowed).toBe(false);
    expect(cardChargeGate(r, { decision: "notOnCard", reviewedTransactionIds: ["ct1", "ct2"], confirmedAt: NOW }).allowed).toBe(true);
  });
});

describe("accounting: expense once, liability, Net Worth and trend", () => {
  const unpaid = charge({ id: "u", amount: 1000 });
  const part = charge({ id: "p", amount: 500, billedDate: d(9, 20), settlements: [pay(200)] });
  const paid = charge({ id: "f", amount: 300, billedDate: d(8, 5), settlements: [pay(300)] });
  const reversed = charge({ id: "r", amount: 700, billedDate: d(9, 2), reversedAt: d(9, 8) });
  const all = [unpaid, part, paid, reversed];

  it("every live charge is one expense event at its billed date — whatever its payment state; reversed ones none", () => {
    const ev = lenderChargeExpenseEvents(all);
    expect(ev.map((e) => e.chargeId).sort()).toEqual(["f", "p", "u"]);
    expect(ev.reduce((s, e) => s + e.amount, 0)).toBe(1800);
  });
  it("billing flows through My Spend as consumption; its settlement payment is not spend — total expense is the billed amount, once", () => {
    const ctx = buildMySpendContext({ expenses: [] });
    const billing = lenderChargeBillingAsSpend(part, "fees");
    expect(classifyForMySpend(billing.transaction, ctx)).toMatchObject({ kind: "consumption", myAmount: 500 });
    expect(billing.transaction.categoryId).toBe("fees");
    const settlementTx = { ...billing.transaction, id: "pay1", amount: 200, accountId: "bank", lenderChargeId: "p" };
    expect(classifyForMySpend(settlementTx, ctx).myAmount).toBe(0);
    expect(isLenderChargeSettlement(settlementTx)).toBe(true);
    const total = [billing.transaction, settlementTx].reduce((s, t) => s + classifyForMySpend(t, ctx).myAmount, 0);
    expect(total).toBe(500);
  });
  it("a reversed charge disappears from spend", () => {
    const ctx = buildMySpendContext({ expenses: [] });
    expect(classifyForMySpend(lenderChargeBillingAsSpend(reversed, "fees").transaction, ctx).kind).toBe("deleted");
  });
  it("unpaid charges are a separate liability line; principal-only totals keep their meaning", () => {
    expect(unpaidLenderChargeTotal(all)).toBe(1300);
    expect(unpaidLenderChargeTotal(all, "other-agreement")).toBe(0);
    const totals = { creditCards: 0, loans: 0, emis: 20000, loanDebt: 20000, total: 20000 };
    const w = withLenderChargeLiability(totals, 1300);
    expect(w).toMatchObject({ total: 20000, emis: 20000, lenderCharges: 1300, totalWithLenderCharges: 21300 });
    expect(netWorthWithLenderCharges(50000, 1300)).toBe(48700);
  });
  it("Net Worth trend: billing lowers it on the billed date, reversal restores it, payments are neutral", () => {
    const ev = lenderChargeNetWorthEvents(all);
    expect(ev.map((e) => [e.chargeId, e.kind, e.delta])).toEqual([
      ["f", "billed", -300], ["r", "billed", -700], ["r", "reversed", 700], ["u", "billed", -1000], ["p", "billed", -500],
    ]);
    // A day-end before the 10th (billing of "u"): only the later events are walked back.
    expect(lenderChargeNetWorthChangeFrom(ev, d(9, 9))).toBe(-1500);
    // Net effect of billing + reversal of "r" is zero once both happened.
    expect(lenderChargeNetWorthChangeFrom(ev, d(9, 1))).toBe(-1500); // r: -700 then +700 nets to 0; u -1000; p -500
  });
  it("a card-linked and a standalone agreement are treated identically here — the card never also carries the charge", () => {
    // The charge is a Loan/EMI-side liability in both cases; the card gate (above) is what keeps it off the card.
    expect(unpaidLenderChargeTotal([charge({ agreementKind: "emi", agreementId: "card-emi" })])).toBe(1000);
  });
});
