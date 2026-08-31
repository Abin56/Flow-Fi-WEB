"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  MoreVertical,
  PieChart as PieChartIcon,
  Plus,
  Receipt,
  SlidersHorizontal,
  Target,
  Wallet,
  Wifi,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { ClayBadge } from "@/components/clay/clay-badge";
import { ClayButton } from "@/components/clay/clay-button";
import { ConfirmDialog, CurrencyCell, DetailDrawer, EmptyState, FinanceTable, FormDialog, SectionLabel, type FinanceTableColumn } from "@/components/finance";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useCategories } from "@/hooks/use-categories";
import { categoryIconFor } from "@/features/transactions/hooks/use-transactions-data";
import { formatCurrency } from "@/lib/format";
import { budgetTypeLabel } from "@/lib/models/budget";
import { statusFor } from "@/features/budgets/lib/budget-status";
import { toast } from "@/store/toast-store";
import type { Category } from "@/lib/models/category";
import {
  budgetTypeBreakdownFrom,
  useBudgetActions,
  useBudgetRows,
  useDailySpend,
  type BudgetRow,
} from "@/features/budgets/hooks/use-budgets-data";
import { cn } from "@/lib/utils";

const TONE_ICON_CLASS: Record<string, string> = {
  neutral: "bg-muted text-muted-foreground",
  primary: "bg-primary/12 text-primary",
  success: "bg-success/15 text-success",
  expense: "bg-expense/12 text-expense",
  warning: "bg-warning/20 text-warning-foreground",
  purple: "bg-purple/15 text-purple",
};

const TYPE_CHART_COLOR: Record<string, string> = {
  primary: "var(--primary)",
  success: "var(--success)",
  warning: "var(--warning)",
  expense: "var(--expense)",
  purple: "var(--purple)",
};

function percentOf(row: BudgetRow): number {
  return row.insight.limit === 0 ? 0 : Math.round((row.insight.spent / row.insight.limit) * 100);
}

function categoryNameOf(row: BudgetRow): string {
  return row.budget.categoryId == null ? `Overall (${budgetTypeLabel(row.budget.type)})` : (row.category?.name ?? "Uncategorized");
}

const STAT_TONE_CLASS = {
  purple: { card: "bg-purple/8 border-purple/20", icon: "bg-purple/20 text-purple", bar: "bg-purple" },
  expense: { card: "bg-expense/8 border-expense/20", icon: "bg-expense/20 text-expense", bar: "bg-expense" },
  success: { card: "bg-success/8 border-success/20", icon: "bg-success/20 text-success", bar: "bg-success" },
  warning: { card: "bg-warning/12 border-warning/25", icon: "bg-warning/25 text-warning-foreground", bar: "bg-warning" },
} as const;

function StatCard({
  label,
  value,
  subtitle,
  percent,
  tone,
  icon: Icon,
}: {
  label: string;
  value: string;
  subtitle: string;
  percent: number;
  tone: keyof typeof STAT_TONE_CLASS;
  icon: typeof Wallet;
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
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", toneClass.bar)} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      </div>
    </div>
  );
}

interface BudgetFormState {
  categoryId: string;
  amount: string;
}

function emptyForm(): BudgetFormState {
  return { categoryId: "", amount: "" };
}

