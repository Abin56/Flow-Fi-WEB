"use client";

/**
 * Balance Control's credit-limit correction — the only live write Balance Control exposes so far (Part A /
 * priority 1 of the correction system). Walks the 6-question flow the user specified: what's being corrected
 * (always "credit limit" here — one sheet per metric), the bank's actual value, the previous value (read-only,
 * taken from FlowFi), the effective date, the reason, and a before/after + affected-modules preview. The Apply
 * button is disabled until the form validates.
 *
 * Writes through `useLimitCorrection` → `CreditLimitCorrectionRepository.record` (see that file for the
 * transaction's safety guarantees — idempotent, conflict-checked, never touches a derived figure).
 */

import { useId, useState } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { formatCurrencyPrecise } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CreditLimitCorrectionReason } from "@/lib/models/credit-limit-correction";
import type { LimitCorrectionTarget } from "@/lib/repositories/credit-limit-correction-repository";
import { useLimitCorrection } from "../hooks/use-limit-correction";
import { parseBankFigure } from "./balance-control-workspace";

const REASON_OPTIONS: { value: CreditLimitCorrectionReason; label: string }[] = [
  { value: "bankIncreased", label: "Bank increased the limit" },
  { value: "bankDecreased", label: "Bank decreased the limit" },
  { value: "dataEntryError", label: "I entered the wrong limit originally" },
  { value: "sharedLimitRestructured", label: "The shared facility was restructured" },
  { value: "other", label: "Other / not sure" },
];

const AFFECTED_MODULES = ["Available credit", "Utilization", "Dashboard", "Reports", "Net Worth"];
const UNAFFECTED_MODULES = ["Total outstanding", "Statement balance", "Transaction history", "My Money", "Accounts", "Loans", "EMI", "Month Cycle"];

function toDateInputValue(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function fromDateInputValue(v: string): Date | null {
  if (!v) return null;
  const [y, m, d] = v.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

export interface LimitCorrectionSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productName: string;
  target: LimitCorrectionTarget;
  previousLimit: number;
  /** Pre-filled from the figure the user already typed into the variance row, if any. */
  initialBankFigure?: number | null;
  onApplied: () => void;
}

export function LimitCorrectionSheet({ open, onOpenChange, productName, target, previousLimit, initialBankFigure, onApplied }: LimitCorrectionSheetProps) {
  // Radix keeps `SheetContent` mounted (for its exit animation) even while `open` is false, so the form's state
  // must reset on each OPEN rather than relying on `useState`'s one-time initializer (otherwise a later open
  // would reuse whatever was left over from the very first mount). Bumping a counter on the false→true
  // transition — detected and applied during render, React's documented "adjust state during render" pattern —
  // and keying the form by it remounts the form fresh each time, with no effect and no ref mutation.
  const [wasOpen, setWasOpen] = useState(open);
  const [openGeneration, setOpenGeneration] = useState(0);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpenGeneration((g) => g + 1);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <LimitCorrectionForm
        key={openGeneration}
        onOpenChange={onOpenChange}
        productName={productName}
        target={target}
        previousLimit={previousLimit}
        initialBankFigure={initialBankFigure}
        onApplied={onApplied}
      />
    </Sheet>
  );
}

