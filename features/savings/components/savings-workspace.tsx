"use client";

import { PiggyBank, Plus, Target } from "lucide-react";
import { useMemo, useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { ConfirmDialog } from "@/components/finance";
import { SegmentedControl } from "@/components/forms/segmented-control";
import { ScrollNav } from "@/components/layout/scroll-nav";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { freeInAccount, type EntryView } from "@/lib/engines/savings-goals";
import type { SavingsEntryDirection } from "@/lib/models/savings-contribution";
import { toast } from "@/store/toast-store";
import { userFacingMessage } from "@/features/transactions/lib/error-toast";
import { useSavingsActions, useSavingsPosition } from "@/features/savings/hooks/use-savings-data";
import { GoalCard, type GoalActions } from "@/features/savings/components/goal-card";
import { GoalDetailDrawer } from "@/features/savings/components/goal-detail-drawer";
import { GoalFormDialog, type GoalFormValues } from "@/features/savings/components/goal-form-dialog";
import { MoneyEntryDialog } from "@/features/savings/components/money-entry-dialog";
import { EntryEditDialog } from "@/features/savings/components/entry-edit-dialog";
import { SavingsSummary } from "@/features/savings/components/savings-summary";

type Tab = "open" | "completed" | "archived";

const TEMPLATES = [
  { name: "Emergency fund", icon: "shield" },
  { name: "New laptop", icon: "laptop" },
  { name: "Vacation", icon: "travel" },
];

type Confirm =
  | { kind: "delete"; goalId: string }
  | { kind: "complete"; goalId: string }
  | { kind: "remove-entry"; goalId: string; entryId: string }
  | null;

export function SavingsWorkspace() {
  const { position, accounts, isLoading } = useSavingsPosition();
  const actions = useSavingsActions();

  const [tab, setTab] = useState<Tab>("open");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formState, setFormState] = useState<{ goalId: string | null; preset?: { name: string; icon: string } } | null>(null);
  const [money, setMoney] = useState<{ goalId: string; direction: SavingsEntryDirection } | null>(null);
  const [entryEdit, setEntryEdit] = useState<{ goalId: string; entryId: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const viewById = useMemo(() => new Map(position.views.map((v) => [v.goal.id, v])), [position.views]);
  const selected = selectedId ? (viewById.get(selectedId) ?? null) : null;
  const moneyView = money ? (viewById.get(money.goalId) ?? null) : null;
  const formView = formState?.goalId ? (viewById.get(formState.goalId) ?? null) : null;
  const editView = entryEdit ? (viewById.get(entryEdit.goalId) ?? null) : null;
  const editEntry: EntryView | null = editView && entryEdit ? (editView.entries.find((e) => e.entry.id === entryEdit.entryId) ?? null) : null;
  const confirmView = confirm ? (viewById.get(confirm.goalId) ?? null) : null;
  const confirmEntry = confirm?.kind === "remove-entry" && confirmView ? (confirmView.entries.find((e) => e.entry.id === confirm.entryId) ?? null) : null;

  const shown = tab === "open" ? position.open : tab === "completed" ? position.completed : position.archived;

  async function guarded(title: string, run: () => Promise<unknown>, success?: string) {
    try {
      await run();
      if (success) toast.success(success);
      return true;
    } catch (e) {
      toast.error(title, userFacingMessage(e) ?? "Please try again.");
      return false;
    }
  }

  const goalActions: GoalActions = {
    onOpen: (v) => setSelectedId(v.goal.id),
    onAdd: (v) => setMoney({ goalId: v.goal.id, direction: "in" }),
    onEdit: (v) => setFormState({ goalId: v.goal.id }),
    onComplete: (v) => setConfirm({ kind: "complete", goalId: v.goal.id }),
    onReopen: (v) => void guarded("Couldn't reopen the goal", async () => actions?.reopen(v.goal), `${v.goal.name} reopened`),
    onArchive: (v) => void guarded("Couldn't archive the goal", async () => actions?.archive(v.goal), `${v.goal.name} archived`),
    onUnarchive: (v) => void guarded("Couldn't unarchive the goal", async () => actions?.unarchive(v.goal), `${v.goal.name} restored`),
    onDelete: (v) => setConfirm({ kind: "delete", goalId: v.goal.id }),
  };

  async function saveGoal(values: GoalFormValues) {
    if (!actions) throw new Error("Not signed in");
    if (formView) {
      await actions.editGoal(formView, { name: values.name, targetAmount: values.targetAmount, dueDate: values.dueDate, clearDueDate: values.dueDate == null, notes: values.notes, icon: values.icon, accent: values.accent });
      toast.success("Goal updated");
    } else {
      await actions.createGoal({ name: values.name, targetAmount: values.targetAmount, dueDate: values.dueDate, notes: values.notes, icon: values.icon, accent: values.accent });
      setTab("open");
      toast.success(`${values.name} created`);
    }
  }

  async function runConfirm() {
    if (!confirm || !confirmView || !actions) return;
    setConfirmBusy(true);
    try {
      if (confirm.kind === "delete") {
        const ok = await guarded("Couldn't delete the goal", () => actions.deleteGoal(confirmView.goal), `${confirmView.goal.name} deleted`);
        if (ok && selectedId === confirm.goalId) setSelectedId(null);
      } else if (confirm.kind === "complete") {
        await guarded("Couldn't complete the goal", () => actions.markCompleted(confirmView), `${confirmView.goal.name} completed`);
      } else if (confirmEntry) {
        await guarded("Couldn't remove the entry", () => actions.removeEntry(confirmView, confirmEntry), confirmEntry.entry.mode === "transfer" && confirmEntry.active ? "Transfer undone" : "Entry removed");
      }
    } finally {
      setConfirmBusy(false);
      setConfirm(null);
    }
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-5 px-1">
        <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Savings</h1>
        <Skeleton className="h-40 rounded-3xl" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-44 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  const hasAny = position.views.length > 0;
  const tabOptions = [
    { value: "open", label: `Active (${position.open.length})` },
    { value: "completed", label: `Completed (${position.completed.length})` },
    ...(position.archived.length > 0 ? [{ value: "archived", label: `Archived (${position.archived.length})` }] : []),
  ];

  const confirmText = (() => {
    if (!confirm || !confirmView) return { title: "", description: "" };
    if (confirm.kind === "delete") {
      const moved = confirmView.entries.filter((e) => e.active && e.entry.mode === "transfer").length;
      return {
        title: `Delete ${confirmView.goal.name}?`,
        description:
          moved > 0
            ? `The goal moves to Trash. Money already transferred into your accounts stays there — nothing is moved back — and set-aside money becomes free again.`
            : `The goal moves to Trash. Set-aside money becomes free again; no account balance changes.`,
      };
    }
    if (confirm.kind === "complete") {
      return {
        title: `Mark ${confirmView.goal.name} completed?`,
        description: confirmView.reached ? "You've reached the target." : `You've saved ${formatCurrency(confirmView.saved)} of ${formatCurrency(confirmView.target)}. It will be closed early at that amount.`,
      };
    }
    const e = confirmEntry;
    if (!e) return { title: "Remove entry?", description: "" };
    if (e.entry.mode === "transfer" && e.active) {
      return { title: "Undo this transfer?", description: `${formatCurrency(e.entry.amount)} goes back to where it came from — both account balances are restored and the transfer is removed from Transactions.` };
    }
    return { title: e.reversed ? "Hide this entry?" : "Remove this entry?", description: e.reversed ? "Its transfer was already deleted in Transactions; this just clears it from the history." : "No account balance changes — the money is simply no longer set aside for this goal." };
  })();
  const blocker = confirm?.kind === "remove-entry" && confirmView && actions ? actions.removeBlocker(confirmView, confirm.entryId) : null;

  return (
    <div className="flex flex-col gap-4 px-1" data-testid="savings-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Savings</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Set goals, put money toward them, watch them grow.</p>
        </div>
        <ClayButton size="sm" className="h-9 gap-1.5 px-4" onClick={() => setFormState({ goalId: null })} data-testid="new-goal">
          <Plus className="size-3.5" />
          New goal
        </ClayButton>
      </div>

      {hasAny ? (
        <>
          <SavingsSummary position={position} accounts={accounts} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SegmentedControl value={tab} onChange={(v) => setTab(v as Tab)} options={tabOptions} className="savings-tabs" />
          </div>
          {shown.length === 0 ? (
            <div className="surface-flat flex items-center gap-3 rounded-2xl border border-border/50 px-4 py-6 text-sm text-muted-foreground">
              <Target className="size-4 shrink-0" />
              {tab === "open" ? "All your goals are completed or archived — start a new one when you're ready." : tab === "completed" ? "Completed goals will collect here." : "Nothing archived."}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="savings-goal-grid">
              {shown.map((v) => (
                <GoalCard key={v.goal.id} view={v} actions={goalActions} mode={tab} />
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="surface-flat flex flex-col items-center gap-3 rounded-3xl border border-border/50 px-6 py-10 text-center" data-testid="savings-empty">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/15 text-primary-accent-text">
            <PiggyBank className="size-6" />
          </span>
          <div>
            <p className="text-base font-semibold text-foreground">Start your first savings goal</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">Name what you&apos;re saving for, set a target, and decide how the money gets there — set aside from an account, or moved into a savings account.</p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {TEMPLATES.map((t) => (
              <button key={t.name} type="button" className="rounded-full border border-border/60 bg-muted/30 px-3 py-1.5 text-xs font-medium text-foreground/80 hover:border-border hover:text-foreground" onClick={() => setFormState({ goalId: null, preset: t })}>
                {t.name}
              </button>
            ))}
          </div>
          <ClayButton size="sm" className="gap-1.5" onClick={() => setFormState({ goalId: null })}>
            <Plus className="size-3.5" /> Create a goal
          </ClayButton>
        </div>
      )}

      <GoalDetailDrawer
        open={selectedId != null}
        onOpenChange={(o) => !o && setSelectedId(null)}
        view={selected}
        accounts={accounts}
        onAdd={() => selected && setMoney({ goalId: selected.goal.id, direction: "in" })}
        onWithdraw={() => selected && setMoney({ goalId: selected.goal.id, direction: "out" })}
        onEditGoal={() => selected && setFormState({ goalId: selected.goal.id })}
        onEditEntry={(e) => selected && setEntryEdit({ goalId: selected.goal.id, entryId: e.entry.id })}
        onRemoveEntry={(e) => selected && setConfirm({ kind: "remove-entry", goalId: selected.goal.id, entryId: e.entry.id })}
        onComplete={() => selected && setConfirm({ kind: "complete", goalId: selected.goal.id })}
        onReopen={() => selected && goalActions.onReopen(selected)}
      />

      <GoalFormDialog
        open={formState != null}
        onOpenChange={(o) => !o && setFormState(null)}
        view={formView}
        preset={formState?.preset}
        onSubmit={saveGoal}
      />

      <MoneyEntryDialog
        open={money != null}
        onOpenChange={(o) => !o && setMoney(null)}
        direction={money?.direction ?? "in"}
        view={moneyView}
        accounts={accounts}
        reservedByAccount={position.reservedByAccount}
        onSubmit={async (v, input) => {
          if (!actions) throw new Error("Not signed in");
          if (input.mode === "transfer" && !actions.hasTransferCategory) throw new Error('Create a "Transfer" category first (Settings → Categories), then try again.');
          await actions.recordEntry(v, input);
          toast.success(input.direction === "in" ? `Added ${formatCurrency(input.amount)} to ${v.goal.name}` : `Withdrew ${formatCurrency(input.amount)} from ${v.goal.name}`);
        }}
      />

      <EntryEditDialog
        open={editEntry != null}
        onOpenChange={(o) => !o && setEntryEdit(null)}
        view={editView}
        entry={editEntry}
        accountFree={(() => {
          const acc = accounts.find((a) => a.id === editEntry?.entry.accountId);
          return acc ? freeInAccount(acc, position.reservedByAccount.get(acc.id) ?? 0) : 0;
        })()}
        onSubmit={async (patch) => {
          if (!actions || !editView || !editEntry) return;
          await actions.editEntry(editView, editEntry, patch);
          toast.success("Entry updated");
        }}
      />

      <ConfirmDialog
        open={confirm != null && !blocker}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirmText.title}
        description={confirmText.description}
        variant={confirm?.kind === "complete" ? "default" : "destructive"}
        confirmLabel={confirm?.kind === "delete" ? "Delete" : confirm?.kind === "complete" ? "Mark completed" : confirmEntry?.entry.mode === "transfer" && confirmEntry.active ? "Undo transfer" : "Remove"}
        onConfirm={runConfirm}
        loading={confirmBusy}
      />
      <ConfirmDialog
        open={confirm != null && !!blocker}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Can't remove this yet"
        description={blocker ?? ""}
        confirmLabel="OK"
        cancelLabel="Close"
        onConfirm={() => setConfirm(null)}
      />
      <ScrollNav />
    </div>
  );
}
