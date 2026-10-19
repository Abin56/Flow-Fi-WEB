import { describe, expect, it } from "vitest";
import { bulkDraftDate, bulkItemKey, historicalCandidates, planBulkRecordedEarlier, runBulkRecordedEarlier, type BulkItem } from "./bulk-recorded-earlier";
import { planLoanPaymentCore } from "./loan-payment-core";
import { RecordedEarlierError } from "./recorded-earlier";
import type { Loan } from "@/lib/models/loan";
import type { Installment, InstallmentPayment } from "@/lib/models/payment-schedule";

const TODAY = new Date(2026, 9, 13);
function inst(seq: number, amountPaid = 0, opts: Partial<Installment> = {}): Installment {
  return {
    id: `i${seq}`, scheduleId: "s", ownerType: "loan", ownerId: "l", sequenceNumber: seq, dueDate: new Date(2026, seq, 10), amountDue: 3000, amountPaid,
    isSkipped: false, principalPortion: null, interestPortion: null, createdAt: new Date(2026, 0, 1), deletedAt: null, lastEditedAt: null, editHistory: [], ...opts,
  } as Installment;
}
const earlierPayment = (installmentId: string) => ({ installmentId, deletedAt: null, recordedEarlier: { dateKnown: true } }) as unknown as InstallmentPayment;

describe("historicalCandidates", () => {
  it("lists due installments oldest first with paid / partial / unpaid and earlier-import marks", () => {
    const list = [inst(3), inst(1, 3000), inst(2, 1000), inst(10), inst(4, 0, { deletedAt: new Date() }), inst(5, 0, { isSkipped: true })];
    const c = historicalCandidates(list, [earlierPayment("i1")], TODAY);
    expect(c.map((x) => [x.installment.sequenceNumber, x.status, x.remaining, x.importedEarlier, x.eligible])).toEqual([
      [1, "paid", 0, true, false],
      [2, "partial", 2000, false, true],
      [3, "unpaid", 3000, false, true],
    ]);
  });
});

