/**
 * The single Loan & EMI "Add" form — pure logic only (no React, no Firestore), so the mapping from the
 * user's answers to the existing create paths is unit-tested directly.
 *
 * The user answers "What is this?" and the form maps it onto an operation that already exists:
 *
 *   Borrowed Money  → `useLoanActions().createLoan`  direction "taken", category institutional | personal
 *   Money I Lent    → `useLoanActions().createLoan`  direction "given", category personal
 *   Purchase        → `useEmiActions().createEmi`    no card link
 *   Credit Card     → `useEmiActions().createEmi`    `linkedCreditCardId` + loanType "creditCard"
 *                     (the EMI's unpaid principal keeps locking the card's available credit)
 *
 * A Loan with an account chosen still goes through `createLoan`'s `movementAccountId` branch
 * (`createAgreementWithOrigination`): the account balance moves, the principal never counts as income.
 *
 * Nothing new is persisted: the request builders below emit exactly the params the old separate
 * Add Loan / Add EMI forms sent.
 */

import type { CreateLoanFormParams } from "@/features/loans/hooks/use-loans-data";
import type { InterestType } from "@/lib/engines/interest-calculator";
import type { Emi, EmiLoanType } from "@/lib/models/emi";
import type { Loan, LoanCategory } from "@/lib/models/loan";
import type { ScheduleType } from "@/lib/models/payment-schedule";
import type { CreateEmiParams } from "@/lib/repositories/emi-repository";

export type AddKind = "borrowed" | "purchase" | "creditCard" | "lent";
/** How a card-linked EMI came about — only changes wording; both lock the principal against the card. */
export type CardEmiKind = "productPurchase" | "creditCardLoan";
export type OwnershipChoice = "me" | "someoneElse";

export interface LoanEmiAddForm {
  kind: AddKind | null;
  /** Borrowed Money only — Bank / Lender vs Person. */
  borrowedFrom: LoanCategory;
  /** Bank / lender name (borrowed from a bank). */
  lenderName: string;
  /** The Person lent to / borrowed from. */
  personId: string;
  /** Loan name (optional) or what was bought (required for Purchase / Credit Card). */
  name: string;
  amount: string;
  /** yyyy-mm-dd — the loan date for Loans, the first EMI date for EMIs (each path's existing meaning). */
  date: string;
  firstEmiDate: string;
  frequency: ScheduleType;
  count: string;
  hasInterest: boolean;
  ratePercent: string;
  interestType: InterestType;
  /** Purchase only — store / finance provider (EMI `lenderName`). */
  provider: string;
  /** Purchase only — EMI type chip. */
  emiType: EmiLoanType;
  cardId: string;
  cardEmiKind: CardEmiKind;
  /** Borrowed / Lent only — "Where did the money go / come from?". */
  useAccount: boolean;
  accountId: string;
  ownership: OwnershipChoice;
  beneficiaryPersonId: string;
  /** Borrowed only — someone else who pays the installments. */
  payerPersonId: string;
  /** Bank borrowing only — reference fields. */
  loanType: string;
  loanNumber: string;
  accountNumber: string;
  branch: string;
  notes: string;
  /** One per Add action, so a retried account-linked save can't post the movement twice. */
  idempotencyKey: string;
}

export function emptyLoanEmiAddForm(kind: AddKind | null = null, idempotencyKey = ""): LoanEmiAddForm {
  return {
    kind,
    borrowedFrom: "institutional",
    lenderName: "",
    personId: "",
    name: "",
    amount: "",
    date: toDateInput(new Date()),
    firstEmiDate: toDateInput(new Date()),
    frequency: "monthly",
    count: "12",
    hasInterest: false,
    ratePercent: "",
    interestType: "reducingBalance",
    provider: "",
    emiType: "other",
    cardId: "",
    cardEmiKind: "productPurchase",
    useAccount: false,
    accountId: "",
    ownership: "me",
    beneficiaryPersonId: "",
    payerPersonId: "",
    loanType: "",
    loanNumber: "",
    accountNumber: "",
    branch: "",
    notes: "",
    idempotencyKey,
  };
}

