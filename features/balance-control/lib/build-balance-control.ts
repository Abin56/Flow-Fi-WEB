/**
 * READ-ONLY adapters: turn the figures the app already computes (card standings, loan / EMI rows, the balance
 * sheet) into (a) the products the variance calculator compares and (b) the input of `runBalanceChecks`. Pure —
 * no Firestore, no hooks, no writes, and no engine is re-implemented here: every number is read from the same
 * engine the rest of the app uses.
 */

import type { CheckAgreement, CheckCard } from "@/lib/engines/balance-control-checks";
import { cardLedgerDebt } from "@/lib/engines/balance-control-checks";
import type { VarianceContext, VarianceMetric } from "@/lib/engines/balance-variance";
import type { LimitCorrectionTarget } from "@/lib/repositories/credit-limit-correction-repository";
import { cardFundedLoanCardId } from "@/lib/engines/credit-utilization";
import { outstandingPrincipalFor } from "@/lib/engines/loan-outstanding";
import type { ReconInstallment } from "@/lib/engines/loan-reconciliation";
import { cardEmiCase, type CardEmiCase } from "@/features/emi/lib/emi-card-funding";
import { unpaidAmount } from "@/lib/engines/lender-charges";
import type { LenderCharge } from "@/lib/models/lender-charge";
import type { Account } from "@/lib/models/account";
import type { Transaction } from "@/lib/models/transaction";
import type { CreditCardStandingView } from "@/features/credit-cards/hooks/use-credit-cards-data";
import type { EmiRow } from "@/features/emi/hooks/use-emi-data";
import type { LoanRow } from "@/features/loans/hooks/use-loans-data";

export type ProductKind = "card" | "loan" | "emi";

export interface VarianceProduct {
  id: string;
  kind: ProductKind;
  name: string;
  subtitle: string;
  /** Which metrics this product offers, in display order. */
  metrics: VarianceMetric[];
  /** FlowFi's calculated figure per metric (null: FlowFi has none). */
  flowfi: Partial<Record<VarianceMetric, number | null>>;
  /** Scope note shown beside a metric when its FlowFi figure needs one (pooled, latest statement, …). */
  notes: Partial<Record<VarianceMetric, string>>;
  context: VarianceContext;
  /** An effect a future correction would also have on a linked card (card-funded loans / EMIs). */
  crossEffect: string | null;
  /** Where a `creditLimit` correction on this product writes to — the card itself, or its shared facility when it has one. Null for loans/EMIs (no supported correction yet). */
  limitCorrectionTarget: LimitCorrectionTarget | null;
  /** Context for the outstanding/available-credit reconciliation guide on this product. Null for loans/EMIs. */
  reconciliation: ReconciliationCardContext | null;
  /** Context for the Loan / EMI reconciliation guide. Null for cards. */
  loanReconciliation?: LoanReconciliationContext | null;
}

/** What the Loan / EMI reconciliation sheet needs for one agreement — see `lib/engines/loan-reconciliation.ts`. */
export interface LoanReconciliationContext {
  agreementId: string;
  source: { kind: "loan"; row: LoanRow } | { kind: "emi"; row: EmiRow };
  principalAmount: number;
  /** FlowFi's outstanding principal for this agreement today (principal only — never includes lender charges). */
  outstandingPrincipal: number;
  ratePercent: number | null;
  installments: ReconInstallment[];
  principalPrepaid: number;
  cardLinkedName: string | null;
  /** Card-linked EMI only: who owns the principal (`planCardEmiLegs` rule) — read from the EMI's purchase record, never guessed. */
  cardEmiCase: CardEmiCase | null;
  supportsPrepaymentAndDisbursement: boolean;
}

/** What the outstanding/available-credit reconciliation sheet needs for one card — see `lib/engines/outstanding-reconciliation.ts`. */
export interface ReconciliationCardContext {
  cardAccountId: string;
  lockedEmiPrincipal: number;
  onSharedLimit: boolean;
  hasOpeningBalance: boolean;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const shortDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });

function cardLabel(s: CreditCardStandingView, accountById: ReadonlyMap<string, Account>): string {
  const account = accountById.get(s.card.accountId);
  const last4 = s.card.lastFourDigits ? ` •••• ${s.card.lastFourDigits}` : "";
  return `${account?.name ?? "Credit card"}${account?.name?.includes(s.card.lastFourDigits ?? "\u0000") ? "" : last4}`.trim();
}

