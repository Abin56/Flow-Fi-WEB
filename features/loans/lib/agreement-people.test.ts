import { describe, expect, it } from "vitest";
import { agreementPeople } from "@/features/loans/lib/agreement-people";
import type { InstallmentParticipant, ShareLine } from "@/lib/engines/installment-participants";
import type { Installment } from "@/lib/models/payment-schedule";

const D = new Date(2026, 9, 5);
const inst = (id: string, n: number, due: number, paid: number): Installment => ({ id, scheduleId: "S", sequenceNumber: n, dueDate: D, amountDue: due, amountPaid: paid, isSkipped: false, deletedAt: null }) as unknown as Installment;
const line = (id: string, n: number, share: number, received: number): ShareLine => ({
  key: `emi-inst:${id}`,
  installmentId: id,
  sequenceNumber: n,
  dueDate: D,
  share,
  received,
  remaining: share - received,
  state: received >= share ? "received" : received > 0 ? "partial" : "pending",
});
const who = (personId: string, name: string, current: ShareLine): InstallmentParticipant => ({ personId, personName: name, current, carried: [], outstanding: current.remaining });

describe("agreementPeople — statuses of each person's share", () => {
  const installments = [inst("a", 1, 3000, 3000), inst("b", 2, 3000, 3000), inst("c", 3, 3000, 0), inst("d", 4, 3000, 0)];
  const map = new Map([
    ["a", [who("amma", "Amma", line("a", 1, 1500, 1500))]],
    ["b", [who("amma", "Amma", line("b", 2, 1500, 500))]],
    ["c", [who("amma", "Amma", line("c", 3, 1500, 0))]],
    ["d", [who("amma", "Amma", line("d", 4, 1500, 0))]],
  ]);

  it("bank paid never means received: a bank-paid installment stays Pending until a reimbursement is recorded", () => {
    const [amma] = agreementPeople({ participantsByInstallment: new Map([["b", [who("amma", "Amma", line("b", 2, 1500, 0))]]]), installments, deferralsByPerson: {}, startDay: 1 });
    expect(amma.lines[0]).toMatchObject({ bankPaid: true, status: "pending", remaining: 1500 });
  });

  it("received / partially received / pending, with the totals per person", () => {
    const [amma] = agreementPeople({ participantsByInstallment: map, installments, deferralsByPerson: {}, startDay: 1 });
    expect(amma.lines.map((l) => l.status)).toEqual(["received", "partial", "pending", "pending"]);
    expect(amma.share).toBe(6000);
    expect(amma.received).toBe(2000);
    expect(amma.remaining).toBe(4000);
    expect(amma.firstOpen?.installmentId).toBe("b");
  });

  it("a postponed share is still owed and reads Postponed (until its date passes)", () => {
    const deferral = { obligationKey: "emi-inst:c", state: "active", expected: { cycle: { start: new Date(2099, 0, 1), end: new Date(2099, 0, 31) }, date: new Date(2099, 0, 5) }, frames: [] } as never;
    const [amma] = agreementPeople({ participantsByInstallment: map, installments, deferralsByPerson: { amma: [deferral] }, startDay: 1 });
    const c = amma.lines.find((l) => l.installmentId === "c")!;
    expect(c).toMatchObject({ status: "postponed", remaining: 1500 });
    expect(c.postponedDate?.getFullYear()).toBe(2099);
    expect(amma.lines.find((l) => l.installmentId === "d")!.status).toBe("pending");
  });

  it("nobody shares it → no people", () => {
    expect(agreementPeople({ participantsByInstallment: new Map(), installments, deferralsByPerson: {}, startDay: 1 })).toEqual([]);
  });
});
