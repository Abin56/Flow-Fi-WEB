/**
 * READ-ONLY financial-definition checks for the Financial Audit (Balance Control P0). Pure: takes already
 * computed standings / rows, returns findings. Nothing is written, repaired or recalculated into storage, and no
 * existing engine is changed — it only RE-DERIVES a figure through the same engine function and compares.
 *
 * Findings are split three ways so a legitimate difference of DEFINITION is never reported as a bug:
 *  - "confirmed"  — two figures that must agree by construction do not (a real inconsistency).
 *  - "suspected"  — consistent with a historical gap or a decision the user must make; not provably wrong.
 *  - "legitimate" — an expected difference (overpayment, net credit, a card's ignored nominal limit, …),
 *                   shown so the numbers are explained, never counted as an issue.
 *
 * Card debt sources (Phase A §2.1): Net Worth / Dashboard use the card ACCOUNT balance (stored, signed); Reports,
 * Debt Planner and the card screens use the DERIVED outstanding. They agree except for explainable reasons:
 *   −balance = (charges − credits − payments) − openingBalance
 *   derived outstanding = max(charges − credits − payments, 0)
 * so the only legitimate gaps are an opening balance (not in the derived figure) and a card in credit
 * (overpayment / net credit — the derived figure floors at 0, the balance goes positive).
 */

import { availableCredit, creditUtilizationPercent, lockedEmiPrincipalFor, type UtilizationEmi } from "@/lib/engines/credit-utilization";
import { liabilityTotals, type LoanBalanceSheet } from "@/lib/engines/loan-balance-sheet";
import { outstandingPrincipalAfterPrepaymentsFor, outstandingPrincipalFor, type OutstandingInstallment } from "@/lib/engines/loan-outstanding";
import { cardPaymentTotal, cardStatementAmount, countsTowardCardStatement } from "@/lib/repositories/credit-card-repository";
import type { Transaction } from "@/lib/models/transaction";

export type CheckArea = "card-balance" | "debt-totals" | "limits" | "card-emi" | "loan-emi";
export type CheckStatus = "confirmed" | "suspected" | "legitimate";

export const CHECK_AREA_LABEL: Record<CheckArea, string> = {
  "card-balance": "Card balance vs outstanding",
  "debt-totals": "Dashboard vs Reports debt",
  limits: "Credit limits & shared limits",
  "card-emi": "Card EMI locking",
  "loan-emi": "Loan / EMI outstanding",
};

export interface CheckFinding {
  id: string;
  area: CheckArea;
  status: CheckStatus;
  title: string;
  detail: string;
  /** Card / loan / EMI / "All cards". */
  subject: string;
  figures?: { label: string; value: number }[];
}

export interface BalanceCheckReport {
  findings: CheckFinding[];
  summary: Record<CheckStatus, number>;
  /** How many products each area looked at — so "no findings" is distinguishable from "nothing checked". */
  checked: Record<CheckArea, number>;
}

const TOL = 0.01;
const round2 = (v: number) => Math.round(v * 100) / 100;
const differs = (a: number, b: number, tol = TOL) => Math.abs(a - b) >= tol;

/**
 * Charges − credits − bill payments on a card account, from active, calculable transactions only (the same
 * classification the statement engine uses). Can be negative: the card is in credit. Excludes the opening balance.
 */
export function cardLedgerDebt(cardTransactions: readonly Transaction[]): number {
  const list = cardTransactions as Transaction[];
  const charges = list.filter(countsTowardCardStatement).reduce((sum, t) => sum + cardStatementAmount(t), 0);
  return round2(charges - cardPaymentTotal(list));
}

// --- Inputs ---

export interface CheckCard {
  cardId: string;
  name: string;
  /** Account.openingBalance (signed; a card's debt is negative). */
  openingBalance: number;
  /** Account.currentBalance (stored, signed). */
  storedBalance: number;
  /** `cardLedgerDebt` of the card's own transactions. */
  ledgerDebt: number;
  /** This physical card's own derived outstanding (`CreditCardStandingView.ownOutstanding`). */
  ownOutstanding: number;
  /** Facility-wide for a shared card, own otherwise (`CreditCardStandingView.outstanding`). */
  outstanding: number;
  lockedEmiPrincipal: number;
  available: number;
  utilizationPercent: number;
  effectiveLimit: number;
  /** `CreditCardProfile.creditLimit` — member cards of a facility often store a nominal 0. */
  ownLimit: number;
  /** `CreditCardProfile.sharedLimitId`. */
  sharedLimitId: string | null;
  /** The facility resolved to a usable `SharedCreditLimit` (the standing is pooled). */
  facilityResolved: boolean;
}

