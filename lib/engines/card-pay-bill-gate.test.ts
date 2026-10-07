import { describe, expect, it } from "vitest";
import { chargesReachedByPayment, type LinkedFundsTransaction } from "./linked-funds";
import { linkedPeopleForCard, peopleSettlementGate } from "./linked-people-readiness";

/**
 * People "ready to pay" gate for a card bill, scoped to the payment actually being made.
 *
 * Card c1: closed statement charges ₹6,000 (20 Aug, AMMA's share ₹3,000) + ₹4,000 (10 Sep); ₹2,000 already
 * paid → statement due ₹8,000. New purchase ₹4,000 (25 Sep, SOJAN's share ₹2,000) — next statement.
 * Outstanding ₹12,000. Sibling card c2 (same shared limit): ₹7,000 charge with RAVI's share ₹3,500.
 */
const d = (m: number, day: number) => new Date(2026, m - 1, day, 12);
const tx = (id: string, type: "income" | "expense", amount: number, date: Date, accountId = "acc-c1"): LinkedFundsTransaction => ({
  id,
  type,
  amount,
  accountId,
  dateTime: date,
  createdAt: date,
  description: "",
  deletedAt: null,
  isPersonLedgerMovement: false,
});
const transactions = [
  tx("aug", "expense", 6000, d(8, 20)),
  tx("sep", "expense", 4000, d(9, 10)),
  tx("paid", "income", 2000, d(9, 20)),
  tx("new", "expense", 4000, d(9, 25)),
  tx("sib", "expense", 7000, d(9, 5), "acc-c2"),
];
const entry = (id: string, personId: string, transactionRef: string) => ({ id, personId, type: "gave" as const, transactionRef, deletedAt: null });
const ledgerEntries = [entry("e-amma", "amma", "aug"), entry("e-sojan", "sojan", "new"), entry("e-ravi", "ravi", "sib")];
const statement = (personId: string, personName: string, key: string, share: number) => ({
  personId,
  personName,
  rows: [{ key, kind: "obligation", title: `${personName} share`, amount: share, signedAmount: share, remainingNow: share }] as never,
});
const statements = [statement("amma", "AMMA", "ledger:e-amma", 3000), statement("sojan", "SOJAN", "ledger:e-sojan", 2000), statement("ravi", "RAVI", "ledger:e-ravi", 3500)];

const gate = (paymentAmount?: number, cardAccountId = "acc-c1") =>
  peopleSettlementGate(linkedPeopleForCard({ statements, ledgerEntries, transactions, cardAccountId, lenderDue: paymentAmount ?? 12000, paymentAmount }));
const people = (g: ReturnType<typeof gate>) => g.attention.map((p) => p.personName).sort();

describe("Card Pay bill — People gate follows the payment scope", () => {
  it("BEFORE (no payment amount): every charge the card carries gates — AMMA and SOJAN", () => {
    expect(people(gate())).toEqual(["AMMA", "SOJAN"]);
  });

  it("A. statement ₹8,000 reaches only the statement's charges — AMMA gates, SOJAN's new purchase doesn't", () => {
    expect([...chargesReachedByPayment(transactions, "acc-c1", 8000)].sort()).toEqual(["aug", "sep"]);
    const g = gate(8000);
    expect(people(g)).toEqual(["AMMA"]);
    expect(g.outstanding).toBe(3000);
  });

  it("B. explicit full outstanding ₹12,000 reaches the new purchase too — both gate", () => {
    expect(people(gate(12000))).toEqual(["AMMA", "SOJAN"]);
  });

  it("C. partial ₹3,000 reaches only the oldest unpaid charge (20 Aug) — AMMA", () => {
    expect([...chargesReachedByPayment(transactions, "acc-c1", 3000)]).toEqual(["aug"]);
    expect(people(gate(3000))).toEqual(["AMMA"]);
    // ₹0 / empty amount reaches nothing (the dialog's own amount check blocks it anyway).
    expect(gate(0).blocked).toBe(false);
  });

  it("D. shared-limit sibling: card c1's payment never gates on card c2's RAVI share, and vice versa", () => {
    expect(people(gate(12000))).not.toContain("RAVI");
    expect(people(gate(7000, "acc-c2"))).toEqual(["RAVI"]);
  });

  it("protection is not weakened: once AMMA's share is received, the statement payment is unblocked", () => {
    const received = statements.map((s) => (s.personId === "amma" ? statement("amma", "AMMA", "ledger:e-amma", 3000) : s));
    (received[0].rows as unknown as { remainingNow: number }[])[0].remainingNow = 0;
    const g = peopleSettlementGate(linkedPeopleForCard({ statements: received, ledgerEntries, transactions, cardAccountId: "acc-c1", lenderDue: 8000, paymentAmount: 8000 }));
    expect(g.blocked).toBe(false);
    expect(g.resolved.map((p) => p.personName)).toEqual(["AMMA"]);
  });
});
