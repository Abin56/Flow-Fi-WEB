import { describe, expect, it, vi } from "vitest";
import { LoanRepository } from "./loan-repository";
import type { InstallmentRepository, PaymentScheduleRepository } from "./payment-schedule-repository";

/**
 * Regression coverage for the `direction`/`category` port from the Flutter
 * app's Loans feature — mirrors `emi-repository.error-propagation.test.ts`'s
 * mocking approach (a fake `PaymentScheduleRepository`/`InstallmentRepository`
 * pair, `firebase/firestore` mocked for the final `setDoc` write).
 */
vi.mock("firebase/firestore", () => ({
  doc: vi.fn((parent: unknown, ...segments: string[]) => ({ id: segments[segments.length - 1] ?? "doc", parent })),
  collection: vi.fn((parent: unknown, ...segments: string[]) => ({ id: segments.join("/"), parent, firestore: {} })),
  setDoc: vi.fn().mockResolvedValue(undefined),
}));

function makeRepo() {
  const paymentScheduleRepository = {
    createSchedule: vi.fn().mockResolvedValue({ id: "sched1" }),
  } as unknown as PaymentScheduleRepository;
  const installmentRepositoryFor = vi.fn(
    () =>
      ({
        generateInstallments: vi.fn().mockResolvedValue([{ id: "inst1", dueDate: new Date("2026-09-01T00:00:00Z") }]),
      }) as unknown as InstallmentRepository,
  );
  const collectionRef = { firestore: {}, parent: { id: "user1" } } as never;
  return new LoanRepository(collectionRef, paymentScheduleRepository, installmentRepositoryFor);
}

describe("LoanRepository.createLoan — category validation", () => {
  it("personal category without personId throws", async () => {
    const repository = makeRepo();
    await expect(
      repository.createLoan({
        category: "personal",
        loanAmount: 100,
        loanDate: new Date("2026-01-01T00:00:00Z"),
        repaymentType: "oneTime",
        dueDate: new Date("2026-02-01T00:00:00Z"),
      }),
    ).rejects.toThrow();
  });

  it("institutional category without institutionName throws", async () => {
    const repository = makeRepo();
    await expect(
      repository.createLoan({
        category: "institutional",
        loanAmount: 100,
        loanDate: new Date("2026-01-01T00:00:00Z"),
        repaymentType: "oneTime",
        dueDate: new Date("2026-02-01T00:00:00Z"),
      }),
    ).rejects.toThrow();
  });

  it("institutional loan persists with personId null and institution fields set, ignoring any personId passed", async () => {
    const repository = makeRepo();
    const loan = await repository.createLoan({
      category: "institutional",
      personId: "p1", // must be ignored — an institutional loan is never person-linked
      institutionName: "HDFC Bank",
      loanType: "Home Loan",
      loanNumber: "HL-1",
      accountNumber: "AC-1",
      branch: "MG Road",
      loanAmount: 500000,
      loanDate: new Date("2026-01-01T00:00:00Z"),
      repaymentType: "oneTime",
      dueDate: new Date("2026-02-01T00:00:00Z"),
    });

    expect(loan.personId).toBeNull();
    expect(loan.category).toBe("institutional");
    expect(loan.institutionName).toBe("HDFC Bank");
    expect(loan.loanType).toBe("Home Loan");
    expect(loan.loanNumber).toBe("HL-1");
    expect(loan.accountNumber).toBe("AC-1");
    expect(loan.branch).toBe("MG Road");
  });

  it("omitting category/direction defaults to institutional/taken — the web repository's own default, distinct from Flutter's personal/given default", async () => {
    const repository = makeRepo();
    const loan = await repository.createLoan({
      institutionName: "HDFC Bank",
      loanAmount: 100,
      loanDate: new Date("2026-01-01T00:00:00Z"),
      repaymentType: "oneTime",
      dueDate: new Date("2026-02-01T00:00:00Z"),
    });

    expect(loan.category).toBe("institutional");
    expect(loan.direction).toBe("taken");
    expect(loan.personId).toBeNull();
  });

  it("an explicit personal loan persists with its personId and no institution fields", async () => {
    const repository = makeRepo();
    const loan = await repository.createLoan({
      category: "personal",
      personId: "p1",
      loanAmount: 100,
      loanDate: new Date("2026-01-01T00:00:00Z"),
      repaymentType: "oneTime",
      dueDate: new Date("2026-02-01T00:00:00Z"),
    });

    expect(loan.category).toBe("personal");
    expect(loan.personId).toBe("p1");
    expect(loan.institutionName).toBeNull();
  });
});
