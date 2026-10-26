"use client";

/**
 * Final approval. Nothing is written until the user ticks the confirmation and presses "Approve & import". The
 * summary is derived from the same plan the screen shows; the commit then re-reads FlowFi from the server and
 * checks it again (see approval-commit.ts), so this dialog can only ever ask for an import — never assume it.
 *
 * Results are precise per row and never "all done" while any row failed or is unresolved.
 */

import { AlertTriangle, ArrowLeft, CheckCircle2, CircleAlert, Eye, Inbox, Link2, Loader2, RefreshCw, ShieldCheck, WifiOff } from "lucide-react";
import { ClayButton } from "@/components/clay/clay-button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCurrencyPrecise } from "@/lib/format";
import type { Account } from "@/lib/models/account";
import { cn } from "@/lib/utils";
import type { ReconciliationApproval } from "../hooks/use-reconciliation-approval";
import type { ApprovalPlan, ImportAction, PlanRow } from "../lib/approval-plan";
import type { RowOutcome, RowOutcomeKind } from "../lib/approval-commit";
import { Chip, formatRowDate } from "./recon-ui";

const rupees = (paise: number) => formatCurrencyPrecise(paise / 100);

const ACTION_LABEL: Record<ImportAction, string> = { normal_expense: "Expense", refund: "Refund", income: "Income" };

const OUTCOME_META: Record<RowOutcomeKind, { label: string; tone: "success" | "primary" | "muted" | "purple" | "danger" }> = {
  imported: { label: "Imported", tone: "success" },
  already_imported: { label: "Already imported", tone: "success" },
  linked: { label: "Linked existing", tone: "primary" },
  ignored: { label: "Ignored", tone: "muted" },
  inbox: { label: "Left in Inbox", tone: "purple" },
  failed: { label: "Failed — retry available", tone: "danger" },
};

function Tile({ label, value, testId, tone }: { label: string; value: number; testId: string; tone?: "warning" }) {
  return (
    <div className="rounded-2xl bg-muted/50 px-3 py-2.5" data-testid={testId}>
      <p className={cn("font-heading text-xl font-semibold tabular-nums text-foreground", tone === "warning" && value > 0 && "text-warning")}>{value}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}

function ImportRow({ row }: { row: PlanRow }) {
  return (
    <li className="flex items-center gap-3 px-3 py-2" data-testid="approval-import-row" data-row-id={row.rowId}>
      <span className="w-6 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{row.number}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{row.description || "No description"}</p>
        <p className="truncate text-[11px] text-muted-foreground">
          {formatRowDate(row.date, true)} · {row.action ? ACTION_LABEL[row.action] : "?"} · {row.category ?? "No category"}
        </p>
      </div>
      <span className={cn("shrink-0 font-mono text-sm font-semibold tabular-nums", row.direction === "credit" ? "text-success" : "text-foreground")}>
        {row.direction === "credit" ? "+" : "−"}
        {formatCurrencyPrecise(row.amount ?? 0)}
      </span>
    </li>
  );
}

function Effects({ plan, account, isCard, label }: { plan: ApprovalPlan; account: Account | null; isCard: boolean; label: string }) {
  const net = Math.abs(plan.balanceDeltaPaise);
  return (
    <section aria-label="Expected effects" className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-3" data-testid="approval-effects">
      <h3 className="text-xs font-semibold text-foreground">What this will do to {label}</h3>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">New charges ({plan.rows.filter((r) => r.status === "import" && r.direction === "debit").length})</dt>
        <dd className="text-right font-mono tabular-nums" data-testid="approval-charges">
          −{rupees(plan.chargesPaise)}
        </dd>
        <dt className="text-muted-foreground">
          New credits ({plan.rows.filter((r) => r.status === "import" && r.direction === "credit").length})
          {plan.creditsPaise > 0 && (
            <span className="block text-[11px]">
              Refunds {rupees(plan.refundsPaise)} · Income {rupees(plan.incomePaise)}
            </span>
          )}
        </dt>
        <dd className="text-right font-mono tabular-nums text-success" data-testid="approval-credits">
          +{rupees(plan.creditsPaise)}
        </dd>
      </dl>
      <p className="border-t border-border pt-2 text-sm text-foreground" data-testid="approval-effect-text">
        {isCard ? (
          <>
            The amount owed on this card {plan.balanceDeltaPaise === 0 ? "does not change" : plan.balanceDeltaPaise < 0 ? <strong>rises by {rupees(net)}</strong> : <strong>falls by {rupees(net)}</strong>}. Charges count toward the bill their date falls in (open bills only).
          </>
        ) : (
          <>
            The account balance {plan.balanceDeltaPaise === 0 ? "does not change" : plan.balanceDeltaPaise < 0 ? <strong>falls by {rupees(net)}</strong> : <strong>rises by {rupees(net)}</strong>}
            {account ? (
              <>
                {" "}
                — from {formatCurrencyPrecise(account.currentBalance)} to {formatCurrencyPrecise(Math.round(account.currentBalance * 100 + plan.balanceDeltaPaise) / 100)}
              </>
            ) : null}
            .
          </>
        )}{" "}
        Linked, ignored and Inbox rows change nothing.
      </p>
    </section>
  );
}

function Outcomes({ outcomes, rows }: { outcomes: RowOutcome[]; rows: PlanRow[] }) {
  const rowOf = new Map(rows.map((r) => [r.rowId, r]));
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border" data-testid="approval-outcomes">
      {outcomes.map((o) => {
        const row = rowOf.get(o.rowId);
        const meta = OUTCOME_META[o.kind];
        return (
          <li key={o.rowId} className="flex flex-col gap-1 px-3 py-2" data-testid="approval-outcome" data-row-id={o.rowId} data-outcome={o.kind}>
            <div className="flex items-center gap-3">
              <span className="w-6 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{o.number}</span>
              <p className="min-w-0 flex-1 truncate text-sm text-foreground">{row?.description || "No description"}</p>
              <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                {row?.direction === "credit" ? "+" : "−"}
                {formatCurrencyPrecise(row?.amount ?? 0)}
              </span>
              <Chip tone={meta.tone}>{meta.label}</Chip>
            </div>
            {o.error && <p className="pl-9 text-[11px] text-danger">{o.error}</p>}
          </li>
        );
      })}
    </ul>
  );
}

