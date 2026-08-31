"use client";

import {
  Archive,
  ArchiveRestore,
  Calendar,
  CheckCircle2,
  MoreVertical,
  Plus,
  Target,
  Trophy,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { ClayBadge } from "@/components/clay/clay-badge";
import { ClayButton } from "@/components/clay/clay-button";
import { ConfirmDialog, CurrencyCell, DetailDrawer, EmptyState, FormDialog, SectionLabel } from "@/components/finance";
import { Skeleton } from "@/components/ui/skeleton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ProgressRing } from "@/components/foundation/progress-ring";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  useArchivedSavingsRows,
  useSavingsActions,
  useSavingsRows,
  type SavingsGoalRow,
} from "@/features/savings/hooks/use-savings-data";

const STAT_TONE_CLASS = {
  purple: { card: "bg-purple/8 border-purple/20", icon: "bg-purple/20 text-purple" },
  success: { card: "bg-success/8 border-success/20", icon: "bg-success/20 text-success" },
  primary: { card: "bg-primary/8 border-primary/20", icon: "bg-primary/20 text-primary" },
  warning: { card: "bg-warning/12 border-warning/25", icon: "bg-warning/25 text-warning-foreground" },
} as const;

function StatCard({
  label,
  value,
  subtitle,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  subtitle: string;
  icon: LucideIcon;
  tone: keyof typeof STAT_TONE_CLASS;
}) {
  const toneClass = STAT_TONE_CLASS[tone];
  return (
    <div className={cn("flex flex-col gap-3 rounded-3xl border p-4", toneClass.card)}>
      <div className="flex items-center gap-2">
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-xl", toneClass.icon)}>
          <Icon className="size-4" />
        </span>
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
      </div>
      <div>
        <p className="font-mono text-xl font-semibold tabular-nums text-foreground">{value}</p>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}

interface GoalFormState {
  name: string;
  targetAmount: string;
  dueDate: string;
  notes: string;
}

function emptyForm(): GoalFormState {
  return { name: "", targetAmount: "", dueDate: "", notes: "" };
}

function formatDueDate(date: Date | null): string {
  if (!date) return "No due date";
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function GoalCard({ row, onSelect }: { row: SavingsGoalRow; onSelect: () => void }) {
  const { goal, progress: ratio } = row;
  const pct = Math.round(ratio * 100);
  const tone = goal.isCompleted ? "success" : pct >= 80 ? "primary" : "purple";
  const ringColor = goal.isCompleted ? "var(--success)" : "var(--primary)";

  return (
    <button
      type="button"
      onClick={onSelect}
      className="surface-flat flex flex-col gap-4 rounded-2xl border border-border/50 p-5 text-left transition-colors hover:border-border"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">{goal.name}</h3>
          <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            <Calendar className="size-3" />
            {formatDueDate(goal.dueDate)}
          </p>
        </div>
        {goal.isCompleted ? (
          <ClayBadge tone="success">Completed</ClayBadge>
        ) : (
          <ClayBadge tone={tone === "primary" ? "primary" : "purple"}>{pct}%</ClayBadge>
        )}
      </div>

      <div className="flex items-center gap-4">
        <ProgressRing value={pct} size={64} strokeWidth={6} color={ringColor}>
          <span className="text-xs font-semibold tabular-nums text-foreground">{pct}%</span>
        </ProgressRing>
        <div className="min-w-0 flex-1">
          <p className="text-lg font-bold tabular-nums text-foreground">{formatCurrency(goal.currentAmount)}</p>
          <p className="text-xs text-muted-foreground">of {formatCurrency(goal.targetAmount)}</p>
        </div>
      </div>
    </button>
  );
}

export function SavingsWorkspace() {
  const { rows, isLoading } = useSavingsRows();
  const { rows: archivedRows } = useArchivedSavingsRows();
  const actions = useSavingsActions();

  const [activeRow, setActiveRow] = useState<SavingsGoalRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [contributeOpen, setContributeOpen] = useState(false);
  const [form, setForm] = useState<GoalFormState>(emptyForm);
  const [contributionAmount, setContributionAmount] = useState("");
  const [saving, setSaving] = useState(false);

  const totals = useMemo(() => {
    const totalSaved = rows.reduce((sum, r) => sum + r.goal.currentAmount, 0);
    const totalTarget = rows.reduce((sum, r) => sum + r.goal.targetAmount, 0);
    const active = rows.filter((r) => !r.goal.isCompleted).length;
    const completed = rows.filter((r) => r.goal.isCompleted).length;
    return { totalSaved, totalTarget, active, completed };
  }, [rows]);

  function openAdd() {
    setActiveRow(null);
    setForm(emptyForm());
    setAddOpen(true);
  }

  function openEdit(row: SavingsGoalRow) {
    setActiveRow(row);
    setForm({
      name: row.goal.name,
      targetAmount: String(row.goal.targetAmount),
      dueDate: row.goal.dueDate ? row.goal.dueDate.toISOString().slice(0, 10) : "",
      notes: row.goal.notes,
    });
    setEditOpen(true);
  }

  function openContribute(row: SavingsGoalRow) {
    setActiveRow(row);
    setContributionAmount("");
    setContributeOpen(true);
  }

  async function handleCreate() {
    if (!actions) return;
    setSaving(true);
    try {
      await actions.createGoal({
        name: form.name,
        targetAmount: Number(form.targetAmount),
        dueDate: form.dueDate ? new Date(form.dueDate) : null,
        notes: form.notes,
      });
      setAddOpen(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleEdit() {
    if (!actions || !activeRow) return;
    setSaving(true);
    try {
      await actions.editGoal(activeRow.goal, {
        name: form.name,
        targetAmount: Number(form.targetAmount),
        dueDate: form.dueDate ? new Date(form.dueDate) : null,
        clearDueDate: !form.dueDate,
        notes: form.notes,
      });
      setEditOpen(false);
      setActiveRow(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleContribute() {
    if (!actions || !activeRow) return;
    setSaving(true);
    try {
      await actions.contribute(activeRow.goal, Number(contributionAmount));
      setContributeOpen(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleArchive() {
    if (!actions || !activeRow) return;
    await actions.archive(activeRow.goal);
    setActiveRow(null);
  }

  async function handleDelete() {
    if (!actions || !activeRow) return;
    await actions.deleteGoal(activeRow.goal);
    setDeleteOpen(false);
    setActiveRow(null);
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-5 px-1">
        <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Savings</h1>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-3xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  const activeGoal = activeRow ? rows.find((r) => r.goal.id === activeRow.goal.id) ?? activeRow : null;

  return (
    <div className="flex flex-col gap-5 px-1">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Savings</h1>
          <p className="mt-1 text-sm text-muted-foreground">Set goals. Track progress. Watch it grow.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ClayButton size="sm" className="gap-1.5" onClick={openAdd}>
            <Plus className="size-3.5" />
            New Goal
          </ClayButton>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <ClayButton variant="ghost" size="icon" aria-label="More options">
                <MoreVertical className="size-4" />
              </ClayButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={openAdd}>New Goal</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total Saved" value={formatCurrency(totals.totalSaved)} subtitle="across all goals" icon={Wallet} tone="primary" />
        <StatCard label="Total Target" value={formatCurrency(totals.totalTarget)} subtitle="combined targets" icon={Target} tone="purple" />
        <StatCard label="Active Goals" value={String(totals.active)} subtitle="in progress" icon={Wallet} tone="warning" />
        <StatCard label="Completed" value={String(totals.completed)} subtitle="goals reached" icon={Trophy} tone="success" />
      </div>

      <div className="surface-flat rounded-3xl border border-border/50 p-5">
        <h2 className="text-sm font-semibold text-foreground">Your Goals ({rows.length})</h2>
        {rows.length === 0 ? (
          <EmptyState
            icon={Target}
            title="No savings goals yet"
            description="Create a goal — like a new laptop or an emergency fund — and start contributing toward it."
            actionLabel="New Goal"
            onAction={openAdd}
          />
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((row) => (
              <GoalCard key={row.goal.id} row={row} onSelect={() => setActiveRow(row)} />
            ))}
          </div>
        )}
      </div>

      {archivedRows.length > 0 && (
        <div className="surface-flat rounded-3xl border border-border/50 p-5">
          <h2 className="text-sm font-semibold text-foreground">Archived Goals ({archivedRows.length})</h2>
          <div className="mt-3 flex flex-col divide-y divide-border/60">
            {archivedRows.map(({ goal, progress: ratio }) => (
              <div key={goal.id} className="flex items-center gap-3 py-2.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <Archive className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{goal.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatCurrency(goal.currentAmount)} / {formatCurrency(goal.targetAmount)} ({Math.round(ratio * 100)}%)
                  </p>
                </div>
                <ClayButton
                  variant="ghost"
                  size="icon"
                  aria-label="Unarchive"
                  onClick={() => actions?.unarchive(goal)}
                >
                  <ArchiveRestore className="size-4" />
                </ClayButton>
              </div>
            ))}
          </div>
        </div>
      )}

      <DetailDrawer
        open={activeRow != null && !editOpen && !deleteOpen && !contributeOpen}
        onOpenChange={(open) => !open && setActiveRow(null)}
        title={activeRow?.goal.name ?? ""}
        footer={
          activeGoal && (
            <div className="flex flex-col gap-2">
              <ClayButton className="w-full" onClick={() => openContribute(activeGoal)} disabled={activeGoal.goal.isCompleted}>
                Add Contribution
              </ClayButton>
              <div className="flex gap-2">
                <ClayButton variant="secondary" className="flex-1" onClick={() => openEdit(activeGoal)}>
                  Edit
                </ClayButton>
                <ClayButton variant="secondary" className="flex-1" onClick={handleArchive}>
                  Archive
                </ClayButton>
                <ClayButton variant="secondary" className="flex-1 text-expense" onClick={() => setDeleteOpen(true)}>
                  Delete
                </ClayButton>
              </div>
            </div>
          )
        }
      >
        {activeGoal && (
          <div className="flex flex-col gap-4 text-sm">
            <div className="flex justify-center py-2">
              <ProgressRing
                value={Math.round(activeGoal.progress * 100)}
                size={120}
                strokeWidth={10}
                color={activeGoal.goal.isCompleted ? "var(--success)" : "var(--primary)"}
              >
                <span className="text-2xl font-bold tabular-nums text-foreground">
                  {Math.round(activeGoal.progress * 100)}%
                </span>
              </ProgressRing>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Saved</span>
              <CurrencyCell amount={activeGoal.goal.currentAmount} signed={false} className="text-base font-semibold" />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Target</span>
              <CurrencyCell amount={activeGoal.goal.targetAmount} signed={false} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Remaining</span>
              <CurrencyCell amount={Math.max(0, activeGoal.goal.targetAmount - activeGoal.goal.currentAmount)} signed={false} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Due Date</span>
              <span className="text-foreground">{formatDueDate(activeGoal.goal.dueDate)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Status</span>
              {activeGoal.goal.isCompleted ? (
                <ClayBadge tone="success">
                  <CheckCircle2 className="size-3" /> Completed
                </ClayBadge>
              ) : (
                <ClayBadge tone="primary">In Progress</ClayBadge>
              )}
            </div>
            {activeGoal.goal.notes && (
              <div>
                <span className="text-muted-foreground">Notes</span>
                <p className="mt-1 text-foreground">{activeGoal.goal.notes}</p>
              </div>
            )}
          </div>
        )}
      </DetailDrawer>

      <FormDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        title="New Savings Goal"
        description="Give it a name and a target, and start contributing whenever you can."
        onConfirm={handleCreate}
        confirmLabel={saving ? "Saving…" : "Save"}
        contentClassName="sm:max-w-lg"
      >
        <div className="flex flex-col gap-3 rounded-2xl bg-muted/30 p-4 text-sm">
          <SectionLabel icon={Target}>Goal Details</SectionLabel>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Goal Name</span>
            <input
              type="text"
              className="clay-pressed h-10 rounded-xl px-3 text-sm outline-none"
              placeholder="New laptop"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Target Amount</span>
              <div className="relative">
                <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-primary">₹</span>
                <input
                  type="number"
                  className="clay-pressed h-10 w-full rounded-xl border border-primary/20 bg-primary/5 pl-7 text-sm font-semibold outline-none"
                  placeholder="0.00"
                  value={form.targetAmount}
                  onChange={(e) => setForm((f) => ({ ...f, targetAmount: e.target.value }))}
                />
              </div>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Due Date (optional)</span>
              <input
                type="date"
                className="clay-pressed h-10 rounded-xl px-3 text-sm outline-none"
                value={form.dueDate}
                onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Notes (optional)</span>
            <textarea
              className="clay-pressed min-h-20 resize-none rounded-xl px-3 py-2 text-sm outline-none"
              rows={3}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </label>
        </div>
      </FormDialog>

      <FormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        title={`Edit ${activeRow?.goal.name ?? "Goal"}`}
        onConfirm={handleEdit}
        confirmLabel={saving ? "Saving…" : "Save Changes"}
        contentClassName="sm:max-w-lg"
      >
        <div className="flex flex-col gap-3 rounded-2xl bg-muted/30 p-4 text-sm">
          <SectionLabel icon={Target}>Goal Details</SectionLabel>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Goal Name</span>
            <input
              type="text"
              className="clay-pressed h-10 rounded-xl px-3 text-sm outline-none"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Target Amount</span>
              <div className="relative">
                <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-primary">₹</span>
                <input
                  type="number"
                  className="clay-pressed h-10 w-full rounded-xl border border-primary/20 bg-primary/5 pl-7 text-sm font-semibold outline-none"
                  value={form.targetAmount}
                  onChange={(e) => setForm((f) => ({ ...f, targetAmount: e.target.value }))}
                />
              </div>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Due Date</span>
              <input
                type="date"
                className="clay-pressed h-10 rounded-xl px-3 text-sm outline-none"
                value={form.dueDate}
                onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Notes</span>
            <textarea
              className="clay-pressed min-h-20 resize-none rounded-xl px-3 py-2 text-sm outline-none"
              rows={3}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </label>
        </div>
      </FormDialog>

      <FormDialog
        open={contributeOpen}
        onOpenChange={setContributeOpen}
        title={`Add to ${activeRow?.goal.name ?? "Goal"}`}
        onConfirm={handleContribute}
        confirmLabel={saving ? "Saving…" : "Contribute"}
      >
        <div className="flex flex-col gap-3 py-1 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Contribution Amount</span>
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-primary">₹</span>
              <input
                type="number"
                className="clay-pressed h-10 w-full rounded-xl border border-primary/20 bg-primary/5 pl-7 text-sm font-semibold outline-none"
                placeholder="0.00"
                value={contributionAmount}
                onChange={(e) => setContributionAmount(e.target.value)}
              />
            </div>
          </label>
        </div>
      </FormDialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${activeRow?.goal.name ?? "this goal"}?`}
        description="This action cannot be undone."
        variant="destructive"
        confirmLabel="Delete"
        onConfirm={handleDelete}
      />
    </div>
  );
}
