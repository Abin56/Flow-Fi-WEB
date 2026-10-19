import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
import { linkedStateOf } from "@/lib/engines/linked-people-readiness";
import type { InstallmentParticipant, ShareLine } from "@/lib/engines/installment-participants";
import { peopleStatusOf } from "./use-installment-people-status";

/** The People line on a shared Loan / EMI schedule row — separate from (never merged with) the lender status. */

const line = (key: string, share: number, received: number): ShareLine => ({
  key, installmentId: key.split(":")[1], sequenceNumber: 1, dueDate: new Date(2026, 9, 5), share, received, remaining: share - received, state: linkedStateOf(share, share - received),
});
const person = (id: string, name: string, current: ShareLine | null): InstallmentParticipant => ({ personId: id, personName: name, current, carried: [], outstanding: current?.remaining ?? 0 });
const later = { start: new Date(2099, 10, 1), end: new Date(2099, 10, 30) };

describe("peopleStatusOf", () => {
  it("nobody shares it → no line", () => {
    expect(peopleStatusOf([], {}, 1)).toBeNull();
    expect(peopleStatusOf([person("p", "Priya", null)], {}, 1)).toBeNull();
  });

  it("owed, part received and received read separately per person", () => {
    const s = peopleStatusOf([person("p", "Priya", line("emi-inst:i1", 1000, 0)), person("r", "Ravi", line("emi-inst:i1", 1000, 400))], {}, 1);
    expect(s).toEqual({ text: "Priya: ₹1,000 to receive · Ravi: ₹400 of ₹1,000 received", tone: "owed" });
  });

  it("everyone received → received", () => {
    expect(peopleStatusOf([person("p", "Priya", line("emi-inst:i1", 1000, 1000))], {}, 1)).toEqual({ text: "Priya: received", tone: "received" });
  });

  it("a live postponement reads as moved — still owed, not received", () => {
    const deferrals = { p: [{ obligationKey: "emi-inst:i1", state: "active", expected: { cycle: later, reason: null, note: null }, frames: [] }] } as never;
    expect(peopleStatusOf([person("p", "Priya", line("emi-inst:i1", 1000, 0))], deferrals, 1)).toEqual({ text: "Priya: moved to Nov 2099 cycle", tone: "moved" });
  });

  it("not due yet with nothing received → no line (an upcoming share isn't news)", () => {
    expect(peopleStatusOf([person("p", "Priya", line("emi-inst:i1", 1000, 0))], {}, 1, true)).toBeNull();
    expect(peopleStatusOf([person("p", "Priya", line("emi-inst:i1", 1000, 1000))], {}, 1, true)?.tone).toBe("received");
  });
});
