import { describe, expect, it } from "vitest";
import { buildPersonCycleStatement, type StatementInstallment, type StatementEmiSource, type StatementLoanSource } from "@/lib/engines/person-cycle-statement";
import { linkedPeopleForCard, linkedPeopleForInstallment, peopleLedgerHref } from "@/lib/engines/linked-people-readiness";
import type { LinkedFundsTransaction } from "@/lib/engines/linked-funds";
import type { AdvanceApplication, LedgerEntry } from "@/lib/models/person";

const d = (day: number) => new Date(2026, 8, day);
const ALL_TIME = { start: new Date(1970, 0, 1), end: new Date(2100, 0, 1) };
const NAMES: Record<string, string> = { amma: "Amma", john: "John", c: "Person C" };

const tx = (id: string, type: "income" | "expense", amount: number, accountId: string, day: number, extra: Partial<LinkedFundsTransaction> = {}): LinkedFundsTransaction => ({
  id, type, amount, accountId, dateTime: d(day), createdAt: d(day), description: id, deletedAt: null, isPersonLedgerMovement: false, ...extra,
});
const entry = (id: string, fields: Partial<LedgerEntry>): LedgerEntry & { id: string } =>
  ({
    id, personId: "amma", type: "receivedBack", amount: 0, date: d(10), note: "", increasesBalance: true, transactionRef: null, parentEntryId: null,
    createdAt: d(10), receivedStatus: "received", deletedAt: null, lastEditedAt: null, editHistory: [], ...fields,
  }) as LedgerEntry & { id: string };

/** A card share: the `gave` entry on a card charge (what split / assigned expenses create). */
const share = (id: string, personId: string, amount: number, chargeId: string) =>
  entry(id, { personId, type: "gave", amount, transactionRef: chargeId, sourceKind: "assignedExpense", receivedStatus: "yetToReceive", date: d(3), createdAt: d(3) });
/** A People Record Payment allocation settling one obligation (cash leg into SBI). */
const paid = (id: string, personId: string, amount: number, settles: { parentEntryId?: string; obligationRef?: string }, extra: Partial<LedgerEntry> = {}) =>
  entry(id, { personId, amount, paymentId: `pay-${id}`, transactionRef: `leg-${id}`, parentEntryId: settles.parentEntryId ?? null, obligationRef: settles.obligationRef, ...extra });

function statements(entries: (LedgerEntry & { id: string })[], opts: { emis?: StatementEmiSource[]; loans?: StatementLoanSource[]; installments?: StatementInstallment[]; advanceApplications?: AdvanceApplication[] } = {}) {
  const people = [...new Set(entries.map((e) => e.personId).concat(Object.keys(NAMES)))];
  return people.map((id) =>
    buildPersonCycleStatement({
      person: { id, name: NAMES[id] ?? id, openingBalance: 0, createdAt: d(1) },
      ledgerEntries: entries,
      loanIds: new Set(),
      emis: opts.emis ?? [],
      loans: opts.loans ?? [],
      installments: opts.installments ?? [],
      advanceApplications: (opts.advanceApplications ?? []).filter((a) => a.personId === id),
      cycle: ALL_TIME,
      now: d(15),
    }),
  );
}

// ─── Credit card ─────────────────────────────────────────────────────────────────────────────────────

