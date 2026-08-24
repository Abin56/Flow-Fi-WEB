"use client";

import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { RecordAction } from "@/lib/models/document-import";
import { defaultActionForDirection, deriveRecordAction, ownershipToAction } from "../../lib/action-metadata";
import type { GridRow } from "../../lib/grid-types";

type FlowTypeOption = "expense" | "income" | "transfer" | "debt" | "investment" | "refund" | "ignore";
type OwnershipOption = "mine" | "shared" | "someone_else";

const FLOW_TYPE_OPTIONS: { value: FlowTypeOption; label: string }[] = [
  { value: "expense", label: "Expense" },
  { value: "income", label: "Income" },
  { value: "transfer", label: "Transfer" },
  { value: "debt", label: "EMI / Loan" },
  { value: "investment", label: "Investment" },
  { value: "refund", label: "Refund" },
  { value: "ignore", label: "Ignore" },
];

const OWNERSHIP_OPTIONS: { value: OwnershipOption; label: string }[] = [
  { value: "mine", label: "Personal" },
  { value: "shared", label: "Shared" },
  { value: "someone_else", label: "Someone Else's" },
];

/**
 * `null` only when this row hasn't been reviewed yet (`action == null` — every real `RecordAction`
 * is covered by a case above) — must NOT fall back to `"expense"` here. That used to make an
 * unreviewed row's Flow Type select *display* "Expense" (and Ownership "Personal") even though
 * nothing had actually been chosen and `row.flowType` was still `null` in Firestore. Since the
 * dropdown already looked filled in, there was nothing prompting the user to touch it — so it never
 * fired `onCommitAction`, flowType stayed `null`, and the row kept showing "No Action Chosen" even
 * after saving other Details-section edits (Category, etc.), silently contradicting what this same
 * modal's own Action badge said ("Not reviewed"). Returning `null` lets the caller render a real
 * empty placeholder instead of a false default.
 */
function flowTypeOptionForAction(action: RecordAction | null): FlowTypeOption | null {
  switch (action) {
    case "normal_expense":
    case "shared_expense":
    case "someone_elses_expense":
    case "recurring_bill":
      return "expense";
    case "income":
    case "cashback":
      return "income";
    case "transfer":
      return "transfer";
    case "existing_emi":
    case "create_emi":
    case "existing_loan":
    case "create_loan":
      return "debt";
    case "investment":
      return "investment";
    case "refund":
      return "refund";
    case "ignore":
      return "ignore";
    default:
      return null;
  }
}

function ownershipValueForAction(action: RecordAction | null): OwnershipOption {
  if (action === "shared_expense") return "shared";
  if (action === "someone_elses_expense") return "someone_else";
  return "mine";
}

const DEFAULT_ACTION_FOR_FLOW_TYPE: Record<Exclude<FlowTypeOption, "expense">, RecordAction> = {
  income: "income",
  transfer: "transfer",
  debt: "existing_emi",
  investment: "investment",
  refund: "refund",
  ignore: "ignore",
};

/**
 * A friendlier two-select front-end over the same Action axes `ActionCell`'s combobox writes.
 * Every change here goes through the caller's `onCommitAction`, which (in `RightSidebar`) routes
 * through `actionToAxesPatch` — the same axis-consistency-safe path the grid's Action dropdown
 * and bulk-action bar already use, so this can never produce a Flow Type/Ownership combination
 * the rest of the workspace (commit validation, B6's consistency check) doesn't already handle.
 * The ownership→Action mapping itself is `ownershipToAction` (`action-metadata.ts`), shared with
 * the grid's Ownership cell so the two editors can never resolve "Shared"/"Someone Else's" differently.
 */
export function FlowOwnershipHeader({ row, onCommitAction }: { row: GridRow; onCommitAction: (action: RecordAction) => void }) {
  const action = deriveRecordAction(row);
  // Unreviewed (`action == null`): pre-select the sensible default (`defaultActionForDirection`)
  // rather than showing an empty picker — most rows are a plain expense/income, and this default is
  // real, not cosmetic: `TransactionManageModal`'s Save applies the exact same default if Flow Type
  // is never touched, so what's shown here always matches what a Details-only save will actually
  // commit. Explicitly picking a different Flow Type (Transfer, EMI/Loan, …) still commits instantly
  // via `onCommitAction`, same as before.
  const flowType = flowTypeOptionForAction(action) ?? flowTypeOptionForAction(defaultActionForDirection(row.direction))!;
  const ownership = ownershipValueForAction(action);

  function handleFlowTypeChange(next: FlowTypeOption) {
    onCommitAction(next === "expense" ? "normal_expense" : DEFAULT_ACTION_FOR_FLOW_TYPE[next]);
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <Label className="mb-1.5 block text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Flow Type</Label>
        <Select value={flowType} onValueChange={(v) => handleFlowTypeChange(v as FlowTypeOption)}>
          <SelectTrigger className="w-full border-foreground/15">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FLOW_TYPE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label className="mb-1.5 block text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Ownership</Label>
        <Select
          disabled={flowType !== "expense"}
          value={ownership}
          onValueChange={(v) => onCommitAction(ownershipToAction(v as OwnershipOption))}
        >
          <SelectTrigger className="w-full border-foreground/15">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OWNERSHIP_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
