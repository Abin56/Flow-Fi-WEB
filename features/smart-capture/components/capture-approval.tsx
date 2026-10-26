"use client";

/**
 * Step 3 of Smart Capture — classification and approval, handed to
 * Transaction Studio's own engine: rows become `StagedRecord`s, are gated by
 * `getPreflightBlockers`, duplicate-checked by
 * `detectFreshDuplicatesForCommit` (+ the shared `DuplicateWarningDialog`),
 * and written only by `commitReviewImport` — after an explicit click.
 *
 * Only single-write Actions (expense / income / refund / ignore) are offered;
 * EMI, loan, transfer and shared-split Actions stay unavailable here.
 */

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronLeft, CreditCard, Loader2, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { ClayButton } from "@/components/clay/clay-button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCurrencyPrecise } from "@/lib/format";
import { useAccounts } from "@/hooks/use-accounts";
import { useBills } from "@/hooks/use-bills";
import { useCategories } from "@/hooks/use-categories";
import { useEmis } from "@/hooks/use-credit-cards";
import { useLoans } from "@/hooks/use-loans";
import { usePeople } from "@/hooks/use-people";
import { useTransactions } from "@/hooks/use-transactions";
import { createAccountRepository, createEmiRepository, createExpenseRepository, createInstallmentRepositoryFor, createLoanRepository, createTransactionRepository } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";
import { DuplicateWarningDialog } from "@/lib/services/duplicate-detection/duplicate-warning-dialog";
import { ACTION_META } from "@/features/transaction-studio/lib/action-metadata";
import { commitReviewImport, detectFreshDuplicatesForCommit, getPreflightBlockers, type CommitReviewImportResult, type FreshDuplicateWarning } from "@/features/transaction-studio/lib/commit-review-import";
import { ImportSuccessPanel } from "@/features/transaction-studio/components/import-success-panel";
import { ValidationPanel } from "@/features/transaction-studio/components/validation-panel";
import type { Category } from "@/lib/models/category";
import { CAPTURE_ACTIONS_BY_DIRECTION, applyRowPatch, captureSessionId, toStagedRecords, type CaptureAction, type ReviewRow, type RowPatch } from "../lib/capture-review";

function categoriesFor(action: CaptureAction | null, categories: Category[]): Category[] {
  const wanted = action === "normal_expense" ? "expense" : "income";
  return categories.filter((c) => c.isActive !== false && c.deletedAt == null && (c.type === wanted || c.type === "both"));
}

