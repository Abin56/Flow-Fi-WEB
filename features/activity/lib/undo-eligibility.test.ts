import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));

import type { CardPaymentCancellationPreview } from "@/features/credit-cards/lib/card-payment-cancellation";
import type { RecordedPaymentAction } from "@/features/loans/lib/recorded-payments";
import type { PaymentImpact } from "@/lib/engines/person-payment-impact";
import type { InstallmentPayment } from "@/lib/models/payment-schedule";
import type { Transaction } from "@/lib/models/transaction";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { classifyActivity, type ActivityItem } from "./activity-classify";
import { decideUndo, MSG, type EffectContext, type UndoFacts } from "./undo-eligibility";

let seq = 0;
function txn(over: Partial<Transaction> & Pick<Transaction, "type">): Transaction {
  seq += 1;
  const base = TransactionRepository.buildTransaction({ type: over.type, amount: 1_000, dateTime: new Date(2026, 9, 10), accountId: "sbi", categoryId: "food" });
  return { ...base, id: `t${seq}`, createdAt: new Date(2026, 9, 10, 10, seq), ...over };
}
const itemOf = (docs: Transaction[], split: string[] = []): ActivityItem =>
  classifyActivity(docs, { cardAccountIds: new Set(["card-acc"]), splitTransactionIds: new Set(split) })[0];

const ctx: EffectContext = {
  money: (n) => `₹${n.toLocaleString("en-IN")}`,
  accountName: (id) => ({ sbi: "SBI", hdfc: "HDFC" })[id] ?? null,
  accountBalance: (id) => ({ sbi: 10_000, hdfc: 2_000 })[id] ?? null,
  personName: (id) => (id === "p1" ? "Ravi" : null),
};

function action(id: string, over: Partial<RecordedPaymentAction> = {}): RecordedPaymentAction {
  return {
    id,
    source: "loan",
    portions: [{ id: `${id}-p0`, installmentId: "i5" } as InstallmentPayment],
    overflow: null,
    amount: 4_000,
    date: new Date(2026, 9, 1),
    note: "",
    createdAt: new Date(2026, 9, 1),
    allocationType: "regularEmi",
    transactionId: "tx-latest",
    installmentSeqs: [5],
    remainingAfter: 0,
    reversed: false,
    recordedEarlier: null,
    ...over,
  };
}

describe("decideUndo — plain transactions (D3)", () => {
  it("a plain expense with no People/purpose reference is undoable through the linked delete", () => {
    const t = txn({ type: "expense", amount: 500 });
    const d = decideUndo(itemOf([t]), { kind: "plain", fresh: t, reference: null }, ctx);
    expect(d.kind).toBe("eligible");
    if (d.kind !== "eligible") return;
    expect(d.handler).toEqual({ kind: "deleteTransaction", transaction: t });
    expect(d.effects[0]).toBe("SBI balance: ₹10,000 → ₹10,500");
  });

  it("a plain-looking income that a People payment points at is view-only", () => {
    const t = txn({ type: "income" });
    const d = decideUndo(itemOf([t]), { kind: "plain", fresh: t, reference: { personId: "p1", via: "ledger" } }, ctx);
    expect(d).toEqual({ kind: "blocked", reason: `${MSG.referencedLedger} (Ravi)` });
  });

  it("purpose-money transactions, lone fees and newly-owned docs are view-only", () => {
    const t = txn({ type: "expense" });
    expect(decideUndo(itemOf([t]), { kind: "plain", fresh: t, reference: { personId: "p1", via: "purpose" } }, ctx).kind).toBe("blocked");
    const fee = txn({ type: "expense", transferFeeForId: "x9" });
    expect(decideUndo(itemOf([fee]), { kind: "plain", fresh: fee, reference: null }, ctx)).toEqual({ kind: "blocked", reason: MSG.fee });
    const nowOwned = { ...t, billPaymentId: "billpay_z" };
    expect(decideUndo(itemOf([t]), { kind: "plain", fresh: nowOwned, reference: null }, ctx)).toEqual({ kind: "blocked", reason: MSG.ownedElsewhere });
  });

  it("already deleted (repeat / second tab) → alreadyUndone; missing → blocked", () => {
    const t = txn({ type: "expense" });
    expect(decideUndo(itemOf([t]), { kind: "plain", fresh: { ...t, deletedAt: new Date() }, reference: null }, ctx)).toEqual({ kind: "alreadyUndone" });
    expect(decideUndo(itemOf([t]), { kind: "missing" }, ctx)).toEqual({ kind: "blocked", reason: MSG.missing });
    expect(decideUndo(itemOf([{ ...t, deletedAt: new Date() }]), { kind: "missing" }, ctx)).toEqual({ kind: "alreadyUndone" });
  });

  it("historical (excluded) transactions say no balance changes", () => {
    const t = txn({ type: "income", excludeFromCalculations: true });
    const d = decideUndo(itemOf([t]), { kind: "plain", fresh: t, reference: null }, ctx);
    expect(d.kind === "eligible" && d.effects).toEqual(["No account balance changes — it was recorded as already paid."]);
  });
});

