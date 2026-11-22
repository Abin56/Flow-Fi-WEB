import { describe, expect, it } from "vitest";
import { summarizePeopleLines, type AgreementPeopleLine } from "@/features/loans/lib/agreement-people";
import { firstPayableId, installmentTableRows } from "@/features/loans/lib/installment-table";
import type { RecordedPaymentAction } from "@/features/loans/lib/recorded-payments";
import type { Installment } from "@/lib/models/payment-schedule";

const NOW = new Date(2026, 10, 22);
const inst = (id: string, n: number, due: Date, amountDue: number, amountPaid: number, extra: Partial<Installment> = {}): Installment =>
  ({ id, scheduleId: "S", sequenceNumber: n, dueDate: due, amountDue, amountPaid, isSkipped: false, deletedAt: null, ...extra }) as Installment;
const action = (installmentId: string, over: Partial<RecordedPaymentAction> = {}): RecordedPaymentAction =>
  ({
    id: `a-${installmentId}`,
    source: "emi",
    portions: [{ installmentId } as never],
    overflow: null,
    amount: 3000,
    date: new Date(2026, 9, 6),
    note: "",
    createdAt: new Date(2026, 9, 6),
    allocationType: "installment",
    transactionId: "t1",
    installmentSeqs: [1],
    remainingAfter: 0,
    reversed: false,
    recordedEarlier: null,
    ...over,
  }) as RecordedPaymentAction;

describe("installmentTableRows", () => {
  const installments = [
    inst("c", 3, new Date(2027, 0, 5), 3000, 0),
    inst("a", 1, new Date(2026, 9, 5), 3000, 3000),
    inst("b", 2, new Date(2026, 10, 5), 3000, 1000),
  ];
  const rows = installmentTableRows({ installments, actions: [action("a")], closed: false, now: NOW });

  it("is in schedule order with the bank status, paid and left read from the installment", () => {
    expect(rows.map((r) => [r.sequenceNumber, r.status, r.paid, r.left])).toEqual([
      [1, "paid", 3000, 0],
      [2, "partiallyPaid", 1000, 2000],
      [3, "upcoming", 0, 3000],
    ]);
  });

  it("a paid row carries its recorded payment and date; only unpaid rows can be paid", () => {
    expect(rows[0].recorded?.id).toBe("a-a");
    expect(rows[0].paidOn?.getMonth()).toBe(9);
    expect(rows.map((r) => r.canPay)).toEqual([false, true, true]);
    expect(firstPayableId(rows)).toBe("b");
  });

  it("a payment recorded as already paid earlier with an unknown date shows no date", () => {
    const [r] = installmentTableRows({ installments: [installments[1]], actions: [action("a", { recordedEarlier: { dateKnown: false } })], closed: false, now: NOW });
    expect(r.earlier).toEqual({ dateKnown: false });
    expect(r.paidOn).toBeNull();
  });

  it("a closed agreement and a skipped installment can't be paid", () => {
    expect(installmentTableRows({ installments, actions: [], closed: true, now: NOW }).every((r) => !r.canPay)).toBe(true);
    const [skipped] = installmentTableRows({ installments: [inst("s", 4, NOW, 3000, 0, { isSkipped: true })], actions: [], closed: false, now: NOW });
    expect(skipped).toMatchObject({ status: "skipped", canPay: false, left: 0 });
  });

  it("the People column is empty for an unshared agreement", () => {
    expect(rows.every((r) => r.people === null)).toBe(true);
  });
});

describe("summarizePeopleLines — one word per installment", () => {
  const l = (status: AgreementPeopleLine["status"]) => ({ status });
  it("nobody → null", () => expect(summarizePeopleLines([])).toBeNull());
  it("all received → Received", () => expect(summarizePeopleLines([l("received"), l("received")])).toBe("received"));
  it("nothing in yet → Pending, even though the bank has been paid", () => expect(summarizePeopleLines([l("pending"), l("pending")])).toBe("pending"));
  it("some in, some open → Partially received", () => expect(summarizePeopleLines([l("received"), l("pending")])).toBe("partial"));
  it("one share part-paid → Partially received", () => expect(summarizePeopleLines([l("partial")])).toBe("partial"));
  it("every open share moved to a later date → Postponed; a mix with pending stays Pending", () => {
    expect(summarizePeopleLines([l("postponed"), l("postponed")])).toBe("postponed");
    expect(summarizePeopleLines([l("postponed"), l("pending")])).toBe("pending");
  });
});