export function BudgetsWorkspace() {
  const { rows, isLoading: rowsLoading } = useBudgetRows();
  const { days: dailyDays, average: dailyAverage } = useDailySpend();
  const { data: categories = [], isLoading: categoriesLoading } = useCategories();
  const actions = useBudgetActions();

  const [activeRow, setActiveRow] = useState<BudgetRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [form, setForm] = useState<BudgetFormState>(emptyForm);
  const [saving, setSaving] = useState(false);

  const isLoading = rowsLoading || categoriesLoading;

  const totals = useMemo(() => {
    const totalBudget = rows.reduce((sum, r) => sum + r.insight.limit, 0);
    const totalSpent = rows.reduce((sum, r) => sum + r.insight.spent, 0);
    const remaining = totalBudget - totalSpent;
    const onTrack = rows.filter((r) => statusFor(r.insight).label === "On Track").length;
    const atRisk = rows.filter((r) => statusFor(r.insight).label === "At Risk").length;
    const overBudget = rows.filter((r) => statusFor(r.insight).label === "Over Budget").length;
    const overBudgetAmount = rows.reduce((sum, r) => sum + Math.max(0, r.insight.spent - r.insight.limit), 0);
    return { totalBudget, totalSpent, remaining, onTrack, atRisk, overBudget, overBudgetAmount };
  }, [rows]);

  const breakdown = useMemo(() => budgetTypeBreakdownFrom(rows), [rows]);
  const typeTotal = breakdown.reduce((sum, t) => sum + t.budget, 0);
  const typeSpentTotal = breakdown.reduce((sum, t) => sum + t.spent, 0);
  const overallUsedPercent = typeTotal === 0 ? 0 : Math.round((typeSpentTotal / typeTotal) * 1000) / 10;

  const remaining = activeRow ? activeRow.insight.remaining : 0;

  const dailyChartData = dailyDays.map((value, i) => ({
    day: i + 1,
    value,
    label: i === 0 ? "Day 1" : i === 14 ? "Day 15" : i === dailyDays.length - 1 ? `Day ${dailyDays.length}` : "",
  }));

  const expenseCategories = useMemo(() => (categories as Category[]).filter((c) => c.type !== "income"), [categories]);

  function openAdd() {
    setActiveRow(null);
    setForm(emptyForm());
    setAddOpen(true);
  }

  function openEdit(row: BudgetRow) {
    setActiveRow(row);
    setForm({ categoryId: row.budget.categoryId ?? "", amount: String(row.budget.amount) });
    setEditOpen(true);
  }

  /** `Number("")` is 0, not NaN — so an empty field must be checked separately from a bad numeric string. */
  function validateAmount(): string | null {
    const amount = Number(form.amount);
    if (form.amount.trim() === "" || !Number.isFinite(amount) || amount <= 0) {
      return "Enter a budget amount greater than 0.";
    }
    return null;
  }

  async function handleCreate() {
    if (!actions) return;
    const validationError = validateAmount();
    if (validationError) {
      toast.error("Couldn't add budget", validationError);
      return;
    }
    setSaving(true);
    try {
      await actions.createBudget({
        type: "monthly",
        amount: Number(form.amount),
        categoryId: form.categoryId || null,
      });
      setAddOpen(false);
    } catch (e) {
      toast.error("Couldn't add budget", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleEdit() {
    if (!actions || !activeRow) return;
    const validationError = validateAmount();
    if (validationError) {
      toast.error("Couldn't save changes", validationError);
      return;
    }
    setSaving(true);
    try {
      await actions.editBudget(activeRow.budget, Number(form.amount));
      setEditOpen(false);
    } catch (e) {
      toast.error("Couldn't save changes", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!actions || !activeRow) return;
    try {
      await actions.deleteBudget(activeRow.budget);
      setDeleteOpen(false);
      setActiveRow(null);
    } catch (e) {
      toast.error("Couldn't delete budget", e instanceof Error ? e.message : "Please try again.");
    }
  }

  const columns: FinanceTableColumn<BudgetRow>[] = [
    {
      id: "category",
      header: "Category",
      accessor: (row) => {
        const Icon = row.category ? categoryIconFor(row.category.iconKey) : Wallet;
        const st = statusFor(row.insight);
        return (
          <div className="flex min-w-0 items-center gap-3">
            <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", TONE_ICON_CLASS[st.tone])}>
              <Icon className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground">{categoryNameOf(row)}</p>
              <p className="truncate text-xs text-muted-foreground">{budgetTypeLabel(row.budget.type)} budget</p>
            </div>
          </div>
        );
      },
    },
    {
      id: "budget",
      header: "Budget",
      accessor: (row) => <CurrencyCell amount={row.insight.limit} signed={false} />,
      numeric: true,
      width: "110px",
    },
    {
      id: "spent",
      header: "Spent",
      accessor: (row) => <CurrencyCell amount={row.insight.spent} signed={false} />,
      numeric: true,
      width: "110px",
    },
    {
      id: "remaining",
      header: "Remaining",
      accessor: (row) => (
        <CurrencyCell amount={row.insight.remaining} signed={false} className={row.insight.isOverBudget ? "text-expense" : undefined} />
      ),
      numeric: true,
      width: "110px",
    },
    {
      id: "percentUsed",
      header: "% Used",
      accessor: (row) => {
        const pct = percentOf(row);
        const st = statusFor(row.insight);
        return (
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full" style={{ width: `${Math.min(100, pct)}%`, backgroundColor: `var(--${st.tone})` }} />
            </div>
            <span className="text-xs font-medium tabular-nums text-foreground">{pct}%</span>
          </div>
        );
      },
      width: "150px",
    },
    {
      id: "status",
      header: "Status",
      accessor: (row) => {
        const st = statusFor(row.insight);
        return <ClayBadge tone={st.tone}>{st.label}</ClayBadge>;
      },
      width: "120px",
    },
    {
      id: "chevron",
      header: "",
      accessor: () => <ChevronRight className="size-4 text-muted-foreground" />,
      width: "32px",
    },
  ];

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-5 px-1 xl:grid-cols-12">
        <div className="flex flex-col gap-5 xl:col-span-8">
          <Skeleton className="h-16 rounded-2xl" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-28 rounded-3xl" />
            ))}
          </div>
          <Skeleton className="h-56 rounded-3xl" />
          <Skeleton className="h-72 rounded-3xl" />
        </div>
        <div className="flex flex-col gap-5 xl:col-span-4">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-40 rounded-3xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-5 px-1 xl:grid-cols-12">
      <div className="flex flex-col gap-5 xl:col-span-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Budgets</h1>
            <p className="mt-1 text-sm text-muted-foreground">Plan your money. Track progress. Achieve your goals.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ClayButton variant="secondary" size="sm" className="gap-1.5">
              This Month
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </ClayButton>
            <ClayButton variant="secondary" size="sm" className="gap-1.5">
              <SlidersHorizontal className="size-3.5" />
              Filters
            </ClayButton>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <ClayButton variant="ghost" size="icon" aria-label="More options">
                  <MoreVertical className="size-4" />
                </ClayButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setAddOpen(true)}>New Budget</DropdownMenuItem>
                <DropdownMenuItem>Export</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label="Total Budget"
            value={formatCurrency(totals.totalBudget)}
            subtitle="100% of planned"
            percent={100}
            icon={Wallet}
            tone="purple"
          />
          <StatCard
            label="Total Spent"
            value={formatCurrency(totals.totalSpent)}
            subtitle={totals.totalBudget === 0 ? "No budgets yet" : `${Math.round((totals.totalSpent / totals.totalBudget) * 1000) / 10}% of budget`}
            percent={totals.totalBudget === 0 ? 0 : (totals.totalSpent / totals.totalBudget) * 100}
            icon={Receipt}
            tone="expense"
          />
          <StatCard
            label="Remaining"
            value={formatCurrency(totals.remaining)}
            subtitle={totals.totalBudget === 0 ? "No budgets yet" : `${Math.round((totals.remaining / totals.totalBudget) * 1000) / 10}% left`}
            percent={totals.totalBudget === 0 ? 0 : (totals.remaining / totals.totalBudget) * 100}
            icon={CheckCircle2}
            tone="success"
          />
          <StatCard
            label="Over Budget"
            value={formatCurrency(totals.overBudgetAmount)}
            subtitle={`${totals.overBudget} categories`}
            percent={rows.length === 0 ? 0 : (totals.overBudget / rows.length) * 100}
            icon={AlertTriangle}
            tone="warning"
          />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          <div className="surface-flat rounded-3xl border border-border/50 p-5 lg:col-span-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">Budget Overview</h2>
              <ClayButton variant="secondary" size="sm" className="gap-1.5">
                By Category
                <ChevronDown className="size-3.5 text-muted-foreground" />
              </ClayButton>
            </div>
            {breakdown.length === 0 ? (
              <EmptyState icon={PieChartIcon} title="No category budgets yet" description="Create a category budget to see the breakdown here." />
            ) : (
              <div className="mt-4 flex items-center gap-5">
                <div className="relative size-32 shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={breakdown} dataKey="spent" nameKey="type" innerRadius="68%" outerRadius="100%" paddingAngle={2} stroke="none">
                        {breakdown.map((item) => (
                          <Cell key={item.type} fill={TYPE_CHART_COLOR[item.color]} />
                        ))}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-lg font-bold tabular-nums text-foreground">{overallUsedPercent}%</span>
                    <span className="text-[10px] text-muted-foreground">of budget used</span>
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-end gap-6 pb-1.5 text-xs text-muted-foreground">
                    <span className="w-16 text-right">Budget</span>
                    <span className="w-16 text-right">Spent</span>
                    <span className="w-14 text-right">% Used</span>
                  </div>
                  {breakdown.map((item) => {
                    const pct = item.budget === 0 ? 0 : Math.round((item.spent / item.budget) * 1000) / 10;
                    return (
                      <div key={item.type} className="flex items-center gap-2 border-t border-border/50 py-2 text-sm">
                        <span className="size-2 shrink-0 rounded-full" style={{ background: TYPE_CHART_COLOR[item.color] }} />
                        <span className="min-w-0 flex-1 truncate text-foreground">{item.type}</span>
                        <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">{formatCurrency(item.budget)}</span>
                        <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">{formatCurrency(item.spent)}</span>
                        <span className="w-14 shrink-0 text-right tabular-nums text-foreground">{pct}%</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="surface-flat rounded-3xl border border-border/50 p-5 lg:col-span-2">
            <h2 className="text-sm font-semibold text-foreground">Daily Average</h2>
            <p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-foreground">{formatCurrency(dailyAverage)}</p>
            <p className="text-xs text-muted-foreground">this month, so far</p>
            <div className="mt-3 h-32 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dailyChartData} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                  <YAxis hide domain={[0, "dataMax + 500"]} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} interval={0} tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} />
                  <Bar dataKey="value" radius={[3, 3, 0, 0]} fill="var(--primary)" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        <div className="surface-flat rounded-3xl border border-border/50 p-5">
          <h2 className="text-sm font-semibold text-foreground">Budget Categories ({rows.length})</h2>
          <div className="mt-3">
            {rows.length === 0 ? (
              <EmptyState
                icon={Wallet}
                title="No budgets yet"
                description="Create a monthly or category budget to start tracking spend against a limit."
                actionLabel="New Budget"
                onAction={openAdd}
              />
            ) : (
              <FinanceTable columns={columns} data={rows} getRowId={(row) => row.budget.id} onRowClick={(row) => setActiveRow(row)} />
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-5 xl:col-span-4">
        <div className="surface-flat rounded-3xl border border-border/50 p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Budget Summary</h2>
            <PieChartIcon className="size-4 text-muted-foreground" />
          </div>
          <div className="mt-3 flex flex-col divide-y divide-border/60">
            <div className="flex items-center gap-3 py-2.5">
              <span className="size-2.5 shrink-0 rounded-full bg-success" />
              <span className="flex-1 text-sm text-foreground">On Track</span>
              <span className="text-sm font-semibold tabular-nums text-foreground">
                {totals.onTrack} <span className="font-normal text-muted-foreground">categories</span>
              </span>
            </div>
            <div className="flex items-center gap-3 py-2.5">
              <span className="size-2.5 shrink-0 rounded-full bg-warning" />
              <span className="flex-1 text-sm text-foreground">At Risk</span>
              <span className="text-sm font-semibold tabular-nums text-foreground">
                {totals.atRisk} <span className="font-normal text-muted-foreground">categories</span>
              </span>
            </div>
            <div className="flex items-center gap-3 py-2.5">
              <span className="size-2.5 shrink-0 rounded-full bg-expense" />
              <span className="flex-1 text-sm text-foreground">Over Budget</span>
              <span className="text-sm font-semibold tabular-nums text-foreground">
                {totals.overBudget} <span className="font-normal text-muted-foreground">categories</span>
              </span>
            </div>
          </div>
        </div>

        <div className="surface-flat rounded-3xl border border-border/50 p-5">
          <h2 className="text-sm font-semibold text-foreground">Quick Actions</h2>
          <div className="mt-4 grid grid-cols-4 gap-2">
            {[
              { label: "Create Budget", icon: Plus, className: "bg-primary/12 text-primary", onClick: openAdd },
              { label: "Add Category", icon: FolderPlus, className: "bg-warning/20 text-warning-foreground", onClick: openAdd },
              { label: "Set Limit", icon: Target, className: "bg-success/15 text-success", onClick: openAdd },
            ].map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={action.onClick}
                className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-border/40 px-1 py-3 text-center transition-colors hover:bg-muted/50"
              >
                <span className={cn("flex size-9 items-center justify-center rounded-xl", action.className)}>
                  <action.icon className="size-4.5" />
                </span>
                <span className="text-[11px] font-medium text-foreground">{action.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="surface-flat rounded-3xl border border-border/50 p-5">
          <h2 className="text-sm font-semibold text-foreground">Helpful Tips</h2>
          <div className="mt-3 flex items-start gap-3 rounded-2xl border border-border/40 p-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
              <Wifi className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">Use the 50/30/20 rule</p>
              <p className="text-xs text-muted-foreground">50% Needs • 30% Wants • 20% Savings</p>
              <p className="mt-1 text-xs text-muted-foreground">Helps maintain a healthy financial balance.</p>
            </div>
          </div>
        </div>
      </div>

      <DetailDrawer
        open={activeRow != null && !editOpen && !deleteOpen}
        onOpenChange={(open) => !open && setActiveRow(null)}
        title={activeRow ? categoryNameOf(activeRow) : ""}
        description={activeRow ? `${budgetTypeLabel(activeRow.budget.type)} budget` : undefined}
        footer={
          activeRow && (
            <div className="flex gap-2">
              <ClayButton variant="secondary" className="flex-1" onClick={() => openEdit(activeRow)}>
                Edit
              </ClayButton>
              <ClayButton variant="secondary" className={cn("flex-1 text-expense")} onClick={() => setDeleteOpen(true)}>
                Delete
              </ClayButton>
            </div>
          )
        }
      >
        {activeRow && (
          <div className="flex flex-col gap-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Spent</span>
              <CurrencyCell amount={activeRow.insight.spent} signed={false} className="text-base font-semibold" />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Limit</span>
              <CurrencyCell amount={activeRow.insight.limit} signed={false} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Remaining</span>
              <CurrencyCell amount={remaining} signed={false} className={remaining < 0 ? "text-expense" : "text-success"} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Used</span>
              <ClayBadge tone={statusFor(activeRow.insight).tone}>{statusFor(activeRow.insight).label}</ClayBadge>
            </div>
          </div>
        )}
      </DetailDrawer>

      <FormDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        title="New Budget"
        description="Set a monthly spending limit, overall or for a specific category."
        onConfirm={handleCreate}
        confirmLabel={saving ? "Saving…" : "Save"}
        contentClassName="sm:max-w-lg"
      >
        <div className="flex flex-col gap-3 rounded-2xl bg-muted/30 p-4 text-sm">
          <SectionLabel icon={Target}>Budget Details</SectionLabel>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Category</span>
            <Select value={form.categoryId || "overall"} onValueChange={(v) => setForm((f) => ({ ...f, categoryId: v === "overall" ? "" : v }))}>
              <SelectTrigger className="h-10 w-full rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="overall">Overall (no category)</SelectItem>
                {expenseCategories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Monthly Limit</span>
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-primary">₹</span>
              <input
                type="number"
                className="clay-pressed h-10 w-full rounded-xl border border-primary/20 bg-primary/5 pl-7 text-sm font-semibold outline-none"
                placeholder="0.00"
                value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              />
            </div>
          </label>
        </div>
      </FormDialog>

      <FormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        title={`Edit ${activeRow ? categoryNameOf(activeRow) : "Budget"}`}
        description="Only the amount can be changed for an existing budget."
        onConfirm={handleEdit}
        confirmLabel={saving ? "Saving…" : "Save Changes"}
        contentClassName="sm:max-w-lg"
      >
        <div className="flex flex-col gap-3 rounded-2xl bg-muted/30 p-4 text-sm">
          <SectionLabel icon={Target}>Budget Details</SectionLabel>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Category</span>
            <input
              className="clay-pressed h-10 rounded-xl px-3 text-sm text-muted-foreground outline-none"
              value={activeRow ? categoryNameOf(activeRow) : ""}
              disabled
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Monthly Limit</span>
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-primary">₹</span>
              <input
                type="number"
                className="clay-pressed h-10 w-full rounded-xl border border-primary/20 bg-primary/5 pl-7 text-sm font-semibold outline-none"
                value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              />
            </div>
          </label>
        </div>
      </FormDialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${activeRow ? categoryNameOf(activeRow) : "budget"}?`}
        description="This action cannot be undone."
        variant="destructive"
        confirmLabel="Delete"
        onConfirm={handleDelete}
      />
    </div>
  );
}