describe("decideUndo — shared expenses (D5)", () => {
  const t = txn({ id: "split-a", type: "expense", amount: 3_000 });
  const item = itemOf([t], ["split-a"]);
  it("undoable only when nothing has been collected or marked received", () => {
    expect(decideUndo(item, { kind: "split", fresh: t, expenseLive: true, collected: 0, anyReceived: false }, ctx).kind).toBe("eligible");
    expect(decideUndo(item, { kind: "split", fresh: t, expenseLive: true, collected: 500, anyReceived: false }, ctx)).toEqual({ kind: "blocked", reason: MSG.splitCollected("₹500") });
    expect(decideUndo(item, { kind: "split", fresh: t, expenseLive: true, collected: 0, anyReceived: true }, ctx)).toEqual({ kind: "blocked", reason: MSG.splitReceived });
  });
});

describe("decideUndo — People", () => {
  const t = txn({ type: "income", isPersonLedgerMovement: true, linkedPersonId: "p1", amount: 2_000 });
  const impact = (over: Partial<PaymentImpact> = {}): PaymentImpact => ({
    paymentId: "pay-1", direction: "theyPaid", received: 2_000, settled: 1_500, settledByKey: {}, advance: 500, advanceUsed: 0, advanceUnused: 500,
    income: 0, purposes: 0, accounts: [], dependencies: [], canRevert: true, ...over,
  });

  it("a Record Payment receipt reverts through revertPersonPayment and explains the People effect", () => {
    const d = decideUndo(itemOf([t]), { kind: "people", fresh: t, personId: "p1", paymentId: "pay-1", impact: impact(), entry: null }, ctx);
    expect(d.kind).toBe("eligible");
    if (d.kind !== "eligible") return;
    expect(d.handler).toEqual({ kind: "revertPersonPayment", personId: "p1", paymentId: "pay-1" });
    expect(d.effects).toEqual(["Ravi owes ₹1,500 again.", "The ₹500 kept as advance is removed.", "SBI balance: ₹10,000 → ₹8,000"]);
  });

  it("blocked when its advance was already used, or its records can't be found", () => {
    const used = impact({ advanceUsed: 200, canRevert: false });
    expect(decideUndo(itemOf([t]), { kind: "people", fresh: t, personId: "p1", paymentId: "pay-1", impact: used, entry: null }, ctx).kind).toBe("blocked");
    expect(decideUndo(itemOf([t]), { kind: "people", fresh: t, personId: "p1", paymentId: "pay-1", impact: null, entry: null }, ctx)).toEqual({ kind: "blocked", reason: MSG.peopleMissing });
  });

  it("an older single entry is undoable only with no dependent entries; unproven links are view-only", () => {
    expect(decideUndo(itemOf([t]), { kind: "people", fresh: t, personId: "p1", paymentId: null, impact: null, entry: { id: "e1", dependents: 0 } }, ctx).kind).toBe("eligible");
    expect(decideUndo(itemOf([t]), { kind: "people", fresh: t, personId: "p1", paymentId: null, impact: null, entry: { id: "e1", dependents: 1 } }, ctx)).toEqual({ kind: "blocked", reason: MSG.peopleDependents });
    expect(decideUndo(itemOf([t]), { kind: "people", fresh: t, personId: "p1", paymentId: null, impact: null, entry: null }, ctx)).toEqual({ kind: "blocked", reason: MSG.peopleUnlinked });
    expect(decideUndo(itemOf([t]), { kind: "people", fresh: t, personId: null, paymentId: null, impact: null, entry: null }, ctx)).toEqual({ kind: "blocked", reason: MSG.peopleUnlinked });
  });
});

