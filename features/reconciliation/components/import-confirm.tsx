"use client";

/**
 * The explicit confirmation an import needs — acknowledgement (when FlowFi has a similar transaction), category, credit
 * kind (refund / income) and the own-account check. It only builds the draft patch for an "Import as transaction"
 * decision; nothing is written until the final approval.
 */

import { useId, useState } from "react";
import { cn } from "@/lib/utils";
import { ClayButton } from "@/components/clay/clay-button";
import { Checkbox } from "@/components/ui/checkbox";
import type { Category } from "@/lib/models/category";
import type { ReconRow, RowDecision } from "../lib/types";
import { categoriesForDirection } from "./recon-row-editor";

export interface ImportPatch {
  notSameAck: boolean;
  category: string | null;
  creditAs: RowDecision["creditAs"];
  /** P0: the explicit "not to/from my own account or card" on an ambiguous NEFT / IMPS / UPI line. */
  notOwnTransferAck: boolean;
}

/** The explicit confirmation Keep both / Import new need: acknowledgement (when a match exists), category, credit kind. */
export function ImportConfirm({ row, decision, categories, needsAck, ownTransferConfirm, label, onConfirm, onCancel }: { row: ReconRow; decision: RowDecision; categories: Category[]; needsAck: boolean; ownTransferConfirm: string | null; label: string; onConfirm: (patch: ImportPatch) => void; onCancel: () => void }) {
  const id = useId();
  const options = categoriesForDirection(categories, row.direction);
  const [ack, setAck] = useState(decision.kind === "import_new" && decision.notSameAck);
  const [category, setCategory] = useState<string>(decision.category ?? "");
  const [creditAs, setCreditAs] = useState<RowDecision["creditAs"]>(decision.creditAs ?? null);
  const [notOwn, setNotOwn] = useState(decision.kind === "import_new" && decision.notOwnTransferAck === true);
  const missing = [needsAck && !ack && "the acknowledgement", ownTransferConfirm && !notOwn && "the own-account check", !category && "a category", row.direction === "credit" && !creditAs && "refund or income"].filter(Boolean) as string[];
  return (
    <div className="flex flex-col gap-3" data-testid="import-confirm">
      <p className="text-xs font-semibold text-foreground">{label}</p>
      {needsAck && (
        <label className="flex items-start gap-2 text-xs text-foreground">
          <Checkbox checked={ack} onCheckedChange={(v) => setAck(v === true)} aria-label="These are separate transactions" />
          <span>I compared them — these are separate transactions. FlowFi&apos;s existing one stays as it is.</span>
        </label>
      )}
      {ownTransferConfirm && (
        <label className="flex items-start gap-2 text-xs text-foreground" data-testid="own-transfer-confirm">
          <Checkbox checked={notOwn} onCheckedChange={(v) => setNotOwn(v === true)} aria-label="Not a transfer to (or from) my own account or card" />
          <span>{ownTransferConfirm}</span>
        </label>
      )}
      <label htmlFor={`${id}-cat`} className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Category
        <select
          id={`${id}-cat`}
          aria-label="Category for import"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="h-8 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="">{options.length ? "Choose a category" : "No categories for this type"}</option>
          {options.map((c) => (
            // The category NAME, exactly as the row editor stores it — the approval plan and commit engine expect names.
            <option key={c.id} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {row.direction === "credit" && (
        <div className="flex flex-col gap-1" role="radiogroup" aria-label="What is this credit?">
          <span className="text-[11px] text-muted-foreground">This credit is a… (never assumed)</span>
          <div className="flex gap-1.5">
            {(["refund", "income"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={creditAs === k}
                onClick={() => setCreditAs(k)}
                className={cn("rounded-lg px-3 py-1 text-xs font-medium", creditAs === k ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground")}
              >
                {k === "refund" ? "Refund" : "Income"}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        {missing.length > 0 && <span className="mr-auto text-[11px] text-muted-foreground">Needs {missing.join(", ")}</span>}
        <ClayButton size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </ClayButton>
        <ClayButton size="sm" disabled={missing.length > 0} onClick={() => onConfirm({ notSameAck: needsAck ? ack : false, category: category || null, creditAs: row.direction === "credit" ? creditAs : null, notOwnTransferAck: ownTransferConfirm ? notOwn : false })} data-testid="import-confirm-submit">
          {label}
        </ClayButton>
      </div>
    </div>
  );
}

