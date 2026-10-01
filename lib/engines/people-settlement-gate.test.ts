import { describe, expect, it } from "vitest";
import { buildPersonCycleStatement, type StatementEmiSource, type StatementInstallment, type StatementLoanSource } from "@/lib/engines/person-cycle-statement";
import {
  isInAppPath,
  linkedPeopleForCard,
  linkedPeopleForInstallment,
  peopleSettleHref,
  peopleSettlementGate,
} from "@/lib/engines/linked-people-readiness";
import type { LinkedFundsTransaction } from "@/lib/engines/linked-funds";
import type { LedgerEntry } from "@/lib/models/person";

/**
 * People settlement gate — a card bill / Loan installment / EMI payment can't complete while a People obligation
 * linked to THAT payment (by key) still has money to come in. Built on real People statements, so the gate reads
 * exactly what the People Ledger shows.
 */

const d = (day: number) => new Date(2026, 8, day);
const ALL_TIME = { start: new Date(1970, 0, 1), end: new Date(2100, 0, 1) };
const NAMES: Record<string, string> = { amma: "AMMA", john: "JOHN", anu: "ANU" };

const tx = (id: string, type: "income" | "expense", amount: number, accountId: string, day: number, extra: Partial<LinkedFundsTransaction> = {}): LinkedFundsTransaction => ({
  id, type, amount, accountId, dateTime: d(day), createdAt: d(day), description: id, deletedAt: null, isPersonLedgerMovement: false, ...extra,
});
const entry = (id: string, fields: Partial<LedgerEntry>): LedgerEntry & { id: string } =>
  ({
    id, personId: "amma", type: "receivedBack", amount: 0, date: d(10), note: "", increasesBalance: true, transactionRef: null, parentEntryId: null,
    createdAt: d(10), receivedStatus: "received", deletedAt: null, lastEditedAt: null, editHistory: [], ...fields,
  }) as LedgerEntry & { id: string };
const share = (id: string, personId: string, amount: number, chargeId: string) =>
  entry(id, { personId, type: "gave", amount, transactionRef: chargeId, sourceKind: "assignedExpense", receivedStatus: "yetToReceive", date: d(3), createdAt: d(3) });
const paid = (id: string, personId: string, amount: number, settles: { parentEntryId?: string; obligationRef?: string }, extra: Partial<LedgerEntry> = {}) =>
  entry(id, { personId, amount, paymentId: `pay-${id}`, transactionRef: `leg-${id}`, parentEntryId: settles.parentEntryId ?? null, obligationRef: settles.obligationRef, ...extra });

function statements(entries: (LedgerEntry & { id: string })[], opts: { emis?: StatementEmiSource[]; loans?: StatementLoanSource[]; installments?: StatementInstallment[] } = {}) {
  const people = [...new Set(entries.map((e) => e.personId).concat(Object.keys(NAMES)))];
  return people.map((id) =>
    buildPersonCycleStatement({
      person: { id, name: NAMES[id] ?? id, openingBalance: 0, createdAt: d(1) },
      ledgerEntries: entries,
      loanIds: new Set(),
      emis: opts.emis ?? [],
      loans: opts.loans ?? [],
      installments: opts.installments ?? [],
      advanceApplications: [],
      cycle: ALL_TIME,
      now: d(15),
    }),
  );
}

const cardGate = (txs: LinkedFundsTransaction[], entries: (LedgerEntry & { id: string })[], lenderDue: number) =>
  peopleSettlementGate(linkedPeopleForCard({ statements: statements(entries), ledgerEntries: entries, transactions: txs, cardAccountId: "octane", lenderDue }));