describe("decideUndo — Loan / EMI (D4, D6)", () => {
  const t = txn({ id: "tx-latest", type: "expense", loanId: "loan-1", installmentPaymentId: "a2-p0", amount: 4_000 });
  const item = itemOf([t]);
  const loan = { id: "loan-1", closed: false, trashed: false, sharedWithPeople: false };

  it("the latest payment reverses through the Loan repository with its own ids", () => {
    const latest = action("txn:tx-latest", { createdAt: new Date(2026, 9, 2) });
    const older = action("txn:tx-old", { transactionId: "tx-old", createdAt: new Date(2026, 9, 1) });
    const d = decideUndo(item, { kind: "loanPayment", fresh: t, loan, action: latest, all: [latest, older] }, ctx);
    expect(d.kind).toBe("eligible");
    if (d.kind !== "eligible") return;
    expect(d.handler).toMatchObject({ kind: "reverseLoanPayment", loanId: "loan-1", transactionId: "tx-latest", reversalIdempotencyKey: "activity_tx-latest" });
    expect(d.effects[0]).toBe("Installment #5 is due again.");
  });

  it("an older payment is view-only and points to the module", () => {
    const older = action("txn:tx-latest", { createdAt: new Date(2026, 9, 1) });
    const newer = action("txn:tx-new", { transactionId: "tx-new", createdAt: new Date(2026, 9, 3) });
    expect(decideUndo(item, { kind: "loanPayment", fresh: t, loan, action: older, all: [older, newer] }, ctx)).toEqual({ kind: "blocked", reason: MSG.laterLoan });
  });

  it("closed / trashed / unmatched / reversed", () => {
    const a = action("txn:tx-latest");
    expect(decideUndo(item, { kind: "loanPayment", fresh: t, loan: { ...loan, closed: true }, action: a, all: [a] }, ctx).kind).toBe("blocked");
    expect(decideUndo(item, { kind: "loanPayment", fresh: t, loan: { ...loan, trashed: true }, action: a, all: [a] }, ctx)).toEqual({ kind: "blocked", reason: MSG.trashedLoan });
    expect(decideUndo(item, { kind: "loanPayment", fresh: t, loan, action: null, all: [] }, ctx)).toEqual({ kind: "blocked", reason: MSG.noLoanAction });
    expect(decideUndo(item, { kind: "loanPayment", fresh: t, loan, action: { ...a, reversed: true }, all: [] }, ctx)).toEqual({ kind: "alreadyUndone" });
  });

  it("loan creation / extra disbursement are never undoable here", () => {
    const orig = txn({ type: "income", loanId: "loan-1" });
    expect(decideUndo(itemOf([orig]), { kind: "plain", fresh: orig, reference: null }, ctx)).toEqual({ kind: "blocked", reason: MSG.loanAgreement });
  });

  it("an EMI payment reverses through the EMI write with its payment/installment ids", () => {
    const e = txn({ type: "expense", emiId: "emi-1", installmentPaymentId: "emi_k_p0" });
    const a = action("emi:k", { source: "emi", transactionId: null, portions: [{ id: "emi_k_p0", installmentId: "i2" } as InstallmentPayment] });
    const d = decideUndo(itemOf([e]), { kind: "emiPayment", fresh: e, emi: { id: "emi-1", closed: false, trashed: false, sharedWithPeople: true }, action: a, all: [a] }, ctx);
    expect(d.kind === "eligible" && d.handler).toEqual({ kind: "reverseEmiPayment", emiId: "emi-1", refs: { paymentIds: ["emi_k_p0"], installmentIds: ["i2"] } });
    // A shared EMI says what happens to People: nothing — their share payments stay.
    expect(d.kind === "eligible" && d.effects).toContain("People's shares stay as recorded — anything they paid you is not changed.");
  });
});