export function cardProducts(
  standings: readonly CreditCardStandingView[],
  accountById: ReadonlyMap<string, Account>,
  now: Date = new Date(),
): VarianceProduct[] {
  return standings.map((s) => {
    const today = startOfDay(now);
    const latest =
      [...s.statements]
        .filter((st) => st.deletedAt == null && startOfDay(st.periodEnd) < today)
        .sort((a, b) => b.periodEnd.getTime() - a.periodEnd.getTime())[0] ?? null;
    const shared = s.sharedLimit;
    const locked = s.lockedEmiPrincipal > 0;
    const notes: VarianceProduct["notes"] = {
      totalOutstanding: locked ? "Billed + unbilled + card-EMI principal" : "Billed + unbilled",
      statementBalance: latest ? `Statement ending ${shortDate(latest.periodEnd)}${shared ? ", this card only" : ""}` : "No closed statement yet",
    };
    if (shared) {
      notes.creditLimit = `Pooled facility limit (${shared.name})`;
      notes.totalOutstanding = `Pooled across ${shared.memberCardIds.length} cards${locked ? ", incl. card-EMI principal" : ""}`;
      notes.availableCredit = "Pooled across the facility";
    }
    return {
      id: `card:${s.card.id}`,
      kind: "card",
      name: cardLabel(s, accountById),
      subtitle: shared ? `Shared limit · ${shared.name}` : "Credit card",
      metrics: ["creditLimit", "totalOutstanding", "statementBalance", "availableCredit"],
      flowfi: {
        creditLimit: s.effectiveCreditLimit,
        totalOutstanding: round2(s.outstanding + s.lockedEmiPrincipal),
        statementBalance: latest ? round2(latest.totalAmount) : null,
        availableCredit: s.available,
      },
      notes,
      context: { lockedEmiPrincipal: s.lockedEmiPrincipal },
      crossEffect: null,
      limitCorrectionTarget: shared != null ? { kind: "sharedLimit", sharedLimitId: shared.id } : { kind: "card", cardId: s.card.id },
      reconciliation: {
        cardAccountId: s.card.accountId,
        lockedEmiPrincipal: s.lockedEmiPrincipal,
        onSharedLimit: shared != null,
        hasOpeningBalance: Math.abs(accountById.get(s.card.accountId)?.openingBalance ?? 0) > 0.005,
      },
    };
  });
}

/** Unpaid, billed lender charges by agreement id — added to the lender-payoff row only (never to principal). */
export type UnpaidChargesByAgreement = ReadonlyMap<string, number>;

export function loanProducts(rows: readonly LoanRow[], cardNameById: ReadonlyMap<string, string>, unpaidCharges: UnpaidChargesByAgreement = new Map()): VarianceProduct[] {
  // A lent loan is a receivable, not a lender figure the user would read off a bank statement.
  return rows
    .filter((r) => r.direction === "taken" && r.loan.deletedAt == null)
    .map((r) => {
      const cardId = cardFundedLoanCardId(r.loan);
      const cardName = cardId != null ? cardNameById.get(cardId) : undefined;
      const charges = unpaidCharges.get(r.loan.id) ?? 0;
      return {
        id: `loan:${r.loan.id}`,
        kind: "loan" as const,
        name: r.loan.name ?? r.lenderName,
        subtitle: r.loan.isClosed ? "Loan · closed" : "Loan",
        metrics: ["loanPrincipal", "lenderPayoff"] as VarianceMetric[],
        flowfi: { loanPrincipal: round2(r.outstandingPrincipal), lenderPayoff: round2(r.outstandingPrincipal + charges) },
        notes: {
          loanPrincipal: r.principalPrepaid > 0 ? "After extra principal paid" : "Principal only",
          lenderPayoff: charges > 0 ? `Principal + ${round2(charges)} unpaid lender charges` : "FlowFi knows the principal floor only",
        },
        context: {},
        crossEffect: cardName ? `Card-funded: would also move ${cardName} available credit & utilization` : null,
        limitCorrectionTarget: null,
        reconciliation: null,
        loanReconciliation: {
          agreementId: r.loan.id,
          source: { kind: "loan", row: r },
          principalAmount: r.loan.loanAmount,
          outstandingPrincipal: round2(r.outstandingPrincipal),
          ratePercent: r.loan.interest?.ratePercent ?? null,
          installments: r.installments,
          principalPrepaid: r.principalPrepaid,
          cardLinkedName: cardId != null ? (cardName ?? "linked card") : null,
          cardEmiCase: null,
          supportsPrepaymentAndDisbursement: true,
        },
      };
    });
}

export function emiProducts(
  rows: readonly EmiRow[],
  cardNameById: ReadonlyMap<string, string> = new Map(),
  transactionById: ReadonlyMap<string, Transaction> = new Map(),
  unpaidCharges: UnpaidChargesByAgreement = new Map(),
): VarianceProduct[] {
  return rows
    .filter((r) => r.emi.deletedAt == null)
    .map((r) => {
      const principal = round2(outstandingPrincipalFor(r.emi.principalAmount, r.installments));
      const charges = unpaidCharges.get(r.emi.id) ?? 0;
      return {
        id: `emi:${r.emi.id}`,
        kind: "emi" as const,
        name: r.emi.name,
        subtitle: r.emi.isClosed ? "EMI · closed" : "EMI",
        metrics: ["emiPrincipal", "lenderPayoff"] as VarianceMetric[],
        flowfi: { emiPrincipal: principal, lenderPayoff: round2(principal + charges) },
        notes: { emiPrincipal: "Principal only", lenderPayoff: charges > 0 ? `Principal + ${round2(charges)} unpaid lender charges` : "FlowFi knows the principal floor only" },
        context: {},
        crossEffect: r.linkedCard ? "Card-linked: would also move that card's available credit & utilization" : null,
        limitCorrectionTarget: null,
        reconciliation: null,
        loanReconciliation: {
          agreementId: r.emi.id,
          source: { kind: "emi", row: r },
          principalAmount: r.emi.principalAmount,
          outstandingPrincipal: principal,
          ratePercent: r.emi.interest?.ratePercent ?? null,
          installments: r.installments,
          principalPrepaid: 0,
          cardLinkedName: r.linkedCard ? (cardNameById.get(r.linkedCard.id) ?? "linked card") : null,
          cardEmiCase: r.linkedCard
            ? cardEmiCase(r.emi, r.linkedCard.accountId, r.emi.purchaseTransactionId ? (transactionById.get(r.emi.purchaseTransactionId) ?? null) : null)
            : null,
          supportsPrepaymentAndDisbursement: false,
        },
      };
    });
}