describe("planBulkRecordedEarlier", () => {
  const candidates = historicalCandidates([inst(1, 3000), inst(2, 1000), inst(3), inst(4)], [], TODAY);

  it("blank amount = what is left, blank date = due date flagged unknown; sorted; exact total; stable keys", () => {
    const plan = planBulkRecordedEarlier({
      candidates,
      draft: [{ installmentId: "i4", amount: "", date: "2026-05-01" }, { installmentId: "i2", amount: "", date: "" }, { installmentId: "i2", amount: "5", date: "" }],
      batchId: "b",
      today: TODAY,
    });
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.items.map((i) => [i.installment.id, i.amount, i.dateKnown, i.idempotencyKey])).toEqual([
      ["i2", 2000, false, bulkItemKey("b", "i2")],
      ["i4", 3000, true, bulkItemKey("b", "i4")],
    ]);
    expect(plan.items[0].date).toEqual(candidates[1].installment.dueDate);
    expect(plan.total).toBe(5000);
  });

  it("refuses a paid installment, a zero / too-large amount and a future date — per installment", () => {
    const plan = planBulkRecordedEarlier({
      candidates,
      draft: [
        { installmentId: "i1", amount: "", date: "" },
        { installmentId: "i2", amount: "2500", date: "" },
        { installmentId: "i3", amount: "0", date: "" },
        { installmentId: "i4", amount: "", date: "2026-12-01" },
      ],
      batchId: "b",
      today: TODAY,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(Object.keys(plan.errors).sort()).toEqual(["i1", "i2", "i3", "i4"]);
  });
});

describe("runBulkRecordedEarlier", () => {
  const items = [1, 2, 3].map((n): BulkItem => ({ installment: inst(n), amount: 3000, date: new Date(2026, n, 10), dateKnown: false, idempotencyKey: `k${n}` }));

  it("records one by one, keeps going past a failure, and a retry runs only what didn't succeed", async () => {
    const calls: string[] = [];
    let fail = true;
    const recordOne = async (item: BulkItem) => {
      calls.push(item.installment.id);
      if (item.installment.id === "i2" && fail) {
        fail = false;
        throw new Error("offline");
      }
      return { alreadyRecorded: false };
    };
    const first = await runBulkRecordedEarlier(items, recordOne);
    expect(first).toEqual({ i1: { status: "recorded" }, i2: { status: "failed", error: "offline" }, i3: { status: "recorded" } });
    const second = await runBulkRecordedEarlier(items, recordOne, { previous: first });
    expect(second.i2).toEqual({ status: "recorded" });
    expect(calls).toEqual(["i1", "i2", "i3", "i2"]);
  });
});

describe("planLoanPaymentCore — onlyInstallmentId (bulk)", () => {
  const loan = { id: "l", scheduleId: "s", name: "Car", repaymentType: "installment" } as unknown as Loan;
  const base = { loan, lastInstallmentId: "i4", accountId: "a", date: new Date(2026, 9, 1), idempotencyKey: "k", includeUpcomingInstallments: true, recordedEarlier: { dateKnown: true } };

  it("lands on exactly that installment even when older ones are unpaid", () => {
    const core = planLoanPaymentCore({ ...base, fresh: [inst(1), inst(2), inst(3)], amount: 3000, onlyInstallmentId: "i3" });
    expect(core.installmentIds).toEqual(["i3"]);
    expect([core.overflow, core.transaction.excludeFromCalculations]).toEqual([0, true]);
  });

  it("more than it owes → overflow (refused by the recorded-earlier guard); already paid → refused", () => {
    expect(planLoanPaymentCore({ ...base, fresh: [inst(1), inst(2, 2000)], amount: 3000, onlyInstallmentId: "i2" }).overflow).toBe(2000);
    expect(() => planLoanPaymentCore({ ...base, fresh: [inst(1), inst(2, 3000)], amount: 3000, onlyInstallmentId: "i2" })).toThrow(RecordedEarlierError);
  });
});

describe("bulkDraftDate — how the dates of several past payments are entered", () => {
  const due = new Date(2025, 0, 5, 12);
  it("due → that installment's own due date (a known date)", () => expect(bulkDraftDate("due", due, "2025-06-01", "2025-02-02")).toBe("2025-01-05"));
  it("same → the one date for all", () => expect(bulkDraftDate("same", due, "2025-06-01", "2025-02-02")).toBe("2025-06-01"));
  it("each → the row's own typed date (blank stays not known)", () => {
    expect(bulkDraftDate("each", due, "2025-06-01", "2025-02-02")).toBe("2025-02-02");
    expect(bulkDraftDate("each", due, "", "")).toBe("");
  });
  it("unknown → blank: the planner stores the due date flagged dateKnown false", () => expect(bulkDraftDate("unknown", due, "2025-06-01", "2025-02-02")).toBe(""));
});

describe("an installment paid ahead (not due yet) — still recordable as a past payment", () => {
  it("is offered only when named (the one the payment dialog was on), never otherwise", () => {
    const list = [inst(1), inst(10)];
    expect(historicalCandidates(list, [], TODAY).map((c) => c.installment.id)).toEqual(["i1"]);
    expect(historicalCandidates(list, [], TODAY, "i10").map((c) => c.installment.id)).toEqual(["i1", "i10"]);
  });

  it("needs its real date: an unknown one would be the future due date", () => {
    const candidates = historicalCandidates([inst(10)], [], TODAY, "i10");
    const unknown = planBulkRecordedEarlier({ candidates, draft: [{ installmentId: "i10", amount: "", date: "" }], batchId: "b", today: TODAY });
    expect(unknown).toEqual({ ok: false, errors: { i10: "Not due yet — enter the date it was paid." } });
    const known = planBulkRecordedEarlier({ candidates, draft: [{ installmentId: "i10", amount: "", date: "2026-01-02" }], batchId: "b", today: TODAY });
    expect(known.ok).toBe(true);
  });
});
