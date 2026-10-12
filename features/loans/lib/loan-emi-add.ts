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
import type { InterestPeriod, InterestType } from "@/lib/engines/interest-calculator";
import { allocateOwnership, fromPaise, installmentWeights, splitByOwnership, splitPaise, toPaise, type AllocationMode, type AllocationResult } from "@/lib/engines/debt-ownership";
import type { Emi, EmiLoanType } from "@/lib/models/emi";
import type { Loan, LoanCategory } from "@/lib/models/loan";
import type { ScheduleType } from "@/lib/models/payment-schedule";
import type { CreateEmiParams } from "@/lib/repositories/emi-repository";

export type AddKind = "borrowed" | "purchase" | "creditCard" | "lent";
/** How a card-linked EMI came about — only changes wording; both lock the principal against the card. */
export type CardEmiKind = "productPurchase" | "creditCardLoan";
export type OwnershipChoice = "me" | "someoneElse";
/** The Add form also offers "shared": ONE loan whose principal is allocated between me and/or several people. */
export type AddOwnership = OwnershipChoice | "shared";

/** One row of the shared-loan allocation. `personId`: null = Me, "" = not chosen yet. */
export interface AllocationFormRow {
  personId: string | null;
  /** ₹ (custom) or % (percentage); ignored for equal. */
  value: string;
  /** Custom only — this person's own EMI (optional; blank on every row = in proportion to their share). */
  emi?: string;
}

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
  /** What `ratePercent` is quoted per — many app lenders quote a monthly rate (e.g. 1.73% p.m.). */
  ratePeriod: InterestPeriod;
  /** "rate": the user types the rate. "emi": they type the EMI they actually pay and the rate is derived from it. */
  rateInput: "rate" | "emi";
  /** The real per-installment amount (rateInput "emi") — covers lender extras like GST on interest. */
  emiAmount: string;
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
  ownership: AddOwnership;
  beneficiaryPersonId: string;
  /** "shared" only — how the principal is divided, and between whom. */
  allocationMode: AllocationMode;
  allocationRows: AllocationFormRow[];
  /**
   * "They repay me each installment" — the explicit opt-in (`beneficiaryRepaysInstallments`) that makes
   * each installment a People obligation on its due date. Off = "who is this for" association only.
   */
  beneficiaryRepays: boolean;
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
    ratePeriod: "yearly",
    rateInput: "rate",
    emiAmount: "",
    interestType: "reducingBalance",
    provider: "",
    emiType: "other",
    cardId: "",
    cardEmiKind: "productPurchase",
    useAccount: false,
    accountId: "",
    ownership: "me",
    beneficiaryPersonId: "",
    allocationMode: "equal",
    allocationRows: [{ personId: null, value: "" }, { personId: "", value: "" }],
    beneficiaryRepays: false,
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
  if (form.hasInterest && form.rateInput === "rate" && !(form.ratePercent.trim() !== "" && Number(form.ratePercent) >= 0)) return "Enter the interest rate";
  if (form.hasInterest && form.rateInput === "emi") {
    const emi = Number(form.emiAmount);
    if (!(emi > 0)) return "Enter the EMI amount";
    if (emi * count < Number(form.amount)) return "EMI × installments can't be less than the amount";
  }
  if (s.account && form.useAccount && form.accountId === "") return "Choose the account";
  if (s.whoFor && form.ownership === "someoneElse" && form.beneficiaryPersonId === "") return "Choose who this is for";
  if (s.whoFor && form.ownership === "shared") {
    if (!form.allocationRows.some((r) => r.personId !== null)) return "Add at least one other person";
    const error = allocationOf(form).error;
    if (error != null) return error;
  }
  return null;
}

type AllocationForm = Pick<LoanEmiAddForm, "amount" | "allocationMode" | "allocationRows"> & Partial<RateForm>;

/** The loan's per-installment amount — 0 until the repayment section is complete. */
export function totalInstallmentOf(form: AllocationForm): number {
  if (form.count == null || form.frequency == null) return 0;
  return previewInstallment(form as RateForm)?.perInstallment ?? 0;
}

/** Custom mode with at least one EMI typed — then blank EMIs share what's left of the loan's EMI. */
export function usesCustomEmis(form: Pick<LoanEmiAddForm, "allocationMode" | "allocationRows">): boolean {
  return form.allocationMode === "custom" && form.allocationRows.some((r) => (r.emi ?? "").trim() !== "");
}

const isBlank = (v: string | undefined) => (v ?? "").trim() === "";

/**
 * Typed values stay fixed; blank rows share what's left of `total` (paise-exact) by `weights` (equal when
 * omitted). Blank rows get 0 when nothing is left — the caller reports it. Returns the filled-in values.
 */
function fillBlanks(typed: readonly (string | undefined)[], total: number, weights?: readonly number[]): number[] {
  const values = typed.map((v) => (isBlank(v) ? 0 : Number(v) || 0));
  const blanks = typed.map((v, i) => (isBlank(v) ? i : -1)).filter((i) => i >= 0);
  const leftPaise = toPaise(total) - values.reduce((sum, v) => sum + toPaise(v), 0);
  if (blanks.length === 0 || leftPaise <= 0) return values;
  const parts = splitPaise(leftPaise, blanks.map((i) => (weights ? weights[i] : 1)));
  blanks.forEach((i, k) => (values[i] = fromPaise(parts[k])));
  return values;
}

