"use client";

/**
 * The Action cell of a statement row (2026-11-25): the row's ONE next step, right where the row is — so a problem is
 * named and fixed beside its row, never as a generic error somewhere else.
 *
 *   Ready            → Import            (imports this row now: the same keyed, server-re-checked approval)
 *   Possible match   → Review            (opens the comparison under the row)
 *   unclear OCR read → Check date / Check amount / Check row   (opens the details on that field, with the image)
 *   a value missing  → Fix
 *   credit           → Credit type ▾     (Income · Refund · From a person I lent to · From my own account)
 *   UPI/NEFT debit   → Recipient ▾       (Paid to someone else · It was my own account)
 *   no category      → Category          (focuses the row's category picker)
 *   rule blocks it   → "Blocked" with the reason in the tooltip (the ⋯ menu still offers Skip / Already recorded)
 *
 * Every choice here is a draft decision (undoable) except Import, which is the explicit write.
 */

import { useState } from "react";
import { Ban, CheckCircle2, ChevronDown, FilePlus2, GitCompareArrows, Loader2, PencilLine, Shapes } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { RowStatus } from "../lib/row-status";
import type { ReconRow } from "../lib/types";
import { CREDIT_CHOICES, type CreditChoice } from "./recon-row-editor";

const BTN = "inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-md px-2 text-[11.5px] font-semibold whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";
const OUTLINE = "border border-border-strong/70 bg-card text-foreground hover:bg-muted";
const WARN = "border border-warning/50 bg-warning/[0.08] text-[oklch(0.45_0.12_70)] hover:bg-warning/15 dark:text-warning";

export interface RowActionHandlers {
  onImport: () => void;
  onReview: () => void;
  onFix: () => void;
  onCategory: () => void;
  onCreditType: (choice: CreditChoice) => void;
  onRecipient: (choice: "someone_else" | "own_account") => void;
}

function Choices<T extends string>({ label, testId, items, onPick, rowNumber }: { label: string; testId: string; items: { id: T; label: string; hint: string }[]; onPick: (id: T) => void; rowNumber: number }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" data-testid={testId} aria-label={`${label} (row ${rowNumber})`} aria-haspopup="menu" onClick={(e) => e.stopPropagation()} className={cn(BTN, WARN)}>
          {label} <ChevronDown className="size-3 shrink-0" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1" onClick={(e) => e.stopPropagation()}>
        <div role="menu" aria-label={label} className="flex flex-col">
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              role="menuitem"
              data-testid={`${testId}-${it.id}`}
              onClick={() => {
                setOpen(false);
                onPick(it.id);
              }}
              className="flex flex-col rounded px-2 py-1.5 text-left outline-none hover:bg-muted focus-visible:bg-muted"
            >
              <span className="text-[13px] font-medium text-foreground">{it.label}</span>
              <span className="text-[11px] leading-snug text-muted-foreground">{it.hint}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const RECIPIENT: { id: "someone_else" | "own_account"; label: string; hint: string }[] = [
  { id: "someone_else", label: "Paid to someone else", hint: "Not my own account or card — import it as an expense." },
  { id: "own_account", label: "It was my own account", hint: "Money between your own accounts — record it as a Transfer. Not imported here." },
];
const RECEIVED: { id: "someone_else" | "own_account"; label: string; hint: string }[] = [
  { id: "someone_else", label: "From someone else", hint: "Not from my own account or card." },
  { id: "own_account", label: "From my own account", hint: "Money between your own accounts — record it as a Transfer. Not imported here." },
];

export function RowAction({ row, rowNumber, status, running, busy, h }: { row: ReconRow; rowNumber: number; status: RowStatus | null; running: boolean; busy: boolean; h: RowActionHandlers }) {
  if (!status) return null;
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  switch (status.next) {
    case "import":
      return (
        <button type="button" data-testid="row-import" disabled={busy || running} onClick={stop(h.onImport)} title="Import this row now — FlowFi is re-checked first, and it is never written twice." aria-label={`Import row ${rowNumber}`} className={cn(BTN, PRIMARY)}>
          {running ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <FilePlus2 className="size-3" aria-hidden />}
          {running ? "Importing" : "Import"}
        </button>
      );
    case "review":
      return (
        <button type="button" data-testid="row-review" onClick={stop(h.onReview)} title={status.reason} aria-label={`Review the possible match for row ${rowNumber}`} className={cn(BTN, OUTLINE)}>
          <GitCompareArrows className="size-3" aria-hidden /> Review
        </button>
      );
    case "confirm_values":
    case "fix_values": {
      const label = /date/i.test(status.reason) ? "Check date" : /amount/i.test(status.reason) ? "Check amount" : /debit\/credit/i.test(status.reason) ? "Check type" : status.next === "confirm_values" ? "Check row" : "Fix";
      return (
        <button type="button" data-testid="row-fix" onClick={stop(h.onFix)} title={status.reason} aria-label={`${label} — row ${rowNumber}`} className={cn(BTN, WARN)}>
          <PencilLine className="size-3" aria-hidden /> {label}
        </button>
      );
    }
    case "category":
      return (
        <button type="button" data-testid="row-choose-category" onClick={stop(h.onCategory)} title={status.reason} aria-label={`Choose a category for row ${rowNumber}`} className={cn(BTN, WARN)}>
          <Shapes className="size-3" aria-hidden /> Category
        </button>
      );
    case "credit_type":
      return <Choices label="Credit type" testId="row-credit-type" rowNumber={rowNumber} items={CREDIT_CHOICES} onPick={h.onCreditType} />;
    case "own_transfer":
      return <Choices label={row.direction === "credit" ? "Sender" : "Recipient"} testId="row-recipient" rowNumber={rowNumber} items={row.direction === "credit" ? RECEIVED : RECIPIENT} onPick={h.onRecipient} />;
    case "blocked":
      return (
        <span className="inline-flex min-w-0 items-center gap-1 text-[11.5px] font-medium text-danger" title={status.reason} data-testid="row-blocked">
          <Ban className="size-3 shrink-0" aria-hidden /> <span className="truncate">Blocked</span>
        </span>
      );
    default:
      return status.kind === "imported" ? (
        <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-success" data-testid="row-imported">
          <CheckCircle2 className="size-3" aria-hidden /> Done
        </span>
      ) : null;
  }
}