describe("peopleSettlementGate — card bill", () => {
  const ammaCharge = tx("amma-phone", "expense", 1000, "octane", 3);

  it("no linked People → never blocks", () => {
    const gate = cardGate([tx("fuel", "expense", 1000, "octane", 3)], [], 1000);
    expect(gate).toMatchObject({ blocked: false, attention: [], resolved: [], outstanding: 0, next: null });
    expect(peopleSettlementGate(null).blocked).toBe(false);
  });

  it("pending People share → blocked, with the exact person + obligation to settle", () => {
    const gate = cardGate([ammaCharge], [share("g1", "amma", 1000, "amma-phone")], 1000);
    expect(gate.blocked).toBe(true);
    expect(gate.outstanding).toBe(1000);
    expect(gate.next).toEqual({ personId: "amma", personName: "AMMA", obligationKey: "ledger:g1", amount: 1000 });
  });

  it("partial People settlement → still blocked for the exact remaining", () => {
    const gate = cardGate([ammaCharge], [share("g1", "amma", 1000, "amma-phone"), paid("s1", "amma", 400, { parentEntryId: "g1" })], 1000);
    expect(gate.blocked).toBe(true);
    expect(gate.attention[0]).toMatchObject({ state: "partial", received: 400, remaining: 600 });
    expect(gate.next?.amount).toBe(600);
  });

  it("fully settled → unblocked; the person stays listed as received", () => {
    const gate = cardGate([ammaCharge], [share("g1", "amma", 1000, "amma-phone"), paid("s1", "amma", 1000, { parentEntryId: "g1" })], 1000);
    expect(gate.blocked).toBe(false);
    expect(gate.resolved).toMatchObject([{ personName: "AMMA", state: "received", received: 1000 }]);
    expect(gate.next).toBeNull();
  });

  it("multiple people: every linked share must resolve; most remaining is settled first", () => {
    const txs = [tx("a", "expense", 2000, "octane", 3), tx("j", "expense", 1000, "octane", 3), tx("n", "expense", 500, "octane", 3), tx("mine", "expense", 1500, "octane", 3)];
    const entries = [
      share("ga", "amma", 2000, "a"),
      share("gj", "john", 1000, "j"),
      paid("sj", "john", 1000, { parentEntryId: "gj" }),
      share("gn", "anu", 500, "n"),
      paid("sn", "anu", 200, { parentEntryId: "gn" }),
    ];
    const gate = cardGate(txs, entries, 5000);
    expect(gate.blocked).toBe(true);
    expect(gate.attention.map((p) => [p.personName, p.remaining])).toEqual([
      ["AMMA", 2000],
      ["ANU", 300],
    ]);
    expect(gate.resolved.map((p) => p.personName)).toEqual(["JOHN"]);
    expect(gate.outstanding).toBe(2300);
    expect(gate.next?.personName).toBe("AMMA");

    // AMMA settles — ANU still open → still blocked.
    const afterAmma = cardGate(txs, [...entries, paid("sa", "amma", 2000, { parentEntryId: "ga" })], 5000);
    expect(afterAmma.blocked).toBe(true);
    expect(afterAmma.next).toMatchObject({ personName: "ANU", amount: 300 });

    // ANU settles too — all linked shares resolved → unblocked.
    const all = cardGate(txs, [...entries, paid("sa", "amma", 2000, { parentEntryId: "ga" }), paid("sn2", "anu", 300, { parentEntryId: "gn" })], 5000);
    expect(all.blocked).toBe(false);
    expect(all.resolved).toHaveLength(3);
  });

  it("unrelated People debts never block the card: other-card share, Loan/EMI share, manual balance", () => {
    const emi = { id: "e1", name: "Bike EMI", scheduleId: "sch", beneficiaryPersonId: "amma", beneficiaryRepaysInstallments: true, isClosed: false, deletedAt: null };
    const inst = { id: "i1", scheduleId: "sch", sequenceNumber: 1, dueDate: d(5), amountDue: 1000, amountPaid: 0, isSkipped: false, deletedAt: null, createdAt: d(1) };
    const entries = [
      share("other-card", "amma", 2000, "sbi-card-charge"), // AMMA's share on a DIFFERENT card
      entry("manual", { personId: "amma", type: "gave", amount: 500, receivedStatus: "yetToReceive", date: d(2), createdAt: d(2) }), // manual balance
    ];
    const sts = statements(entries, { emis: [emi], installments: [inst] }); // + AMMA's open EMI share
    const txs = [tx("sbi-card-charge", "expense", 2000, "sbi-card", 3), tx("mine", "expense", 1000, "octane", 3)];
    const gate = peopleSettlementGate(linkedPeopleForCard({ statements: sts, ledgerEntries: entries, transactions: txs, cardAccountId: "octane", lenderDue: 1000 }));
    expect(gate.blocked).toBe(false);
    // …even though AMMA owes overall (global balance is never the gate).
    expect(sts.find((s) => s.personId === "amma")!.currentPending).toBeGreaterThan(0);
  });

  it("same amount + same person on another card's charge is not linked (IDs, not amounts or names)", () => {
    const entries = [share("g1", "amma", 1000, "elsewhere")];
    const gate = cardGate([tx("elsewhere", "expense", 1000, "hdfc", 3), tx("own", "expense", 1000, "octane", 3)], entries, 1000);
    expect(gate.blocked).toBe(false);
  });

  it("settling People never changes the card bill; paying the card never changes People", () => {
    const entries = [share("g1", "amma", 1000, "amma-phone")];
    const before = linkedPeopleForCard({ statements: statements(entries), ledgerEntries: entries, transactions: [ammaCharge], cardAccountId: "octane", lenderDue: 1000 });
    const settled = [...entries, paid("s1", "amma", 1000, { parentEntryId: "g1" })];
    const after = linkedPeopleForCard({ statements: statements(settled), ledgerEntries: settled, transactions: [ammaCharge], cardAccountId: "octane", lenderDue: 1000 });
    expect(after.lenderDue).toBe(before.lenderDue); // card liability unchanged by the People receipt
    expect(statements(settled).find((s) => s.personId === "amma")!.currentPending).toBe(0);

    // Then the lender payment: the bill leaves, People stays exactly as settled.
    const paidCard = linkedPeopleForCard({ statements: statements(settled), ledgerEntries: settled, transactions: [ammaCharge, tx("pay", "income", 1000, "octane", 12)], cardAccountId: "octane", lenderDue: 0 });
    expect(paidCard.people).toEqual([]);
    expect(statements(settled).find((s) => s.personId === "amma")!.currentPending).toBe(0);
  });

  it("reverting the People payment re-blocks the card", () => {
    const entries = [share("g1", "amma", 1000, "amma-phone"), paid("s1", "amma", 1000, { parentEntryId: "g1" }, { deletedAt: d(13) })];
    expect(cardGate([ammaCharge], entries, 1000)).toMatchObject({ blocked: true, outstanding: 1000 });
  });
});

