import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bill, BillOccurrence } from "@/lib/models/bill";
import { BillOccurrenceRepository, BillRepository } from "./bill-repository";

/**
 * Regression coverage for the Bills mutation-error-handling fix
 * (`bills-workspace.tsx`'s `handleSave`/`handleDelete`/`handleMarkPaid`/
 * `handleSkip` now `catch` and toast instead of silently swallowing via
 * `try/finally`). Those catch blocks are only as good as the repository
 * calls they wrap actually rejecting on failure — this proves that both
 * synchronous validation errors and a genuine Firestore write failure
 * propagate as a rejected promise from every mutation the UI now handles,
 * rather than being silently absorbed somewhere in the repository layer.
 */
vi.mock("firebase/firestore", () => ({
  doc: vi.fn((_collection: unknown, id: string) => ({ id })),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  query: vi.fn((...args: unknown[]) => ({ args })),
  where: vi.fn((...args: unknown[]) => ({ args })),
  setDoc: vi.fn(),
  updateDoc: vi.fn(),
}));

import { setDoc } from "firebase/firestore";

function bill(overrides: Partial<Bill> = {}): Bill {
  return {
    id: "b1",
    name: "Electricity",
    amount: 1500,
    nextDueDate: new Date("2026-09-01T00:00:00Z"),
    recurrence: "monthly",
    accountId: null,
    categoryId: null,
    customIntervalDays: null,
    reminderOffsets: [],
    notes: "",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

function occurrence(overrides: Partial<BillOccurrence> = {}): BillOccurrence {
  return {
    id: "occ1",
    billId: "b1",
    dueDate: new Date("2026-09-01T00:00:00Z"),
    amount: 1500,
    amountPaid: 0,
    isSkipped: false,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

describe("Bill mutation validation errors reject (not silently no-op)", () => {
  it("createBill rejects with a useful message when amount <= 0", async () => {
    const repo = new BillRepository({ firestore: {} } as never);
    await expect(
      repo.createBill({ name: "Rent", amount: 0, dueDate: new Date(), recurrence: "monthly" }),
    ).rejects.toThrow("Bill amount must be greater than 0");
  });

  it("createBill rejects when recurrence is custom but no interval is given", async () => {
    const repo = new BillRepository({ firestore: {} } as never);
    await expect(
      repo.createBill({ name: "Rent", amount: 100, dueDate: new Date(), recurrence: "custom" }),
    ).rejects.toThrow("Custom recurrence needs a repeat interval greater than 0 days");
  });

  it("editBill rejects with a useful message when amount <= 0", async () => {
    const repo = new BillRepository({ firestore: {} } as never);
    await expect(repo.editBill(bill(), { amount: -5 })).rejects.toThrow("Bill amount must be greater than 0");
  });
});

describe("Bill mutations propagate a genuine Firestore write failure (not swallowed)", () => {
  beforeEach(() => {
    vi.mocked(setDoc).mockReset();
    vi.mocked(setDoc).mockRejectedValue(new Error("Firestore unavailable"));
  });

  it("createBill propagates the failure", async () => {
    const repo = new BillRepository({ firestore: {} } as never);
    await expect(
      repo.createBill({ name: "Rent", amount: 100, dueDate: new Date(), recurrence: "monthly" }),
    ).rejects.toThrow("Firestore unavailable");
  });

  it("editBill propagates the failure", async () => {
    const repo = new BillRepository({ firestore: {} } as never);
    await expect(repo.editBill(bill(), { name: "New name" })).rejects.toThrow("Firestore unavailable");
  });

  it("deleteBill (softDelete) propagates the failure", async () => {
    const repo = new BillRepository({ firestore: {} } as never);
    await expect(repo.softDelete(bill())).rejects.toThrow("Firestore unavailable");
  });

  it("markPaid propagates the failure", async () => {
    const billRepo = new BillRepository({ firestore: {} } as never);
    const occRepo = new BillOccurrenceRepository(
      { firestore: {} } as never,
      billRepo,
      {} as never,
      {} as never,
    );
    await expect(occRepo.markPaid(occurrence())).rejects.toThrow("Firestore unavailable");
  });

  it("skipOccurrence propagates the failure", async () => {
    const billRepo = new BillRepository({ firestore: {} } as never);
    const occRepo = new BillOccurrenceRepository(
      { firestore: {} } as never,
      billRepo,
      {} as never,
      {} as never,
    );
    await expect(occRepo.skipOccurrence(occurrence())).rejects.toThrow("Firestore unavailable");
  });
});
