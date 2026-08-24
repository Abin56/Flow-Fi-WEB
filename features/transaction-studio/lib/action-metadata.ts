import {
  ArrowRightLeft,
  CalendarClock,
  EyeOff,
  Gift,
  Landmark,
  LineChart,
  Receipt,
  RotateCcw,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { RecordAction, RecordActionDetail, RecordFlowType, RecordModifiers, RecordOwnership, StagedRecord } from "@/lib/models/document-import";
import { DEFAULT_RECORD_MODIFIERS } from "@/lib/models/document-import";

/**
 * B30 — Category is only meaningful for money-movement flow types where "what
 * kind of spend/income is this" is a real question. `transfer` (moving your
 * own money between accounts), `debt_movement` (an EMI/loan already has its
 * own categorization via the linked record), and `ignore` have no such
 * question — forcing a Category choice on them is exactly the "meaningless
 * choice for transfers/EMI rows" the roadmap entry names. `investment_movement`
 * and `reversal` keep Category (a SIP debit or a refund still benefits from a
 * spend category), matching the review's flow-type list at workflow-review
 * §3 without inventing a new taxonomy.
 */
const FLOW_TYPES_WITHOUT_CATEGORY: ReadonlySet<RecordFlowType> = new Set(["transfer", "debt_movement", "ignore"]);

/** B30 — whether Category applies to a row with this flow type. `null` (not yet reviewed) is treated as applicable, so the default "needs a category" validation still fires until the reviewer sets a flow type. */
export function isCategoryApplicableForFlowType(flowType: RecordFlowType | null): boolean {
  if (flowType == null) return true;
  return !FLOW_TYPES_WITHOUT_CATEGORY.has(flowType);
}

export interface ActionMeta {
  label: string;
  /** Semantic color token group (from app/globals.css) — text-{tone}, bg-{tone}/10, border-{tone}/30. */
  tone: "success" | "expense" | "warning" | "danger" | "purple" | "royal" | "muted";
  group: "expense" | "income" | "linked" | "shortcut" | "ignore";
  /** Icon shown in the ActionCell pill — reuses the same choices `ContextualCell` already renders
   *  for transfer/shared/EMI-loan rows, so the two columns read consistently. */
  icon: LucideIcon;
}

/** Display metadata for every Action (architecture §5's table) — single source of truth for the ActionCell dropdown, contextual-column switch, and Inspector routing. */
export const ACTION_META: Record<RecordAction, ActionMeta> = {
  normal_expense: { label: "Normal Expense", tone: "expense", group: "expense", icon: Receipt },
  income: { label: "Income", tone: "success", group: "income", icon: TrendingUp },
  shared_expense: { label: "Shared Expense", tone: "purple", group: "expense", icon: Users },
  someone_elses_expense: { label: "Someone Else's Expense", tone: "purple", group: "expense", icon: Users },
  transfer: { label: "Transfer", tone: "royal", group: "linked", icon: ArrowRightLeft },
  existing_emi: { label: "Existing EMI", tone: "warning", group: "linked", icon: Landmark },
  create_emi: { label: "Create EMI", tone: "warning", group: "linked", icon: CalendarClock },
  existing_loan: { label: "Existing Loan", tone: "warning", group: "linked", icon: Landmark },
  create_loan: { label: "Create Loan", tone: "warning", group: "linked", icon: CalendarClock },
  recurring_bill: { label: "Recurring Bill", tone: "warning", group: "linked", icon: Landmark },
  investment: { label: "Investment", tone: "success", group: "shortcut", icon: LineChart },
  cashback: { label: "Cashback", tone: "success", group: "shortcut", icon: Gift },
  refund: { label: "Refund", tone: "success", group: "shortcut", icon: RotateCcw },
  ignore: { label: "Ignore", tone: "muted", group: "ignore", icon: EyeOff },
};

export const ACTION_GROUPS: { group: ActionMeta["group"]; label: string; actions: RecordAction[] }[] = [
  { group: "expense", label: "Expense", actions: ["normal_expense", "shared_expense", "someone_elses_expense", "income"] },
  { group: "linked", label: "Linked Payment", actions: ["transfer", "existing_emi", "create_emi", "existing_loan", "create_loan", "recurring_bill"] },
  { group: "shortcut", label: "Shortcuts", actions: ["investment", "cashback", "refund"] },
  { group: "ignore", label: "", actions: ["ignore"] },
];

const TONE_CLASSES: Record<ActionMeta["tone"], string> = {
  success: "border-success/30 bg-success/10 text-success",
  expense: "border-expense/30 bg-expense/10 text-expense",
  warning: "border-warning/30 bg-warning/10 text-warning",
  danger: "border-danger/30 bg-danger/10 text-danger",
  purple: "border-purple/30 bg-purple/10 text-purple",
  // Blue — matches the grid's Status badge, which already colors Transfer rows with `--royal`
  // (status-cell.tsx); this keeps "Transfer = blue" consistent everywhere the Action shows up.
  royal: "border-royal/30 bg-royal/10 text-royal",
  muted: "border-border bg-muted text-muted-foreground",
};

export function actionBadgeClassName(action: RecordAction | null): string {
  if (action == null) return TONE_CLASSES.muted;
  return TONE_CLASSES[ACTION_META[action].tone];
}

export function actionLabel(action: RecordAction | null): string {
  return action == null ? "Not reviewed" : ACTION_META[action].label;
}

/**
 * The sensible default Action for a row nobody's classified yet, based on nothing but which way the
 * money moved — the overwhelming common case for a personal-finance statement line is a plain debit
 * expense or incoming credit, not a transfer/EMI/shared expense. Single source of truth for both the
 * Classification header's default display (`FlowOwnershipHeader`) and the Manage modal's Save
 * behavior (`TransactionManageModal`) — a Details-only save (Amount/Category/etc., Flow Type never
 * touched) applies this exact default rather than leaving `flowType: null` and the row stuck at "No
 * Action Chosen" after the user visibly filled everything else in. Anything that isn't this common
 * case (Transfer, EMI/Loan, Shared, Ignore, …) still requires an explicit pick via the Classification
 * section, same as before — this only fills the gap for the default nobody explicitly disagreed with.
 */
export function defaultActionForDirection(direction: StagedRecord["direction"]): RecordAction {
  return direction === "credit" ? "income" : "normal_expense";
}

type ActionAxes = Pick<StagedRecord, "flowType" | "ownership" | "actionDetail" | "modifiers">;

/**
 * Derives the single Action-column value the UI presents (architecture §5)
 * from the underlying `flowType`/`ownership`/`actionDetail`/`modifiers` axes
 * (workflow review §3). Read-only projection — nothing stores this value;
 * every call recomputes it, so it can never drift from the axes the way the
 * old flat `action` field could drift from `owner` (workflow review §4).
 */
export function deriveRecordAction(record: ActionAxes): RecordAction | null {
  const { flowType, ownership, actionDetail, modifiers } = record;
  if (flowType == null) return null;

  switch (flowType) {
    case "expense":
      // Recurring is a modifier orthogonal to ownership (a shared recurring bill is representable in the schema),
      // but today's flat Action dropdown only has one "Recurring Bill" slot — prefer it only when ownership is
      // otherwise unset/"mine" so a shared/pass-through expense's ownership stays visible in the derived label.
      if (modifiers.recurring && (ownership == null || ownership === "mine")) return "recurring_bill";
      if (ownership === "shared") return "shared_expense";
      if (ownership === "someone_else") return "someone_elses_expense";
      return "normal_expense";
    case "income":
      if (actionDetail?.kind === "cashback") return "cashback";
      return "income";
    case "transfer":
      return "transfer";
    case "debt_movement":
      switch (actionDetail?.kind) {
        case "existing_emi":
          return "existing_emi";
        case "create_emi":
          return "create_emi";
        case "existing_loan":
          return "existing_loan";
        case "create_loan":
          return "create_loan";
        default:
          // `actionToAxesPatch` always sets one of the four detail kinds above the moment a debt_movement
          // Action is picked (see below) — this only fires for a debt_movement row with no detail at all,
          // which shouldn't happen via the UI, but falls back to the EMI shape rather than returning null.
          return "existing_emi";
      }
    case "investment_movement":
      return "investment";
    case "reversal":
      return "refund";
    case "ignore":
      return "ignore";
  }
}

/**
 * `debt_movement`'s four sub-choices (and `recurring_bill`'s bill link) are
 * only distinguishable via `actionDetail.kind` — unlike `ownership`, there's
 * no dedicated axis field for "which specific debt shape." Picking one from
 * the dropdown has to stamp a placeholder of the right `kind` immediately
 * (empty id / zeroed amounts), or the row becomes indistinguishable from
 * any other `debt_movement` row the instant `actionDetail` is cleared. The
 * Inspector overwrites this placeholder with real values once the user
 * finishes the flow (`contextual-cell.tsx` already treats an empty
 * `emiId`/`loanId`/`billId` as "chosen but not yet linked").
 */
const ACTION_DETAIL_PLACEHOLDERS: Partial<Record<RecordAction, RecordActionDetail>> = {
  existing_emi: { kind: "existing_emi", emiId: "" },
  create_emi: { kind: "create_emi", name: "", principalAmount: 0, interestRatePercent: null, months: 0, startDate: new Date() },
  existing_loan: { kind: "existing_loan", loanId: "" },
  create_loan: { kind: "create_loan", name: "", loanAmount: 0, interestRatePercent: null, months: null, startDate: new Date(), personId: "" },
  recurring_bill: { kind: "recurring_bill", billId: "" },
  cashback: { kind: "cashback" },
};

/**
 * The inverse of `deriveRecordAction` — the write-side patch for picking an
 * Action in the dropdown/bulk-assign UI. Always resets `modifiers` to the
 * defaults for the chosen Action (a fresh pick shouldn't inherit a stale
 * modifier from whatever the row was before), except `recurring_bill`,
 * which is itself just "expense + the recurring modifier" under the new
 * axis split. `detail` defaults to the Action's placeholder (see
 * `ACTION_DETAIL_PLACEHOLDERS`) so the discriminator survives until the
 * Inspector fills in real values, matching every Action that needs one.
 */
export function actionToAxesPatch(
  action: RecordAction,
  detail?: RecordActionDetail | null,
): { flowType: RecordFlowType; ownership: RecordOwnership | null; modifiers: RecordModifiers; actionDetail: RecordActionDetail | null } {
  const resolvedDetail = detail !== undefined ? detail : (ACTION_DETAIL_PLACEHOLDERS[action] ?? null);
  switch (action) {
    case "normal_expense":
      return { flowType: "expense", ownership: "mine", modifiers: DEFAULT_RECORD_MODIFIERS, actionDetail: resolvedDetail };
    case "income":
      return { flowType: "income", ownership: "mine", modifiers: DEFAULT_RECORD_MODIFIERS, actionDetail: resolvedDetail };
    case "shared_expense":
      return { flowType: "expense", ownership: "shared", modifiers: DEFAULT_RECORD_MODIFIERS, actionDetail: resolvedDetail };
    case "someone_elses_expense":
      return { flowType: "expense", ownership: "someone_else", modifiers: DEFAULT_RECORD_MODIFIERS, actionDetail: resolvedDetail };
    case "transfer":
      return { flowType: "transfer", ownership: null, modifiers: DEFAULT_RECORD_MODIFIERS, actionDetail: resolvedDetail };
    case "existing_emi":
    case "create_emi":
    case "existing_loan":
    case "create_loan":
      return { flowType: "debt_movement", ownership: null, modifiers: DEFAULT_RECORD_MODIFIERS, actionDetail: resolvedDetail };
    case "recurring_bill":
      return { flowType: "expense", ownership: "mine", modifiers: { ...DEFAULT_RECORD_MODIFIERS, recurring: true }, actionDetail: resolvedDetail };
    case "investment":
      return { flowType: "investment_movement", ownership: null, modifiers: DEFAULT_RECORD_MODIFIERS, actionDetail: resolvedDetail };
    case "cashback":
      return { flowType: "income", ownership: "mine", modifiers: DEFAULT_RECORD_MODIFIERS, actionDetail: resolvedDetail };
    case "refund":
      return { flowType: "reversal", ownership: null, modifiers: DEFAULT_RECORD_MODIFIERS, actionDetail: resolvedDetail };
    case "ignore":
      return { flowType: "ignore", ownership: null, modifiers: DEFAULT_RECORD_MODIFIERS, actionDetail: resolvedDetail };
  }
}

/**
 * Inverse of the Ownership axis's read side — the write-side patch for the
 * grid's Ownership segmented control. Shares `flow-ownership-header.tsx`'s
 * mapping (that Inspector component imports this instead of keeping its own
 * copy) so the two Ownership editors can never drift apart on what "Shared"
 * or "Someone Else's" resolves to.
 */
export function ownershipToAction(ownership: RecordOwnership): RecordAction {
  switch (ownership) {
    case "mine":
      return "normal_expense";
    case "shared":
      return "shared_expense";
    case "someone_else":
      return "someone_elses_expense";
  }
}

export type AmountTone = "expense" | "income" | "refund" | "transfer";

/**
 * The Amount cell's 4-way color (expense=red/income=green/refund=blue/
 * transfer=purple, per the redesign brief) — driven by `flowType` where it's
 * set, falling back to the original 2-way debit/credit `direction` check for
 * rows with no `flowType` yet (unreviewed) or flow types the brief didn't
 * name a color for (debt movement, investment movement, ignore).
 */
export function amountToneForRow(row: Pick<StagedRecord, "flowType" | "direction">): AmountTone {
  switch (row.flowType) {
    case "reversal":
      return "refund";
    case "transfer":
      return "transfer";
    case "income":
      return "income";
    case "expense":
      return "expense";
    default:
      return row.direction === "credit" ? "income" : "expense";
  }
}

/**
 * B6 — Action/detail consistency validation. `deriveRecordAction` already
 * tolerates a `debt_movement` row with no `actionDetail` by falling back to
 * `existing_emi`'s shape (see its own comment) so the UI never crashes, but
 * that fallback must not silently reach commit with an empty `emiId`/
 * `loanId`/`billId` — this is the check that turns "silently wrong" into "a
 * hard block," which is the entire point of B6 (same class of gap as B5).
 * Checks two independent things: the `actionDetail.kind` actually agrees
 * with the derived Action (closes the exact `owner`/`action` disagreement
 * class workflow review §4 describes, now expressed as `flowType`/
 * `ownership` vs. `actionDetail.kind` instead of two free-standing fields),
 * and that a detail requiring a linked-record id has a non-empty one.
 */
export function actionDetailConsistencyError(row: Pick<StagedRecord, "flowType" | "ownership" | "actionDetail" | "modifiers">): string | null {
  const action = deriveRecordAction(row);
  if (action == null) return null;

  const detail = row.actionDetail;
  switch (action) {
    case "existing_emi":
      if (detail?.kind !== "existing_emi") return `Action "Existing EMI" requires EMI details — open this row's Inspector to finish setting it up.`;
      if (!detail.emiId) return `Action "Existing EMI" has no EMI linked — open this row's Inspector to pick one.`;
      return null;
    case "existing_loan":
      if (detail?.kind !== "existing_loan") return `Action "Existing Loan" requires loan details — open this row's Inspector to finish setting it up.`;
      if (!detail.loanId) return `Action "Existing Loan" has no loan linked — open this row's Inspector to pick one.`;
      return null;
    case "create_emi":
      if (detail?.kind !== "create_emi") return `Action "Create EMI" requires EMI terms — open this row's Inspector to finish setting it up.`;
      if (!detail.name || detail.principalAmount <= 0 || detail.months <= 0) return `Action "Create EMI" has incomplete terms — open this row's Inspector to finish setting it up.`;
      return null;
    case "create_loan":
      if (detail?.kind !== "create_loan") return `Action "Create Loan" requires loan terms — open this row's Inspector to finish setting it up.`;
      if (!detail.name || !detail.personId || detail.loanAmount <= 0) return `Action "Create Loan" has incomplete terms — open this row's Inspector to finish setting it up.`;
      return null;
    case "transfer":
      if (detail?.kind !== "transfer" || !detail.destinationAccountId) return `Action "Transfer" has no destination account — open this row's Inspector to pick one.`;
      return null;
    case "shared_expense":
      if (detail?.kind !== "shared_expense" || detail.participants.length === 0) return `Action "Shared Expense" has no participants — open this row's Inspector to finish setting it up.`;
      if (row.ownership !== "shared") return `Row disagrees with itself: Action is "Shared Expense" but ownership is "${row.ownership ?? "unset"}".`;
      return null;
    case "someone_elses_expense":
      if (detail?.kind !== "someone_elses_expense" || (!detail.personId && !detail.personName)) return `Action "Someone Else's Expense" has no person chosen — open this row's Inspector to pick one.`;
      if (row.ownership !== "someone_else") return `Row disagrees with itself: Action is "Someone Else's Expense" but ownership is "${row.ownership ?? "unset"}".`;
      return null;
    case "normal_expense":
    case "recurring_bill":
      if (row.ownership !== "mine") return `Row disagrees with itself: Action is "${ACTION_META[action].label}" but ownership is "${row.ownership ?? "unset"}", not "mine".`;
      return null;
    default:
      return null;
  }
}
