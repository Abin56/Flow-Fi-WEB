import { describe, expect, it } from "vitest";
import { linkableCandidates, linkableTransactionProblem, matchEvidence, splitCandidates } from "@/lib/engines/link-earlier-payment";
import { declaredTransactionOwner } from "@/lib/repositories/transaction-repository";
import { earlierPaymentLinkFromMap, type Transaction } from "@/lib/models/transaction";
import { installmentPaymentFromFirestore, installmentPaymentToFirestore, type InstallmentPayment } from "@/lib/models/payment-schedule";
import { Timestamp } from "firebase/firestore";

const NOW = new Date(2026, 10, 14);
const d = (m: number, day: number, y = 2026) => new Date(y, m - 1, day);

function tx(patch: Partial<Transaction> = {}): Transaction {
  return {
    id: "t1", type: "expense", amount: 3000, dateTime: d(2, 8), accountId: "acc", deletedAt: null, excludeFromCalculations: false, transferId: null,
    loanId: null, emiId: null, billPaymentId: null, fundedByPersonId: null, isPersonLedgerMovement: false, paymentAllocationType: null, earlierPaymentLink: null, ...patch,
  } as unknown as Transaction;
}

describe("linkableTransactionProblem", () => {
  it("accepts a live, unlinked, past expense", () => expect(linkableTransactionProblem(tx(), undefined, NOW)).toBeNull());

  it("refuses everything that is not a plain expense that really moved an account", () => {
    const bad = (patch: Partial<Transaction>) => linkableTransactionProblem(tx(patch), undefined, NOW);
    expect(bad({ type: "income" })).toMatch(/Only an expense/);
    expect(bad({ deletedAt: d(3, 1) })).toMatch(/deleted/);
    expect(bad({ excludeFromCalculations: true })).toMatch(/excluded/);
    expect(bad({ transferId: "x" })).toMatch(/transfer/);
    expect(bad({ isPersonLedgerMovement: true })).toMatch(/People or bill/);
    expect(bad({ fundedByPersonId: "p" })).toMatch(/People or bill/);
    expect(bad({ billPaymentId: "b" })).toMatch(/People or bill/);
    expect(bad({ loanId: "L" })).toMatch(/already belongs to a Loan/);
    expect(bad({ emiId: "E" })).toMatch(/already belongs to a Loan/);
    expect(bad({ earlierPaymentLink: { ownerType: "loan", ownerId: "L", scheduleId: "s", installmentId: "i", paymentId: "p" } })).toMatch(/already linked/);
    expect(bad({ amount: 0 })).toMatch(/no amount/);
    expect(bad({ dateTime: d(12, 1) })).toMatch(/future/);
    expect(linkableTransactionProblem(null, undefined, NOW)).toMatch(/no longer exists/);
  });

  it("when a payment is being recorded, its amount, date and account must BE the transaction's", () => {
    const wanted = { amount: 3000, date: d(2, 8), accountId: "acc" };
    expect(linkableTransactionProblem(tx(), wanted, NOW)).toBeNull();
    expect(linkableTransactionProblem(tx(), { ...wanted, amount: 2999.5 }, NOW)).toMatch(/exactly the transaction's amount/);
    expect(linkableTransactionProblem(tx(), { ...wanted, date: d(2, 9) }, NOW)).toMatch(/exactly the transaction's date/);
    expect(linkableTransactionProblem(tx(), { ...wanted, accountId: "other" }, NOW)).toMatch(/transaction's account/);
    // The same calendar day at another time of day is the same date.
    expect(linkableTransactionProblem(tx({ dateTime: new Date(2026, 1, 8, 21, 30) }), wanted, NOW)).toBeNull();
  });
});

describe("linkableCandidates", () => {
  const installment = { amountDue: 3000, amountPaid: 0, dueDate: d(2, 10) };

  it("lists only what could be this installment's payment, exact amount first, then nearest its due date", () => {
    const list = linkableCandidates(
      [
        tx({ id: "exact-far", amount: 3000, dateTime: d(1, 1) }),
        tx({ id: "exact-near", amount: 3000, dateTime: d(2, 9) }),
        tx({ id: "smaller", amount: 1000, dateTime: d(2, 10) }),
        tx({ id: "too-big", amount: 5000 }),
        tx({ id: "income", type: "income" }),
        tx({ id: "linked", earlierPaymentLink: { ownerType: "loan", ownerId: "L", scheduleId: "s", installmentId: "i", paymentId: "p" } }),
      ],
      installment,
      NOW,
    );
    expect(list.map((t) => t.id)).toEqual(["exact-near", "exact-far", "smaller"]);
  });

  it("a part-paid installment only offers what is still owed", () => {
    const list = linkableCandidates([tx({ id: "a", amount: 3000 }), tx({ id: "b", amount: 2000 })], { ...installment, amountPaid: 1000 }, NOW);
    expect(list.map((t) => t.id)).toEqual(["b"]);
  });
});

describe("a linked transaction is owned by its Loan / EMI (the existing edit / delete / undo guards apply)", () => {
  it("declaredTransactionOwner reads the link; an unlinked expense has no owner", () => {
    expect(declaredTransactionOwner(tx() as never)).toBeNull();
    const link = (ownerType: "loan" | "emi") => ({ ownerType, ownerId: "o", scheduleId: "s", installmentId: "i", paymentId: "p" }) as const;
    expect(declaredTransactionOwner(tx({ earlierPaymentLink: link("loan") }) as never)).toBe("loan");
    expect(declaredTransactionOwner(tx({ earlierPaymentLink: link("emi") }) as never)).toBe("emi");
  });
});

describe("storage shape", () => {
  it("the link parses back, and anything malformed reads as unlinked (the write shape is proven on the emulator)", () => {
    const link = { ownerType: "loan" as const, ownerId: "L", scheduleId: "s", installmentId: "i", paymentId: "p" };
    expect(earlierPaymentLinkFromMap(link)).toEqual(link);
    expect(earlierPaymentLinkFromMap({ ownerType: "emi", ownerId: "E", scheduleId: "s", installmentId: "i", paymentId: "p" })?.ownerType).toBe("emi");
    expect(earlierPaymentLinkFromMap({ ownerType: "bill", ownerId: "x" })).toBeNull();
    expect(earlierPaymentLinkFromMap({ ownerType: "loan", ownerId: "L" })).toBeNull();
    expect(earlierPaymentLinkFromMap(null)).toBeNull();
  });

  it("the payment's reference is written only when present, and absent reads as null", () => {
    const payment = {
      id: "p", installmentId: "i", scheduleId: "s", ownerType: "loan", ownerId: "L", amount: 3000, date: d(2, 8), note: "", createdAt: d(2, 8), settlementMethod: null, billingCycleLabel: null,
      remainingBalanceAfterPayment: 0, allocationType: "regularEmi", prepaymentPrincipalAmount: null, prepaymentPolicyApplied: null, reamortizationEventId: null, transactionId: "tx",
      recordedEarlier: { dateKnown: true }, deletedAt: null, lastEditedAt: null, editHistory: [],
    } as unknown as InstallmentPayment;
    expect("linkedTransactionId" in installmentPaymentToFirestore(payment)).toBe(false);
    const stored = installmentPaymentToFirestore({ ...payment, linkedTransactionId: "t1" });
    expect(stored.linkedTransactionId).toBe("t1");
    const read = (data: Record<string, unknown>) => installmentPaymentFromFirestore({ id: "p", data: () => ({ ...data, date: Timestamp.fromDate(d(2, 8)), createdAt: Timestamp.fromDate(d(2, 8)) }) } as never);
    expect(read(stored).linkedTransactionId).toBe("t1");
    expect(read(installmentPaymentToFirestore(payment)).linkedTransactionId).toBeNull();
  });
});

describe("evidence — an amount/date match alone is never a suggestion", () => {
  const installment = { amountDue: 1000, amountPaid: 0, dueDate: d(10, 1) };
  const ctx = { names: ["iPhone EMI", "HDFC Bank"], categoryIds: ["cat-phone"] };
  const lulu = tx({ id: "lulu", amount: 1000, dateTime: d(10, 1), description: "lulu", categoryId: "groceries" } as Partial<Transaction>);

  it("the 'lulu' grocery expense (same amount, same day) has no evidence and is not suggested", () => {
    const { related, others } = splitCandidates(linkableCandidates([lulu], installment, NOW), ctx);
    expect(related).toEqual([]);
    expect(others.map((t) => t.id)).toEqual(["lulu"]);
  });

  it("an expense that names the EMI / lender, says EMI, or sits in the agreement's category IS suggested, with its reasons", () => {
    const list = linkableCandidates(
      [
        tx({ id: "named", amount: 1000, dateTime: d(10, 2), description: "iphone emi oct" } as Partial<Transaction>),
        tx({ id: "word", amount: 1000, dateTime: d(10, 2), description: "Monthly EMI" } as Partial<Transaction>),
        tx({ id: "cat", amount: 1000, dateTime: d(10, 2), description: "transfer", categoryId: "cat-phone" } as Partial<Transaction>),
        tx({ id: "loancat", amount: 1000, dateTime: d(10, 2), description: "x", categoryId: "loan_payment" } as Partial<Transaction>),
        lulu,
      ],
      installment,
      NOW,
    );
    const { related, others } = splitCandidates(list, ctx);
    expect(related.map((r) => r.t.id).sort()).toEqual(["cat", "loancat", "named", "word"]);
    expect(related.find((r) => r.t.id === "named")?.reasons[0]).toBe("Mentions “iPhone EMI”");
    expect(others.map((t) => t.id)).toEqual(["lulu"]);
  });

  it("excluded transactions (e.g. the EMI's own purchase) are in neither list; short names don't match by accident", () => {
    const purchase = tx({ id: "purchase", amount: 1000, dateTime: d(10, 1), description: "iPhone EMI purchase" } as Partial<Transaction>);
    const { related, others } = splitCandidates([purchase], { ...ctx, excludeIds: new Set(["purchase"]) });
    expect(related).toEqual([]);
    expect(others).toEqual([]);
    expect(matchEvidence({ id: "t", categoryId: "x", description: "mall run" } as never, { names: ["al"] })).toEqual([]);
  });
});
