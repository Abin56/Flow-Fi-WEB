"use client";

import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ClayButton } from "@/components/clay/clay-button";
import { FLAT_INPUT } from "@/components/finance/chip-row";
import { formatCurrency } from "@/lib/format";
import { isCreditor, type Person } from "@/lib/models/person";
import { usePersonPendingSplitParticipants } from "@/features/people/hooks/use-person-pending-split-participants";
import { useTransactionActions } from "@/features/transactions/hooks/use-transactions-data";
import { cn } from "@/lib/utils";

type Mode = "all" | "custom" | "specific";

const MODES: { value: Mode; label: string }[] = [
  { value: "all", label: "All pending" },
  { value: "custom", label: "Custom amount" },
  { value: "specific", label: "Specific expense" },
];

/**
 * Web port of Flutter's `SettleUpSheet` — records money received back from
 * (or repaid to) a person, either as a lump sum across every outstanding
 * split-expense installment (oldest-due-first) or against one specific
 * installment. Ported logic lives in `ExpenseRepository.settleAcrossPending`/
 * `settleParticipant`; this component is pure UI + form state.
 */
export function SettleUpDialog({
  open,
  onOpenChange,
  person,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  person: Person | null;
}) {
  const actions = useTransactionActions();
  const { pending } = usePersonPendingSplitParticipants(person?.id);

  const [mode, setMode] = useState<Mode>("all");
  const [customAmount, setCustomAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [rowAmounts, setRowAmounts] = useState<Record<string, string>>({});
  const [rowSaving, setRowSaving] = useState<string | null>(null);

  const totalPending = person ? Math.abs(person.currentBalance) : 0;
  const directionLabel = person && isCreditor(person) ? "Receive money from" : "Pay money to";

  // Reset the form when the dialog transitions from closed to open, pre-filling
  // the custom amount with the pending balance (mirrors Flutter's
  // `SettleUpSheet`, which seeds `_amountController` with
  // `person.currentBalance.abs()`) — in-render adjustment, not a useEffect,
  // so it happens in the same commit instead of triggering an extra render.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setMode("all");
      setCustomAmount(totalPending > 0 ? totalPending.toFixed(2) : "");
      setError(null);
      setRowAmounts({});
    }
  }

  function reset() {
    setMode("all");
    setCustomAmount("");
    setError(null);
    setRowAmounts({});
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleSettleLump() {
    if (!actions || !person) return;
    const amount = mode === "all" ? totalPending : Number(customAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter an amount greater than 0.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await actions.settleAcrossPending({ person, pending, amount, date: new Date() });
      handleOpenChange(false);
    } catch {
      // toasted by withErrorToast
    } finally {
      setSaving(false);
    }
  }

  async function handleSettleRow(item: (typeof pending)[number]) {
    if (!actions || !person) return;
    const raw = rowAmounts[item.installment.id];
    const remaining = item.installment.amountDue - item.installment.amountPaid;
    const amount = raw != null && raw !== "" ? Number(raw) : remaining;
    if (!Number.isFinite(amount) || amount <= 0 || amount > remaining) {
      setError(`Enter an amount between 0 and ${formatCurrency(remaining)}.`);
      return;
    }
    setError(null);
    setRowSaving(item.installment.id);
    try {
      await actions.settleParticipant({
        expense: item.expense,
        participant: item.participant,
        installment: item.installment,
        amount,
        date: new Date(),
      });
    } catch {
      // toasted by withErrorToast
    } finally {
      setRowSaving(null);
    }
  }

  const canSubmitLump = useMemo(() => {
    if (mode === "all") return totalPending > 0;
    if (mode === "custom") return Number(customAmount) > 0;
    return false;
  }, [mode, totalPending, customAmount]);

  if (!person) return null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] flex-col gap-4 overflow-hidden sm:max-w-md">
        <DialogHeader className="shrink-0">
          <DialogTitle>Settle Up — {person.name}</DialogTitle>
          <DialogDescription>
            {directionLabel} {person.name}. Outstanding: {formatCurrency(totalPending)}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1 rounded-xl border border-border/50 p-1">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => {
                setMode(m.value);
                setError(null);
              }}
              className={cn(
                "flex-1 rounded-lg py-1.5 text-xs font-medium transition-colors",
                mode === m.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          {mode === "all" && (
            <div className="flex flex-col gap-2 py-1 text-sm">
              <p className="text-muted-foreground">
                Settles the full outstanding amount across every pending split expense, oldest first.
              </p>
              <p className="text-2xl font-bold tabular-nums text-foreground">{formatCurrency(totalPending)}</p>
            </div>
          )}

          {mode === "custom" && (
            <label className="flex flex-col gap-1 py-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Amount</span>
              <input
                type="number"
                className={cn(FLAT_INPUT, "h-10 rounded-xl px-3")}
                placeholder="0.00"
                value={customAmount}
                onChange={(e) => setCustomAmount(e.target.value)}
              />
              <span className="text-xs text-muted-foreground">
                Applied oldest-due-first; any amount beyond tracked split expenses is recorded as a plain ledger
                entry.
              </span>
            </label>
          )}

          {mode === "specific" && (
            <div className="flex flex-col gap-2 py-1">
              {pending.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">No pending split expenses.</p>
              ) : (
                pending.map((item) => {
                  const remaining = item.installment.amountDue - item.installment.amountPaid;
                  return (
                    <div key={item.installment.id} className="flex items-center gap-2 rounded-xl border border-border/40 p-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{item.expense.description}</p>
                        <p className="text-xs text-muted-foreground">
                          Due {item.installment.dueDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })} · Remaining {formatCurrency(remaining)}
                        </p>
                      </div>
                      <input
                        type="number"
                        className={cn(FLAT_INPUT, "h-9 w-24 rounded-lg px-2 text-sm")}
                        placeholder={String(remaining)}
                        value={rowAmounts[item.installment.id] ?? ""}
                        onChange={(e) => setRowAmounts((f) => ({ ...f, [item.installment.id]: e.target.value }))}
                      />
                      <ClayButton
                        type="button"
                        size="sm"
                        onClick={() => void handleSettleRow(item)}
                        disabled={rowSaving === item.installment.id}
                      >
                        {rowSaving === item.installment.id ? "Recording…" : "Record"}
                      </ClayButton>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {error && <p className="mt-2 text-xs text-expense">{error}</p>}
        </div>

        {mode !== "specific" && (
          <div className="flex shrink-0 justify-end gap-2">
            <ClayButton type="button" variant="ghost" onClick={() => handleOpenChange(false)} disabled={saving}>
              Cancel
            </ClayButton>
            <ClayButton type="button" onClick={() => void handleSettleLump()} disabled={saving || !canSubmitLump}>
              {saving ? "Recording…" : "Record Settlement"}
            </ClayButton>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