function LimitCorrectionForm({
  onOpenChange,
  productName,
  target,
  previousLimit,
  initialBankFigure,
  onApplied,
}: Omit<LimitCorrectionSheetProps, "open">) {
  const actions = useLimitCorrection();
  const [newLimitText, setNewLimitText] = useState(initialBankFigure != null ? String(initialBankFigure) : "");
  const [effectiveDate, setEffectiveDate] = useState(() => toDateInputValue(new Date()));
  const [reason, setReason] = useState<CreditLimitCorrectionReason | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();

  const newLimit = parseBankFigure(newLimitText);
  const effectiveDateValue = fromDateInputValue(effectiveDate);
  const valid = newLimit != null && newLimit > 0 && effectiveDateValue != null && reason != null;
  const difference = newLimit != null ? Math.round((newLimit - previousLimit) * 100) / 100 : null;

  async function handleApply() {
    if (!valid || !actions || newLimit == null || effectiveDateValue == null || reason == null) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await actions.recordCorrection({ target, previousLimit, newLimit, effectiveDate: effectiveDateValue, reason, note });
      if (result.status === "alreadyApplied") {
        setError("This correction was already applied.");
        return;
      }
      onApplied();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't apply this correction. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SheetContent side="bottom" className="mx-auto w-full sm:max-w-lg" data-testid="limit-correction-sheet">
      <SheetHeader>
        <SheetTitle>Correct credit limit — {productName}</SheetTitle>
        <SheetDescription>Enter what the bank actually reports. Nothing is changed until you apply.</SheetDescription>
      </SheetHeader>

      <div className="flex flex-col gap-4 overflow-y-auto px-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs text-muted-foreground">FlowFi&rsquo;s current limit</Label>
            <p className="mt-1 font-medium tabular-nums" data-testid="correction-previous-value">{formatCurrencyPrecise(previousLimit)}</p>
          </div>
          <div>
            <Label htmlFor={`${formId}-new-limit`} className="text-xs text-muted-foreground">Bank&rsquo;s actual limit</Label>
            <div className="relative mt-1">
              <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-muted-foreground">₹</span>
              <input
                id={`${formId}-new-limit`}
                inputMode="decimal"
                autoComplete="off"
                value={newLimitText}
                onChange={(e) => setNewLimitText(e.target.value)}
                placeholder="New limit"
                data-testid="correction-new-value"
                className="h-9 w-full rounded-[6px] border border-border-strong bg-card pr-2 pl-6 text-right text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          </div>
        </div>

        {difference != null && difference !== 0 && (
          <p className="text-xs text-muted-foreground" data-testid="correction-difference">
            Difference: <span className={cn("font-medium tabular-nums", difference > 0 ? "text-success" : "text-foreground")}>
              {difference > 0 ? "+" : "−"}{formatCurrencyPrecise(Math.abs(difference))}
            </span>
          </p>
        )}

        <div>
          <Label htmlFor={`${formId}-date`} className="text-xs text-muted-foreground">Effective date</Label>
          <input
            id={`${formId}-date`}
            type="date"
            value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)}
            data-testid="correction-effective-date"
            max={toDateInputValue(new Date())}
            className="mt-1 h-9 w-full rounded-[6px] border border-border-strong bg-card px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">Why is this different?</Label>
          <RadioGroup value={reason ?? ""} onValueChange={(v) => setReason(v as CreditLimitCorrectionReason)} className="mt-2" data-testid="correction-reason">
            {REASON_OPTIONS.map((opt) => (
              <label key={opt.value} className="flex items-center gap-2 text-sm">
                <RadioGroupItem value={opt.value} data-testid={`correction-reason-${opt.value}`} />
                {opt.label}
              </label>
            ))}
          </RadioGroup>
        </div>

        <div>
          <Label htmlFor={`${formId}-note`} className="text-xs text-muted-foreground">Supporting reference / notes (optional)</Label>
          <Textarea
            id={`${formId}-note`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. SMS from bank dated 12 Oct, or statement page reference"
            data-testid="correction-note"
            className="mt-1"
          />
        </div>

        <section className="rounded-xl border border-border p-3" data-testid="correction-preview">
          <h3 className="text-sm font-semibold text-foreground">Before / after</h3>
          <div className="mt-1.5 flex items-center gap-2 text-sm">
            <span className="tabular-nums text-muted-foreground">{formatCurrencyPrecise(previousLimit)}</span>
            <span className="text-muted-foreground">→</span>
            <span className="font-medium tabular-nums">{newLimit != null ? formatCurrencyPrecise(newLimit) : "—"}</span>
          </div>
          <h3 className="mt-3 text-sm font-semibold text-foreground">What will change</h3>
          <div className="mt-1 flex flex-wrap gap-1">
            {AFFECTED_MODULES.map((m) => <Badge key={m} variant="secondary">{m}</Badge>)}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Left untouched: {UNAFFECTED_MODULES.join(", ")}.</p>
        </section>

        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          This only changes the credit limit. Outstanding, available credit and utilization are recalculated from it — they are never set directly.
        </p>

        {error && (
          <p role="alert" className="flex items-start gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive" data-testid="correction-error">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        )}
      </div>

      <SheetFooter className="flex-row justify-end gap-2">
        <SheetClose asChild>
          <Button variant="ghost">Cancel</Button>
        </SheetClose>
        <Button onClick={handleApply} disabled={!valid || submitting || !actions} data-testid="correction-apply">
          {submitting ? "Applying…" : "Apply correction"}
        </Button>
      </SheetFooter>
    </SheetContent>
  );
}
