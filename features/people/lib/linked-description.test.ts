import { describe, expect, it } from "vitest";
import { userNote, withLinkedDescriptions } from "./linked-description";

const RAW = "UPI/627632125367/DR/Jio Pr/YESB/paytm-jio/UPI";
const APPROVED = "Jio Mobile Recharge · UPI";

describe("userNote", () => {
  it("never returns the bank narration or the import marker", () => {
    expect(userNote(`Bank narration: ${RAW} · Imported via Reconciliation (Smart Capture)`)).toBeNull();
    expect(userNote("Imported via Reconciliation (Smart Capture)")).toBeNull();
    expect(userNote("Imported via Smart Capture")).toBeNull();
  });
  it("keeps what the user typed, including their own separators", () => {
    expect(userNote(`ask next week · Bank narration: ${RAW} · Imported via Reconciliation (Smart Capture)`)).toBe("ask next week");
    expect(userNote("rent · October")).toBe("rent · October");
    expect(userNote("")).toBeNull();
    expect(userNote(undefined)).toBeNull();
  });
});

type Entry = Parameters<typeof withLinkedDescriptions>[0][number];
const share = (over: Partial<Entry> = {}): Entry => ({ type: "gave", sourceKind: "assignedExpense", paymentId: null, note: `Split: ${RAW}`, transactionRef: "t1", ...over });
const txn = (over: Record<string, unknown> = {}) => new Map([["t1", { id: "t1", description: APPROVED, deletedAt: null, type: "expense" as const, isPersonLedgerMovement: false, ...over }]]);

describe("withLinkedDescriptions", () => {
  it("titles a stale share with the transaction's description without touching the stored entry", () => {
    for (const sourceKind of ["assignedExpense", "splitExpense"] as const) {
      const stored = share({ sourceKind });
      const [shown] = withLinkedDescriptions([stored], txn());
      expect(shown.note).toBe(`Split: ${APPROVED}`);
      expect(stored.note).toBe(`Split: ${RAW}`);
    }
  });
  it("returns the same array when nothing differs", () => {
    const entries = [share({ note: `Split: ${APPROVED}` })];
    expect(withLinkedDescriptions(entries, txn())).toBe(entries);
  });
  it.each<[string, Partial<Entry>, Record<string, unknown>]>([
    ["a note typed on the People side", { note: "Mum's recharge" }, {}],
    ["a payment entry", { paymentId: "p1" }, {}],
    ["a settlement", { type: "receivedBack" }, {}],
    ["a manual entry", { sourceKind: "manual" }, {}],
    ["a missing transaction", { transactionRef: "other" }, {}],
    ["a deleted transaction", {}, { deletedAt: new Date() }],
    ["a person cash leg", {}, { isPersonLedgerMovement: true }],
    ["a blank description", {}, { description: "  " }],
  ])("leaves %s as stored", (_name, entry, over) => {
    const entries = [share(entry)];
    expect(withLinkedDescriptions(entries, txn(over))).toBe(entries);
  });
});

describe("an expense a person paid for me", () => {
  const funded = (over: Partial<Entry> = {}): Entry => ({ type: "borrowed", sourceKind: "personFundedExpense", paymentId: null, note: RAW, transactionRef: "t1", personId: "p1", editHistory: [], ...over });
  it("an untouched copy follows the description", () => {
    expect(withLinkedDescriptions([funded()], txn({ fundedByPersonId: "p1" }))[0].note).toBe(APPROVED);
  });
  it.each<[string, Partial<Entry>, Record<string, unknown>]>([
    ["a note with a recorded change", { editHistory: [{ timestamp: new Date(), field: "note", oldValue: "a", newValue: RAW }] }, { fundedByPersonId: "p1" }],
    ["an entry whose history is unknown", { editHistory: undefined }, { fundedByPersonId: "p1" }],
    ["another person's funding", {}, { fundedByPersonId: "p2" }],
    ["a blank description", {}, { fundedByPersonId: "p1", description: " " }],
  ])("leaves %s as stored", (_name, entry, over) => {
    const entries = [funded(entry)];
    expect(withLinkedDescriptions(entries, txn(over))).toBe(entries);
  });
});
