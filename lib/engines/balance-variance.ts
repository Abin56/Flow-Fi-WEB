/**
 * READ-ONLY variance calculator: FlowFi's calculated figure versus a figure the user types from a bank / lender
 * statement. Pure — nothing is stored, applied or written, and no existing engine is changed. The bank figure
 * exists only in component state.
 *
 * Definitions are deliberately NOT conflated (balance-control audit §2):
 *  - Total outstanding  = everything owed on the card, billed + unbilled, plus card-EMI principal FlowFi keeps
 *                         locked against the limit (`outstanding + lockedEmiPrincipal`).
 *  - Statement balance  = the total of the LATEST CLOSED statement (what that bill came to), not what is owed now.
 *  - Remaining principal = loan / EMI principal still to repay (`outstandingPrincipal*`). Never interest.
 *  - Lender payoff      = principal + accrued interest + charges. FlowFi does not model it, so it is never
 *                         "calculated": the bank's payoff can only be sanity-checked against the principal floor.
 */

export type VarianceMetric =
  | "creditLimit"
  | "totalOutstanding"
  | "statementBalance"
  | "availableCredit"
  | "loanPrincipal"
  | "emiPrincipal"
  | "lenderPayoff";

export type VarianceClass =
  | "match"
  | "rounding"
  | "notEntered"
  | "notComparable"
  | "limitDiffers"
  | "bankHigher"
  | "bankLower"
  | "emiLockExplains"
  | "payoffImplied"
  | "payoffBelowPrincipal";

export type VarianceSeverity = "ok" | "info" | "review";

export const VARIANCE_METRIC_LABEL: Record<VarianceMetric, string> = {
  creditLimit: "Credit limit",
  totalOutstanding: "Total outstanding",
  statementBalance: "Statement balance",
  availableCredit: "Available credit",
  loanPrincipal: "Remaining principal",
  emiPrincipal: "Remaining principal",
  lenderPayoff: "Lender payoff amount",
};

/** One-line definition shown under the metric — the distinction the user must not lose. */
export const VARIANCE_METRIC_DEFINITION: Record<VarianceMetric, string> = {
  creditLimit: "Approved limit (pooled facility limit for shared cards).",
  totalOutstanding: "FlowFi's figure: billed + unbilled + card-EMI principal. Not the statement balance.",
  statementBalance: "Total of the latest closed statement in FlowFi. Not what is owed today.",
  availableCredit: "FlowFi's figure: limit − total outstanding. Banks may count differently.",
  loanPrincipal: "Principal left to repay. No interest, no charges.",
  emiPrincipal: "Principal left to repay. No interest, no charges.",
  lenderPayoff: "A lender's payoff may add interest and charges. FlowFi only knows the principal floor.",
};

/** A difference up to this many rupees is treated as bank rounding rather than a real gap. */
export const ROUNDING_TOLERANCE = 1;

const PAISE = 0.005;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Facts about the product that let a difference be explained without guessing. */
export interface VarianceContext {
  /** Card-EMI principal FlowFi keeps locked against the card (0 when none). */
  lockedEmiPrincipal?: number;
}

export interface VarianceInput {
  metric: VarianceMetric;
  /** FlowFi's calculated figure, or null when FlowFi has no such figure (e.g. lender payoff). */
  flowfi: number | null;
  /** The figure the user typed; null / NaN means nothing entered yet. */
  bank: number | null;
  context?: VarianceContext;
}

export interface VarianceResult {
  metric: VarianceMetric;
  flowfi: number | null;
  bank: number | null;
  /** bank − FlowFi (positive: the bank reports more). Null until both sides exist. */
  difference: number | null;
  classification: VarianceClass;
  severity: VarianceSeverity;
  /** Short chip text. */
  label: string;
  /** One sentence naming the likely, NON-assumed causes — never an instruction to adjust. */
  hint: string;
}

const LABEL: Record<VarianceClass, string> = {
  match: "Matches",
  rounding: "Rounding",
  notEntered: "Enter bank figure",
  notComparable: "Not comparable",
  limitDiffers: "Limit differs",
  bankHigher: "Bank higher",
  bankLower: "Bank lower",
  emiLockExplains: "Card-EMI lock",
  payoffImplied: "Interest & charges",
  payoffBelowPrincipal: "Below principal",
};

function result(input: VarianceInput, difference: number | null, classification: VarianceClass, severity: VarianceSeverity, hint: string): VarianceResult {
  return {
    metric: input.metric,
    flowfi: input.flowfi,
    bank: input.bank,
    difference,
    classification,
    severity,
    label: LABEL[classification],
    hint,
  };
}

const isNumber = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