/**
 * The live allocation of the principal for the "shared" choice — the form shows it continuously and it
 * re-derives on every change. Custom ₹ / %: typed rows are fixed, blank rows share the rest. Per-person EMIs
 * (custom): typed EMIs are fixed, blank ones share the rest of the loan's EMI in proportion to their shares.
 */
export function allocationOf(form: AllocationForm): AllocationResult {
  const principal = Number(form.amount) > 0 ? Number(form.amount) : 0;
  const typed = form.allocationRows.map((r) => r.value);
  const values =
    form.allocationMode === "custom"
      ? fillBlanks(typed, principal)
      : form.allocationMode === "percentage"
        ? fillBlanks(typed, 100)
        : typed.map(() => 0);
  const rows = form.allocationRows.map((r, i) => ({ personId: r.personId, value: values[i] }));
  const result = allocateOwnership(principal, form.allocationMode, rows);
  if (!usesCustomEmis(form)) return result;

  const total = totalInstallmentOf(form);
  if (!(total > 0)) return { ...result, error: result.error ?? "Fill in the repayment details first" };
  const emiTyped = form.allocationRows.map((r) => r.emi);
  const emis = fillBlanks(emiTyped, total, result.shares.map((x) => x.amount));
  // Each person's own EMI rides on their share; the engine splits installments by these (installmentWeights).
  const shares = result.shares.map((x, i) => ({ ...x, installmentAmount: emis[i] }));
  const emiSum = emis.reduce((sum, v) => sum + v, 0);
  // Within ₹1 — the loan's EMI is usually fractional (₹5,046.98) while people type whole rupees.
  const gap = Math.round((total - emiSum) * 100) / 100;
  const emiError =
    gap <= -1
      ? `EMIs are ₹${(-gap).toLocaleString("en-IN")} more than the loan's EMI`
      : emis.some((v) => !(v > 0))
        ? "No EMI left for the blank rows — lower the typed EMIs"
        : gap >= 1
          ? `EMIs are ₹${gap.toLocaleString("en-IN")} short of the loan's EMI`
          : null;
  return { ...result, shares, error: result.error ?? emiError };
}

/** Each person's part of one installment — the same split the engine applies to the schedule. */
export function installmentSharesOf(form: AllocationForm, shares: AllocationResult["shares"]): number[] {
  const total = totalInstallmentOf(form);
  if (!(total > 0) || !shares.some((s) => s.amount > 0)) return shares.map(() => 0);
  return splitByOwnership(total, installmentWeights(shares)).map((s) => s.amount);
}

function sharesOf(form: LoanEmiAddForm) {
  return addSections(form).whoFor && form.ownership === "shared" ? allocationOf(form).shares : null;
}

export function parseDateInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function interestOf(form: LoanEmiAddForm) {
  const rate = effectiveRate(form);
  return rate ? { type: form.interestType, ...rate } : null;
}

type RateForm = Pick<LoanEmiAddForm, "amount" | "count" | "frequency" | "hasInterest" | "ratePercent" | "ratePeriod" | "rateInput" | "emiAmount" | "interestType">;

/**
 * The rate that is saved: the typed one, or — when the user typed their EMI — the rate that reproduces that EMI
 * exactly (so the engine's schedule matches what the lender actually debits, GST and all). Null = no interest.
 */
export function effectiveRate(form: RateForm): { ratePercent: number; period: InterestPeriod } | null {
  if (!form.hasInterest) return null;
  if (form.rateInput === "rate") return { ratePercent: Number(form.ratePercent), period: form.ratePeriod };
  const principal = Number(form.amount);
  const count = Math.floor(Number(form.count));
  const emi = Number(form.emiAmount);
  if (!(principal > 0) || !(count > 0) || !(emi * count > principal)) return null;
  const periodic = form.interestType === "flat" ? (emi * count - principal) / (principal * count) : reducingRateForEmi(principal, count, emi);
  // Monthly installments: quote per month (reads like the lender's "1.73% p.m."). Weekly: per year.
  return form.frequency === "weekly"
    ? { ratePercent: round6(periodic * 52 * 100), period: "yearly" }
    : { ratePercent: round6(periodic * 100), period: "monthly" };
}

/** Periodic rate r where principal·r / (1 − (1+r)^−count) = emi — bisection; the payment rises with r. */
function reducingRateForEmi(principal: number, count: number, emi: number): number {
  const payment = (r: number) => (principal * r) / (1 - Math.pow(1 + r, -count));
  let lo = 1e-9;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (payment(mid) < emi) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

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
        beneficiaryRepaysInstallments: kind === "borrowed" && beneficiaryOf(form) != null && form.beneficiaryRepays,
        ownershipShares: kind === "borrowed" ? sharesOf(form) : null,
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
      beneficiaryRepaysInstallments: beneficiaryOf(form) != null && form.beneficiaryRepays,
      ownershipShares: sharesOf(form),
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
  form: RateForm,
): { perInstallment: number; interest: number } | null {
  const principal = Number(form.amount);
  const count = Math.floor(Number(form.count));
  if (!(principal > 0) || !(count > 0)) return null;
  if (form.hasInterest && form.rateInput === "emi") {
    const emi = Number(form.emiAmount);
    if (!(emi > 0) || emi * count < principal) return null;
    if (toPaise(emi * count) === toPaise(principal)) return { perInstallment: emi, interest: 0 };
  }
  const rate = effectiveRate(form);
  const quoted = rate ? rate.ratePercent / 100 : 0;
  // Same conversion as the engine's computePeriodicRate: a monthly quote is 12× per year.
  const annual = rate?.period === "monthly" ? quoted * 12 : quoted;
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