describe("peopleSettlementGate — Loan / EMI installment", () => {
  const shares = [
    { personId: null, amount: 10000 },
    { personId: "amma", amount: 10000 },
    { personId: "john", amount: 10000 },
  ];
  const inst = (id: string, seq: number) => ({ id, scheduleId: "sch", sequenceNumber: seq, dueDate: d(seq + 4), amountDue: 3000, amountPaid: 0, isSkipped: false, deletedAt: null, createdAt: d(1) });

  function gateFor(kind: "emi" | "loan", entries: (LedgerEntry & { id: string })[], installmentId = "i1") {
    const source = { id: "src", name: "Home", scheduleId: "sch", ownershipShares: shares, isClosed: false, deletedAt: null } as unknown;
    const sts = statements(entries, {
      emis: kind === "emi" ? [source as StatementEmiSource] : [],
      loans: kind === "loan" ? [{ ...(source as StatementLoanSource), direction: "taken" }] : [],
      installments: [inst("i1", 1), inst("i2", 2)],
    });
    return peopleSettlementGate(linkedPeopleForInstallment({ statements: sts, installmentId, sourceKind: kind, lenderDue: 3000 }));
  }

  for (const kind of ["loan", "emi"] as const) {
    const ref = (id: string) => `${kind === "emi" ? "emi-inst" : "loan-inst"}:${id}`;

    it(`${kind}: AMMA received, JOHN pending → blocked on JOHN for this installment`, () => {
      const gate = gateFor(kind, [paid("s1", "amma", 1000, { obligationRef: ref("i1") })]);
      expect(gate.blocked).toBe(true);
      expect(gate.next).toMatchObject({ personName: "JOHN", obligationKey: ref("i1"), amount: 1000 });
      expect(gate.resolved.map((p) => p.personName)).toEqual(["AMMA"]);
    });

    it(`${kind}: both people settled → unblocked`, () => {
      const gate = gateFor(kind, [paid("s1", "amma", 1000, { obligationRef: ref("i1") }), paid("s2", "john", 1000, { obligationRef: ref("i1") })]);
      expect(gate.blocked).toBe(false);
    });

    it(`${kind}: a payment against ANOTHER installment never unblocks this one`, () => {
      const gate = gateFor(kind, [paid("s1", "amma", 1000, { obligationRef: ref("i2") }), paid("s2", "john", 1000, { obligationRef: ref("i2") })]);
      expect(gate.blocked).toBe(true);
      expect(gate.attention).toHaveLength(2);
      // …and installment #2 itself is unblocked by those payments.
      expect(gateFor(kind, [paid("s1", "amma", 1000, { obligationRef: ref("i2") }), paid("s2", "john", 1000, { obligationRef: ref("i2") })], "i2").blocked).toBe(false);
    });
  }
});

describe("peopleSettleHref", () => {
  it("deep-links to Record payment for the exact obligation, with an in-app return path", () => {
    expect(peopleSettleHref("amma", "ledger:g1", "/credit-cards?card=c1&pay=1")).toBe(
      "/people?person=amma&obligation=ledger%3Ag1&settle=1&return=%2Fcredit-cards%3Fcard%3Dc1%26pay%3D1",
    );
  });

  it("never carries an off-site return URL", () => {
    expect(peopleSettleHref("amma", "emi-inst:i1", "https://evil.example")).toBe("/people?person=amma&obligation=emi-inst%3Ai1&settle=1");
    expect(isInAppPath("//evil.example")).toBe(false);
    expect(isInAppPath("/\\evil.example")).toBe(false);
    expect(isInAppPath("/loans")).toBe(true);
  });
});
