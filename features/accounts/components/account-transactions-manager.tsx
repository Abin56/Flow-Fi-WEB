"use client";

import { AlertTriangle, Ban, CheckCheck, Link2, Receipt, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAccounts } from "@/hooks/use-accounts";
import { useExpenses } from "@/hooks/use-expenses";
import { useTransactions } from "@/hooks/use-transactions";
import { useTransactionActions } from "@/features/transactions/hooks/use-transactions-data";
import { userFacingMessage } from "@/features/transactions/lib/error-toast";
import {
  blockedReasonFor,
  liveAccountTransactions,
  planAccountTransactionClearing,
  runAccountTransactionClearing,
  type ClearingFailure,
} from "@/lib/engines/account-transaction-clearing";
import { formatCurrency } from "@/lib/format";
import type { Account } from "@/lib/models/account";
import { signedAmount, type Transaction } from "@/lib/models/transaction";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";

type Step = "pick" | "confirm" | "confirmAll" | "running" | "done";

const ACCOUNTS_TITLE: Record<Step, string> = {
  pick: "Manage transactions",
  confirm: "Review deletion",
  confirmAll: "Confirm deletion",
  running: "Deleting transactions",
  done: "Deletion complete",
};
const ACCOUNTS_FOOTER = "shrink-0 border-t border-border/65 pt-3 [&_button]:rounded-lg";
const fmtDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Clear transaction history for one bank account / credit card WITHOUT deleting the account. Reuses the app's one
 * linked-aware delete (see `lib/engines/account-transaction-clearing.ts`): rows tied to Loan & EMI, Bills or a
 * lender charge are blocked with a reason; transfers / card bill payments, split expenses and People movements
 * are removed together with their linked records only after an explicit acknowledgement. Nothing runs until the
 * user confirms (Delete all asks twice).
 */
