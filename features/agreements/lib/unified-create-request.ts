/**
 * Pure form logic for the unified "Add Loan / Installment" wizard — validation, the explicit account
 * movement choice, and the exact `createAgreementWithOrigination` request. Mirrors Flutter's
 * `unified_create_request.dart`; no React/Firestore so it is unit-tested directly.
 */

import type { InterestType } from "@/lib/engines/interest-calculator";
import type { LoanFundingSource } from "@/lib/models/loan";
import type { CreateAgreementWithOriginationParams } from "@/lib/repositories/loan-repository";

export type UnifiedCreateKind = "borrowed" | "lent" | "installmentPurchase";
export type UnifiedRepayment = "scheduled" | "oneTime";

export interface UnifiedCreateForm {
  kind: UnifiedCreateKind | null;
  funding: LoanFundingSource;
  name: string;
  provider: string;
  personId: string;
  amount: string;
  downPayment: string;
  repayment: UnifiedRepayment;
  count: string;
  /** yyyy-mm-dd, one-time repayment only. */
  dueDate: string;
  rate: string;
  interestType: InterestType;
  cardId: string;
  purchaseId: string;
  /** The explicit opt-in — selecting an account alone never moves money. */
  recordMovement: boolean;
  movementAccountId: string;
}

export const EMPTY_UNIFIED_CREATE_FORM: UnifiedCreateForm = {
  kind: null,
  funding: "bank",
  name: "",
  provider: "",
  personId: "",
  amount: "",
  downPayment: "0",
  repayment: "scheduled",
  count: "12",
  dueDate: "",
  rate: "",
  interestType: "reducingBalance",
  cardId: "",
  purchaseId: "",
  recordMovement: false,
  movementAccountId: "",
};

/** The checkbox label for the account movement, or null when this agreement has none to record. */
export function movementChoiceLabel(form: Pick<UnifiedCreateForm, "kind" | "downPayment">): string | null {
  switch (form.kind) {
    case "borrowed":
      return "Record money received in an account";
    case "lent":
      return "Record money sent from an account";
    case "installmentPurchase":
      return (Number(form.downPayment) || 0) > 0 ? "Record down payment from an account" : null;
    default:
      return null;
  }
}

export interface UnifiedCreateFigures {
  purchase: number;
  down: number;
  principal: number;
  /** True only when the user opted in AND this agreement has a movement to record. */
  movesMoney: boolean;
  movementAmount: number;
  /** +received / −paid, as the Account will see it. */
  movementDelta: number;
}

export function unifiedCreateFigures(form: UnifiedCreateForm): UnifiedCreateFigures {
  const purchase = Number(form.amount) || 0;
  const down = form.kind === "installmentPurchase" ? Number(form.downPayment) || 0 : 0;
  const principal = purchase - down;
  const movesMoney = form.recordMovement && movementChoiceLabel(form) != null;
  const movementAmount = !movesMoney ? 0 : form.kind === "installmentPurchase" ? down : principal;
  const movementDelta = form.kind === "borrowed" ? movementAmount : -movementAmount;
  return { purchase, down, principal, movesMoney, movementAmount, movementDelta };
}

function parseDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Why the terms step can't continue yet, or null when it can. */
export function unifiedCreateError(form: UnifiedCreateForm): string | null {
  const { purchase, down, principal, movesMoney } = unifiedCreateFigures(form);
  if (form.kind == null) return "Choose what you are adding";
  if (form.name.trim() === "") return form.kind === "installmentPurchase" ? "Enter what you bought" : "Enter a name";
  if (!(purchase > 0)) return "Enter an amount";
  if (down < 0 || down > purchase) return "Down payment must be between 0 and the purchase amount";
  if (!(principal > 0)) return "Nothing is left to finance";
  if (form.funding === "person" && form.personId === "") return "Choose a person";
  if (form.funding === "creditCard" && form.cardId === "") return "Choose a credit card";
  const oneTime = form.kind !== "installmentPurchase" && form.repayment === "oneTime";
  if (oneTime && parseDate(form.dueDate) == null) return "Choose when it will be repaid";
  if (!oneTime && !(Number(form.count) >= 1 && Number.isInteger(Number(form.count)))) return "Enter the number of payments";
  if (form.rate.trim() !== "" && !(Number(form.rate) >= 0)) return "Interest rate cannot be negative";
  if (movesMoney && form.movementAccountId === "") return "Choose the account";
  return null;
}

export function buildUnifiedCreateRequest(
  form: UnifiedCreateForm,
  idempotencyKey: string,
  today: Date,
): CreateAgreementWithOriginationParams {
  const error = unifiedCreateError(form);
  if (error != null) throw new Error(error);
  const { purchase, down, principal, movesMoney } = unifiedCreateFigures(form);
  const kind = form.kind!;
  const personal = form.funding === "person";
  const oneTime = kind !== "installmentPurchase" && form.repayment === "oneTime";
  const purchasePlan = kind === "installmentPurchase";
  return {
    idempotencyKey,
    name: form.name.trim(),
    category: personal ? "personal" : "institutional",
    personId: personal ? form.personId : null,
    institutionName: personal ? null : form.provider.trim() || fundingLabel(form.funding),
    direction: kind === "lent" ? "given" : "taken",
    loanAmount: principal,
    loanDate: today,
    repaymentType: oneTime ? "oneTime" : "installment",
    dueDate: oneTime ? parseDate(form.dueDate) : null,
    installmentFrequency: oneTime ? null : "monthly",
    installmentCount: oneTime ? null : Number(form.count),
    interest: form.rate.trim() === "" ? null : { type: form.interestType, ratePercent: Number(form.rate), period: "yearly" },
    notes: "",
    agreementKind: purchasePlan ? "installmentPurchase" : "loan",
    fundingSource: form.funding,
    linkedCreditCardId: form.funding === "creditCard" ? form.cardId : null,
    purchaseTransactionId: form.funding === "creditCard" && form.purchaseId !== "" ? form.purchaseId : null,
    purchaseAmount: purchasePlan ? purchase : null,
    downPayment: purchasePlan ? down : null,
    movementAccountId: movesMoney ? form.movementAccountId : null,
  };
}

export function fundingLabel(value: LoanFundingSource): string {
  switch (value) {
    case "bank":
      return "Bank";
    case "financeCompany":
      return "Finance Company";
    case "creditCard":
      return "Credit Card";
    case "person":
      return "Person";
    default:
      return "Other";
  }
}
