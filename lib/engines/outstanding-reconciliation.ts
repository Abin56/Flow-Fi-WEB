/**
 * Balance Control's outstanding / available-credit reconciliation guide — READ-ONLY. Given a bank-reported
 * figure that differs from FlowFi's, it classifies the possible causes and tells the caller which existing
 * workflow (if any) resolves each one. It never writes anything and never invents a transaction — every cause
 * either points at an already-safe existing flow (Add Expense, Pay bill, the Phase-1 credit-limit correction)
 * or is explained as a legitimate, non-correctable difference (card-EMI lock, shared-limit pooling, statement
 * timing), or is left for manual review when nothing here can explain it.
 *
 * This module only enumerates and labels causes; `build-outstanding-reconciliation.ts` supplies the live data
 * (existing transactions, locked EMI principal, shared-limit membership) that turns a cause into a concrete
 * next step for one specific card.
 */

export type OutstandingReconciliationCause =
  | "missingPurchase"
  | "interestCharge"
  | "gst"
  | "lateFee"
  | "otherCharge"
  | "missingPayment"
  | "refundOrCredit"
  | "cardEmiOrSharedLimit"
  | "statementTiming"
  | "openingOutstanding"
  | "unknown";

export const RECONCILIATION_CAUSE_LABEL: Record<OutstandingReconciliationCause, string> = {
  missingPurchase: "Missing purchase",
  interestCharge: "Interest charge",
  gst: "GST",
  lateFee: "Late fee",
  otherCharge: "Other bank charge",
  missingPayment: "Missing payment",
  refundOrCredit: "Refund or credit",
  cardEmiOrSharedLimit: "Card-linked EMI or shared limit",
  statementTiming: "Statement-date or pending-transaction timing",
  openingOutstanding: "Opening outstanding discrepancy",
  unknown: "Unknown — needs review",
};

/** What resolving a cause actually involves — never "write it here." */
export type ReconciliationResolution =
  | { kind: "addExpense"; description: string }
  | { kind: "addPayment"; description: string }
  | { kind: "payBill"; description: string }
  | { kind: "correctLimit"; description: string }
  | { kind: "explainedNoAction"; description: string }
  | { kind: "reviewOnly"; description: string };

export interface ReconciliationCauseOption {
  cause: OutstandingReconciliationCause;
  label: string;
  /** One sentence describing when this cause applies, shown under the option. */
  hint: string;
  resolution: ReconciliationResolution;
}

/**
 * The standard set of cause options for a total-outstanding or available-credit gap, in the order the user
 * should scan them (most common first). `bank > flowfi` and `bank < flowfi` share the same cause list — only
 * the hint text differs for directional causes (missing purchase only explains a HIGHER bank figure; a missing
 * payment only explains a LOWER one) — callers filter with `applicableCauses`.
 */
export function allReconciliationCauses(): OutstandingReconciliationCause[] {
  return [
    "missingPurchase",
    "interestCharge",
    "gst",
    "lateFee",
    "otherCharge",
    "missingPayment",
    "refundOrCredit",
    "cardEmiOrSharedLimit",
    "statementTiming",
    "openingOutstanding",
    "unknown",
  ];
}

/**
 * Which causes make sense for the SIGN of this gap. `bankHigher`: the bank reports more owed / less available
 * — explained by something FlowFi is missing (a charge or fee) or doesn't lock. `bankLower`: the bank reports
 * less owed / more available — explained by a payment or credit FlowFi hasn't recorded.
 */
export function applicableCauses(direction: "bankHigher" | "bankLower"): OutstandingReconciliationCause[] {
  const directional: Record<"bankHigher" | "bankLower", OutstandingReconciliationCause[]> = {
    bankHigher: ["missingPurchase", "interestCharge", "gst", "lateFee", "otherCharge", "openingOutstanding"],
    bankLower: ["missingPayment", "refundOrCredit"],
  };
  return [...directional[direction], "cardEmiOrSharedLimit", "statementTiming", "unknown"];
}

export interface ReconciliationContext {
  cardAccountId: string;
  /** Absolute difference (bank − FlowFi), already resolved to a positive magnitude by the caller. */
  amount: number;
  /** Card-EMI principal FlowFi locks against this card (0 when none). */
  lockedEmiPrincipal: number;
  /** This card draws from a shared facility. */
  onSharedLimit: boolean;
  /** The account has a non-zero legacy opening balance. */
  hasOpeningBalance: boolean;
}

