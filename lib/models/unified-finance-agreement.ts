import { emiPurchaseRepresentedOnCard } from "@/lib/engines/credit-utilization";
import type { Emi } from "@/lib/models/emi";
import type { Loan } from "@/lib/models/loan";
import type { Installment, ScheduleType } from "@/lib/models/payment-schedule";
import { installmentStatus } from "@/lib/models/payment-schedule";

export type UnifiedAgreementSourceType = "loan" | "emi";
export type UnifiedAgreementKind = "loan" | "installmentPurchase";
export type UnifiedAgreementDirection = "borrowed" | "lent";
export type UnifiedRepaymentType = "scheduled" | "oneTime" | "flexible";
export type UnifiedFundingSource = "bank" | "financeCompany" | "creditCard" | "person" | "other";
export type UnifiedAgreementStatus = "active" | "dueSoon" | "overdue" | "defaulted" | "closed";

/** Presentation-only contract. None of these fields is persisted by this adapter. */
export interface UnifiedFinanceAgreement {
  sourceType: UnifiedAgreementSourceType;
  sourceId: string;
  agreementKind: UnifiedAgreementKind;
  direction: UnifiedAgreementDirection;
  repaymentType: UnifiedRepaymentType;
  fundingSource: UnifiedFundingSource;
  personId: string | null;
  creditCardId: string | null;
  purchaseTransactionId: string | null;
  linkedAccountId: string | null;
  accountReference: string | null;
  title: string;
  providerName: string | null;
  purchaseAmount: number | null;
  downPayment: number | null;
  originalPrincipal: number;
  remainingPrincipal: number;
  liabilityPrincipal: number;
  receivablePrincipal: number;
  cardOwnedLiability: number;
  nonCardEmiLiability: number;
  paidPrincipal: number;
  paidInterest: number;
  futureInterest: number;
  interestRate: number | null;
  interestType: string | null;
  repaymentFrequency: ScheduleType | null;
  installmentCount: number | null;
  installmentAmount: number | null;
  nextDueDate: Date | null;
  status: UnifiedAgreementStatus;
  sourceStatus: string;
  scheduleId: string;
  createdAt: Date;
}

export interface CardOwnershipContext {
  cardAccountId: string;
  purchase: Parameters<typeof emiPurchaseRepresentedOnCard>[1];
}

function moneyState(installments: Installment[]) {
  let originalPrincipal = 0;
  let remainingPrincipal = 0;
  let paidInterest = 0;
  let futureInterest = 0;
  for (const installment of installments.filter((item) => item.deletedAt == null)) {
    const interest = installment.interestPortion ?? 0;
    const principal = installment.principalPortion ?? Math.max(installment.amountDue - interest, 0);
    const interestPaid = Math.min(Math.max(installment.amountPaid, 0), interest);
    const principalPaid = Math.min(Math.max(installment.amountPaid - interest, 0), principal);
    originalPrincipal += principal;
    remainingPrincipal += principal - principalPaid;
    paidInterest += interestPaid;
    futureInterest += interest - interestPaid;
  }
  return {
    originalPrincipal,
    remainingPrincipal: Math.max(remainingPrincipal, 0),
    paidPrincipal: Math.max(originalPrincipal - remainingPrincipal, 0),
    paidInterest,
    futureInterest,
  };
}

function dueState(installments: Installment[], now: Date) {
  const live = installments.filter((item) => item.deletedAt == null && !item.isSkipped);
  const unpaid = live.filter((item) => item.amountPaid < item.amountDue).sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  const nextDueDate = unpaid[0]?.dueDate ?? null;
  const overdue = live.some((item) => installmentStatus(item, now) === "overdue");
  const dueSoon = nextDueDate != null && nextDueDate.getTime() >= now.getTime() && nextDueDate.getTime() <= now.getTime() + 7 * 86_400_000;
  return { nextDueDate, overdue, dueSoon, installmentAmount: unpaid[0]?.amountDue ?? live[0]?.amountDue ?? null };
}