export interface CheckAgreement {
  id: string;
  name: string;
  kind: "loan" | "emi";
  /** Loans only — a lent loan is a receivable. */
  direction: "given" | "taken" | null;
  isClosed: boolean;
  principalAmount: number;
  /** Active extra principal (loans only; EMIs have none). */
  principalPrepaid: number;
  /** What the app currently displays / feeds the balance sheet. */
  displayedOutstanding: number;
  installments: readonly (OutstandingInstallment & { deletedAt?: Date | null })[];
  /** The linked card id when one is set (EMI `linkedCreditCardId` / card-funded loan). */
  linkedCardId: string | null;
  /** The linked card resolves to a tracked card. */
  linkedCardTracked: boolean;
}

export interface BalanceCheckInput {
  cards: readonly CheckCard[];
  /** Same figure Reports use: `creditCardTotalsFrom(standings).utilized`. */
  reportsCardUtilized: number;
  sheet: LoanBalanceSheet;
  utilizationEmis: readonly UtilizationEmi[];
  agreements: readonly CheckAgreement[];
}

// --- Card balance vs derived outstanding ---

function checkCardBalances(cards: readonly CheckCard[], out: CheckFinding[]) {
  for (const c of cards) {
    const debtFromBalance = -c.storedBalance;
    const expectedBalanceDebt = round2(c.ledgerDebt - c.openingBalance);
    const expectedOutstanding = Math.max(c.ledgerDebt, 0);

    const balanceResidual = round2(debtFromBalance - expectedBalanceDebt);
    if (differs(balanceResidual, 0)) {
      out.push({
        id: `card-balance-drift:${c.cardId}`,
        area: "card-balance",
        status: "confirmed",
        subject: c.name,
        title: "Stored card balance disagrees with its own transactions",
        detail: "The card account's stored balance is not opening balance + its active transactions. This is the same drift the account check reports; the card's Net Worth contribution is affected.",
        figures: [
          { label: "Debt per stored balance", value: debtFromBalance },
          { label: "Debt per transactions", value: expectedBalanceDebt },
          { label: "Residual", value: balanceResidual },
        ],
      });
    }

    const engineResidual = round2(c.ownOutstanding - expectedOutstanding);
    if (differs(engineResidual, 0)) {
      out.push({
        id: `card-outstanding-engine:${c.cardId}`,
        area: "card-balance",
        status: "confirmed",
        subject: c.name,
        title: "Derived outstanding disagrees with the card's transactions",
        detail: "Outstanding is charges − credits − bill payments, floored at 0. The engine's figure is not that.",
        figures: [
          { label: "Derived outstanding", value: c.ownOutstanding },
          { label: "Per transactions", value: expectedOutstanding },
          { label: "Residual", value: engineResidual },
        ],
      });
    }

    if (differs(c.openingBalance, 0)) {
      out.push({
        id: `card-opening:${c.cardId}`,
        area: "card-balance",
        status: "suspected",
        subject: c.name,
        title: "Opening balance sits in Net Worth but not in outstanding or available credit",
        detail: "The card account has a non-zero opening balance. The account balance (Net Worth) includes it; derived outstanding, available credit and utilization do not. Cards can no longer be created with one, so this is a legacy value — it needs a decision, not an assumption.",
        figures: [{ label: "Opening balance", value: c.openingBalance }],
      });
    }

    if (c.ledgerDebt < -TOL && !differs(engineResidual, 0)) {
      out.push({
        id: `card-credit:${c.cardId}`,
        area: "card-balance",
        status: "legitimate",
        subject: c.name,
        title: "Card is in credit (overpayment or net credit)",
        detail: "Payments and refunds exceed charges. The stored balance is positive; derived outstanding correctly floors at ₹0. Not a discrepancy.",
        figures: [{ label: "Credit position", value: -c.ledgerDebt }],
      });
    }
  }
}

// --- Dashboard debt vs Reports debt ---