function money(n: number): string {
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

/** Builds one cause option, with a resolution that reflects THIS card's actual state (locked EMI, shared limit, opening balance). */
export function describeCause(cause: OutstandingReconciliationCause, ctx: ReconciliationContext): ReconciliationCauseOption {
  const label = RECONCILIATION_CAUSE_LABEL[cause];
  switch (cause) {
    case "missingPurchase":
      return {
        cause, label,
        hint: "A purchase on this card was never entered in FlowFi.",
        resolution: { kind: "addExpense", description: `Add the missing purchase as an expense on this card for ${money(ctx.amount)} (or the real amount, once you check the statement).` },
      };
    case "interestCharge":
      return {
        cause, label,
        hint: "The bank charged interest on a carried balance; FlowFi doesn't calculate interest.",
        resolution: { kind: "addExpense", description: `Record the interest as an expense on this card (category: Interest/Finance charges) for ${money(ctx.amount)}.` },
      };
    case "gst":
      return {
        cause, label,
        hint: "GST on fees or interest, billed separately from the purchase.",
        resolution: { kind: "addExpense", description: `Record the GST as an expense on this card for ${money(ctx.amount)}.` },
      };
    case "lateFee":
      return {
        cause, label,
        hint: "A late-payment fee the bank charged after a missed due date.",
        resolution: { kind: "addExpense", description: `Record the late fee as an expense on this card for ${money(ctx.amount)}.` },
      };
    case "otherCharge":
      return {
        cause, label,
        hint: "Any other bank charge not covered above (annual fee, cash-advance fee, forex markup, …).",
        resolution: { kind: "addExpense", description: `Record the charge as an expense on this card for ${money(ctx.amount)}, with a note on what it was.` },
      };
    case "missingPayment":
      return {
        cause, label,
        hint: "A bill payment reached the bank but was never recorded in FlowFi.",
        resolution: { kind: "payBill", description: `Record the payment through Pay bill on this card for ${money(ctx.amount)} — this keeps it a transfer, never an ordinary expense.` },
      };
    case "refundOrCredit":
      return {
        cause, label,
        hint: "A refund or credit the bank applied that FlowFi hasn't recorded.",
        resolution: { kind: "addPayment", description: `Record the refund as an income/credit transaction on this card for ${money(ctx.amount)}.` },
      };
    case "cardEmiOrSharedLimit":
      return ctx.lockedEmiPrincipal > 0 || ctx.onSharedLimit
        ? {
            cause, label,
            hint: ctx.onSharedLimit
              ? "This card shares its limit with another card — the bank may report a per-card figure FlowFi pools."
              : `FlowFi locks ${money(ctx.lockedEmiPrincipal)} of card-EMI principal against this card; the bank may not.`,
            resolution: { kind: "explainedNoAction", description: "This is a difference in definition, not an error — nothing to correct here." },
          }
        : {
            cause, label,
            hint: "Would explain the gap if this card had a locked card-EMI or a shared limit — neither applies here.",
            resolution: { kind: "reviewOnly", description: "Doesn't apply to this card. If you believe it should, check the EMI's card link or the card's shared-limit setting." },
          };
    case "statementTiming":
      return {
        cause, label,
        hint: "A transaction posted on a different date at the bank than in FlowFi, or is still pending at the bank.",
        resolution: { kind: "explainedNoAction", description: "Often resolves itself once the pending transaction settles — check again after a day or two before correcting anything." },
      };
    case "openingOutstanding":
      return ctx.hasOpeningBalance
        ? {
            cause, label,
            hint: "A legacy opening balance on this card predates FlowFi tracking its transactions.",
            resolution: { kind: "correctLimit", description: "This needs a decision on the opening balance itself — see the Balance Control finding for this card in Financial Audit, not a new transaction." },
          }
        : {
            cause, label,
            hint: "Would explain the gap if this card had an opening balance — it doesn't.",
            resolution: { kind: "reviewOnly", description: "Doesn't apply: this card has no opening balance on file." },
          };
    case "unknown":
      return {
        cause, label,
        hint: "None of the above explains it, or you're not sure.",
        resolution: { kind: "reviewOnly", description: "Left for review. No transaction is created and nothing is changed — recheck the statement, or flag it to look at again later." },
      };
  }
}

/** Every applicable cause for this gap, each described against the card's actual state. */
export function reconciliationCausesFor(direction: "bankHigher" | "bankLower", ctx: ReconciliationContext): ReconciliationCauseOption[] {
  return applicableCauses(direction).map((c) => describeCause(c, ctx));
}
