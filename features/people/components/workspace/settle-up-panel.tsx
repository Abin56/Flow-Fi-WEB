"use client";

import { CircleCheck, ListChecks, PencilLine } from "lucide-react";
import { useMemo, useState } from "react";
import { formatCurrency } from "@/lib/format";
import type { Person } from "@/lib/models/person";
import { usePersonPositions } from "@/features/people/hooks/use-people-data";
import { usePersonPendingSplitParticipants } from "@/features/people/hooks/use-person-pending-split-participants";
import { useTransactionActions } from "@/features/transactions/hooks/use-transactions-data";
import { cn } from "@/lib/utils";
import { CompactAmountInput, InlinePanel } from "./ledger-ui";
import { ModeFooter, ModeHeader, WS_FIELD, WS_GHOST, WS_PAD, WS_PRIMARY, WS_SECONDARY, WsLabel, WsSegmented } from "./person-workspace-ui";

type Mode = "all" | "custom" | "specific";

/**
 * Settle — web port of Flutter's `SettleUpSheet`, expanding inline in the Person workspace. Records
 * money received back from (or repaid to) a person, either as a lump sum across every outstanding
 * split-expense installment (oldest-due-first) or against one specific installment. Ported logic
 * lives in `ExpenseRepository.settleAcrossPending`/`settleParticipant`; this component is pure UI +
 * form state — unchanged from the former Settle mode apart from the surface.
 */