export interface ProductSources {
  standings: readonly CreditCardStandingView[];
  accounts: readonly Account[];
  loanRows: readonly LoanRow[];
  emiRows: readonly EmiRow[];
  /** Only used to tell a card EMI's Case A (purchase already on the card) from Case B. */
  transactions?: readonly Transaction[];
  /** Live lender charges — only used to add unpaid charges to the lender-payoff row. */
  lenderCharges?: readonly LenderCharge[];
  now?: Date;
}

export function buildVarianceProducts(src: ProductSources): VarianceProduct[] {
  const accountById = new Map(src.accounts.map((a) => [a.id, a]));
  const cardNameById = new Map(src.standings.map((s) => [s.card.id, cardLabel(s, accountById)]));
  const unpaid = new Map<string, number>();
  for (const c of src.lenderCharges ?? []) unpaid.set(c.agreementId, (unpaid.get(c.agreementId) ?? 0) + unpaidAmount(c));
  return [...cardProducts(src.standings, accountById, src.now), ...loanProducts(src.loanRows, cardNameById, unpaid), ...emiProducts(src.emiRows, cardNameById, new Map((src.transactions ?? []).map((t) => [t.id, t])), unpaid)];
}

// --- Check input ---

export function buildCheckCards(standings: readonly CreditCardStandingView[], accounts: readonly Account[], transactions: readonly Transaction[]): CheckCard[] {
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const byAccount = new Map<string, Transaction[]>();
  for (const t of transactions) {
    if (t.deletedAt != null) continue;
    const list = byAccount.get(t.accountId);
    if (list) list.push(t);
    else byAccount.set(t.accountId, [t]);
  }
  const out: CheckCard[] = [];
  for (const s of standings) {
    const account = accountById.get(s.card.accountId);
    // A card whose account is not loaded cannot be compared — never invent a balance for it.
    if (!account) continue;
    out.push({
      cardId: s.card.id,
      name: cardLabel(s, accountById),
      openingBalance: account.openingBalance,
      storedBalance: account.currentBalance,
      ledgerDebt: cardLedgerDebt(byAccount.get(account.id) ?? []),
      ownOutstanding: s.ownOutstanding,
      outstanding: s.outstanding,
      lockedEmiPrincipal: s.lockedEmiPrincipal,
      available: s.available,
      utilizationPercent: s.utilizationPercent,
      effectiveLimit: s.effectiveCreditLimit,
      ownLimit: s.card.creditLimit,
      sharedLimitId: s.card.sharedLimitId,
      facilityResolved: s.sharedLimit != null,
    });
  }
  return out;
}

export function buildCheckAgreements(loanRows: readonly LoanRow[], emiRows: readonly EmiRow[], trackedCardIds: ReadonlySet<string>): CheckAgreement[] {
  const loans = loanRows
    .filter((r) => r.loan.deletedAt == null)
    .map((r): CheckAgreement => {
      const cardId = cardFundedLoanCardId(r.loan);
      return {
        id: r.loan.id,
        name: r.loan.name ?? r.lenderName,
        kind: "loan",
        direction: r.direction,
        isClosed: r.loan.isClosed,
        principalAmount: r.loan.loanAmount,
        principalPrepaid: r.principalPrepaid,
        displayedOutstanding: r.outstandingPrincipal,
        installments: r.installments,
        linkedCardId: cardId,
        linkedCardTracked: cardId != null && trackedCardIds.has(cardId),
      };
    });
  const emis = emiRows
    .filter((r) => r.emi.deletedAt == null)
    .map((r): CheckAgreement => ({
      id: r.emi.id,
      name: r.emi.name,
      kind: "emi",
      direction: null,
      isClosed: r.emi.isClosed,
      principalAmount: r.emi.principalAmount,
      principalPrepaid: 0,
      displayedOutstanding: outstandingPrincipalFor(r.emi.principalAmount, r.installments),
      installments: r.installments,
      linkedCardId: r.emi.linkedCreditCardId,
      linkedCardTracked: r.linkedCard != null,
    }));
  return [...loans, ...emis];
}
