import { describe, expect, it } from "vitest";
import { derivePendingSplitParticipants } from "./person-pending-split-participants";
import type { Expense, ExpenseParticipant } from "@/lib/models/expense";
import type { Installment } from "@/lib/models/payment-schedule";

function participant(overrides: Partial<ExpenseParticipant> = {}): ExpenseParticipant {
  return {
    personId: "p1",
    name: "Alex",
    share: 100,
    installmentId: "i1",
    isMe: false,
    receivedStatus: "yetToReceive",
    ...overrides,
  };
}

function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: "e1",
    description: "Dinner",
    totalAmount: 200,
    date: new Date("2026-01-01"),
    categoryId: "c1",
    accountId: "a1",
    transactionId: "t1",
    splitType: "equal",
    participants: [participant()],
    scheduleId: "s1",
    notes: "",
    createdAt: new Date("2026-01-01"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

function installment(overrides: Partial<Installment> = {}): Installment {
  return {
    id: "i1",
    scheduleId: "s1",
    ownerType: "splitExpense",
    ownerId: "e1",
    sequenceNumber: 1,
    dueDate: new Date("2026-01-08"),
    amountDue: 100,
    amountPaid: 0,
    isSkipped: false,
    principalPortion: null,
    interestPortion: null,
    createdAt: new Date("2026-01-01"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

describe("derivePendingSplitParticipants", () => {
  it("returns a matching participant/installment pair for the given person", () => {
    const i = installment();
    const e = expense();
    const result = derivePendingSplitParticipants("p1", [e], { s1: [i] });
    expect(result).toEqual([{ expense: e, participant: e.participants[0], installment: i }]);
  });

  it("excludes participants belonging to a different person", () => {
    const e = expense({ participants: [participant({ personId: "someone-else" })] });
    const result = derivePendingSplitParticipants("p1", [e], { s1: [installment()] });
    expect(result).toEqual([]);
  });

  it("excludes the 'Me' participant even if personId somehow matches", () => {
    const e = expense({ participants: [participant({ isMe: true })] });
    const result = derivePendingSplitParticipants("p1", [e], { s1: [installment()] });
    expect(result).toEqual([]);
  });

  it("does NOT filter by remaining balance itself — a fully-settled installment is still resolved (matches Flutter's provider; callers like the Settle Up dialog filter remainingAmount > 0 themselves)", () => {
    const i = installment({ amountDue: 100, amountPaid: 100 });
    const result = derivePendingSplitParticipants("p1", [expense()], { s1: [i] });
    expect(result).toHaveLength(1);
    expect(result[0].installment).toBe(i);
  });

  it("includes a partially-paid installment (still has a remaining balance)", () => {
    const i = installment({ amountDue: 100, amountPaid: 40 });
    const result = derivePendingSplitParticipants("p1", [expense()], { s1: [i] });
    expect(result).toHaveLength(1);
    expect(result[0].installment).toBe(i);
  });

  it("skips expenses with no scheduleId, and participants with no installmentId", () => {
    const unsplit = expense({ id: "e2", scheduleId: null, participants: [] });
    const notYetScheduled = expense({
      id: "e3",
      scheduleId: "s1",
      participants: [participant({ installmentId: null })],
    });
    const result = derivePendingSplitParticipants("p1", [unsplit, notYetScheduled], { s1: [installment()] });
    expect(result).toEqual([]);
  });

  it("skips a participant whose installmentId no longer resolves to a live installment", () => {
    const e = expense({ participants: [participant({ installmentId: "missing" })] });
    const result = derivePendingSplitParticipants("p1", [e], { s1: [installment()] });
    expect(result).toEqual([]);
  });

  it("sorts the result oldest-due-date-first across multiple expenses", () => {
    const iLate = installment({ id: "late", dueDate: new Date("2026-03-01") });
    const iEarly = installment({ id: "early", dueDate: new Date("2026-01-01") });
    const iMid = installment({ id: "mid", dueDate: new Date("2026-02-01") });
    const eLate = expense({ id: "e-late", participants: [participant({ installmentId: "late" })] });
    const eEarly = expense({ id: "e-early", participants: [participant({ installmentId: "early" })] });
    const eMid = expense({ id: "e-mid", participants: [participant({ installmentId: "mid" })] });

    const result = derivePendingSplitParticipants("p1", [eLate, eEarly, eMid], {
      s1: [iLate, iEarly, iMid],
    });

    expect(result.map((r) => r.installment.id)).toEqual(["early", "mid", "late"]);
  });
});