export function toDateInput(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Which backend operation a kind maps to. */
export function createPathFor(kind: AddKind): "loan" | "emi" {
  return kind === "borrowed" || kind === "lent" ? "loan" : "emi";
}

/** Which form sections apply — the progressive-disclosure rules in one place. */
export interface AddSections {
  details: boolean;
  repayment: boolean;
  /** "First EMI date" lives in Repayment for EMIs; Loans keep their loan date in Details. */
  firstPaymentDate: boolean;
  bankLender: boolean;
  person: boolean;
  purchase: boolean;
  card: boolean;
  account: boolean;
  whoFor: boolean;
  payer: boolean;
  bankReferences: boolean;
}

export function addSections(form: Pick<LoanEmiAddForm, "kind" | "borrowedFrom">): AddSections {
  const { kind } = form;
  const borrowed = kind === "borrowed";
  return {
    details: kind != null,
    repayment: kind != null,
    firstPaymentDate: kind != null,
    bankLender: borrowed && form.borrowedFrom === "institutional",
    person: (borrowed && form.borrowedFrom === "personal") || kind === "lent",
    purchase: kind === "purchase",
    card: kind === "creditCard",
    account: borrowed || kind === "lent",
    whoFor: kind === "borrowed" || kind === "purchase" || kind === "creditCard",
    payer: borrowed,
    bankReferences: borrowed && form.borrowedFrom === "institutional",
  };
}

/** Why the form can't be saved yet, or null when it can. */
export function loanEmiAddError(form: LoanEmiAddForm): string | null {
  if (form.kind == null) return "Choose what you're adding";
  const s = addSections(form);
  if (s.bankLender && form.lenderName.trim() === "") return "Enter the bank or lender";
  if (s.person && form.personId === "") return "Choose a person";
  if (s.card && form.cardId === "") return "Choose a credit card";
  if ((s.purchase || s.card) && form.name.trim() === "") {
    return form.kind === "creditCard" && form.cardEmiKind === "creditCardLoan" ? "Name this card loan" : "Enter what you bought";
  }
  if (!(Number(form.amount) > 0)) return "Enter an amount";
  if (parseDateInput(form.date) == null) return "Choose a date";
  if (parseDateInput(form.firstEmiDate) == null) return "Choose the first EMI date";
  const count = Number(form.count);
  if (!(Number.isInteger(count) && count >= 1)) return "Enter the number of installments";
  if (form.hasInterest && !(form.ratePercent.trim() !== "" && Number(form.ratePercent) >= 0)) return "Enter the interest rate";
  if (s.account && form.useAccount && form.accountId === "") return "Choose the account";
  if (s.whoFor && form.ownership === "someoneElse" && form.beneficiaryPersonId === "") return "Choose who this is for";
  return null;
}

export function parseDateInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function interestOf(form: LoanEmiAddForm) {
  return form.hasInterest ? { type: form.interestType, ratePercent: Number(form.ratePercent), period: "yearly" as const } : null;
}

function beneficiaryOf(form: LoanEmiAddForm): string | null {
  return addSections(form).whoFor && form.ownership === "someoneElse" && form.beneficiaryPersonId !== "" ? form.beneficiaryPersonId : null;
}

export type LoanEmiCreateRequest =
  | { path: "loan"; params: CreateLoanFormParams }
  | { path: "emi"; params: CreateEmiParams & { loanType: EmiLoanType } };

/** The exact params for the existing create operation. Throws when the form isn't valid. */
export function buildLoanEmiCreateRequest(form: LoanEmiAddForm): LoanEmiCreateRequest {
  const error = loanEmiAddError(form);
  if (error != null) throw new Error(error);
  const kind = form.kind!;
  const date = parseDateInput(form.date)!;
  const firstEmiDate = parseDateInput(form.firstEmiDate)!;

  if (createPathFor(kind) === "loan") {
    const category: LoanCategory = kind === "lent" ? "personal" : form.borrowedFrom;
    const institutional = category === "institutional";
    const movesMoney = form.useAccount && form.accountId !== "";
    return {
      path: "loan",
      params: {
        name: form.name.trim(),
        category,
        personId: institutional ? null : form.personId,
        lenderName: institutional ? form.lenderName.trim() : "",
        direction: kind === "lent" ? "given" : "taken",
        loanAmount: Number(form.amount),
        loanDate: date,
        firstDueDate: firstEmiDate,
        interest: interestOf(form),
        installmentFrequency: form.frequency,
        installmentCount: Number(form.count),
        notes: form.notes,
        loanType: institutional ? form.loanType.trim() || null : null,
        loanNumber: institutional ? form.loanNumber.trim() || null : null,
        accountNumber: institutional ? form.accountNumber.trim() || null : null,
        branch: institutional ? form.branch.trim() || null : null,
        payerPersonId: kind === "borrowed" ? form.payerPersonId || null : null,
        beneficiaryPersonId: beneficiaryOf(form),
        movementAccountId: movesMoney ? form.accountId : null,
        idempotencyKey: movesMoney ? form.idempotencyKey : undefined,
      },
    };
  }

  const card = kind === "creditCard";
  return {
    path: "emi",
    params: {
      name: form.name.trim(),
      lenderName: card ? null : form.provider.trim() || null,
      loanType: card ? "creditCard" : form.emiType,
      linkedCreditCardId: card ? form.cardId : null,
      beneficiaryPersonId: beneficiaryOf(form),
      principalAmount: Number(form.amount),
      startDate: firstEmiDate,
      installmentFrequency: form.frequency,
      installmentCount: Number(form.count),
      interest: interestOf(form),
      notes: form.notes,
    },
  };
}

/** Rough per-installment figure for the form preview — the real schedule is built by the engine on save. */
export function previewInstallment(
  form: Pick<LoanEmiAddForm, "amount" | "count" | "frequency" | "hasInterest" | "ratePercent" | "interestType">,
): { perInstallment: number; interest: number } | null {
  const principal = Number(form.amount);
  const count = Math.floor(Number(form.count));
  if (!(principal > 0) || !(count > 0)) return null;
  const annual = form.hasInterest ? Number(form.ratePercent) / 100 : 0;
  if (!(annual > 0)) return { perInstallment: principal / count, interest: 0 };
  const periodsPerYear = form.frequency === "weekly" ? 52 : 12;
  if (form.interestType === "flat") {
    const interest = principal * annual * (count / periodsPerYear);
    return { perInstallment: (principal + interest) / count, interest };
  }
  const r = annual / periodsPerYear;
  const per = (principal * r) / (1 - Math.pow(1 + r, -count));
  return { perInstallment: per, interest: per * count - principal };
}

/* ───────────── Existing records → unified classification (display only, nothing persisted) ───────────── */

export interface RecordKind {
  kind: AddKind;
  /** Small user-facing badge — "Bank Loan", "Credit Card EMI", … */
  label: string;
}

const EMI_LOAN_LABEL: Partial<Record<EmiLoanType, string>> = {
  home: "Home Loan",
  personal: "Personal Loan",
  education: "Education Loan",
  gold: "Gold Loan",
  business: "Business Loan",
  vehicle: "Vehicle Finance",
};

export function recordKindForLoan(
  loan: Pick<Loan, "direction" | "category" | "agreementKind" | "fundingSource" | "linkedCreditCardId">,
): RecordKind {
  if (loan.direction === "given") return { kind: "lent", label: "Loan I Gave" };
  if (loan.linkedCreditCardId || loan.fundingSource === "creditCard") return { kind: "creditCard", label: "Credit Card EMI" };
  if (loan.agreementKind === "installmentPurchase") return { kind: "purchase", label: "Purchase Finance" };
  return loan.category === "personal" ? { kind: "borrowed", label: "Personal Loan" } : { kind: "borrowed", label: "Bank Loan" };
}

export function recordKindForEmi(emi: Pick<Emi, "loanType" | "linkedCreditCardId">): RecordKind {
  if (emi.linkedCreditCardId || emi.loanType === "creditCard") return { kind: "creditCard", label: "Credit Card EMI" };
  return { kind: "purchase", label: EMI_LOAN_LABEL[emi.loanType] ?? "Purchase Finance" };
}