export function AccountTransactionsManager({
  open,
  onOpenChange,
  accountId,
  kind,
  presentation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  kind: "account" | "card";
  presentation?: "accounts";
}) {
  const { data: allTransactions = [], isLoading: isLoadingTransactions } = useTransactions();
  const { data: accounts = [] } = useAccounts();
  const { data: expenses = [] } = useExpenses();
  const actions = useTransactionActions();

  const [step, setStep] = useState<Step>("pick");
  const [mode, setMode] = useState<"selected" | "all">("selected");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ack, setAck] = useState(false);
  const [typed, setTyped] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<ClearingFailure[]>([]);
  const [removed, setRemoved] = useState(0);
  const running = useRef(false);

  const account = (accounts as Account[]).find((a) => a.id === accountId);
  const name = account?.name ?? (kind === "card" ? "this card" : "this account");
  const label = kind === "card" ? "card" : "account";

  const transactions = allTransactions as Transaction[];
  const splitOwned = useMemo(() => new Set(expenses.filter((e) => e.deletedAt == null).map((e) => e.transactionId)), [expenses]);
  const accountRefs = useMemo(() => (accounts as Account[]).map((a) => ({ id: a.id, name: a.name, currentBalance: a.currentBalance })), [accounts]);
  const rows = useMemo(
    () =>
      liveAccountTransactions(transactions, accountId)
        .sort((a, b) => b.dateTime.getTime() - a.dateTime.getTime())
        .map((t) => ({ t, blocked: blockedReasonFor(t, transactions, splitOwned) })),
    [transactions, accountId, splitOwned],
  );
  const deletableIds = useMemo(() => rows.filter((r) => r.blocked == null).map((r) => r.t.id), [rows]);

  const plan = useMemo(
    () =>
      planAccountTransactionClearing({
        accountId,
        transactions,
        accounts: accountRefs,
        splitOwnedTransactionIds: splitOwned,
        target: mode === "all" ? "all" : selected,
      }),
    [accountId, transactions, accountRefs, splitOwned, mode, selected],
  );

  function reset() {
    setStep("pick");
    setMode("selected");
    setSelected(new Set());
    setAck(false);
    setTyped("");
    setProgress(null);
    setFailures([]);
    setRemoved(0);
  }

  function close(next: boolean) {
    if (!next && step === "running") return; // never abandon a run midway
    onOpenChange(next);
    if (!next) reset();
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function begin(next: "selected" | "all") {
    setMode(next);
    setAck(false);
    setTyped("");
    setStep("confirm");
  }

  async function execute() {
    if (running.current || actions == null || plan.steps.length === 0) return;
    running.current = true;
    setStep("running");
    setProgress({ done: 0, total: plan.steps.length });
    try {
      const result = await runAccountTransactionClearing(plan.steps, (t) => actions.deleteTransactionWithLinkedEffects(t), {
        messageFor: (e) => userFacingMessage(e) ?? (e instanceof Error ? e.message : "Couldn't delete this transaction."),
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setRemoved(result.removedSteps);
      setFailures(result.failures);
      if (result.removedSteps > 0 && result.failures.length === 0) {
        toast.success(`Deleted ${plural(result.removedSteps, "transaction")} from ${name}`, `The ${label} itself is unchanged.`);
      } else if (result.failures.length > 0) {
        toast.error(`${plural(result.failures.length, "transaction")} couldn't be deleted`, "The rest were deleted. See the list for why.");
      }
      setStep("done");
    } finally {
      running.current = false;
    }
  }

  const own = plan.balanceMovements.find((m) => m.accountId === accountId);
  const others = plan.balanceMovements.filter((m) => m.accountId !== accountId);
  const confirmReady = !plan.needsLinkedAcknowledgement || ack;
  const allSelected = deletableIds.length > 0 && deletableIds.every((id) => selected.has(id));
  const fromAccounts = presentation === "accounts";
  const showEmptyState = fromAccounts && step === "pick" && rows.length === 0;
  const showCloseButton = !showEmptyState && !(fromAccounts && step === "running");

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className={cn(
          "flex max-h-[88vh] flex-col gap-4 sm:max-w-2xl",
          fromAccounts && "max-h-[calc(100dvh-2rem)] bg-card p-4 sm:p-5",
          showEmptyState && "sm:max-w-md",
        )}
        showCloseButton={showCloseButton}
        data-testid="account-transactions-manager"
      >
        <DialogHeader className={cn("pr-8", fromAccounts && "shrink-0 gap-1", !showCloseButton && "pr-0")}>
          <DialogTitle className={cn("flex items-center gap-2", fromAccounts && "text-lg leading-tight font-semibold tracking-tight")}>
            {!fromAccounts && <Trash2 className="size-4 text-danger" />}
            {fromAccounts
              ? ACCOUNTS_TITLE[step]
              : step === "pick" || step === "running" || step === "done" ? `Manage transactions · ${name}` : `Delete from ${name}?`}
          </DialogTitle>
          <DialogDescription className={cn(fromAccounts && "wrap-anywhere")}>
            {fromAccounts
              ? name
              : step === "pick"
                ? `Remove transactions and keep this ${label} — its name, details and settings stay exactly as they are.`
                : step === "done"
                  ? `Finished. This ${label} is still here and keeps working.`
                  : `Only ${name}'s own history is affected; the ${label} itself is never deleted.`}
          </DialogDescription>
        </DialogHeader>

        {showEmptyState && (
          <>
            <div className="flex shrink-0 flex-col items-center gap-2.5 rounded-xl border border-border/65 bg-secondary/45 px-4 py-6 text-center" role="status">
              <span className="grid size-10 place-items-center rounded-lg bg-secondary text-muted-foreground" aria-hidden>
                <Receipt className="size-5" />
              </span>
              <p className="text-sm font-semibold text-foreground">
                {isLoadingTransactions ? "Loading transactions…" : "No transactions yet"}
              </p>
            </div>
            <DialogFooter className="shrink-0">
              <ClayButton variant="primary" className="min-w-24 rounded-lg" onClick={() => close(false)}>
                Close
              </ClayButton>
            </DialogFooter>
          </>
        )}

        {step === "pick" && !showEmptyState && (
          <>
            <div className={cn("flex flex-wrap items-center gap-2 text-xs", fromAccounts && "shrink-0 justify-between rounded-lg bg-secondary/55 px-3 py-2")}>
              <button
                type="button"
                className={cn("rounded-[6px] border border-border-strong px-2 py-1 font-semibold hover:bg-secondary disabled:opacity-50", fromAccounts && "min-h-8 bg-card focus-visible:outline-2 focus-visible:outline-ring")}
                disabled={deletableIds.length === 0}
                onClick={() => setSelected(allSelected ? new Set() : new Set(deletableIds))}
              >
                {allSelected ? "Clear selection" : "Select all deletable"}
              </button>
              <span className={cn("text-muted-foreground", fromAccounts && "tabular-nums")} role={fromAccounts ? "status" : undefined}>
                {plural(rows.length, "transaction")} · {selected.size} selected
                {rows.length - deletableIds.length > 0 && ` · ${rows.length - deletableIds.length} protected`}
              </span>
            </div>
            <ul className={cn("min-h-0 flex-1 divide-y divide-border overflow-y-auto rounded-[10px] border border-border-strong/60", fromAccounts && "min-h-20 overscroll-contain rounded-lg border-border/75")} aria-label="Transactions">
              {rows.length === 0 && <li className="px-3 py-8 text-center text-sm text-muted-foreground">No transactions on this {label}.</li>}
              {rows.map(({ t, blocked }) => {
                const linked = t.transferId != null || splitOwned.has(t.id) || t.isPersonLedgerMovement;
                const amount = signedAmount(t);
                return (
                  <li key={t.id}>
                    <label className={cn(
                      "flex items-start gap-3 px-3 py-2 text-sm",
                      blocked ? "cursor-not-allowed opacity-70" : "cursor-pointer hover:bg-secondary/60",
                      fromAccounts && "gap-2.5 py-3",
                      fromAccounts && selected.has(t.id) && "bg-primary/10 hover:bg-primary/15",
                    )}>
                      <input
                        type="checkbox"
                        className={cn("mt-1 size-4 shrink-0", fromAccounts && "accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring")}
                        checked={selected.has(t.id)}
                        disabled={blocked != null}
                        onChange={() => toggle(t.id)}
                        aria-label={`Select ${t.description || "transaction"} ${fmtDate(t.dateTime)}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className={cn("block font-medium text-foreground", fromAccounts ? "wrap-anywhere" : "truncate")}>{t.description || "Transaction"}</span>
                        <span className="block text-xs text-muted-foreground">{fmtDate(t.dateTime)}</span>
                        {blocked && (
                          <span className="mt-0.5 flex items-start gap-1 text-xs text-warning-foreground dark:text-warning">
                            <Ban className="mt-px size-3 shrink-0" /> {blocked}
                          </span>
                        )}
                        {!blocked && linked && (
                          <span className="mt-0.5 flex items-start gap-1 text-xs text-muted-foreground">
                            <Link2 className="mt-px size-3 shrink-0" />
                            {t.transferId != null ? "Linked transfer / payment — its other side is removed too" : splitOwned.has(t.id) ? "Shared expense — its People shares are removed too" : "People entry — removed from that person's ledger too"}
                          </span>
                        )}
                      </span>
                      <span className={cn("shrink-0 font-semibold tabular-nums", amount >= 0 ? "text-success" : "text-foreground")}>
                        {amount >= 0 ? "+" : "−"}
                        {formatCurrency(Math.abs(t.amount))}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <DialogFooter className={cn("gap-2 sm:justify-between", fromAccounts && ACCOUNTS_FOOTER)}>
              <ClayButton variant="ghost" onClick={() => close(false)}>
                Close
              </ClayButton>
              <div className={cn("flex flex-wrap gap-2", fromAccounts && "*:w-full min-[440px]:*:w-auto sm:justify-end")}>
                <ClayButton
                  variant={fromAccounts ? "primary" : "secondary"}
                  className={cn(fromAccounts && "bg-danger text-danger-foreground hover:bg-danger/90 disabled:bg-secondary disabled:text-muted-foreground")}
                  disabled={selected.size === 0}
                  onClick={() => begin("selected")}
                >
                  Delete Selected Transactions{selected.size > 0 ? ` (${selected.size})` : ""}
                </ClayButton>
                <ClayButton
                  variant={fromAccounts ? "secondary" : "primary"}
                  className={fromAccounts ? "border-danger/30 text-danger hover:bg-danger/10" : "bg-danger text-danger-foreground"}
                  disabled={deletableIds.length === 0}
                  onClick={() => begin("all")}
                >
                  Delete All Transactions
                </ClayButton>
              </div>
            </DialogFooter>
          </>
        )}

        {(step === "confirm" || step === "confirmAll") && (
          <>
            <div className={cn("flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto text-sm", fromAccounts && "min-h-24 overscroll-contain wrap-anywhere")}>
              <div className="rounded-[10px] border border-danger/30 bg-danger/6 px-3 py-2.5">
                <p className="font-semibold text-foreground">
                  {mode === "all" ? "Delete ALL transactions" : "Delete selected transactions"} · {name}
                </p>
                <p className="text-muted-foreground">
                  {plural(plan.ownTransactionCount, "transaction")} on {name}
                  {plan.otherAccountTransactionCount > 0 && ` + ${plural(plan.otherAccountTransactionCount, "linked transaction")} on other accounts`} will be removed.
                </p>
              </div>

              <ul className="divide-y divide-border rounded-[10px] border border-border-strong/60">
                {plan.counts.direct > 0 && <ImpactRow n={plan.counts.direct} text="ordinary transactions — only this account changes" />}
                {plan.counts.transfers > 0 && <ImpactRow n={plan.counts.transfers} text="transfers / card bill payments — the other account's side is removed too" />}
                {plan.counts.fees > 0 && <ImpactRow n={plan.counts.fees} text="transfer fees removed with their transfer" />}
                {plan.counts.splits > 0 && <ImpactRow n={plan.counts.splits} text="shared expenses — their schedules and People shares are removed" />}
                {plan.counts.people > 0 && <ImpactRow n={plan.counts.people} text="People cash movements — the matching People ledger entries are removed" />}
              </ul>

              {plan.balanceMovements.length > 0 && (
                <div className="rounded-[10px] border border-border-strong/60 px-3 py-2">
                  <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Balance after</p>
                  {own && (
                    <p className={cn("flex justify-between", fromAccounts && "flex-wrap gap-x-3")}>
                      <span>{name}</span>
                      <span className="tabular-nums">
                        {formatCurrency(own.before)} → <strong>{formatCurrency(own.after)}</strong>
                      </span>
                    </p>
                  )}
                  {others.map((m) => (
                    <p key={m.accountId} className={cn("flex justify-between text-muted-foreground", fromAccounts && "flex-wrap gap-x-3")}>
                      <span>{m.name}</span>
                      <span className="tabular-nums">
                        {formatCurrency(m.before)} → {formatCurrency(m.after)}
                      </span>
                    </p>
                  ))}
                  {kind === "card" && own && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Outstanding becomes {formatCurrency(Math.max(0, -own.after))}; the card&apos;s limit, billing cycle and due date are untouched and available credit recalculates from this.
                    </p>
                  )}
                </div>
              )}

              {plan.blocked.length > 0 && (
                <div className="rounded-[10px] border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
                  <p className="flex items-center gap-1.5 font-semibold text-foreground">
                    <Ban className="size-3.5" /> {plural(plan.blocked.length, "transaction")} will NOT be deleted
                  </p>
                  <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                    {plan.blocked.slice(0, 4).map((b) => (
                      <li key={b.transaction.id}>
                        {b.transaction.description || "Transaction"} — {b.reason}
                      </li>
                    ))}
                    {plan.blocked.length > 4 && <li>…and {plan.blocked.length - 4} more.</li>}
                  </ul>
                </div>
              )}

              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" />
                Historical reports (spending, income, categories, Net Worth, statements) will change because these transactions no longer exist. This cannot be undone from here.
              </p>

              {plan.needsLinkedAcknowledgement && (
                <label className="flex cursor-pointer items-start gap-2.5 rounded-[10px] border border-border-strong px-3 py-2.5 font-medium">
                  <input type="checkbox" className="mt-0.5 size-4" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  <span>I understand linked records on other accounts, in People and in split expenses will also be removed.</span>
                </label>
              )}

              {step === "confirmAll" && (
                <label className="flex flex-col gap-1.5">
                  <span className="text-muted-foreground">
                    Type <strong className="text-foreground">{name}</strong> to delete its whole transaction history
                  </span>
                  <input
                    className="h-10 rounded-[6px] border border-border bg-background px-3 text-sm outline-none focus:border-danger focus:ring-2 focus:ring-danger/20"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={name}
                  />
                </label>
              )}
            </div>
            <DialogFooter className={cn(fromAccounts && ACCOUNTS_FOOTER)}>
              <ClayButton variant="ghost" onClick={() => setStep("pick")}>
                Back
              </ClayButton>
              {mode === "all" && step === "confirm" ? (
                <ClayButton variant="primary" className="bg-danger text-danger-foreground" disabled={plan.steps.length === 0 || !confirmReady} onClick={() => setStep("confirmAll")}>
                  Continue
                </ClayButton>
              ) : (
                <ClayButton
                  variant="primary"
                  className="bg-danger text-danger-foreground"
                  disabled={plan.steps.length === 0 || !confirmReady || (mode === "all" && typed.trim() !== name) || actions == null}
                  onClick={() => void execute()}
                >
                  {mode === "all" ? "Delete All Transactions" : `Delete ${plural(plan.ownTransactionCount, "transaction")}`}
                </ClayButton>
              )}
            </DialogFooter>
          </>
        )}

        {step === "running" && (
          <p className="py-6 text-center text-sm text-muted-foreground" role="status">
            Deleting… {progress ? `${progress.done} of ${progress.total}` : ""} — please keep this window open.
          </p>
        )}

        {step === "done" && (
          <>
            <div className={cn("flex flex-col gap-2 text-sm", fromAccounts && "min-h-0 overflow-y-auto overscroll-contain wrap-anywhere")}>
              <p className="flex items-center gap-2 font-semibold text-foreground">
                <CheckCheck className="size-4 text-success" /> {plural(removed, "transaction")} deleted
              </p>
              {failures.length > 0 && (
                <div className="rounded-[10px] border border-danger/30 bg-danger/6 px-3 py-2">
                  <p className="font-semibold text-foreground">{plural(failures.length, "transaction")} kept — nothing was changed for them:</p>
                  <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
                    {failures.map((f) => (
                      <li key={f.step.transaction.id}>
                        {f.step.transaction.description || "Transaction"} — {f.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <DialogFooter className={cn(fromAccounts && ACCOUNTS_FOOTER)}>
              <ClayButton variant="primary" onClick={() => close(false)}>
                Done
              </ClayButton>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ImpactRow({ n, text }: { n: number; text: string }) {
  return (
    <li className="flex items-baseline gap-3 px-3 py-1.5">
      <span className="w-8 shrink-0 text-right font-semibold text-danger tabular-nums">{n}</span>
      <span className="text-foreground/85">{text}</span>
    </li>
  );
}
