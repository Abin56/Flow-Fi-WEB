import { describe, expect, it } from "vitest";
import { personEmiObligations } from "@/lib/engines/person-emi-obligations";
import { personLinkedEmis } from "@/lib/engines/person-linked-emis";
import { buildPersonCycleStatement, type StatementInstallment, type StatementLoanSource } from "@/lib/engines/person-cycle-statement";
import type { LedgerEntry } from "@/lib/models/person";

const NOW = new Date(2026, 10, 14); // 14 Nov 2026
const ALL_TIME = { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) };

const inst = (id: string, seq: number, due: Date, amountDue: number, amountPaid = 0) =>
  ({ id, scheduleId: "sch", sequenceNumber: seq, dueDate: due, amountDue, amountPaid, isSkipped: false, deletedAt: null, createdAt: new Date(2026, 0, 1) }) as StatementInstallment & { amountDue: number };

const solo = { id: "L", name: "Bike loan", scheduleId: "sch", direction: "taken", personId: null, beneficiaryPersonId: "rahul", beneficiaryRepaysInstallments: true, isClosed: false, deletedAt: null };
const shared = {
  ...solo,
  beneficiaryPersonId: null,
  beneficiaryRepaysInstallments: false,
  ownershipShares: [
    { personId: null, amount: 20000 },
    { personId: "rahul", amount: 20000 },
    { personId: "arun", amount: 20000 },
  ],
};

function summarize(loan: typeof solo | typeof shared, installments: ReturnType<typeof inst>[], entries: LedgerEntry[] = []) {
  const obligations = personEmiObligations({ personId: "rahul", emis: [], loans: [loan as never], installments, now: NOW });
  const statement = buildPersonCycleStatement({
    person: { id: "rahul", name: "Rahul", openingBalance: 0, createdAt: new Date(2026, 0, 1) },
    ledgerEntries: entries,
    loanIds: new Set(),
    emis: [],
    loans: [loan as unknown as StatementLoanSource],
    installments,
    advanceApplications: [],
    cycle: ALL_TIME,
    now: NOW,
  });
  const remainingByKey = new Map(statement.rows.filter((r) => r.kind === "obligation" && r.remainingNow != null).map((r) => [r.key, r.remainingNow as number]));
  return personLinkedEmis({ obligations, remainingByKey, sharedSourceIds: new Set("ownershipShares" in loan ? [`loan:${loan.id}`] : []), now: NOW });
}

const schedule = [
  inst("i1", 1, new Date(2026, 8, 5), 5000),
  inst("i2", 2, new Date(2026, 9, 5), 5000),
  inst("i3", 3, new Date(2026, 10, 5), 5000),
  inst("i4", 4, new Date(2026, 11, 5), 5000),
];

const receipt = (id: string, amount: number, ref: string): LedgerEntry =>
  ({
    id, personId: "rahul", type: "receivedBack", amount, date: new Date(2026, 9, 6), note: "", increasesBalance: true, transactionRef: `leg-${id}`,
    parentEntryId: null, createdAt: new Date(2026, 9, 6), receivedStatus: "received", deletedAt: null, lastEditedAt: null, editHistory: [], paymentId: `pay-${id}`, obligationRef: ref,
  }) as LedgerEntry;

describe("personLinkedEmis", () => {
  it("shows the whole responsibility as pending/overdue with nothing received yet", () => {
    const [emi] = summarize(solo, schedule);
    expect(emi.name).toBe("Bike loan");
    expect(emi.monthlyShare).toBe(5000);
    expect(emi.dueToDate).toBe(15000); // Sep, Oct, Nov already due
    expect(emi.paid).toBe(0);
    expect(emi.remaining).toBe(15000);
    expect(emi.upcoming).toBe(5000);
    expect(emi.status).toBe("overdue");
    expect(emi.overdueCount).toBe(3);
    expect(emi.installments.map((i) => i.status)).toEqual(["overdue", "overdue", "overdue", "upcoming"]);
    expect(emi.nextDue?.number).toBe(1);
  });

  it("tracks a person's payment against the installment without touching the bank side", () => {
    const [emi] = summarize(solo, schedule, [receipt("a", 5000, "loan-inst:i1"), receipt("b", 2000, "loan-inst:i2")]);
    expect(emi.paid).toBe(7000);
    expect(emi.remaining).toBe(8000);
    expect(emi.installments.map((i) => i.status)).toEqual(["paid", "partial", "overdue", "upcoming"]);
    expect(emi.installments[1]).toMatchObject({ paid: 2000, remaining: 3000 });
    // The bank installment is still unpaid: Rahul paying me never settles the lender.
    expect(emi.installments.every((i) => i.lenderStatus !== "paid")).toBe(true);
    expect(emi.nextDue?.number).toBe(2);
    expect(emi.nextDue?.remaining).toBe(3000);
  });

  it("reports an agreement as paid once every due share is settled", () => {
    const entries = [receipt("a", 5000, "loan-inst:i1"), receipt("b", 5000, "loan-inst:i2"), receipt("c", 5000, "loan-inst:i3")];
    const [emi] = summarize(solo, schedule, entries);
    expect(emi.status).toBe("paid");
    expect(emi.remaining).toBe(0);
    expect(emi.upcoming).toBe(5000);
    expect(emi.paidCount).toBe(3);
  });

  it("shows only the person's own share of a shared EMI", () => {
    const sharedSchedule = schedule.map((i) => ({ ...i, amountDue: 6000 }));
    const [emi] = summarize(shared, sharedSchedule);
    expect(emi.shared).toBe(true);
    expect(emi.monthlyShare).toBe(2000);
    expect(emi.installmentAmount).toBe(6000);
    expect(emi.dueToDate).toBe(6000);
  });

  it("treats an installment due today as pending, and one not yet due as upcoming — never overdue", () => {
    const early = [inst("i1", 1, new Date(2026, 10, 14), 5000), inst("i2", 2, new Date(2026, 11, 14), 5000)];
    const [emi] = summarize(solo, early);
    expect(emi.installments.map((i) => i.status)).toEqual(["pending", "upcoming"]);
    expect(emi.status).toBe("pending");
    expect(emi.overdueCount).toBe(0);
    expect(emi.remaining).toBe(5000);
    expect(emi.upcoming).toBe(5000);
  });

  it("lists nothing for a person who owes no share", () => {
    const obligations = personEmiObligations({ personId: "nobody", emis: [], loans: [shared as never], installments: schedule, now: NOW });
    expect(personLinkedEmis({ obligations, remainingByKey: new Map(), now: NOW })).toEqual([]);
  });
});
