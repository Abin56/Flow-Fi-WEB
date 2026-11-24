import { describe, expect, it } from "vitest";
import { classificationNote } from "@/features/transactions/lib/classification-note";

const base = { type: "income" as const, isPersonLedgerMovement: false, loanId: null, emiId: null, paymentAllocationType: null, linkedPersonId: null, owesPersonToggle: false };

describe("classificationNote", () => {
  it("calls a borrowed cash leg a liability, not income", () => {
    const n = classificationNote({ ...base, isPersonLedgerMovement: true, linkedPersonId: "p" }, { entryType: "borrowed", personName: "ABIN" });
    expect(n?.title).toBe("Money borrowed from ABIN");
    expect(n?.detail).toMatch(/liability, not income/);
  });
  it("describes repayments and lending without calling them income or spending", () => {
    expect(classificationNote({ ...base, isPersonLedgerMovement: true }, { entryType: "receivedBack", personName: "DAD" })?.detail).toMatch(/not income/);
    expect(classificationNote({ ...base, type: "expense", isPersonLedgerMovement: true }, { entryType: "repaid", personName: "DAD" })?.detail).toMatch(/not a personal expense/);
    expect(classificationNote({ ...base, type: "expense", isPersonLedgerMovement: true }, { entryType: "gave", personName: "DAD" })?.detail).toMatch(/receivable/);
  });
  it("marks an expense paid for someone, and is silent for ordinary rows", () => {
    expect(classificationNote({ ...base, type: "expense", linkedPersonId: "p", owesPersonToggle: true }, { entryType: null, personName: "JOHN" })?.title).toBe("Paid for JOHN");
    expect(classificationNote(base, { entryType: null, personName: null })).toBeNull();
    expect(classificationNote({ ...base, type: "expense", linkedPersonId: "p", owesPersonToggle: false }, { entryType: null, personName: "JOHN" })).toBeNull();
  });
});