describe("linkedPeopleForCard — card bill readiness", () => {
  const mine = tx("groceries", "expense", 2000, "hdfc", 3);
  const ammaCharge = tx("amma-phone", "expense", 3000, "hdfc", 3);
  const card = (txs: LinkedFundsTransaction[], entries: (LedgerEntry & { id: string })[], lenderDue = 5000) =>
    linkedPeopleForCard({ statements: statements(entries), ledgerEntries: entries, transactions: txs, cardAccountId: "hdfc", lenderDue });

  it("1. a bill that is 100% mine has no linked people", () => {
    const r = card([mine, tx("fuel", "expense", 3000, "hdfc", 4)], []);
    expect(r.people).toEqual([]);
    expect(r).toMatchObject({ peopleShare: 0, stillExpected: 0, yourPortion: 5000, lenderDue: 5000 });
  });

  it("2. a person's share not yet received → pending, lender still due in full", () => {
    const r = card([mine, ammaCharge], [share("g1", "amma", 3000, "amma-phone")]);
    expect(r.people).toMatchObject([{ personName: "Amma", share: 3000, received: 0, remaining: 3000, state: "pending" }]);
    expect(r).toMatchObject({ lenderDue: 5000, peopleShare: 3000, received: 0, stillExpected: 3000, yourPortion: 2000 });
  });

  it("3 + 8. person fully paid before the card → received; card still due (People payment never touches the card)", () => {
    const entries = [share("g1", "amma", 3000, "amma-phone"), paid("s1", "amma", 3000, { parentEntryId: "g1" })];
    const r = card([mine, ammaCharge], entries);
    expect(r.people[0]).toMatchObject({ state: "received", received: 3000, remaining: 0 });
    expect(r).toMatchObject({ lenderDue: 5000, stillExpected: 0, received: 3000 });
  });

  it("4 + 14. partial People payment → partial with exact remaining", () => {
    const entries = [share("g1", "amma", 2000, "amma-phone"), paid("s1", "amma", 1200, { parentEntryId: "g1" })];
    const r = card([ammaCharge], entries, 3000);
    expect(r.people[0]).toMatchObject({ state: "partial", share: 2000, received: 1200, remaining: 800 });
  });

  it("5. multiple people with mixed states", () => {
    const txs = [tx("a", "expense", 1500, "hdfc", 3), tx("j", "expense", 1000, "hdfc", 3), tx("c", "expense", 500, "hdfc", 3)];
    const entries = [
      share("ga", "amma", 1500, "a"),
      share("gj", "john", 1000, "j"),
      paid("sj", "john", 1000, { parentEntryId: "gj" }),
      share("gc", "c", 500, "c"),
      paid("sc", "c", 200, { parentEntryId: "gc" }),
    ];
    const r = card(txs, entries, 3000);
    const byName = Object.fromEntries(r.people.map((p) => [p.personName, p]));
    expect(byName.Amma).toMatchObject({ state: "pending", remaining: 1500 });
    expect(byName.John).toMatchObject({ state: "received", received: 1000 });
    expect(byName["Person C"]).toMatchObject({ state: "partial", received: 200, remaining: 300 });
    expect(r).toMatchObject({ peopleShare: 3000, received: 1200, stillExpected: 1800, yourPortion: 0 });
  });

  it("6 + 12. paying the card before reimbursement: the card bill leaves, the People receivable stays open", () => {
    const entries = [share("g1", "amma", 3000, "amma-phone")];
    const payCard = tx("card-payment", "income", 5000, "hdfc", 12);
    const r = card([mine, ammaCharge, payCard], entries, 0);
    expect(r.people).toEqual([]); // nothing of the paid bill is linked to this payment any more
    const amma = statements(entries).find((s) => s.personId === "amma")!;
    expect(amma.rows.find((x) => x.key === "ledger:g1")?.remainingNow).toBe(3000); // still owes me
    expect(amma.currentPending).toBe(3000);
  });

  it("7. person reimburses after the card was paid: People settles, the card stays settled", () => {
    const entries = [share("g1", "amma", 3000, "amma-phone"), paid("s1", "amma", 3000, { parentEntryId: "g1" })];
    const payCard = tx("card-payment", "income", 5000, "hdfc", 12);
    const r = card([mine, ammaCharge, payCard], entries, 0);
    expect(r).toMatchObject({ lenderDue: 0, people: [] });
    expect(statements(entries).find((s) => s.personId === "amma")!.currentPending).toBe(0);
  });

  it("9. a partial card payment keeps the still-carried charge's share linked, unchanged by the payment", () => {
    // ₹2,500 paid covers the oldest charge (₹2,000 mine) and ₹500 of Amma's — her ₹3,000 share is still open People-side.
    const r = card([mine, ammaCharge, tx("card-payment", "income", 2500, "hdfc", 12)], [share("g1", "amma", 3000, "amma-phone")], 2500);
    expect(r.people[0]).toMatchObject({ remaining: 3000, state: "pending" });
  });

  it("13. source-scoped: a Loan-share payment never funds the card share", () => {
    const emi = { id: "e1", name: "Bike EMI", scheduleId: "sch", beneficiaryPersonId: "amma", beneficiaryRepaysInstallments: true, isClosed: false, deletedAt: null };
    const inst = { id: "i1", scheduleId: "sch", sequenceNumber: 1, dueDate: d(5), amountDue: 1000, amountPaid: 0, isSkipped: false, deletedAt: null, createdAt: d(1) };
    const entries = [
      share("g1", "amma", 2000, "amma-phone"),
      entry("manual", { personId: "amma", type: "gave", amount: 500, receivedStatus: "yetToReceive", date: d(2), createdAt: d(2) }),
      paid("s1", "amma", 1000, { obligationRef: "emi-inst:i1" }, { sourceKind: "emiInstallment" }),
    ];
    const sts = statements(entries, { emis: [emi], installments: [inst] });
    const cardR = linkedPeopleForCard({ statements: sts, ledgerEntries: entries, transactions: [ammaCharge], cardAccountId: "hdfc", lenderDue: 3000 });
    expect(cardR.people[0]).toMatchObject({ remaining: 2000, state: "pending" });
    const emiR = linkedPeopleForInstallment({ statements: sts, installmentId: "i1", sourceKind: "emi", lenderDue: 1000 });
    expect(emiR.people[0]).toMatchObject({ remaining: 0, state: "received" });
    expect(sts.find((s) => s.personId === "amma")!.rows.find((r) => r.key === "ledger:manual")?.remainingNow).toBe(500);
  });

  it("15. reverting the People payment (soft-deleted settlement) restores pending", () => {
    const entries = [share("g1", "amma", 3000, "amma-phone"), paid("s1", "amma", 3000, { parentEntryId: "g1" }, { deletedAt: d(13) })];
    expect(card([ammaCharge], entries, 3000).people[0]).toMatchObject({ state: "pending", remaining: 3000 });
  });

  it("16. reverting the card payment brings the share back under the bill, People state unchanged", () => {
    const entries = [share("g1", "amma", 3000, "amma-phone")];
    const reverted = tx("card-payment", "income", 5000, "hdfc", 12, { deletedAt: d(13) });
    expect(card([mine, ammaCharge, reverted], entries).people[0]).toMatchObject({ state: "pending", remaining: 3000 });
  });

  it("17. a deleted linked card expense (and its share) drops out", () => {
    const entries = [share("g1", "amma", 3000, "amma-phone")];
    entries[0] = { ...entries[0], deletedAt: d(13) };
    expect(card([mine, { ...ammaCharge, deletedAt: d(13) }], entries, 2000).people).toEqual([]);
  });

  it("19. an advance applied to the card share counts as received for it, never for another obligation", () => {
    const entries = [
      share("g1", "amma", 3000, "amma-phone"),
      share("g2", "amma", 1000, "other"),
      entry("adv", { personId: "amma", amount: 1000, sourceKind: "advance", paymentId: "p-adv", date: d(4), createdAt: d(4) }),
    ];
    const app = { id: "a1", personId: "amma", advanceEntryId: "adv", obligationKey: "ledger:g1", amount: 1000, date: d(5), createdAt: d(5), deletedAt: null } as unknown as AdvanceApplication;
    const sts = statements(entries, { advanceApplications: [app] });
    const r = linkedPeopleForCard({ statements: sts, ledgerEntries: entries, transactions: [ammaCharge, tx("other", "expense", 1000, "hdfc", 3)], cardAccountId: "hdfc", lenderDue: 4000 });
    const amma = r.people[0];
    expect(amma.obligations.find((o) => o.key === "ledger:g1")).toMatchObject({ received: 1000, remaining: 2000, state: "partial" });
    expect(amma.obligations.find((o) => o.key === "ledger:g2")).toMatchObject({ received: 0, state: "pending" });
  });

  it("24. charges on other cards / bank-paid shares are ignored", () => {
    const entries = [share("g1", "amma", 3000, "bank-dinner")];
    expect(card([tx("bank-dinner", "expense", 3000, "sbi", 3), mine], entries, 2000).people).toEqual([]);
  });
});