function checkDebtTotals(input: BalanceCheckInput, out: CheckFinding[]) {
  const { cards, reportsCardUtilized, sheet } = input;
  if (cards.length === 0) return;

  // Dashboard: −Σ card account balances (signed, so a card in credit nets against another's debt).
  const dashboardCardDebt = round2(-cards.reduce((s, c) => s + c.storedBalance, 0));
  const dashboardTotal = liabilityTotals(sheet, dashboardCardDebt).total;
  const reportsTotal = liabilityTotals(sheet, reportsCardUtilized).total;
  const totalsDifference = round2(dashboardTotal - reportsTotal);
  if (!differs(totalsDifference, 0) && !differs(dashboardCardDebt, reportsCardUtilized)) return;

  const openingPart = round2(-cards.reduce((s, c) => s + c.openingBalance, 0));
  const creditPart = round2(cards.reduce((s, c) => s + Math.min(c.ledgerDebt, 0), 0));
  const rawGap = round2(dashboardCardDebt - reportsCardUtilized);
  const unexplained = round2(rawGap - openingPart - creditPart);

  const figures = [
    { label: "Dashboard total debt", value: dashboardTotal },
    { label: "Reports total debt", value: reportsTotal },
    { label: "Opening balances", value: openingPart },
    { label: "Cards in credit", value: creditPart },
    { label: "Unexplained", value: unexplained },
  ];

  if (differs(unexplained, 0)) {
    out.push({
      id: "debt-totals-unexplained",
      area: "debt-totals",
      status: "confirmed",
      subject: "All cards",
      title: "Dashboard and Reports debt differ by more than definitions explain",
      detail: "Dashboard takes card debt from the stored card balances; Reports from derived outstanding. After accounting for opening balances and cards in credit, a gap remains — see the per-card findings.",
      figures,
    });
  } else {
    out.push({
      id: "debt-totals-explained",
      area: "debt-totals",
      status: "legitimate",
      subject: "All cards",
      title: "Dashboard and Reports debt differ, fully explained by definitions",
      detail: "Dashboard nets a card in credit against other cards' debt and counts opening balances; Reports floor each card at ₹0 and ignore opening balances. Every rupee of the gap is one of those two.",
      figures,
    });
  }
}

// --- Credit limits & shared limits ---

function checkLimits(cards: readonly CheckCard[], out: CheckFinding[]) {
  const byFacility = new Map<string, CheckCard[]>();
  for (const c of cards) {
    if (c.sharedLimitId != null && c.facilityResolved) byFacility.set(c.sharedLimitId, [...(byFacility.get(c.sharedLimitId) ?? []), c]);

    if (c.sharedLimitId != null && !c.facilityResolved) {
      out.push({
        id: `limit-unresolved:${c.cardId}`,
        area: "limits",
        status: c.ownLimit > 0 ? "suspected" : "confirmed",
        subject: c.name,
        title: "Card points to a shared limit that cannot be used",
        detail: "Its facility is missing, deleted or has no valid limit, so the card is treated as standalone with its own limit — often ₹0 for a shared-limit member. Available credit and utilization reflect that.",
        figures: [{ label: "Own limit used", value: c.ownLimit }],
      });
    } else if (c.effectiveLimit <= 0) {
      out.push({
        id: `limit-missing:${c.cardId}`,
        area: "limits",
        status: "confirmed",
        subject: c.name,
        title: "No credit limit set",
        detail: "The card's limit is ₹0, so available credit is ₹0 and utilization shows 0% whatever is owed.",
      });
    }

    if (c.effectiveLimit > 0) {
      const expectedAvailable = availableCredit({
        creditLimit: c.effectiveLimit,
        outstanding: c.outstanding,
        linkedEmiPrincipal: c.lockedEmiPrincipal,
        principalRestored: 0,
      });
      if (differs(expectedAvailable, c.available)) {
        out.push({
          id: `limit-available:${c.cardId}`,
          area: "limits",
          status: "confirmed",
          subject: c.name,
          title: "Available credit is not limit − outstanding − locked EMI principal",
          detail: "Recomputed with the same formula the card screen uses; the displayed value disagrees.",
          figures: [
            { label: "Displayed available", value: c.available },
            { label: "Recomputed", value: expectedAvailable },
          ],
        });
      }
      const expectedUtilization = creditUtilizationPercent(c.outstanding + c.lockedEmiPrincipal, c.effectiveLimit);
      if (differs(expectedUtilization, c.utilizationPercent, 0.05)) {
        out.push({
          id: `limit-utilization:${c.cardId}`,
          area: "limits",
          status: "confirmed",
          subject: c.name,
          title: "Utilization is not (outstanding + locked EMI) ÷ limit",
          detail: "Recomputed with the shared utilization formula; the displayed percentage disagrees.",
          figures: [
            { label: "Displayed %", value: c.utilizationPercent },
            { label: "Recomputed %", value: round2(expectedUtilization) },
          ],
        });
      }
      if (c.outstanding + c.lockedEmiPrincipal > c.effectiveLimit + TOL) {
        out.push({
          id: `limit-over:${c.cardId}`,
          area: "limits",
          status: "legitimate",
          subject: c.name,
          title: "Card is over its limit",
          detail: "Exposure exceeds the limit (fees, interest or an over-limit spend). Available credit correctly clamps to ₹0 and utilization shows above 100%.",
          figures: [{ label: "Over by", value: round2(c.outstanding + c.lockedEmiPrincipal - c.effectiveLimit) }],
        });
      }
    }

    if (c.sharedLimitId != null && c.facilityResolved && c.ownLimit > TOL && differs(c.ownLimit, c.effectiveLimit)) {
      out.push({
        id: `limit-own-ignored:${c.cardId}`,
        area: "limits",
        status: "legitimate",
        subject: c.name,
        title: "Card's own limit is ignored while it shares a facility",
        detail: "Only the facility's limit applies. The card's own stored limit would take effect again if it left the facility.",
        figures: [
          { label: "Card's own limit", value: c.ownLimit },
          { label: "Facility limit used", value: c.effectiveLimit },
        ],
      });
    }
  }

  for (const [facilityId, members] of byFacility) {
    const first = members[0];
    const mismatch = members.some((m) => differs(m.outstanding, first.outstanding) || differs(m.available, first.available) || differs(m.lockedEmiPrincipal, first.lockedEmiPrincipal) || differs(m.effectiveLimit, first.effectiveLimit));
    if (mismatch) {
      out.push({
        id: `limit-sibling-parity:${facilityId}`,
        area: "limits",
        status: "confirmed",
        subject: members.map((m) => m.name).join(" + "),
        title: "Cards on one shared limit report different pooled figures",
        detail: "Every card on a facility must show the same pooled outstanding, locked EMI principal, available credit and limit.",
        figures: members.map((m) => ({ label: m.name, value: m.available })),
      });
    }
  }
}

