import { describe, expect, it } from "vitest";
import type { AgreementPeopleLine } from "@/features/loans/lib/agreement-people";
import { scheduleReceipts } from "@/features/loans/lib/schedule-receipts";
import { PAID_DIRECTLY_NOTE } from "@/lib/engines/historical-reimbursement";
import { cycleRangeFor } from "@/lib/engines/month-cycle-range";
import type { AdvanceApplication, LedgerEntry } from "@/lib/models/person";

const date = (month: number, day: number) => new Date(2026, month - 1, day, 12);
const cycle = cycleRangeFor(18, date(12, 5));
const older = date(11, 17);

function receipt(id: string, amount: number, fields: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id, personId: "dad", amount, date: older, createdAt: older, type: "receivedBack", note: "",
    increasesBalance: true, transactionRef: null, parentEntryId: null, receivedStatus: "received",
    deletedAt: null, lastEditedAt: null, editHistory: [], ...fields,
  };
}

function share(key: string, sequenceNumber: number): AgreementPeopleLine {
  return {
    personId: "dad", personName: "DAD", key, sequenceNumber, installmentId: key.split(":")[1],
    dueDate: date(12, 5), share: 2500, received: 0, remaining: 2500, status: "pending",
    postponedDate: null, bankPaid: false,
  };
}

function application(id: string, obligationKey: string, amount: number, deletedAt: Date | null = null): AdvanceApplication {
  return {
    id, personId: "dad", advanceEntryId: "advance", obligationKey, amount,
    date: date(11, 21), createdAt: date(11, 21), deletedAt,
  };
}

describe("Schedule receipt context", () => {
  it("keeps one mixed receipt, shows where advance was used, and reports only the held remainder", () => {
    const lines = [share("emi-inst:october", 1), share("emi-inst:december", 2)];
    const result = scheduleReceipts({
      cycle, lines,
      entries: [
        receipt("linked", 500, { paymentId: "split", obligationRef: lines[0].key }),
        receipt("advance", 1000, { paymentId: "split", sourceKind: "advance" }),
        receipt("paid-out", 900, { type: "repaid", sourceKind: "advance" }),
        receipt("deleted", 100, { sourceKind: "advance", deletedAt: cycle.start }),
      ],
      applications: [
        application("applied", lines[1].key, 250),
        application("elsewhere", "loan-inst:other", 200),
        application("undone", lines[1].key, 100, cycle.start),
      ],
    });

    expect(result).toMatchObject({ availableAdvance: 550, earlierAdvance: 550, receivedThisCycle: 0 });
    expect(result.recent).toHaveLength(1);
    expect(result.recent[0]).toMatchObject({
      date: older,
      amount: 1500,
      installmentKeys: new Set(lines.map((line) => line.key)),
      parts: new Map([
        ["Applied to #1", 500],
        ["Advance applied to #2", 250],
        ["Advance applied elsewhere", 200],
        ["Unallocated advance", 550],
      ]),
    });
    expect(lines[1]).toMatchObject({ received: 0, remaining: 2500 });
  });

  it("uses the configured cycle and keeps general receipts separate from other obligations and direct lender payments", () => {
    const result = scheduleReceipts({
      cycle, lines: [share("loan-inst:december", 2)], applications: [],
      entries: [
        receipt("previous", 35),
        receipt("general", 120, { date: date(11, 18) }),
        receipt("other-agreement", 80, { date: date(11, 19), obligationRef: "emi-inst:elsewhere" }),
        receipt("matched-obligation", 90, { transactionRef: "legacy-transaction" }),
        receipt("obligation", 90, { type: "gave", transactionRef: "legacy-transaction" }),
        receipt("direct", 1000, { obligationRef: "loan-inst:december", recordedEarlier: true, note: PAID_DIRECTLY_NOTE, date: date(11, 19) }),
        receipt("unknown", 100, { date: date(11, 20), obligationRef: "loan-inst:december", receivedDateKnown: false }),
        receipt("next", 10, { date: date(12, 18) }),
      ],
    });

    expect(result).toMatchObject({ availableAdvance: 0, earlierAdvance: 0, receivedThisCycle: 200 });
    expect(result.recent.map(({ key, date }) => [key, date])).toEqual([
      ["entry:next", date(12, 18)], ["entry:general", date(11, 18)], ["entry:previous", older], ["entry:unknown", null],
    ]);
    expect([...result.recent[1].parts.keys()]).toEqual(["General receipt · no installment selected"]);
    expect([...result.recent[3].parts.keys()]).toEqual(["Applied to #2"]);
  });

  it("waits for advance applications before presenting available advance", () => {
    const result = scheduleReceipts({
      cycle, lines: [share("loan-inst:december", 2)],
      entries: [receipt("advance", 1000, { sourceKind: "advance" })],
    });
    expect(result.availableAdvance).toBeUndefined();
    expect(result.earlierAdvance).toBe(0);
    expect(result.recent[0].parts).toEqual(new Map([["Advance receipt", 1000]]));
  });
});