// ─── Loan / EMI ──────────────────────────────────────────────────────────────────────────────────────

describe("linkedPeopleForInstallment — shared Loan / EMI readiness", () => {
  const shares = [
    { personId: null, amount: 10000 },
    { personId: "amma", amount: 10000 },
    { personId: "john", amount: 10000 },
  ];
  const inst = (amountPaid = 0) => ({ id: "i1", scheduleId: "sch", sequenceNumber: 3, dueDate: d(5), amountDue: 3000, amountPaid, isSkipped: false, deletedAt: null, createdAt: d(1) });

  function run(kind: "emi" | "loan", entries: (LedgerEntry & { id: string })[], amountPaid = 0) {
    const source = { id: "src", name: "Home", scheduleId: "sch", ownershipShares: shares, isClosed: false, deletedAt: null } as unknown;
    const sts = statements(entries, {
      emis: kind === "emi" ? [source as StatementEmiSource] : [],
      loans: kind === "loan" ? [{ ...(source as StatementLoanSource), direction: "taken" }] : [],
      installments: [inst(amountPaid)],
    });
    return linkedPeopleForInstallment({ statements: sts, installmentId: "i1", sourceKind: kind, lenderDue: 3000 - amountPaid });
  }

  for (const kind of ["loan", "emi"] as const) {
    it(`${kind === "loan" ? "10" : "11"}. shared ${kind} installment — Amma received, John pending`, () => {
      const ref = `${kind === "emi" ? "emi-inst" : "loan-inst"}:i1`;
      const shareOf = (r: ReturnType<typeof run>, name: string) => r.people.find((p) => p.personName === name)!;
      const r = run(kind, [paid("s1", "amma", 1000, { obligationRef: ref })]);
      expect(r.people.map((p) => p.personName).sort()).toEqual(["Amma", "John"]);
      expect(shareOf(r, "Amma")).toMatchObject({ state: "received", received: 1000 });
      expect(shareOf(r, "John")).toMatchObject({ state: "pending", remaining: 1000 });
      expect(r.yourPortion).toBeCloseTo(1000, 1);
      expect(r.lenderDue).toBe(3000);
    });
  }

  it("12. paying the lender leaves the People shares exactly as they were", () => {
    const before = run("emi", []);
    const after = run("emi", [], 3000);
    expect(after.people.map((p) => p.remaining)).toEqual(before.people.map((p) => p.remaining));
    expect(after.lenderDue).toBe(0);
  });

  it("24. an un-shared, non-opted-in EMI has no linked people", () => {
    const sts = statements([], { emis: [{ id: "x", name: "Mine", scheduleId: "sch", isClosed: false, deletedAt: null } as StatementEmiSource], installments: [inst()] });
    expect(linkedPeopleForInstallment({ statements: sts, installmentId: "i1", sourceKind: "emi", lenderDue: 3000 }).people).toEqual([]);
  });

  it("deep link targets the person and the obligation", () => {
    expect(peopleLedgerHref("amma", "emi-inst:i1")).toBe("/people?person=amma&obligation=emi-inst%3Ai1");
  });
});
