import { describe, expect, it } from "vitest";
import { compareLedgerEntriesNewestFirst, type LedgerEntry } from "./person";

function ledgerEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: "e1",
    personId: "person-1",
    type: "gave",
    amount: 100,
    date: new Date("2026-07-15T00:00:00Z"),
    note: "",
    increasesBalance: true,
    transactionRef: null,
    parentEntryId: null,
    createdAt: new Date("2026-07-15T00:00:00Z"),
    receivedStatus: "yetToReceive",
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

describe("compareLedgerEntriesNewestFirst", () => {
  it("sorts by date descending when dates differ", () => {
    const older = ledgerEntry({ id: "older", date: new Date("2026-07-01T00:00:00Z") });
    const newer = ledgerEntry({ id: "newer", date: new Date("2026-07-15T00:00:00Z") });
    expect([older, newer].sort(compareLedgerEntriesNewestFirst).map((e) => e.id)).toEqual(["newer", "older"]);
  });

  it("on the same date, breaks ties by most-recently-created (e.g. a 'gave' entry and its same-day 'receivedBack' settlement)", () => {
    const gave = ledgerEntry({
      id: "gave",
      type: "gave",
      date: new Date("2026-08-01T00:00:00Z"),
      createdAt: new Date("2026-08-01T09:00:00Z"),
    });
    const receivedBack = ledgerEntry({
      id: "receivedBack",
      type: "receivedBack",
      date: new Date("2026-08-01T00:00:00Z"),
      createdAt: new Date("2026-08-01T09:05:00Z"),
    });
    expect([gave, receivedBack].sort(compareLedgerEntriesNewestFirst).map((e) => e.id)).toEqual([
      "receivedBack",
      "gave",
    ]);
  });

  it("date always wins over createdAt recency", () => {
    const olderDateJustCreated = ledgerEntry({
      id: "older-date",
      date: new Date("2026-07-01T00:00:00Z"),
      createdAt: new Date("2026-08-10T00:00:00Z"),
    });
    const newerDateCreatedEarlier = ledgerEntry({
      id: "newer-date",
      date: new Date("2026-08-01T00:00:00Z"),
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    expect(
      [olderDateJustCreated, newerDateCreatedEarlier].sort(compareLedgerEntriesNewestFirst).map((e) => e.id),
    ).toEqual(["newer-date", "older-date"]);
  });
});