export function compareFigure(input: VarianceInput): VarianceResult {
  const { metric, flowfi, bank } = input;

  if (!isNumber(bank)) return result(input, null, "notEntered", "info", "Type the figure from your statement or lender app.");

  // Lender payoff: FlowFi has no calculated payoff. Only the principal floor is meaningful, and that is
  // supplied by the caller as `flowfi` (remaining principal) — compared as a lower bound, never as equality.
  if (metric === "lenderPayoff") {
    if (!isNumber(flowfi)) return result(input, null, "notComparable", "info", "FlowFi has no remaining principal to compare this payoff with.");
    const implied = round2(bank - flowfi);
    if (implied < -ROUNDING_TOLERANCE) {
      return result(input, implied, "payoffBelowPrincipal", "review", "A payoff should not be below the principal. Either a principal payment is not recorded here, or the figure is not a payoff.");
    }
    return result(input, implied, "payoffImplied", "info", "Difference above the principal is interest and charges the lender adds — FlowFi does not track them, so this is not an error.");
  }

  if (!isNumber(flowfi)) return result(input, null, "notComparable", "info", "FlowFi has no calculated figure for this product.");

  const difference = round2(bank - flowfi);
  const abs = Math.abs(difference);
  if (abs < PAISE) return result(input, 0, "match", "ok", "FlowFi and the bank agree.");
  if (abs <= ROUNDING_TOLERANCE) return result(input, difference, "rounding", "ok", "Within ₹1 — bank rounding, not a real gap.");

  if (metric === "creditLimit") {
    return result(input, difference, "limitDiffers", "review", "The limit is a setting, not a calculation. The bank may have raised or lowered it, or FlowFi still holds the old one.");
  }

  const locked = input.context?.lockedEmiPrincipal ?? 0;
  if ((metric === "totalOutstanding" || metric === "availableCredit") && locked > PAISE && Math.abs(abs - locked) <= ROUNDING_TOLERANCE) {
    return result(
      input,
      difference,
      "emiLockExplains",
      "info",
      metric === "totalOutstanding"
        ? "The difference equals the card-EMI principal FlowFi counts against this card. The bank may list it separately."
        : "The difference equals the card-EMI principal FlowFi keeps locked. The bank may not lock it against the limit.",
    );
  }

  const higher = difference > 0;
  const hints: Record<VarianceMetric, [string, string]> = {
    creditLimit: ["", ""],
    totalOutstanding: [
      "Possible unrecorded fees, GST or interest; spend not yet entered; or an opening outstanding from before FlowFi.",
      "Possible payment or refund recorded at the bank but not here, or a pending credit.",
    ],
    statementBalance: [
      "Possible fees, GST or interest on that statement, or spend dated in another cycle.",
      "Possible refund or credit on that statement not recorded here.",
    ],
    availableCredit: [
      "Bank has more headroom: lower outstanding at the bank, a higher limit, or EMI principal not locked there.",
      "Bank has less headroom: higher outstanding at the bank, a lower limit, or holds that FlowFi cannot see.",
    ],
    loanPrincipal: [
      "Bank shows more principal: an extra disbursement, a missed payment here, or interest capitalised by the lender.",
      "Bank shows less principal: a prepayment or part-payment not recorded here.",
    ],
    emiPrincipal: [
      "Bank shows more principal: a payment recorded here that the lender has not applied, or capitalised charges.",
      "Bank shows less principal: a prepayment the lender applied that FlowFi cannot represent for EMIs.",
    ],
    lenderPayoff: ["", ""],
  };
  return result(input, difference, higher ? "bankHigher" : "bankLower", "review", hints[metric][higher ? 0 : 1]);
}

// --- What a FUTURE correction would touch (preview only; nothing here applies anything) ---

export type ImpactArea =
  | "Accounts"
  | "Card outstanding"
  | "Available credit"
  | "Utilization"
  | "Card bills"
  | "Loan/EMI schedule"
  | "Paid installments"
  | "People"
  | "Net Worth"
  | "Dashboard & Reports"
  | "Transaction history";

export interface ImpactPreview {
  /** Areas a correction of this kind would have to change. */
  wouldChange: ImpactArea[];
  /** Areas it must leave exactly as they are. */
  mustNotChange: ImpactArea[];
}

const ALL_AREAS: ImpactArea[] = [
  "Accounts",
  "Card outstanding",
  "Available credit",
  "Utilization",
  "Card bills",
  "Loan/EMI schedule",
  "Paid installments",
  "People",
  "Net Worth",
  "Dashboard & Reports",
  "Transaction history",
];

function split(change: ImpactArea[]): ImpactPreview {
  return { wouldChange: change, mustNotChange: ALL_AREAS.filter((a) => !change.includes(a)) };
}

/** From the Phase A impact matrix. `null` when no correction is implied (match / rounding / not entered / informational). */
export function impactPreviewFor(metric: VarianceMetric, classification: VarianceClass): ImpactPreview | null {
  switch (classification) {
    case "match":
    case "rounding":
    case "notEntered":
    case "notComparable":
    case "payoffImplied":
    case "emiLockExplains":
      return null;
    default:
      break;
  }
  switch (metric) {
    case "creditLimit":
      return split(["Available credit", "Utilization", "Dashboard & Reports"]);
    case "totalOutstanding":
      return split(["Accounts", "Card outstanding", "Available credit", "Utilization", "Card bills", "Net Worth", "Dashboard & Reports"]);
    case "statementBalance":
      return split(["Card bills", "Card outstanding", "Available credit", "Utilization", "Accounts", "Net Worth", "Dashboard & Reports"]);
    case "availableCredit":
      // Available is derived, so it can only move through its inputs; the preview names the likely ones.
      return split(["Available credit", "Utilization", "Dashboard & Reports"]);
    case "loanPrincipal":
    case "emiPrincipal":
      // A card-funded loan/EMI would also move that card's available credit and utilization; the product
      // row says so, because it depends on the product, not on the metric.
      return split(["Loan/EMI schedule", "Net Worth", "Dashboard & Reports"]);
    case "lenderPayoff":
      return null;
  }
}
