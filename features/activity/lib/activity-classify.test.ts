import { describe, expect, it } from "vitest";
import type { Transaction } from "@/lib/models/transaction";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { activityContext, activityHref, activityKindLabel, activityTitle, classifyActivity, filterActivity, type ActivityNames, type ClassifyContext } from "./activity-classify";

let seq = 0;
function txn(over: Partial<Transaction> & Pick<Transaction, "type">): Transaction {
  seq += 1;
  const base = TransactionRepository.buildTransaction({ type: over.type, amount: 1_000, dateTime: new Date(2026, 9, 10), accountId: "sbi", categoryId: "food" });
  return { ...base, id: `t${seq}`, createdAt: new Date(2026, 9, 10, 10, seq), ...over };
}

const ctx: ClassifyContext = { cardAccountIds: new Set(["card-acc"]), splitTransactionIds: new Set(["split-1"]) };
const names: ActivityNames = {
  account: (id) => ({ sbi: "SBI", hdfc: "HDFC", "card-acc": "HDFC Card" })[id] ?? null,
  person: (id) => (id === "p1" ? "Ravi" : null),
  loan: (id) => (id === "loan-1" ? "Car loan" : null),
  emi: (id) => (id === "emi-1" ? "Phone" : null),
};

describe("classifyActivity — one row per action, by stored ownership only", () => {
  it("classifies each owner kind from its own fields", () => {
    const rows = classifyActivity(
      [
        txn({ id: "plain", type: "expense", description: "Groceries" }),
        txn({ id: "inc", type: "income", description: "Salary" }),
        txn({ id: "loanpay", type: "expense", loanId: "loan-1", installmentPaymentId: "pay-1" }),
        txn({ id: "loanorig", type: "income", loanId: "loan-1", paymentAllocationType: null }),
        txn({ id: "loandisb", type: "income", loanId: "loan-1", paymentAllocationType: "additionalDisbursement" }),
        txn({ id: "emipay", type: "expense", emiId: "emi-1", installmentPaymentId: "emi_k_p0" }),
        txn({ id: "bill", type: "expense", billPaymentId: "billpay_x", description: "Electricity" }),
        txn({ id: "pp", type: "income", isPersonLedgerMovement: true, linkedPersonId: "p1" }),
        txn({ id: "pf", type: "expense", fundedByPersonId: "p1", description: "Dinner" }),
        txn({ id: "split-1", type: "expense", description: "Trip" }),
      ],
      ctx,
    );
    const kindOf = Object.fromEntries(rows.map((r) => [r.anchor.id, r.kind]));
    expect(kindOf).toEqual({
      plain: "expense",
      inc: "income",
      loanpay: "loanPayment",
      loanorig: "loanAgreement",
      loandisb: "loanAgreement",
      emipay: "emiPayment",
      bill: "billPayment",
      pp: "peopleMovement",
      pf: "personFunded",
      "split-1": "splitExpense",
    });
    expect(rows.find((r) => r.anchor.id === "pp")?.personId).toBe("p1");
  });

  it("folds a card bill payment's two legs and fee into ONE row anchored on the card leg", () => {
    const out = txn({ id: "leg-out", type: "expense", accountId: "sbi", transferId: "x1", amount: 5_000 });
    const into = txn({ id: "leg-in", type: "income", accountId: "card-acc", transferId: "x1", amount: 5_000 });
    const fee = txn({ id: "x1_fee", type: "expense", accountId: "sbi", transferFeeForId: "x1", amount: 20 });
    const rows = classifyActivity([out, into, fee], ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "act:x:x1", kind: "cardPayment", filter: "cards", amount: 5_000, cardAccountId: "card-acc", state: "active" });
    expect(rows[0].anchor.id).toBe("leg-in");
    expect(rows[0].transactions.map((t) => t.id).sort()).toEqual(["leg-in", "leg-out", "x1_fee"]);
    expect(activityContext(rows[0], names)).toBe("SBI → HDFC Card");
  });

  it("a plain transfer is one 'move' row; duplicates across pages don't duplicate rows", () => {
    const a = txn({ id: "a", type: "expense", accountId: "sbi", transferId: "x2" });
    const b = txn({ id: "b", type: "income", accountId: "hdfc", transferId: "x2" });
    const rows = classifyActivity([a, b, a, b], ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "transfer", direction: "move", filter: "transactions" });
  });

  it("a fee whose transfer legs aren't loaded is shown alone (never as a transfer)", () => {
    const rows = classifyActivity([txn({ id: "x3_fee", type: "expense", transferFeeForId: "x3" })], ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("expense");
  });

  it("state: soft-deleted → reversedOrReplaced; half-deleted pair → inconsistent; a fee removed alone doesn't matter", () => {
    const gone = txn({ id: "g", type: "expense", deletedAt: new Date() });
    const l1 = txn({ id: "l1", type: "expense", transferId: "x4" });
    const l2 = txn({ id: "l2", type: "income", accountId: "hdfc", transferId: "x4", deletedAt: new Date() });
    const m1 = txn({ id: "m1", type: "expense", transferId: "x5" });
    const m2 = txn({ id: "m2", type: "income", accountId: "hdfc", transferId: "x5" });
    const mfee = txn({ id: "x5_fee", type: "expense", transferFeeForId: "x5", deletedAt: new Date() });
    const rows = classifyActivity([gone, l1, l2, m1, m2, mfee], ctx);
    const stateOf = Object.fromEntries(rows.map((r) => [r.id, r.state]));
    expect(stateOf).toEqual({ "act:t:g": "reversedOrReplaced", "act:x:x4": "inconsistent", "act:x:x5": "active" });
  });

  it("orders newest recorded first and keeps the event date separately", () => {
    const old = txn({ id: "old", type: "expense", dateTime: new Date(2026, 0, 1), createdAt: new Date(2026, 9, 12) });
    const recent = txn({ id: "recent", type: "expense", dateTime: new Date(2026, 9, 11), createdAt: new Date(2026, 9, 11) });
    const rows = classifyActivity([recent, old], ctx);
    expect(rows.map((r) => r.anchor.id)).toEqual(["old", "recent"]);
    expect(rows[0].eventDate).toEqual(new Date(2026, 0, 1));
    expect(rows[0].recordedAt).toEqual(new Date(2026, 9, 12));
  });

  it("filters, titles and links", () => {
    const rows = classifyActivity(
      [txn({ id: "lp", type: "expense", loanId: "loan-1", installmentPaymentId: "p" }), txn({ id: "e", type: "expense", description: "Tea" }), txn({ id: "pp2", type: "income", isPersonLedgerMovement: true, linkedPersonId: "p1" })],
      ctx,
    );
    expect(filterActivity(rows, "loans").map((r) => r.anchor.id)).toEqual(["lp"]);
    expect(filterActivity(rows, "people").map((r) => r.anchor.id)).toEqual(["pp2"]);
    expect(filterActivity(rows, "all")).toHaveLength(3);
    const lp = rows.find((r) => r.anchor.id === "lp")!;
    expect(activityTitle(lp, names)).toBe("Loan payment · Car loan");
    expect(activityHref(lp)).toBe("/loans?agreement=loan-1");
    const pp = rows.find((r) => r.anchor.id === "pp2")!;
    expect(activityTitle(pp, names)).toBe("Received from Ravi");
    expect(activityHref(pp)).toBe("/people?person=p1");
    expect(activityHref(rows.find((r) => r.anchor.id === "e")!)).toBe("/transactions?transaction=e");
    expect(activityContext(rows.find((r) => r.anchor.id === "e")!, names)).toBe("From SBI");
    expect(activityKindLabel(lp.kind)).toBe("Loan payment");
    expect(activityKindLabel("cardPayment")).toBe("Card bill payment");
  });
});