export function loanToUnifiedAgreement(
  loan: Loan,
  installments: Installment[],
  ownershipOrNow: CardOwnershipContext | Date | null = null,
  nowArg = new Date(),
): UnifiedFinanceAgreement {
  const ownership = ownershipOrNow instanceof Date ? null : ownershipOrNow;
  const now = ownershipOrNow instanceof Date ? ownershipOrNow : nowArg;
  const money = moneyState(installments);
  const due = dueState(installments, now);
  const remainingPrincipal = installments.length === 0 ? loan.loanAmount : money.remainingPrincipal;
  const status: UnifiedAgreementStatus = loan.isClosed ? "closed" : due.overdue ? "overdue" : due.dueSoon ? "dueSoon" : "active";
  const borrowed = loan.direction === "taken";
  const agreementKind = loan.agreementKind ?? "loan";
  const fundingSource = loan.fundingSource ?? (loan.category === "personal" ? "person" : loan.institutionName ? "bank" : "other");
  const purchaseRepresented =
    fundingSource === "creditCard" &&
    ownership != null &&
    emiPurchaseRepresentedOnCard(loan.purchaseTransactionId ?? null, ownership.purchase, ownership.cardAccountId);
  const cardOwnedLiability =
    borrowed && fundingSource === "creditCard" && !purchaseRepresented && !loan.isClosed ? remainingPrincipal : 0;
  const ordinaryLiability =
    borrowed && fundingSource !== "creditCard" && !loan.isClosed ? remainingPrincipal : 0;
  return {
    sourceType: "loan", sourceId: loan.id, agreementKind,
    direction: borrowed ? "borrowed" : "lent",
    repaymentType: loan.repaymentType === "oneTime" ? "oneTime" : "scheduled",
    fundingSource,
    personId: loan.personId, creditCardId: loan.linkedCreditCardId ?? null, purchaseTransactionId: loan.purchaseTransactionId ?? null,
    linkedAccountId: null, accountReference: loan.accountNumber ?? null,
    title: loan.name ?? loan.institutionName ?? "Loan", providerName: loan.institutionName ?? null,
    purchaseAmount: loan.purchaseAmount ?? null, downPayment: loan.downPayment ?? null, originalPrincipal: loan.loanAmount, remainingPrincipal,
    liabilityPrincipal: ordinaryLiability + cardOwnedLiability,
    receivablePrincipal: !borrowed && !loan.isClosed ? remainingPrincipal : 0,
    cardOwnedLiability, nonCardEmiLiability: agreementKind === "installmentPurchase" && fundingSource !== "creditCard" ? ordinaryLiability : 0,
    paidPrincipal: installments.length === 0 ? 0 : money.paidPrincipal,
    paidInterest: money.paidInterest, futureInterest: money.futureInterest,
    interestRate: loan.interest?.ratePercent ?? null, interestType: loan.interest?.type ?? null,
    repaymentFrequency: loan.installmentFrequency, installmentCount: loan.installmentCount,
    installmentAmount: due.installmentAmount, nextDueDate: loan.repaymentType === "oneTime" ? loan.dueDate : due.nextDueDate,
    status, sourceStatus: loan.isClosed ? "closed" : due.overdue ? "overdue" : "active",
    scheduleId: loan.scheduleId, createdAt: loan.createdAt,
  };
}

export function emiToUnifiedAgreement(emi: Emi, installments: Installment[], ownership: CardOwnershipContext | null, now = new Date()): UnifiedFinanceAgreement {
  const money = moneyState(installments);
  const due = dueState(installments, now);
  const remainingPrincipal = installments.length === 0 ? emi.principalAmount : money.remainingPrincipal;
  const purchaseRepresented = ownership != null && emiPurchaseRepresentedOnCard(emi.purchaseTransactionId, ownership.purchase, ownership.cardAccountId);
  const cardOwnedLiability = emi.linkedCreditCardId != null && !purchaseRepresented && !emi.isClosed ? remainingPrincipal : 0;
  const nonCardEmiLiability = emi.linkedCreditCardId == null && !emi.isClosed ? remainingPrincipal : 0;
  const status: UnifiedAgreementStatus = emi.isClosed ? "closed" : emi.isDefaulted ? "defaulted" : due.overdue ? "overdue" : due.dueSoon ? "dueSoon" : "active";
  return {
    sourceType: "emi", sourceId: emi.id, agreementKind: "installmentPurchase", direction: "borrowed", repaymentType: "scheduled",
    fundingSource: emi.linkedCreditCardId ? "creditCard" : emi.lenderName ? "financeCompany" : "other",
    personId: null, creditCardId: emi.linkedCreditCardId, purchaseTransactionId: emi.purchaseTransactionId,
    linkedAccountId: null, accountReference: emi.autoDebitAccount,
    title: emi.name, providerName: emi.lenderName,
    purchaseAmount: null, downPayment: null, originalPrincipal: emi.principalAmount, remainingPrincipal,
    liabilityPrincipal: cardOwnedLiability + nonCardEmiLiability, receivablePrincipal: 0,
    cardOwnedLiability, nonCardEmiLiability,
    paidPrincipal: installments.length === 0 ? 0 : money.paidPrincipal,
    paidInterest: money.paidInterest, futureInterest: money.futureInterest,
    interestRate: emi.interest?.ratePercent ?? null, interestType: emi.interest?.type ?? null,
    repaymentFrequency: emi.installmentFrequency, installmentCount: emi.installmentCount,
    installmentAmount: due.installmentAmount, nextDueDate: due.nextDueDate,
    status, sourceStatus: emi.isClosed ? "closed" : emi.isDefaulted ? "defaulted" : due.overdue ? "overdue" : "active",
    scheduleId: emi.scheduleId, createdAt: emi.createdAt,
  };
}

export function sortUnifiedAgreements(agreements: UnifiedFinanceAgreement[]): UnifiedFinanceAgreement[] {
  return [...agreements].sort((a, b) => {
    const aDate = a.nextDueDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bDate = b.nextDueDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return aDate - bDate || a.sourceType.localeCompare(b.sourceType) || a.sourceId.localeCompare(b.sourceId);
  });
}