export function SettleUpPanel({
  person,
  onCancel,
  onDone,
  variant = "inline",
  backLabel = "Back",
}: {
  person: Person;
  onCancel: () => void;
  onDone: () => void;
  /** "inline": the compact workspace's expanding panel. "page": a full view inside the expanded ledger, with a Back link and a summary column. */
  variant?: "inline" | "page";
  backLabel?: string;
}) {
  const actions = useTransactionActions();
  const { pending } = usePersonPendingSplitParticipants(person.id);

  const [mode, setMode] = useState<Mode>("all");
  const [customAmount, setCustomAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [rowAmounts, setRowAmounts] = useState<Record<string, string>>({});
  const [rowSaving, setRowSaving] = useState<string | null>(null);

  // Settle Up settles the DIRECT Person balance only (split expenses, manual entries). Loan principal
  // is settled from the Loan (payments / reversal), never through the ledger — so neither the amount
  // nor its direction may include a Loan, including one an old Web Loan once mirrored into the ledger.
  const { positionsByPersonId } = usePersonPositions();
  const position = positionsByPersonId[person.id];
  // Opted-in Person-linked EMI installments are People obligations too — repaid through this same
  // Settle Up (a "Received back" ledger entry), never by paying the lender.
  const emiReceivable = position?.emiReceivable ?? 0;
  const directBalance = (position?.directBalance ?? person.currentBalance ?? 0) + emiReceivable;
  const loanBalance = position ? position.loanReceivable - position.loanPayable : 0;
  const totalPending = Math.abs(directBalance);
  const firstName = person.name.split(" ")[0];
  const positionLabel = totalPending === 0 ? "All settled" : directBalance > 0 ? `${firstName} owes you` : `You owe ${firstName}`;
  const effectLine = directBalance > 0 ? `Money received from ${firstName}` : `Money paid to ${firstName}`;

  async function handleSettleLump() {
    if (!actions || saving) return;
    const amount = mode === "all" ? totalPending : Number(customAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter an amount greater than 0.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await actions.settleAcrossPending({ person, pending, amount, date: new Date(), legacyLoanLedger: position?.legacyLoanLedger ?? 0, emiReceivable });
      onDone();
    } catch {
      // toasted by withErrorToast
    } finally {
      setSaving(false);
    }
  }

  async function handleSettleRow(item: (typeof pending)[number]) {
    if (!actions) return;
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

  const choose = (next: Mode) => {
    setMode(next);
    setError(null);
  };

  const actionButtons =
    mode === "specific" ? (
      <button type="button" onClick={onCancel} className={WS_SECONDARY}>
        Done
      </button>
    ) : (
      <>
        <button type="button" onClick={onCancel} disabled={saving} className={WS_GHOST}>
          Cancel
        </button>
        <button type="button" onClick={() => void handleSettleLump()} disabled={saving || !canSubmitLump} className={WS_PRIMARY}>
          {saving ? "Recording…" : mode === "all" ? `Record ${formatCurrency(totalPending)} settlement` : "Record settlement"}
        </button>
      </>
    );

  const modePicker = (
    <WsSegmented
      label="Settle amount"
      value={mode}
      onChange={choose}
      options={[
        { value: "all", label: "All pending", icon: CircleCheck },
        { value: "custom", label: "Custom amount", icon: PencilLine },
        { value: "specific", label: "Choose entries", icon: ListChecks, meta: pending.length > 0 ? pending.length : undefined },
      ]}
      className={variant === "page" ? "w-full" : "w-full sm:w-auto sm:min-w-[24rem]"}
    />
  );

  const loanNote = loanBalance !== 0 && (
    <p className="mt-2 text-xs text-muted-foreground">
      Loans ({loanBalance > 0 ? "they owe you" : "you owe"} {formatCurrency(Math.abs(loanBalance))}) aren&apos;t settled here — record Loan payments from
      the Loan.
    </p>
  );

  /* Only the controls the selected option needs */
  const controls = (
    <div key={mode} className="mt-3.5 animate-in duration-200 fade-in-0">
      {mode === "all" && (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {totalPending > 0
            ? `Settles your whole outstanding balance with ${firstName} — ${effectLine.toLowerCase()}, applied across pending split expenses, oldest first.`
            : `There's nothing outstanding with ${firstName} right now.`}
        </p>
      )}

      {mode === "custom" && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="w-40">
            <CompactAmountInput label="Settlement amount" value={customAmount} onChange={setCustomAmount} invalid={!!error} autoFocus />
          </div>
          {totalPending > 0 && (
            <span className="flex gap-1.5">
              {[
                ["Half", totalPending / 2],
                ["Full", totalPending],
              ].map(([label, v]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setCustomAmount((v as number).toFixed(2))}
                  className="h-8 rounded-[6px] border border-border-strong bg-card px-2.5 text-xs font-medium text-foreground tabular-nums transition-colors hover:bg-secondary"
                >
                  {label} · {formatCurrency(v as number)}
                </button>
              ))}
            </span>
          )}
          <p className="w-full text-xs text-muted-foreground">Applied oldest-due-first; anything beyond tracked split expenses is recorded as a plain ledger entry.</p>
        </div>
      )}

      {mode === "specific" &&
        (pending.length === 0 ? (
          <p className="rounded-[8px] border border-dashed border-border-strong px-4 py-3 text-sm text-muted-foreground">
            No pending split expenses with {firstName}. To settle a single transaction, use Settle on that transaction.
          </p>
        ) : (
          <ul className={cn("divide-y divide-border overflow-y-auto overscroll-contain border-y border-border", variant === "inline" && "max-h-64")}>
            {pending.map((item) => {
              const remaining = item.installment.amountDue - item.installment.amountPaid;
              const busy = rowSaving === item.installment.id;
              return (
                <li key={item.installment.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2">
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="truncate text-sm font-medium text-foreground">{item.expense.description}</p>
                    <p className="text-xs text-muted-foreground">
                      Due {item.installment.dueDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })} · Remaining{" "}
                      <span className="font-medium text-foreground tabular-nums">{formatCurrency(remaining)}</span>
                    </p>
                  </div>
                  <div className="relative w-28">
                    <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-xs text-muted-foreground">₹</span>
                    <input
                      type="number"
                      aria-label={`Amount for ${item.expense.description}`}
                      className={cn(WS_FIELD, "h-8 pl-6 tabular-nums")}
                      placeholder={String(remaining)}
                      value={rowAmounts[item.installment.id] ?? ""}
                      onChange={(e) => setRowAmounts((f) => ({ ...f, [item.installment.id]: e.target.value }))}
                    />
                  </div>
                  <button type="button" onClick={() => void handleSettleRow(item)} disabled={busy} className={cn(WS_SECONDARY, "h-8 px-3")}>
                    {busy ? "Recording…" : "Record"}
                  </button>
                </li>
              );
            })}
          </ul>
        ))}

      {error && (
        <p className="mt-2 text-xs font-medium text-expense" role="alert">
          {error}
        </p>
      )}
    </div>
  );

  const positionTone = directBalance > 0 ? "text-success" : directBalance < 0 ? "text-expense" : "text-muted-foreground";

  if (variant === "page") {
    // What this settlement would record — the amount the existing flow is about to post, beside the outstanding it applies to.
    const payingNow = mode === "all" ? totalPending : mode === "custom" ? Number(customAmount) || 0 : null;
    return (
      <div className="flex min-h-full flex-col">
        <ModeHeader
          backLabel={backLabel}
          onBack={onCancel}
          title={`Settle with ${firstName}`}
          subtitle="Settles the overall outstanding balance. To settle one transaction, use Settle on its row."
        />
        <div className={cn(WS_PAD, "mt-5 flex-1")}>
          <div className="mx-auto grid w-full max-w-5xl gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
            <div className="min-w-0 max-w-2xl">
              <WsLabel>How much to settle</WsLabel>
              <div className="mt-2">{modePicker}</div>
              {controls}
              {loanNote}
            </div>

            <aside className="h-fit rounded-[8px] border border-border-strong bg-secondary/35 p-4 lg:sticky lg:top-4">
              <WsLabel>Settlement summary</WsLabel>
              <dl className="mt-3 space-y-3">
                <div>
                  <dt className="text-xs text-muted-foreground">Outstanding</dt>
                  <dd className="font-heading text-2xl leading-tight font-bold tracking-tight text-foreground tabular-nums">{formatCurrency(totalPending)}</dd>
                  <dd className={cn("text-xs font-semibold", positionTone)}>{positionLabel}</dd>
                </div>
                {payingNow != null && (
                  <div className="border-t border-border pt-3">
                    <dt className="text-xs text-muted-foreground">Paying now</dt>
                    <dd className="font-heading text-lg font-semibold text-foreground tabular-nums">{formatCurrency(payingNow)}</dd>
                    {totalPending > 0 && <dd className="text-xs text-muted-foreground">{effectLine}</dd>}
                  </div>
                )}
                {mode === "specific" && (
                  <div className="border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
                    Record against one pending split expense at a time.
                  </div>
                )}
              </dl>
            </aside>
          </div>
        </div>
        <ModeFooter>
          <div className="mx-auto flex w-full max-w-5xl items-center justify-end gap-2">{actionButtons}</div>
        </ModeFooter>
      </div>
    );
  }

  return (
    <InlinePanel
      title={`Settle with ${firstName}`}
      subtitle="Settles the overall outstanding balance. To settle one transaction, use Settle on its row."
      onClose={onCancel}
      footer={actionButtons}
    >
      {/* Position being settled */}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <WsLabel>Outstanding</WsLabel>
          <p className="mt-0.5 font-heading text-[26px] leading-tight font-bold tracking-tight text-foreground tabular-nums">{formatCurrency(totalPending)}</p>
          <p className={cn("text-xs font-semibold", positionTone)}>{positionLabel}</p>
        </div>
        {modePicker}
      </div>
      {loanNote}
      {controls}
    </InlinePanel>
  );
}
