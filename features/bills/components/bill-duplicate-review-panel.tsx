"use client";

/**
 * READ-ONLY review panel for historical duplicate bill cycles (same bill, same due calendar day — left by the
 * two-tab race `BillOccurrenceRepository` used to have). This panel never merges, deletes, suppresses, restores or
 * otherwise changes a duplicate record, a bill, a payment or any total: `findDuplicateBillCycles`
 * (`lib/engines/bill-duplicate-cycles.ts`) is a pure read, and nothing in this file writes to Firestore. Its only
 * action is a "Copy details" button for taking the group to wherever the actual (separately approved) repair happens.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Copy } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ClayBadge } from "@/components/clay/clay-badge";
import { ClayButton } from "@/components/clay/clay-button";
import { CurrencyCell, DateCell } from "@/components/finance";
import { findDuplicateBillCycles, type DuplicateCycleGroup } from "@/lib/engines/bill-duplicate-cycles";
import { formatCurrency } from "@/lib/format";
import type { Bill, BillOccurrence, PaymentRecord } from "@/lib/models/bill";
import { toast } from "@/store/toast-store";

const STATUS_TONE: Record<string, "expense" | "success" | "neutral"> = { paid: "success", skipped: "neutral", overdue: "expense", dueToday: "expense", partiallyPaid: "neutral", upcoming: "neutral" };
const STATUS_LABEL: Record<string, string> = { paid: "Paid", skipped: "Skipped", overdue: "Overdue", dueToday: "Due today", partiallyPaid: "Partially paid", upcoming: "Upcoming" };

function groupText(g: DuplicateCycleGroup): string {
  const lines = [
    `${g.billName} — duplicate cycles due ${g.dueDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`,
    ...g.occurrences.map(
      (o) =>
        `  • ${o.occurrenceId} — ${STATUS_LABEL[o.status] ?? o.status} — paid ${formatCurrency(o.amountPaid)} of ${formatCurrency(o.amount)}${
          o.isShownAsCurrent ? " [shown on Bills page]" : ""
        }${o.payments.length > 0 ? ` — payments: ${o.payments.map((p) => `${p.id}${p.deletedAt ? " (cancelled)" : ""}`).join(", ")}` : ""}`,
    ),
    `Effect on totals: counted as ${formatCurrency(g.totalsEffect.asCountedToday)} today vs. ${formatCurrency(g.totalsEffect.ifCountedOnce)} if counted once (overstated by ${formatCurrency(g.totalsEffect.overstatement)}; +${g.totalsEffect.extraDashboardRows} Dashboard row(s)).`,
    `Recommendation: ${g.recommendation}`,
  ];
  return lines.join("\n");
}

export interface BillDuplicateReviewPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bills: Pick<Bill, "id" | "name">[];
  occurrencesByBillId: ReadonlyMap<string, BillOccurrence[]>;
  currentOccurrenceIdByBillId: ReadonlyMap<string, string | null>;
  /** Loads one bill's payment records — `null` while the signed-in user's actions aren't ready yet. */
  listPayments: ((billId: string) => Promise<PaymentRecord[]>) | null;
}

/** Shows every group of historical duplicate bill cycles, what they add to Bills/Month Cycle/Dashboard totals, and a
 *  plain-language suggestion for a human to act on elsewhere. Loads each affected bill's payments once, on open. */