// --- Card EMI locking & utilization ---

function checkCardEmi(input: BalanceCheckInput, out: CheckFinding[]) {
  const { cards, utilizationEmis, agreements } = input;

  // Per facility (or standalone card): locked principal reported == Σ over member cards of the engine's lock.
  const groups = new Map<string, CheckCard[]>();
  for (const c of cards) {
    const key = c.sharedLimitId != null && c.facilityResolved ? `f:${c.sharedLimitId}` : `c:${c.cardId}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  for (const members of groups.values()) {
    const expected = round2(members.reduce((s, m) => s + lockedEmiPrincipalFor([...utilizationEmis], m.cardId), 0));
    for (const m of members) {
      if (differs(expected, m.lockedEmiPrincipal)) {
        out.push({
          id: `emi-lock:${m.cardId}`,
          area: "card-emi",
          status: "confirmed",
          subject: m.name,
          title: "Locked card-EMI principal does not match the open card-linked EMIs",
          detail: "Open, linked EMIs / card-funded loans whose purchase is not on the card must lock exactly their remaining principal against it.",
          figures: [
            { label: "Reported lock", value: m.lockedEmiPrincipal },
            { label: "Σ open linked EMIs", value: expected },
          ],
        });
      }
    }
  }

  for (const a of agreements) {
    if (a.linkedCardId != null && !a.linkedCardTracked) {
      out.push({
        id: `emi-link-untracked:${a.id}`,
        area: "card-emi",
        status: "legitimate",
        subject: a.name,
        title: "Linked card is not tracked in FlowFi",
        detail: "It is counted as an ordinary Loan/EMI liability instead of on a card. Not double-counted.",
      });
    }
    if (a.linkedCardTracked && a.isClosed && a.displayedOutstanding > TOL) {
      out.push({
        id: `emi-closed-remaining:${a.id}`,
        area: "card-emi",
        status: "suspected",
        subject: a.name,
        title: "Closed card-linked EMI still has principal",
        detail: "A closed EMI releases its card lock, and a card-owned EMI is left out of Loan/EMI debt — so this principal currently counts nowhere. Fine if it was genuinely settled; otherwise it is missing from debt and Net Worth.",
        figures: [{ label: "Remaining principal", value: a.displayedOutstanding }],
      });
    }
  }
}

// --- Loan / EMI outstanding consistency ---

function checkLoanEmi(agreements: readonly CheckAgreement[], out: CheckFinding[]) {
  for (const a of agreements) {
    const live = a.installments.filter((i) => i.deletedAt == null);

    const recomputed = a.kind === "loan"
      ? outstandingPrincipalAfterPrepaymentsFor(a.principalAmount, live, a.principalPrepaid)
      : outstandingPrincipalFor(a.principalAmount, live);
    if (differs(recomputed, a.displayedOutstanding)) {
      out.push({
        id: `outstanding-engine:${a.id}`,
        area: "loan-emi",
        status: "confirmed",
        subject: a.name,
        title: "Displayed remaining principal differs from the shared principal formula",
        detail: "Recomputed from the schedule with the one canonical function; the figure feeding Net Worth and the cards is different.",
        figures: [
          { label: "Displayed", value: a.displayedOutstanding },
          { label: "Recomputed", value: round2(recomputed) },
        ],
      });
    }

    const overpaid = live.find((i) => i.amountPaid > i.amountDue + TOL);
    if (overpaid) {
      out.push({
        id: `installment-overpaid:${a.id}`,
        area: "loan-emi",
        status: "confirmed",
        subject: a.name,
        title: "An installment is recorded as paid for more than it is due",
        detail: "A paid amount above the installment is capped by the engine, so principal is not double-counted, but the record is inconsistent.",
        figures: [{ label: "Paid − due", value: round2(overpaid.amountPaid - overpaid.amountDue) }],
      });
    }

    const scheduledPrincipal = round2(live.reduce((s, i) => s + (i.principalPortion ?? i.amountDue), 0) + a.principalPrepaid);
    const tolerance = Math.max(2, a.principalAmount * 0.001);
    if (live.length > 0 && Math.abs(scheduledPrincipal - a.principalAmount) > tolerance) {
      out.push({
        id: `schedule-principal:${a.id}`,
        area: "loan-emi",
        status: "suspected",
        subject: a.name,
        title: "Schedule principal does not add up to the loan principal",
        detail: "Principal shares of the active installments (plus extra principal) should total the principal. A re-plan, a skipped installment or a hand edit can legitimately cause this — confirm against the lender before trusting the remaining principal.",
        figures: [
          { label: "Principal", value: a.principalAmount },
          { label: "Σ scheduled principal", value: scheduledPrincipal },
        ],
      });
    }

    if (a.isClosed && a.displayedOutstanding > TOL && !a.linkedCardTracked) {
      out.push({
        id: `closed-with-principal:${a.id}`,
        area: "loan-emi",
        status: "suspected",
        subject: a.name,
        title: "Closed, but principal remains",
        detail: "The balance sheet still counts a closed item's remaining principal (closing is not the same as repaying). Check whether it was settled outside FlowFi.",
        figures: [{ label: "Remaining principal", value: a.displayedOutstanding }],
      });
    }

    const nothingScheduled = live.every((i) => i.isSkipped || i.amountPaid >= i.amountDue - TOL);
    if (!a.isClosed && a.displayedOutstanding > TOL && live.length > 0 && nothingScheduled) {
      out.push({
        id: `principal-unscheduled:${a.id}`,
        area: "loan-emi",
        status: "suspected",
        subject: a.name,
        title: "Principal remains but no installment is left to repay it",
        detail: "Every installment is paid or skipped, yet principal is outstanding (typically skipped installments). Nothing in the schedule will ever clear it.",
        figures: [{ label: "Remaining principal", value: a.displayedOutstanding }],
      });
    }
  }
}

export function runBalanceChecks(input: BalanceCheckInput): BalanceCheckReport {
  const findings: CheckFinding[] = [];
  checkCardBalances(input.cards, findings);
  checkDebtTotals(input, findings);
  checkLimits(input.cards, findings);
  checkCardEmi(input, findings);
  checkLoanEmi(input.agreements, findings);

  const summary: Record<CheckStatus, number> = { confirmed: 0, suspected: 0, legitimate: 0 };
  for (const f of findings) summary[f.status] += 1;
  const cards = input.cards.length;
  return {
    findings,
    summary,
    checked: {
      "card-balance": cards,
      "debt-totals": cards > 0 ? 1 : 0,
      limits: cards,
      "card-emi": cards + input.agreements.filter((a) => a.linkedCardId != null).length,
      "loan-emi": input.agreements.length,
    },
  };
}
