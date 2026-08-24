import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Emi } from "@/lib/models/emi";
import { EmiRepository } from "./emi-repository";
import type { InstallmentRepository, PaymentScheduleRepository } from "./payment-schedule-repository";

/**
 * Regression coverage for the EMI mutation-error-handling fix
 * (`emi-workspace.tsx`'s `handleCreate`/`handleDelete`/`handleRecordPayment`/
 * `handleClose` now `catch` and toast instead of `try/finally`-without-`catch`
 * or no error handling at all). Proves the repository calls those handlers
 * wrap actually reject on failure — both synchronous validation errors and a
 * genuine Firestore write/batch failure — rather than being silently
 * absorbed.
 */
vi.mock("firebase/firestore", () => ({
  doc: vi.fn((parent: unknown, ...segments: string[]) => ({ id: segments[segments.length - 1] ?? "doc", parent })),
  collection: vi.fn((parent: unknown, ...segments: string[]) => ({ id: segments.join("/"), parent, firestore: {} })),
  getDoc: vi.fn(),
  getDocs: vi.fn().mockResolvedValue({ docs: [] }),
  query: vi.fn((...args: unknown[]) => ({ args })),
  where: vi.fn((...args: unknown[]) => ({ args })),
  setDoc: vi.fn(),
  writeBatch: vi.fn(() => ({ delete: vi.fn(), commit: vi.fn().mockRejectedValue(new Error("Firestore unavailable")) })),
}));

import { getDocs, setDoc, writeBatch } from "firebase/firestore";

function emi(overrides: Partial<Emi> = {}): Emi {
  return {
    id: "emi1",
    name: "Car Loan",
    lenderName: null,
    loanType: "vehicle",
    principalAmount: 100000,
    scheduleId: "sched1",
    interest: null,
    notes: "",
    loanNumber: null,
    categoryId: null,
    branch: null,
    customerId: null,
    sanctionDate: null,
    disbursementDate: null,
    processingFee: 0,
    insuranceAmount: 0,
    extraCharges: 0,
    foreclosureAmount: null,
    prepaymentCharges: null,
    isAutoDebitEnabled: false,
    autoDebitAccount: null,
    linkedCreditCardId: null,
    dueDayOfMonth: null,
    isClosed: false,
    isDefaulted: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  } as Emi;
}

function makeRepo(paymentScheduleRepositoryOverrides: Partial<PaymentScheduleRepository> = {}) {
  const paymentScheduleRepository = {
    createSchedule: vi.fn().mockResolvedValue({ id: "sched1" }),
    ...paymentScheduleRepositoryOverrides,
  } as unknown as PaymentScheduleRepository;
  const installmentRepositoryFor = vi.fn(
    () =>
      ({
        getAll: vi.fn().mockResolvedValue([]),
        getTrash: vi.fn().mockResolvedValue([]),
        generateInstallments: vi.fn().mockResolvedValue([{ id: "inst1", dueDate: new Date("2026-09-01T00:00:00Z") }]),
      }) as unknown as InstallmentRepository,
  );
  const collectionRef = { firestore: {}, parent: { id: "user1" } } as never;
  return new EmiRepository(collectionRef, paymentScheduleRepository, installmentRepositoryFor);
}

describe("EMI mutation validation errors reject (not silently no-op)", () => {
  it("createEmi rejects with a useful message when name is blank", async () => {
    const repo = makeRepo();
    await expect(
      repo.createEmi({
        name: "",
        principalAmount: 1000,
        startDate: new Date(),
        installmentFrequency: "monthly",
        installmentCount: 12,
      }),
    ).rejects.toThrow("EMI name is required");
  });

  it("createEmi rejects with a useful message when principal <= 0", async () => {
    const repo = makeRepo();
    await expect(
      repo.createEmi({
        name: "Car Loan",
        principalAmount: 0,
        startDate: new Date(),
        installmentFrequency: "monthly",
        installmentCount: 12,
      }),
    ).rejects.toThrow("Principal amount must be greater than 0");
  });
});

describe("EMI mutations propagate a genuine Firestore failure (not swallowed)", () => {
  beforeEach(() => {
    vi.mocked(setDoc).mockReset();
    vi.mocked(setDoc).mockRejectedValue(new Error("Firestore unavailable"));
    vi.mocked(getDocs).mockReset();
    vi.mocked(getDocs).mockResolvedValue({ docs: [] } as never);
  });

  it("createEmi propagates the failure", async () => {
    const repo = makeRepo();
    await expect(
      repo.createEmi({
        name: "Car Loan",
        principalAmount: 100000,
        startDate: new Date(),
        installmentFrequency: "monthly",
        installmentCount: 12,
      }),
    ).rejects.toThrow("Firestore unavailable");
  });

  it("closeEmi propagates the failure", async () => {
    const repo = makeRepo();
    await expect(repo.closeEmi(emi())).rejects.toThrow("Firestore unavailable");
  });

  it("permanentlyDeleteEmi (handleDelete's underlying call) propagates a batch-commit failure", async () => {
    const repo = makeRepo();
    await expect(repo.permanentlyDeleteEmi(emi())).rejects.toThrow("Firestore unavailable");
    expect(writeBatch).toHaveBeenCalled();
  });
});