export function BillDuplicateReviewPanel({ open, onOpenChange, bills, occurrencesByBillId, currentOccurrenceIdByBillId, listPayments }: BillDuplicateReviewPanelProps) {
  const [paymentsByBillId, setPaymentsByBillId] = useState<Map<string, PaymentRecord[]>>(new Map());
  const [loadingPayments, setLoadingPayments] = useState(false);

  // Groups from occurrences alone (payments only refine what's SHOWN per occurrence, not which groups exist) —
  // so the panel renders immediately, then fills in payment detail once loaded.
  const groups = findDuplicateBillCycles(bills, occurrencesByBillId, paymentsByBillId, currentOccurrenceIdByBillId);

  useEffect(() => {
    if (!open || !listPayments) return;
    let cancelled = false;
    const billIds = [...new Set(findDuplicateBillCycles(bills, occurrencesByBillId, new Map(), currentOccurrenceIdByBillId).map((g) => g.billId))];
    if (billIds.length === 0) return;

    async function load() {
      setLoadingPayments(true);
      try {
        const entries = await Promise.all(billIds.map(async (id) => [id, await listPayments!(id)] as const));
        if (!cancelled) setPaymentsByBillId(new Map(entries));
      } catch {
        // Payment detail is a nice-to-have for this read-only view — a failed load still shows the occurrences themselves.
      } finally {
        if (!cancelled) setLoadingPayments(false);
      }
    }
    void load();

    return () => {
      cancelled = true;
    };
  }, [open, listPayments, bills, occurrencesByBillId, currentOccurrenceIdByBillId]);

  function copyGroup(g: DuplicateCycleGroup) {
    void navigator.clipboard
      .writeText(groupText(g))
      .then(() => toast.success("Copied", "Duplicate-cycle details copied — nothing on this bill was changed."))
      .catch(() => toast.error("Couldn't copy", "Please try again."));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] flex-col gap-4 overflow-hidden sm:max-w-2xl">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4.5 text-warning-foreground" />
            Duplicate bill cycles
          </DialogTitle>
          <DialogDescription>
            Read-only. Nothing here is merged, deleted or changed — this is for review before a separate, approved data correction.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 overflow-y-auto pr-1">
          {groups.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No duplicate cycles found.</p>
          ) : (
            groups.map((g) => (
              <div key={`${g.billId}-${g.dueDate.toISOString()}`} className="flex flex-col gap-3 rounded-2xl border border-warning/30 bg-warning/8 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-foreground">{g.billName}</p>
                    <p className="text-xs text-muted-foreground">
                      Due <DateCell date={g.dueDate} className="inline" /> · {g.occurrences.length} occurrences for this cycle
                    </p>
                  </div>
                  <ClayButton size="sm" variant="secondary" className="gap-1.5 shrink-0" onClick={() => copyGroup(g)}>
                    <Copy className="size-3.5" />
                    Copy details
                  </ClayButton>
                </div>

                <div className="flex flex-col gap-2">
                  {g.occurrences.map((o) => (
                    <div key={o.occurrenceId} className="flex flex-col gap-1 rounded-xl bg-card p-3 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-foreground">{o.occurrenceId}</span>
                          {o.isShownAsCurrent && <ClayBadge tone="neutral">Shown on Bills page</ClayBadge>}
                        </div>
                        <ClayBadge tone={STATUS_TONE[o.status] ?? "neutral"}>{STATUS_LABEL[o.status] ?? o.status}</ClayBadge>
                      </div>
                      <div className="flex items-center justify-between text-muted-foreground">
                        <span>
                          Paid <CurrencyCell amount={-o.amountPaid} className="inline" /> of <CurrencyCell amount={-o.amount} className="inline" />
                        </span>
                        <span>{loadingPayments ? "loading payments…" : `${o.payments.length} payment record(s)`}</span>
                      </div>
                      {o.payments.length > 0 && (
                        <ul className="flex flex-col gap-0.5 border-t border-border/40 pt-1">
                          {o.payments.map((p) => (
                            <li key={p.id} className="flex items-center justify-between text-muted-foreground">
                              <span className="font-mono">
                                {p.id}
                                {p.deletedAt != null && " (cancelled)"}
                                {p.recordedEarlier && " (paid earlier, no debit)"}
                              </span>
                              <CurrencyCell amount={-p.amount} className="inline" />
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>

                <div className="rounded-xl bg-card/70 p-3 text-xs text-muted-foreground">
                  <p>
                    Counted today: <span className="font-medium text-foreground">{formatCurrency(g.totalsEffect.asCountedToday)}</span> · if counted once:{" "}
                    <span className="font-medium text-foreground">{formatCurrency(g.totalsEffect.ifCountedOnce)}</span>
                    {g.totalsEffect.overstatement > 0 && (
                      <>
                        {" "}
                        · overstated by <span className="font-medium text-expense">{formatCurrency(g.totalsEffect.overstatement)}</span>
                      </>
                    )}
                    {g.totalsEffect.extraDashboardRows > 0 && <> · +{g.totalsEffect.extraDashboardRows} extra Dashboard row(s)</>}
                  </p>
                </div>

                <p className="text-xs text-foreground/80">{g.recommendation}</p>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
