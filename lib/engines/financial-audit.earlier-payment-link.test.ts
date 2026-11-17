import { describe, expect, it } from "vitest";
import { runFinancialAudit, type AuditInput } from "@/lib/engines/financial-audit";
import type { InstallmentPayment } from "@/lib/models/payment-schedule";
import type { Transaction } from "@/lib/models/transaction";

const LINK = { ownerType: "loan" as const, ownerId: "L", scheduleId: "s", installmentId: "i", paymentId: "p1" };
const tx = (patch: Partial<Transaction> = {}) =>
  ({ id: "t1", type: "expense", amount: 3000, dateTime: new Date(2026, 1, 8), accountId: "acc", deletedAt: null, excludeFromCalculations: false, transferId: null, description: "EMI",
    loanId: null, emiId: null, earlierPaymentLink: LINK, ...patch }) as unknown as Transaction;
const pay = (patch: Partial<InstallmentPayment> = {}) =>
  ({ id: "p1", installmentId: "i", amount: 3000, date: new Date(2026, 1, 8), deletedAt: null, linkedTransactionId: "t1", ...patch }) as unknown as InstallmentPayment;
const input = (transactions: Transaction[], payments: InstallmentPayment[]): AuditInput =>
  ({ accounts: [], transactions, people: [], ledgerEntries: [], loans: [], emis: [], expenses: [], installments: [], payments });
const linkFindings = (i: AuditInput) => runFinancialAudit(i, new Date(2026, 10, 15)).findings.filter((f) => f.category === "earlier-payment-link");

describe("audit: earlier-payment links", () => {
  it("a consistent pair produces no finding, and unlinked data is ignored", () => {
    expect(linkFindings(input([tx()], [pay()]))).toEqual([]);
    expect(linkFindings(input([tx({ earlierPaymentLink: null })], [pay({ linkedTransactionId: null })]))).toEqual([]);
  });

  it("an expense still marked as a payment that is gone or reversed (it would stay locked)", () => {
    expect(linkFindings(input([tx()], []))[0].title).toMatch(/no longer exists/);
    expect(linkFindings(input([tx()], [pay({ deletedAt: new Date() })]))[0].title).toMatch(/no longer exists/);
  });

  it("a payment whose expense is deleted, missing or no longer points back", () => {
    expect(linkFindings(input([tx({ deletedAt: new Date() })], [pay()]))[0].title).toMatch(/expense that is gone/);
    expect(linkFindings(input([], [pay()]))[0].title).toMatch(/expense that is gone/);
    expect(linkFindings(input([tx({ earlierPaymentLink: null })], [pay()]))[0].title).toMatch(/does not point back/);
  });

  it("an expense whose amount changed after linking, and one expense claimed by two payments", () => {
    expect(linkFindings(input([tx({ amount: 4000 })], [pay()]))[0].title).toMatch(/amount differs/);
    const dup = linkFindings(input([tx()], [pay(), pay({ id: "p2" })]));
    expect(dup.some((f) => /several payments/.test(f.title))).toBe(true);
  });

  it("never proposes a balance change (a link moves no money)", () => {
    for (const f of linkFindings(input([tx({ amount: 4000 })], [pay()]))) expect(f.proposal.balanceDelta).toBe(0);
  });
});