export function ApprovalDialog({
  approval,
  plan,
  account,
  accountLabel,
  onClearReview,
}: {
  approval: ReconciliationApproval;
  plan: ApprovalPlan | null;
  account: Account | null;
  accountLabel: string;
  /** Explicit "I'm finished" after a complete run — discards the draft. Never automatic. */
  onClearReview: () => void;
}) {
  const { stage } = approval;
  const open = stage !== "closed";
  const isCard = account?.type === "card";
  const working = approval.isBusy;
  const imports = plan?.rows.filter((r) => r.status === "import") ?? [];
  const result = approval.result;
  const failed = result?.outcomes.filter((o) => o.kind === "failed").length ?? 0;
  const total = result?.outcomes.length ?? 0;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && approval.close()}>
      <DialogContent className="max-h-[calc(100dvh-1.5rem)] gap-4 sm:max-w-2xl" showCloseButton={!working} data-testid="approval-dialog" data-stage={stage} onInteractOutside={(e) => working && e.preventDefault()} onEscapeKeyDown={(e) => working && e.preventDefault()}>
        {(stage === "review" || stage === "checking" || stage === "importing") && plan && (
          <>
            <DialogHeader>
              <DialogTitle className="text-lg">Final approval</DialogTitle>
              <DialogDescription>Nothing is written to FlowFi until you confirm below. Linked, ignored and Inbox rows are never written.</DialogDescription>
            </DialogHeader>

            <p className="flex items-center gap-2 rounded-2xl bg-primary/10 px-3 py-2 text-sm text-foreground" data-testid="approval-account">
              <ShieldCheck className="size-4 shrink-0 text-primary-accent-text" />
              <span className="min-w-0">
                Imports go to <strong>{accountLabel}</strong> {isCard ? "(credit card)" : "(account)"} only.
              </span>
            </p>

            <section aria-label="Review totals" className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="approval-counts">
              <Tile label="Captured rows" value={plan.counts.captured} testId="count-captured" />
              <Tile label="New to import" value={plan.counts.newImports} testId="count-new" />
              <Tile label="Linked existing" value={plan.counts.linked} testId="count-linked" />
              <Tile label="Ignored" value={plan.counts.ignored} testId="count-ignored" />
              <Tile label="Left in Inbox" value={plan.counts.inbox} testId="count-inbox" />
              <Tile label="Unresolved / investigate" value={plan.counts.unresolved} testId="count-unresolved" tone="warning" />
            </section>
            {(plan.counts.alreadyImported > 0 || plan.counts.excluded > 0) && (
              <p className="-mt-2 text-[11px] text-muted-foreground" data-testid="approval-extra-counts">
                {plan.counts.alreadyImported > 0 && `${plan.counts.alreadyImported} already imported (nothing more to write)`}
                {plan.counts.alreadyImported > 0 && plan.counts.excluded > 0 && " · "}
                {plan.counts.excluded > 0 && `${plan.counts.excluded} left out of this review earlier`}
              </p>
            )}

            {plan.counts.newImports > 0 ? (
              <>
                <Effects plan={plan} account={account} isCard={isCard} label={accountLabel} />
                <section aria-label="New transactions" className="flex flex-col gap-1.5">
                  <h3 className="text-xs font-semibold text-foreground">New transactions ({imports.length})</h3>
                  <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-2xl border border-border">
                    {imports.map((row) => (
                      <ImportRow key={row.rowId} row={row} />
                    ))}
                  </ul>
                </section>
              </>
            ) : (
              <p className="flex items-start gap-2 rounded-2xl bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground" data-testid="approval-nothing">
                <Eye className="mt-px size-4 shrink-0" /> Nothing will be imported — every row is linked, ignored, in the Inbox or already imported. FlowFi stays exactly as it is.
              </p>
            )}

            {approval.liveChanged && (
              <div role="alert" className="flex flex-wrap items-center gap-2 rounded-2xl border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground" data-testid="approval-live-changed">
                <AlertTriangle className="size-4 shrink-0 text-warning" />
                <span className="min-w-0 flex-1">FlowFi&apos;s records changed while you were reviewing. Refresh this summary to see what it would do now.</span>
                <ClayButton size="sm" variant="secondary" onClick={approval.refresh}>
                  <RefreshCw className="size-3.5" /> Refresh summary
                </ClayButton>
              </div>
            )}

            {approval.repeatRowIds.length > 0 && (
              <label className="flex items-start gap-2 rounded-2xl border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground" data-testid="approval-repeats">
                <Checkbox checked={approval.repeatsAck} onCheckedChange={(v) => approval.setRepeatsAck(v === true)} disabled={working} aria-label="These repeated rows are separate transactions" />
                <span>
                  {approval.repeatRowIds.length} rows in this import look like repeats of each other (same merchant, amount and day). I checked — they are separate purchases and each should be imported.
                </span>
              </label>
            )}

            {plan.counts.newImports > 0 && (
              <label className="flex items-start gap-2 text-sm text-foreground">
                <Checkbox checked={approval.confirmed} onCheckedChange={(v) => approval.setConfirmed(v === true)} disabled={working || approval.liveChanged} aria-label="I confirm this import" data-testid="approval-confirm" />
                <span>
                  I&apos;ve checked this summary and want to import <strong>{plan.counts.newImports}</strong> new transaction{plan.counts.newImports === 1 ? "" : "s"} into {accountLabel}.
                </span>
              </label>
            )}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
              {working && (
                <p role="status" className="mr-auto flex items-center gap-2 text-xs text-muted-foreground" data-testid="approval-working">
                  <Loader2 className="size-4 animate-spin" /> {stage === "checking" ? "Checking FlowFi's latest records…" : "Importing — please keep this page open…"}
                </p>
              )}
              <ClayButton variant="secondary" onClick={approval.close} disabled={working}>
                <ArrowLeft className="size-4" /> Back to reconciliation
              </ClayButton>
              {plan.counts.newImports > 0 && (
                <ClayButton onClick={() => void approval.approve()} disabled={!approval.canApprove || working} data-testid="approval-submit">
                  {working && <Loader2 className="size-4 animate-spin" />}
                  {working ? "Working…" : `Approve & import ${plan.counts.newImports}`}
                </ClayButton>
              )}
            </div>
          </>
        )}

        {stage === "review" && !plan && (
          <>
            <DialogHeader>
              <DialogTitle className="text-lg">Final approval</DialogTitle>
              <DialogDescription>FlowFi&apos;s records are reloading, so this summary can&apos;t be shown right now. Nothing was written.</DialogDescription>
            </DialogHeader>
            <div className="flex justify-end">
              <ClayButton variant="secondary" onClick={approval.close}>
                <ArrowLeft className="size-4" /> Back to reconciliation
              </ClayButton>
            </div>
          </>
        )}

        {stage === "stale" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-lg">
                <CircleAlert className="size-5 text-warning" /> This review is out of date
              </DialogTitle>
              <DialogDescription data-testid="approval-stale-note">Nothing was imported. FlowFi&apos;s records are different from what you reviewed, so the approval stopped. Go back, look at the rows below, and approve again.</DialogDescription>
            </DialogHeader>
            <ul className="max-h-64 space-y-1.5 overflow-y-auto rounded-2xl border border-warning/30 bg-warning/5 p-3 text-sm" data-testid="approval-stale">
              {approval.staleReasons.map((r, i) => (
                <li key={`${r.code}-${r.rowId ?? i}-${i}`} className="flex gap-2">
                  {r.rowNumber ? <span className="shrink-0 font-medium text-foreground">Row {r.rowNumber}:</span> : null}
                  <span className="text-muted-foreground">{r.message}</span>
                </li>
              ))}
            </ul>
            <div className="flex justify-end">
              <ClayButton onClick={approval.close} data-testid="approval-stale-back">
                <ArrowLeft className="size-4" /> Back to reconciliation
              </ClayButton>
            </div>
          </>
        )}

        {stage === "unavailable" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-lg">
                <WifiOff className="size-5 text-warning" /> Couldn&apos;t re-check FlowFi
              </DialogTitle>
              <DialogDescription data-testid="approval-unavailable">Nothing was imported. FlowFi&apos;s records couldn&apos;t be read from the server just now, so the import can&apos;t be checked safely. {approval.message}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <ClayButton variant="secondary" onClick={approval.close}>
                Back to reconciliation
              </ClayButton>
              <ClayButton onClick={approval.refresh}>
                <RefreshCw className="size-4" /> Try again
              </ClayButton>
            </div>
          </>
        )}

        {stage === "result" && result && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-lg" data-testid="approval-result" data-status={result.status}>
                {result.status === "complete" ? (
                  <>
                    <CheckCircle2 className="size-5 text-success" /> All {total} rows are resolved
                  </>
                ) : (
                  <>
                    <AlertTriangle className="size-5 text-warning" /> {total - failed} of {total} rows done — {failed} need{failed === 1 ? "s" : ""} a retry
                  </>
                )}
              </DialogTitle>
              <DialogDescription>
                {result.status === "complete"
                  ? "Every row is imported, already imported, linked, ignored or left in the Inbox."
                  : "Rows that were imported are safe — retrying only attempts the failed ones, and nothing is written twice."}
              </DialogDescription>
            </DialogHeader>
            <section className="max-h-72 overflow-y-auto">
              <Outcomes outcomes={result.outcomes} rows={approval.rowsAtApproval} />
            </section>
            <p className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Link2 className="size-3" /> Linked rows were not changed
              </span>
              <span className="inline-flex items-center gap-1">
                <Inbox className="size-3" /> Inbox rows stay in the Inbox
              </span>
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              {result.status === "complete" && (
                <ClayButton variant="ghost" onClick={onClearReview} data-testid="approval-clear">
                  Clear this review
                </ClayButton>
              )}
              <ClayButton variant="secondary" onClick={approval.close}>
                Back to reconciliation
              </ClayButton>
              {result.status === "partial" && (
                <ClayButton onClick={approval.refresh} data-testid="approval-retry">
                  <RefreshCw className="size-4" /> Retry the {failed} failed
                </ClayButton>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