describe("decideUndo — Bills (D10)", () => {
  const t = txn({ id: "txn_billpay_k", type: "expense", billPaymentId: "billpay_k" });
  it("only when the payment doc was found under a bill AND points back at this transaction", () => {
    const ok = decideUndo(itemOf([t]), { kind: "billPayment", fresh: t, billId: "b1", payment: { id: "billpay_k", transactionId: t.id, deleted: false } }, ctx);
    expect(ok.kind === "eligible" && ok.handler).toEqual({ kind: "reverseBillPayment", billId: "b1", paymentId: "billpay_k" });
    expect(decideUndo(itemOf([t]), { kind: "billPayment", fresh: t, billId: null, payment: null }, ctx)).toEqual({ kind: "blocked", reason: MSG.billUnknown });
    expect(decideUndo(itemOf([t]), { kind: "billPayment", fresh: t, billId: "b1", payment: { id: "billpay_k", transactionId: "other", deleted: false } }, ctx)).toEqual({ kind: "blocked", reason: MSG.billUnknown });
    expect(decideUndo(itemOf([t]), { kind: "billPayment", fresh: t, billId: "b1", payment: { id: "billpay_k", transactionId: t.id, deleted: true } }, ctx)).toEqual({ kind: "alreadyUndone" });
  });
});

describe("decideUndo — transfers and card payments", () => {
  const out = txn({ id: "o", type: "expense", accountId: "sbi", transferId: "x1", amount: 5_000 });
  const into = txn({ id: "i", type: "income", accountId: "hdfc", transferId: "x1", amount: 5_000 });
  const fee = txn({ id: "x1_fee", type: "expense", accountId: "sbi", transferFeeForId: "x1", amount: 20 });

  it("a transfer reverses both legs and its fee together", () => {
    const d = decideUndo(itemOf([out, into, fee]), { kind: "transfer", legs: [out, into], fee, reference: null, card: null }, ctx);
    expect(d.kind).toBe("eligible");
    if (d.kind !== "eligible") return;
    expect(d.effects).toEqual(["SBI balance: ₹10,000 → ₹15,020", "HDFC balance: ₹2,000 → ₹-3,000","The ₹20 transfer fee is removed too."]);
  });

  it("half-deleted legs / owned legs / purpose-linked are view-only", () => {
    expect(decideUndo(itemOf([out, into]), { kind: "transfer", legs: [out, { ...into, deletedAt: new Date() }], fee: null, reference: null, card: null }, ctx)).toEqual({ kind: "blocked", reason: MSG.inconsistent });
    expect(decideUndo(itemOf([out, into]), { kind: "transfer", legs: [out, { ...into, loanId: "l" }], fee: null, reference: null, card: null }, ctx)).toEqual({ kind: "blocked", reason: MSG.ownedElsewhere });
    expect(decideUndo(itemOf([out, into]), { kind: "transfer", legs: [out, into], fee: null, reference: { personId: "p1", via: "purpose" }, card: null }, ctx).kind).toBe("blocked");
  });

  it("a card payment uses the Credit Cards preview and its card leg", () => {
    const cardIn = { ...into, accountId: "card-acc" };
    const item = itemOf([out, cardIn]);
    const preview = { state: "ready", blockedReason: null, amount: 5_000, cardLegId: cardIn.id, cardName: "HDFC Card", paidFrom: null, feeAmount: null, statementDue: null, outstanding: { before: 5_000, after: 10_000 }, available: null, sharedLimit: false, overLimitAfter: false, otherPaymentCount: 0 } as CardPaymentCancellationPreview;
    const d = decideUndo(item, { kind: "transfer", legs: [out, cardIn], fee: null, reference: null, card: preview }, ctx);
    expect(d.kind === "eligible" && d.handler).toEqual({ kind: "deleteTransaction", transaction: cardIn });
    expect(decideUndo(item, { kind: "transfer", legs: [out, cardIn], fee: null, reference: null, card: null }, ctx)).toEqual({ kind: "blocked", reason: MSG.cardLoading });
    expect(decideUndo(item, { kind: "transfer", legs: [out, cardIn], fee: null, reference: null, card: { ...preview, state: "blocked", blockedReason: "Linked to People." } }, ctx)).toEqual({ kind: "blocked", reason: "Linked to People." });
  });

  it("a reversed/inconsistent item never reaches a handler", () => {
    const facts: UndoFacts = { kind: "transfer", legs: [out, into], fee: null, reference: null, card: null };
    expect(decideUndo(itemOf([{ ...out, deletedAt: new Date() }, { ...into, deletedAt: new Date() }]), facts, ctx)).toEqual({ kind: "alreadyUndone" });
  });
});
