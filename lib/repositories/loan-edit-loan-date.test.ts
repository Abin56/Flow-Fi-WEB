import { describe, expect, it, vi } from "vitest";
import type { CollectionReference } from "firebase/firestore";
import type { Loan } from "@/lib/models/loan";
import type { Installment } from "@/lib/models/payment-schedule";
import { LoanRepository } from "./loan-repository";
import type { InstallmentRepository, PaymentScheduleRepository } from "./payment-schedule-repository";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

/**
 * `editLoanDate` returned before its old schedule-regeneration block, so that block never ran. Removing
 * it must leave behavior identical: only the Loan's `loanDate` (+ edit history) is written; the schedule
 * and its installments are never touched.
 */
function repo() {
  const scheduleRepo = { getByKey: vi.fn(), editSchedule: vi.fn() };
  const installmentRepo = { softDelete: vi.fn(), generateInstallments: vi.fn() };
  const installmentRepositoryFor = vi.fn(() => installmentRepo as unknown as InstallmentRepository);
  const repository = new LoanRepository(
    {} as unknown as CollectionReference<Loan>,
    scheduleRepo as unknown as PaymentScheduleRepository,
    installmentRepositoryFor,
  );
  const update = vi.spyOn(repository, "update").mockResolvedValue(undefined);
  return { repository, update, scheduleRepo, installmentRepo, installmentRepositoryFor };
}

const baseLoan = {
  id: "loan-1",
  scheduleId: "sched-1",
  repaymentType: "installment",
  loanDate: new Date(2026, 0, 10),
  loanAmount: 100000,
  installmentCount: 12,
  installmentFrequency: "monthly",
  interest: { type: "flat", ratePercent: 10, period: "yearly" },
  editHistory: [],
} as unknown as Loan;

const installments = [{ id: "i1", dueDate: new Date(2026, 1, 10) }] as unknown as Installment[];

describe("LoanRepository.editLoanDate (dead-code removal is behavior-neutral)", () => {
  it("writes only the new loanDate; never touches schedule or installments", async () => {
    const { repository, update, scheduleRepo, installmentRepo, installmentRepositoryFor } = repo();
    const newDate = new Date(2026, 0, 20);
    const result = await repository.editLoanDate(baseLoan, { newLoanDate: newDate, hasPayments: false, currentInstallments: installments });

    expect(result.loanDate).toBe(newDate);
    expect(result.loanAmount).toBe(100000);
    expect(result.interest).toEqual(baseLoan.interest);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].loanDate).toBe(newDate);
    expect(installmentRepositoryFor).not.toHaveBeenCalled();
    expect(installmentRepo.softDelete).not.toHaveBeenCalled();
    expect(installmentRepo.generateInstallments).not.toHaveBeenCalled();
    expect(scheduleRepo.getByKey).not.toHaveBeenCalled();
    expect(scheduleRepo.editSchedule).not.toHaveBeenCalled();
  });

  it("still rejects one-time loans and loans with payments", async () => {
    const { repository, update } = repo();
    const params = { newLoanDate: new Date(2026, 0, 20), hasPayments: false, currentInstallments: installments };
    await expect(repository.editLoanDate({ ...baseLoan, repaymentType: "oneTime" } as Loan, params)).rejects.toThrow(/Only installment loans/);
    await expect(repository.editLoanDate(baseLoan, { ...params, hasPayments: true })).rejects.toThrow(/after a payment/);
    expect(update).not.toHaveBeenCalled();
  });
});