export function CaptureApproval({
  rows,
  onRowsChange,
  sourceText,
  onBack,
  accountId,
  onAccountChange,
  onComplete,
}: {
  rows: ReviewRow[];
  onRowsChange: (rows: ReviewRow[]) => void;
  sourceText: string;
  onBack: () => void;
  accountId: string | null;
  onAccountChange: (accountId: string) => void;
  /** Called once every included row is imported (or ignored) — the capture is finished. */
  onComplete: () => void;
}) {
  const uid = useAuthStore((s) => s.user?.uid);
  const { data: accounts = [] } = useAccounts();
  const { data: categories = [] } = useCategories();
  const { data: people = [] } = usePeople();
  const { data: emis = [] } = useEmis();
  const { data: loans = [] } = useLoans();
  const { data: bills = [] } = useBills();
  const { data: transactions = [] } = useTransactions();

  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<CommitReviewImportResult | null>(null);
  const [warnings, setWarnings] = useState<FreshDuplicateWarning[] | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [duplicateDialogOpen, setDuplicateDialogOpen] = useState(false);

  const accountOptions = useMemo(
    () => accounts.filter((a) => a.deletedAt == null).sort((a, b) => Number(b.type === "card") - Number(a.type === "card") || a.name.localeCompare(b.name)),
    [accounts],
  );
  const included = rows.filter((r) => r.include);
  const staged = useMemo(() => toStagedRecords(rows), [rows]);
  const blockers = useMemo(() => getPreflightBlockers(staged, categories), [staged, categories]);
  const blockedIds = new Set(blockers.map((b) => b.recordId));
  const duplicateIds = new Set((warnings ?? []).map((w) => w.recordId));
  const pending = staged.filter((s) => !s.committedTransactionId && s.flowType !== "ignore");
  const sessionId = accountId ? captureSessionId(sourceText, accountId) : null;

  const patch = (id: string, p: RowPatch) => onRowsChange(rows.map((r) => (r.id === id ? applyRowPatch(r, p) : r)));
  const applyCategoryToAll = (action: CaptureAction, category: string) =>
    onRowsChange(rows.map((r) => (r.include && !r.committedTransactionId && r.action === action ? applyRowPatch(r, { category }) : r)));

  async function approve(skipDuplicateCheck = false) {
    if (!uid || !accountId || !sessionId) return;
    setCommitError(null);
    if (!skipDuplicateCheck) {
      const fresh = detectFreshDuplicatesForCommit(staged, transactions, accountId, sessionId);
      if (fresh.length > 0) {
        setWarnings(fresh);
        setDuplicateDialogOpen(true);
        return;
      }
    }
    setCommitting(true);
    // Local mirror so each acknowledged row is reflected even while the loop is still running.
    let latest = rows;
    try {
      const accountRepository = createAccountRepository(uid);
      const commit = await commitReviewImport({
        documentId: sessionId,
        rows: staged,
        accountId,
        categories,
        people,
        accounts,
        emis,
        loans,
        bills,
        repositories: {
          transactionRepository: createTransactionRepository(uid, accountRepository),
          expenseRepository: createExpenseRepository(uid, accountRepository),
          emiRepository: createEmiRepository(uid),
          loanRepository: createLoanRepository(uid),
          installmentRepositoryFor: (scheduleId) => createInstallmentRepositoryFor(uid, scheduleId),
        },
        onRowCommitted: async (recordId, transactionId) => {
          latest = latest.map((r) => (r.id === recordId ? { ...r, committedTransactionId: transactionId } : r));
          onRowsChange(latest);
        },
      });
      setResult(commit);
      setWarnings(null);
    } catch (e) {
      setCommitError(e instanceof Error ? e.message : "Import failed — nothing further was written.");
    } finally {
      setCommitting(false);
    }
  }

  const allDone = included.length > 0 && included.every((r) => r.committedTransactionId || r.action === "ignore");
  useEffect(() => {
    if (allDone) onComplete();
  }, [allDone, onComplete]);

  return (
    <div className="flex flex-col gap-4">
      <section className="surface-primary flex flex-col gap-3 rounded-3xl p-4 sm:flex-row sm:items-center">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-2xl bg-primary/10 text-primary-accent-text">
            <CreditCard className="size-5" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">Which card or account is this statement from?</p>
            <p className="text-xs text-muted-foreground">Every approved row is recorded on this account.</p>
          </div>
        </div>
        <Select value={accountId ?? undefined} onValueChange={onAccountChange} disabled={committing || rows.some((r) => r.committedTransactionId)}>
          <SelectTrigger className="w-full rounded-2xl sm:ml-auto sm:w-72" aria-label="Card or account">
            <SelectValue placeholder="Choose card or account" />
          </SelectTrigger>
          <SelectContent>
            {accountOptions.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
                {a.type === "card" ? " · Card" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </section>

      <BulkCategoryBar rows={rows} categories={categories} onApply={applyCategoryToAll} />

      <section className="surface-primary overflow-hidden rounded-3xl">
        <ul className="divide-y divide-border">
          {included.map((row) => {
            const actions = row.direction ? CAPTURE_ACTIONS_BY_DIRECTION[row.direction] : [];
            const options = categoriesFor(row.action, categories);
            const done = row.committedTransactionId != null;
            return (
              <li key={row.id} className={cn("grid items-center gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_9rem_11rem_12rem]", done && "bg-success/5")}>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{row.description}</p>
                  <p className="text-xs text-muted-foreground">
                    {row.date?.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                    {duplicateIds.has(row.id) && <span className="ml-2 text-warning">· Possible duplicate</span>}
                    {blockedIds.has(row.id) && !done && <span className="ml-2 text-warning">· {blockers.find((b) => b.recordId === row.id)?.blockingReasons[0]?.message}</span>}
                  </p>
                </div>
                <p className={cn("text-right text-sm font-semibold tabular-nums", row.direction === "credit" ? "text-success" : "text-expense")}>
                  {row.direction === "credit" ? "+" : "−"}
                  {formatCurrencyPrecise(row.amount ?? 0)}
                </p>
                {done ? (
                  <span className="col-span-2 inline-flex items-center gap-1.5 text-xs font-medium text-success sm:justify-self-end">
                    <CheckCircle2 className="size-4" /> Imported
                  </span>
                ) : (
                  <>
                    <Select value={row.action ?? undefined} onValueChange={(v) => patch(row.id, { action: v as CaptureAction, category: null })} disabled={committing}>
                      <SelectTrigger className="h-8 rounded-xl text-xs" aria-label="Action">
                        <SelectValue placeholder="Action" />
                      </SelectTrigger>
                      <SelectContent>
                        {actions.map((a) => (
                          <SelectItem key={a} value={a}>
                            {ACTION_META[a].label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={row.category ?? undefined} onValueChange={(v) => patch(row.id, { category: v })} disabled={committing || row.action === "ignore"}>
                      <SelectTrigger className="h-8 rounded-xl text-xs" aria-label="Category">
                        <SelectValue placeholder={row.action === "ignore" ? "Not needed" : "Category"} />
                      </SelectTrigger>
                      <SelectContent>
                        {options.map((c) => (
                          <SelectItem key={c.id} value={c.name}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <div className="flex items-start gap-2 rounded-2xl bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
        <ShieldCheck className="mt-px size-4 shrink-0 text-primary-accent-text" />
        <p>
          Imports run through Transaction Studio&apos;s own validation, duplicate check and commit engine. EMI, loan, transfer and split actions aren&apos;t available here — record those from
          Loan &amp; EMI or Transactions. Re-running the same capture on the same account won&apos;t create duplicates.
        </p>
      </div>

      {commitError && (
        <p role="alert" className="flex items-center gap-2 rounded-2xl border border-danger/30 bg-danger/10 px-4 py-2.5 text-sm text-danger">
          <AlertTriangle className="size-4" /> {commitError}
        </p>
      )}
      {result && <ValidationPanel result={result} onOpenRow={() => undefined} />}
      {result && <ImportSuccessPanel result={result} onDismiss={() => setResult(null)} />}

      <div className="sticky bottom-3 z-10 border border-border bg-card shadow-e4 flex flex-wrap items-center gap-3 rounded-3xl px-4 py-3">
        <ClayButton variant="ghost" size="sm" onClick={onBack} disabled={committing}>
          <ChevronLeft className="size-4" />
          Back to review
        </ClayButton>
        <p className="text-xs text-muted-foreground">
          {allDone
            ? "All approved rows are imported."
            : !accountId
              ? "Choose the card or account first."
              : blockers.length > 0
                ? `${blockers.length} row${blockers.length === 1 ? "" : "s"} still need an Action or category.`
                : `${pending.length} transaction${pending.length === 1 ? "" : "s"} will be written after you approve.`}
        </p>
        <ClayButton className="ml-auto" disabled={!uid || !accountId || committing || blockers.length > 0 || pending.length === 0} onClick={() => void approve()}>
          {committing && <Loader2 className="size-4 animate-spin" />}
          {committing ? "Importing…" : `Approve & Import (${pending.length})`}
        </ClayButton>
      </div>

      <DuplicateWarningDialog
        open={duplicateDialogOpen && warnings != null && warnings.length > 0}
        // Closing keeps the warnings so the flagged rows stay marked "Possible duplicate" for the user to exclude.
        onOpenChange={setDuplicateDialogOpen}
        result={warnings?.[0]?.result ?? null}
        additionalCount={Math.max(0, (warnings?.length ?? 0) - 1)}
        confirmLabel="Import anyway"
        busy={committing}
        onConfirm={() => {
          setDuplicateDialogOpen(false);
          void approve(true);
        }}
      />
    </div>
  );
}

function BulkCategoryBar({ rows, categories, onApply }: { rows: ReviewRow[]; categories: Category[]; onApply: (action: CaptureAction, category: string) => void }) {
  const groups = (["normal_expense", "refund", "income"] as const).filter((a) => rows.some((r) => r.include && !r.committedTransactionId && r.action === a));
  if (groups.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>Set category for all:</span>
      {groups.map((action) => (
        <Select key={action} onValueChange={(v) => onApply(action, v)}>
          <SelectTrigger className="h-8 w-auto rounded-xl text-xs" aria-label={`Category for all ${ACTION_META[action].label} rows`}>
            <SelectValue placeholder={`${ACTION_META[action].label} rows…`} />
          </SelectTrigger>
          <SelectContent>
            {categoriesFor(action, categories).map((c) => (
              <SelectItem key={c.id} value={c.name}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ))}
    </div>
  );
}
