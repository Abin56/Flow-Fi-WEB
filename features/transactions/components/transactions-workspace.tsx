"use client";

import {
  Activity,
  ArrowDownToLine,
  ArrowUpRight,
  BarChart3,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  LayoutGrid,
  List,
  Maximize2,
  Minimize2,
  Plus,
  Receipt,
  Search,
  SlidersHorizontal,
  Trash2,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import {
  ConfirmDialog,
  CurrencyCell,
  EmptyState,
  FilterBar,
  FinanceTable,
  type FilterDef,
  type FinanceTableColumn,
  FormDialog,
} from "@/components/finance";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { usePeople } from "@/hooks/use-people";
import { useExpenses } from "@/hooks/use-expenses";
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { SplitType } from "@/lib/models/expense";
import type { Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";
import { toast } from "@/store/toast-store";
import {
  categoryIconFor,
  categoryToneFor,
  useTransactionActions,
  useTransactionRows,
  type TransactionRow,
} from "@/features/transactions/hooks/use-transactions-data";
import { TransactionDetailsModal } from "@/features/transactions/components/transaction-details-modal";
import { transactionFlagFor } from "@/features/transactions/lib/transaction-flag";
import { findSameAmountDateDuplicateIds } from "@/features/transactions/lib/same-amount-date-duplicates";
import { useDuplicateGuardedCreate } from "@/lib/services/duplicate-detection/use-duplicate-guarded-create";
import { cn } from "@/lib/utils";

const SPLIT_TYPE_OPTIONS: { value: SplitType; label: string }[] = [
  { value: "equal", label: "Split equally" },
  { value: "custom", label: "Custom amounts" },
  { value: "percentage", label: "By percentage" },
];

interface SplitParticipantForm {
  personId: string | null;
  name: string;
  value: string;
}

interface SplitFormState {
  description: string;
  amount: string;
  accountId: string;
  categoryId: string;
  date: string;
  notes: string;
  splitType: SplitType;
  includeMe: boolean;
  participants: SplitParticipantForm[];
}

function emptySplitForm(defaultAccountId: string, defaultCategoryId: string): SplitFormState {
  return {
    description: "",
    amount: "",
    accountId: defaultAccountId,
    categoryId: defaultCategoryId,
    date: new Date().toISOString().slice(0, 10),
    notes: "",
    splitType: "equal",
    includeMe: true,
    participants: [{ personId: null, name: "", value: "" }],
  };
}

const ROWS_PER_PAGE_OPTIONS = [10, 20, 50, 100];

const TONE_ICON_CLASS: Record<string, string> = {
  neutral: "bg-muted text-muted-foreground",
  primary: "bg-primary/12 text-primary",
  success: "bg-success/15 text-success",
  expense: "bg-expense/12 text-expense",
  warning: "bg-warning/20 text-warning-foreground",
  purple: "bg-purple/15 text-purple",
};

function paymentMethodFor(transaction: Transaction, account?: Account): string {
  if (transaction.transferId) return "Internal Transfer";
  if (transaction.type === "income") return "Bank Transfer";
  if (!account) return "Card Payment";
  switch (account.type) {
    case "cash":
      return "Cash";
    case "wallet":
      return "UPI";
    case "card":
      return "Credit Card";
    case "business":
      return "Bank Transfer";
    default:
      return "Debit Card";
  }
}

function formatFullDate(date: Date, withTime = false): string {
  const datePart = date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  if (!withTime) return datePart;
  const timePart = date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  return `${datePart}, ${timePart}`;
}

function paginationRange(current: number, total: number): (number | "ellipsis")[] {
  if (total <= 1) return [1];
  const delta = 1;
  const range: (number | "ellipsis")[] = [1];
  const left = Math.max(2, current - delta);
  const right = Math.min(total - 1, current + delta);
  if (left > 2) range.push("ellipsis");
  for (let i = left; i <= right; i++) range.push(i);
  if (right < total - 1) range.push("ellipsis");
  if (total > 1) range.push(total);
  return range;
}

const STAT_TONE_CLASS = {
  success: { card: "bg-success/8 border-success/20", icon: "bg-success/20 text-success", trend: "text-success" },
  expense: { card: "bg-expense/8 border-expense/20", icon: "bg-expense/20 text-expense", trend: "text-expense" },
  purple: { card: "bg-purple/8 border-purple/20", icon: "bg-purple/20 text-purple", trend: "text-purple" },
  warning: { card: "bg-warning/12 border-warning/25", icon: "bg-warning/25 text-warning-foreground", trend: "text-warning-foreground" },
} as const;

function StatCard({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  tone: keyof typeof STAT_TONE_CLASS;
}) {
  const toneClass = STAT_TONE_CLASS[tone];
  return (
    <div className={cn("flex flex-col gap-3 rounded-3xl border p-4", toneClass.card)}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-xl", toneClass.icon)}>
          <Icon className="size-4" />
        </span>
      </div>
      <p className="font-mono text-xl font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  );
}

type FormKind = "expense" | "income" | "transfer";

export function TransactionsWorkspace() {
  const { rows, accounts, categories, isLoading } = useTransactionRows();
  const actions = useTransactionActions();
  const { data: people = [] } = usePeople();
  const { data: expenses = [] } = useExpenses();
  const expenseByTransactionId = useMemo(() => new Map(expenses.map((e) => [e.transactionId, e])), [expenses]);

  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [accountFilter, setAccountFilter] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [paymentMethodFilter, setPaymentMethodFilter] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(20);
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");

  const [detailRow, setDetailRow] = useState<TransactionRow | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailDefaultKind, setDetailDefaultKind] = useState<FormKind>("expense");
  const [autoFocusAssign, setAutoFocusAssign] = useState(false);
  const [quickDeleteRow, setQuickDeleteRow] = useState<TransactionRow | null>(null);

  const [splitOpen, setSplitOpen] = useState(false);
  const [splitForm, setSplitForm] = useState<SplitFormState>(() => emptySplitForm("", ""));
  const [splitSaving, setSplitSaving] = useState(false);
  const [splitError, setSplitError] = useState<string | null>(null);
  const splitDuplicateGuard = useDuplicateGuardedCreate(rows.map((r) => r.transaction));

  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && setFullscreen(false);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreen]);

  const filtered = useMemo(() => {
    let list = rows;

    if (deferredSearch.trim()) {
      const q = deferredSearch.trim().toLowerCase();
      list = list.filter(
        (r) => r.transaction.description.toLowerCase().includes(q) || r.transaction.notes.toLowerCase().includes(q),
      );
    }
    if (accountFilter) list = list.filter((r) => r.transaction.accountId === accountFilter);
    if (categoryFilter) list = list.filter((r) => r.transaction.categoryId === categoryFilter);
    if (typeFilter) list = list.filter((r) => r.transaction.type === typeFilter);
    if (paymentMethodFilter) {
      list = list.filter((r) => paymentMethodFor(r.transaction, r.account) === paymentMethodFilter);
    }
    if (dateFrom) {
      const from = new Date(dateFrom);
      list = list.filter((r) => r.transaction.dateTime >= from);
    }
    if (dateTo) {
      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);
      list = list.filter((r) => r.transaction.dateTime <= to);
    }

    return [...list].sort((a, b) => b.transaction.dateTime.getTime() - a.transaction.dateTime.getTime());
  }, [rows, deferredSearch, accountFilter, categoryFilter, typeFilter, paymentMethodFilter, dateFrom, dateTo]);

  // Computed over the full, unfiltered `rows` — not `filtered` — so a duplicate is still flagged even
  // if its pair got filtered out of the current view.
  const duplicateTransactionIds = useMemo(() => findSameAmountDateDuplicateIds(rows.map((r) => r.transaction)), [rows]);

  const stats = useMemo(() => {
    let inflow = 0;
    let outflow = 0;
    for (const { transaction: t } of filtered) {
      if (t.type === "income") inflow += t.amount;
      else outflow += t.amount;
    }
    return { inflow, outflow, net: inflow - outflow, count: filtered.length };
  }, [filtered]);

  const count = filtered.length;
  const totalPages = Math.max(1, Math.ceil(count / rowsPerPage));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * rowsPerPage, safePage * rowsPerPage);
  const rangeStart = count === 0 ? 0 : (safePage - 1) * rowsPerPage + 1;
  const rangeEnd = Math.min(safePage * rowsPerPage, count);

  const clearFilters = () => {
    setSearch("");
    setAccountFilter(null);
    setCategoryFilter(null);
    setTypeFilter(null);
    setPaymentMethodFilter(null);
    setDateFrom("");
    setDateTo("");
    setPage(1);
  };

  const paymentMethodOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => paymentMethodFor(r.transaction, r.account)))).sort(),
    [rows],
  );

  const setThisMonth = () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    setDateFrom(start.toISOString().slice(0, 10));
    setDateTo(now.toISOString().slice(0, 10));
    setPage(1);
  };

  const filters: FilterDef[] = [
    {
      id: "account",
      label: "All Accounts",
      value: accountFilter,
      onChange: (v) => {
        setAccountFilter(v);
        setPage(1);
      },
      options: accounts.map((a) => ({ value: a.id, label: a.name })),
    },
    {
      id: "category",
      label: "All Categories",
      value: categoryFilter,
      onChange: (v) => {
        setCategoryFilter(v);
        setPage(1);
      },
      options: categories.map((c) => ({ value: c.id, label: c.name })),
    },
    {
      id: "type",
      label: "All Types",
      value: typeFilter,
      onChange: (v) => {
        setTypeFilter(v);
        setPage(1);
      },
      options: [
        { value: "income", label: "Income" },
        { value: "expense", label: "Expense" },
      ],
    },
    {
      id: "paymentMethod",
      label: "All Payment Methods",
      value: paymentMethodFilter,
      onChange: (v) => {
        setPaymentMethodFilter(v);
        setPage(1);
      },
      options: paymentMethodOptions.map((m) => ({ value: m, label: m })),
    },
  ];

  function openAdd(kind: FormKind) {
    setDetailRow(null);
    setDetailDefaultKind(kind);
    setAutoFocusAssign(false);
    setDetailOpen(true);
  }

  function openSplit() {
    const firstCategory = categories.find((c) => c.type !== "income");
    setSplitError(null);
    setSplitForm(emptySplitForm(accounts[0]?.id ?? "", firstCategory?.id ?? ""));
    setSplitOpen(true);
  }

  function validateSplitForm(): string | null {
    if (!splitForm.description.trim()) return "Description is required.";
    const amount = Number(splitForm.amount);
    if (!splitForm.amount.trim() || Number.isNaN(amount) || amount <= 0) return "Enter an amount greater than 0.";
    if (!splitForm.accountId) return "Select an account.";
    if (!splitForm.categoryId) return "Select a category.";
    if (!splitForm.date) return "Select a date.";
    const named = splitForm.participants.filter((p) => p.name.trim() !== "");
    if (named.length === 0) return "Add at least one person to share with.";
    if (splitForm.splitType !== "equal") {
      for (const p of named) {
        const v = Number(p.value);
        if (p.value.trim() === "" || Number.isNaN(v) || v < 0) {
          return `Enter a valid ${splitForm.splitType === "percentage" ? "percentage" : "amount"} for ${p.name}.`;
        }
      }
    }
    return null;
  }

  async function handleSplitSave() {
    if (!actions) return;
    const validationError = validateSplitForm();
    if (validationError) {
      setSplitError(validationError);
      return;
    }
    setSplitSaving(true);
    setSplitError(null);
    try {
      const totalAmount = Number(splitForm.amount);
      const date = new Date(splitForm.date);

      // Same pre-save gate manual entry uses — a split expense creates a Transaction exactly
      // like the plain Add Transaction flow does, so it needs the same duplicate check. Split
      // expenses are always debits (an "income split" doesn't exist in this model).
      const proceed = await splitDuplicateGuard.guard({
        description: splitForm.description,
        amount: totalAmount,
        date,
        direction: "debit",
        accountId: splitForm.accountId,
        referenceNumber: null,
        requireDescriptionMatch: false,
      });
      if (!proceed) {
        setSplitSaving(false);
        return;
      }

      const otherInputs = splitForm.participants
        .filter((p) => p.name.trim() !== "")
        .map((p) => ({
          personId: p.personId,
          name: p.name.trim(),
          value: splitForm.splitType === "equal" ? null : Number(p.value),
        }));

      const participantInputs = splitForm.includeMe
        ? [
            {
              name: "Me",
              isMe: true,
              value:
                splitForm.splitType === "equal"
                  ? null
                  : Number(splitForm.amount) -
                    otherInputs.reduce((sum, p) => sum + (p.value ?? 0), 0),
            },
            ...otherInputs,
          ]
        : otherInputs;

      await actions.createSplitTransaction({
        description: splitForm.description,
        totalAmount,
        date,
        categoryId: splitForm.categoryId,
        accountId: splitForm.accountId,
        splitType: splitForm.splitType,
        participantInputs,
        notes: splitForm.notes,
      });
      setSplitOpen(false);
    } catch (e) {
      setSplitError(e instanceof Error ? e.message : "Could not save this split");
    } finally {
      setSplitSaving(false);
    }
  }

  async function handleQuickDelete() {
    if (!actions || !quickDeleteRow) return;
    try {
      // actions.deleteTransaction already surfaces a failure toast (withErrorToast) — no need to
      // toast again here, only to keep the confirm dialog open on failure.
      const expense = expenseByTransactionId.get(quickDeleteRow.transaction.id) ?? null;
      await actions.deleteTransaction(quickDeleteRow.transaction, expense);
      setQuickDeleteRow(null);
      toast.success("Transaction deleted");
    } catch {
      // Already toasted by actions.deleteTransaction.
    }
  }

  /**
   * The tick column's quick action. With no person linked yet, there's
   * nothing to toggle — open the full popup pre-focused on assignment
   * instead. Otherwise flips `owesPersonToggle` in place through the same
   * state machine the popup uses, so a person's ledger never drifts out of
   * sync with what the table shows.
   */
  const handleQuickToggleOwed = useCallback(
    async (row: TransactionRow) => {
      if (!actions) return;
      const { transaction } = row;
      if (!transaction.linkedPersonId) {
        setDetailRow(row);
        setAutoFocusAssign(true);
        setDetailOpen(true);
        return;
      }
      const person = people.find((p) => p.id === transaction.linkedPersonId);
      const existingExpense = expenseByTransactionId.get(transaction.id) ?? null;
      try {
        // actions.applyOwesPersonChange already surfaces a failure toast (withErrorToast).
        await actions.applyOwesPersonChange({
          transaction,
          existingExpense,
          target: { personId: transaction.linkedPersonId, personName: person?.name ?? "", owesPersonToggle: !transaction.owesPersonToggle },
        });
        toast.success(transaction.owesPersonToggle ? "Unmarked" : "Marked as owed to you");
      } catch {
        // Already toasted by actions.applyOwesPersonChange.
      }
    },
    [actions, people, expenseByTransactionId],
  );

  const columns: FinanceTableColumn<TransactionRow>[] = useMemo(
    () => [
    {
      id: "no",
      header: "#",
      hideOnMobile: true,
      accessor: (row) => {
        const index = pageRows.findIndex((r) => r.transaction.id === row.transaction.id);
        return <span className="text-sm text-muted-foreground">{(safePage - 1) * rowsPerPage + index + 1}</span>;
      },
      width: "40px",
    },
    {
      id: "date",
      header: "Date",
      accessor: (row) => <span className="text-sm text-muted-foreground">{formatFullDate(row.transaction.dateTime)}</span>,
      width: "110px",
    },
    {
      id: "merchant",
      header: "Merchant",
      minWidth: "200px",
      accessor: (row) => {
        const iconKey = row.category?.iconKey ?? "other";
        const Icon = categoryIconFor(iconKey);
        const flag = transactionFlagFor(row.transaction);
        const isDuplicate = duplicateTransactionIds.has(row.transaction.id);
        return (
          <div className="flex min-w-0 items-center gap-3">
            <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", TONE_ICON_CLASS[categoryToneFor(iconKey)])}>
              <Icon className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground">{row.transaction.description || "(No description)"}</p>
              {flag && <p className="truncate text-xs text-warning-foreground">{flag.label}</p>}
              {isDuplicate && (
                <span
                  className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger"
                  title="Another transaction has the same amount and date — check it isn't a duplicate."
                >
                  <Copy className="size-2.5" aria-hidden />
                  Possible duplicate
                </span>
              )}
            </div>
          </div>
        );
      },
    },
    {
      id: "amount",
      header: "Amount",
      accessor: (row) => <CurrencyCell amount={row.transaction.type === "income" ? row.transaction.amount : -row.transaction.amount} />,
      numeric: true,
      width: "130px",
    },
    {
      id: "owed",
      header: "",
      accessor: (row) => {
        const linked = row.transaction.linkedPersonId != null;
        const active = linked && row.transaction.owesPersonToggle;
        const label = active ? "This person owes me — tap to unmark" : linked ? "Mark as owed to you" : "Assign to a person";
        return (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleQuickToggleOwed(row);
            }}
            className={cn(
              "flex size-7 items-center justify-center rounded-full border transition-colors",
              active
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border/60 text-muted-foreground hover:border-primary/50 hover:text-primary",
            )}
            aria-label={label}
            title={label}
          >
            <Check className="size-3.5" />
          </button>
        );
      },
      width: "48px",
      align: "center",
    },
    {
      id: "delete",
      header: "",
      accessor: (row) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setQuickDeleteRow(row);
          }}
          className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-expense/10 hover:text-expense"
          aria-label="Delete transaction"
        >
          <Trash2 className="size-3.5" />
        </button>
      ),
      width: "44px",
      align: "center",
    },
    ],
    [pageRows, safePage, rowsPerPage, handleQuickToggleOwed, duplicateTransactionIds],
  );

  if (isLoading) {
    return (
      <div className="flex flex-col gap-5 px-1">
        <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Transactions</h1>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-3xl" />
          ))}
        </div>
        <Skeleton className="h-10 w-full max-w-sm rounded-2xl" />
        <div className="flex flex-col gap-2">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-5",
        fullscreen ? "fixed inset-0 z-50 overflow-y-auto bg-background p-6" : "px-1",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Transactions</h1>
          <p className="mt-1 text-sm text-muted-foreground">Track, review and manage all your money movements</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ClayButton variant="secondary" size="sm" className="gap-1.5">
            <Upload className="size-3.5" />
            Import Statement
          </ClayButton>
          <ClayButton variant="secondary" size="sm" className="gap-1.5">
            <Download className="size-3.5" />
            Export
          </ClayButton>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <ClayButton size="sm" className="gap-1.5 border-transparent text-primary-foreground" style={{ background: "var(--gradient-accent)" }}>
                <Plus className="size-3.5" />
                Add Transaction
                <ChevronDown className="size-3.5" />
              </ClayButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => openAdd("expense")}>Expense</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openAdd("income")}>Income</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openAdd("transfer")}>Transfer</DropdownMenuItem>
              <DropdownMenuItem onSelect={openSplit}>Split Expense</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total Inflow" value={formatCurrency(stats.inflow)} icon={ArrowDownToLine} tone="success" />
        <StatCard label="Total Outflow" value={formatCurrency(stats.outflow)} icon={ArrowUpRight} tone="expense" />
        <StatCard label="Net Flow" value={formatCurrency(stats.net)} icon={Activity} tone="purple" />
        <StatCard label="Transactions" value={String(stats.count)} icon={BarChart3} tone="warning" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="clay-pressed flex h-10 max-w-sm flex-1 items-center gap-2 rounded-2xl px-3.5 text-sm text-muted-foreground focus-within:text-foreground">
          <Search className="size-4 shrink-0" />
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search transactions, categories, merchants..."
            className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
        <ClayButton variant="secondary" size="sm" className="gap-1.5" onClick={setThisMonth}>
          <Calendar className="size-3.5" />
          This Month
        </ClayButton>
        <FilterBar filters={filters} onClearAll={clearFilters} />
        <Popover>
          <PopoverTrigger asChild>
            <ClayButton variant="ghost" size="sm" className="gap-1.5">
              <SlidersHorizontal className="size-3.5" />
              More Filters
            </ClayButton>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64">
            <div className="flex flex-col gap-3 text-sm">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Date Range</p>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">From</span>
                <input
                  type="date"
                  className="clay-pressed h-9 rounded-xl px-3 text-sm outline-none"
                  value={dateFrom}
                  onChange={(e) => {
                    setDateFrom(e.target.value);
                    setPage(1);
                  }}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">To</span>
                <input
                  type="date"
                  className="clay-pressed h-9 rounded-xl px-3 text-sm outline-none"
                  value={dateTo}
                  onChange={(e) => {
                    setDateTo(e.target.value);
                    setPage(1);
                  }}
                />
              </label>
              {(dateFrom || dateTo) && (
                <ClayButton
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDateFrom("");
                    setDateTo("");
                  }}
                >
                  Clear dates
                </ClayButton>
              )}
            </div>
          </PopoverContent>
        </Popover>
        <div className="clay-pressed ml-auto flex items-center gap-1 rounded-xl p-1">
          <button
            type="button"
            onClick={() => setViewMode("list")}
            className={cn(
              "flex items-center justify-center rounded-lg p-1.5 transition-colors",
              viewMode === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
            aria-label="List view"
          >
            <List className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => setViewMode("grid")}
            className={cn(
              "flex items-center justify-center rounded-lg p-1.5 transition-colors",
              viewMode === "grid" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
            aria-label="Grid view"
          >
            <LayoutGrid className="size-4" />
          </button>
        </div>
        <ClayButton
          variant="secondary"
          size="icon"
          onClick={() => setFullscreen((v) => !v)}
          aria-label={fullscreen ? "Exit full screen" : "Full screen"}
          title={fullscreen ? "Exit full screen (Esc)" : "Full screen"}
        >
          {fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </ClayButton>
      </div>

      {viewMode === "list" ? (
        <FinanceTable
          columns={columns}
          data={pageRows}
          getRowId={(row) => row.transaction.id}
          onRowClick={(row) => {
            setDetailRow(row);
            setAutoFocusAssign(false);
            setDetailOpen(true);
          }}
          // A calm left accent + tint, not a boxed-off card — keeps the list's normal flush row rhythm
          // instead of visually breaking the row out with a margin gap. `!` (important) forces the
          // color/width to win over the table's own base row border, since Tailwind doesn't guarantee
          // this className string's later position in the cascade order. The "Possible duplicate" badge
          // in the Merchant column (below) carries the actual explanation — this is just the scan cue.
          rowClassName={(row) => (duplicateTransactionIds.has(row.transaction.id) ? "!border-l-4 !border-l-danger bg-danger/5" : undefined)}
          emptyState={
            <EmptyState
              icon={Receipt}
              title="No transactions found"
              description="Try adjusting your filters or search to find what you're looking for."
              actionLabel="Clear filters"
              onAction={clearFilters}
            />
          }
        />
      ) : pageRows.length === 0 ? (
        <div className="w-full overflow-hidden rounded-2xl border border-border/60 bg-card">
          <EmptyState
            icon={Receipt}
            title="No transactions found"
            description="Try adjusting your filters or search to find what you're looking for."
            actionLabel="Clear filters"
            onAction={clearFilters}
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {pageRows.map((row) => {
            const iconKey = row.category?.iconKey ?? "other";
            const Icon = categoryIconFor(iconKey);
            return (
              <button
                key={row.transaction.id}
                type="button"
                onClick={() => {
                  setDetailRow(row);
                  setAutoFocusAssign(false);
                  setDetailOpen(true);
                }}
                className={cn(
                  "flex items-center gap-3 rounded-2xl border border-border/60 bg-card p-4 text-left transition-transform duration-150 hover:-translate-y-0.5 hover:bg-muted/30 active:scale-[0.99]",
                  duplicateTransactionIds.has(row.transaction.id) && "!border-danger bg-danger/5",
                )}
              >
                <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-2xl", TONE_ICON_CLASS[categoryToneFor(iconKey)])}>
                  <Icon className="size-4.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{row.transaction.description || "(No description)"}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {formatFullDate(row.transaction.dateTime)} • {row.account?.name ?? "Unknown"}
                  </p>
                  {duplicateTransactionIds.has(row.transaction.id) && (
                    <span
                      className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger"
                      title="Another transaction has the same amount and date — check it isn't a duplicate."
                    >
                      <Copy className="size-2.5" aria-hidden />
                      Possible duplicate
                    </span>
                  )}
                </div>
                <CurrencyCell amount={row.transaction.type === "income" ? row.transaction.amount : -row.transaction.amount} />
              </button>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Showing {rangeStart} to {rangeEnd} of {count} transactions
        </p>
        <div className="flex items-center gap-1">
          <ClayButton variant="ghost" size="icon" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} aria-label="Previous page">
            <ChevronLeft className="size-4" />
          </ClayButton>
          {paginationRange(safePage, totalPages).map((entry, i) =>
            entry === "ellipsis" ? (
              <span key={`ellipsis-${i}`} className="px-2 text-sm text-muted-foreground">
                …
              </span>
            ) : (
              <button
                key={entry}
                type="button"
                onClick={() => setPage(entry)}
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-medium transition-colors",
                  entry === safePage ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
                )}
              >
                {entry}
              </button>
            ),
          )}
          <ClayButton variant="ghost" size="icon" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)} aria-label="Next page">
            <ChevronRight className="size-4" />
          </ClayButton>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ClayButton variant="secondary" size="sm" className="gap-1.5">
              Rows per page
              <span className="font-semibold text-foreground">{rowsPerPage}</span>
            </ClayButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {ROWS_PER_PAGE_OPTIONS.map((n) => (
              <DropdownMenuItem
                key={n}
                onSelect={() => {
                  setRowsPerPage(n);
                  setPage(1);
                }}
              >
                {n}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <TransactionDetailsModal
        open={detailOpen}
        onOpenChange={(open) => {
          setDetailOpen(open);
          if (!open) {
            setDetailRow(null);
            setAutoFocusAssign(false);
          }
        }}
        row={detailRow}
        expense={detailRow ? (expenseByTransactionId.get(detailRow.transaction.id) ?? null) : null}
        people={people}
        accounts={accounts}
        categories={categories}
        actions={actions!}
        defaultKind={detailDefaultKind}
        autoFocusAssign={autoFocusAssign}
        existingTransactions={rows.map((r) => r.transaction)}
      />

      <ConfirmDialog
        open={quickDeleteRow != null}
        onOpenChange={(open) => {
          if (!open) setQuickDeleteRow(null);
        }}
        title={quickDeleteRow?.transaction.transferId != null ? "Delete this transfer?" : "Delete transaction?"}
        description={
          quickDeleteRow?.transaction.transferId != null
            ? "This removes both linked transactions and reverses the balance change on both accounts. This action cannot be undone."
            : "This action cannot be undone."
        }
        variant="destructive"
        confirmLabel="Delete"
        onConfirm={() => void handleQuickDelete()}
      />

      <FormDialog
        open={splitOpen}
        onOpenChange={setSplitOpen}
        title="Split Expense"
        onConfirm={handleSplitSave}
        confirmLabel={splitSaving ? "Saving…" : "Save Split"}
      >
        <SplitFormFields
          form={splitForm}
          setForm={setSplitForm}
          accounts={accounts}
          categories={categories}
          people={people}
          error={splitError}
        />
      </FormDialog>

      {splitDuplicateGuard.dialog}
    </div>
  );
}

function SplitFormFields({
  form,
  setForm,
  accounts,
  categories,
  people,
  error,
}: {
  form: SplitFormState;
  setForm: React.Dispatch<React.SetStateAction<SplitFormState>>;
  accounts: Account[];
  categories: Category[];
  people: Person[];
  error: string | null;
}) {
  function updateParticipant(index: number, patch: Partial<SplitParticipantForm>) {
    setForm((f) => ({
      ...f,
      participants: f.participants.map((p, i) => (i === index ? { ...p, ...patch } : p)),
    }));
  }

  function addParticipant() {
    setForm((f) => ({ ...f, participants: [...f.participants, { personId: null, name: "", value: "" }] }));
  }

  function removeParticipant(index: number) {
    setForm((f) => ({ ...f, participants: f.participants.filter((_, i) => i !== index) }));
  }

  return (
    <div className="flex flex-col gap-3 py-1 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Description</span>
        <input
          className="clay-pressed h-10 rounded-xl px-3 text-sm outline-none"
          placeholder="e.g. Dinner at Cafe"
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Total Amount</span>
        <input
          type="number"
          className="clay-pressed h-10 rounded-xl px-3 text-sm outline-none"
          placeholder="0.00"
          value={form.amount}
          onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Account</span>
        <Select value={form.accountId} onValueChange={(v) => setForm((f) => ({ ...f, accountId: v }))}>
          <SelectTrigger className="h-10 w-full rounded-xl">
            <SelectValue placeholder="Select account" />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Category</span>
        <Select value={form.categoryId} onValueChange={(v) => setForm((f) => ({ ...f, categoryId: v }))}>
          <SelectTrigger className="h-10 w-full rounded-xl">
            <SelectValue placeholder="Select category" />
          </SelectTrigger>
          <SelectContent>
            {categories.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Date</span>
        <input
          type="date"
          className="clay-pressed h-10 rounded-xl px-3 text-sm outline-none"
          value={form.date}
          onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Split Type</span>
        <Select value={form.splitType} onValueChange={(v) => setForm((f) => ({ ...f, splitType: v as SplitType }))}>
          <SelectTrigger className="h-10 w-full rounded-xl">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SPLIT_TYPE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 rounded border-border/60"
          checked={form.includeMe}
          onChange={(e) => setForm((f) => ({ ...f, includeMe: e.target.checked }))}
        />
        Include my own share
      </label>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">Split With</span>
        {form.participants.map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <Select
              value={p.personId ?? "custom"}
              onValueChange={(v) => {
                if (v === "custom") {
                  updateParticipant(i, { personId: null });
                  return;
                }
                const person = people.find((person) => person.id === v);
                updateParticipant(i, { personId: v, name: person?.name ?? p.name });
              }}
            >
              <SelectTrigger className="h-10 w-36 rounded-xl">
                <SelectValue placeholder="Person" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="custom">Custom name</SelectItem>
                {people.map((person) => (
                  <SelectItem key={person.id} value={person.id}>
                    {person.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {p.personId == null && (
              <input
                className="clay-pressed h-10 flex-1 rounded-xl px-3 text-sm outline-none"
                placeholder="Name"
                value={p.name}
                onChange={(e) => updateParticipant(i, { name: e.target.value })}
              />
            )}
            {form.splitType !== "equal" && (
              <input
                type="number"
                className="clay-pressed h-10 w-24 rounded-xl px-3 text-sm outline-none"
                placeholder={form.splitType === "percentage" ? "%" : "Amount"}
                value={p.value}
                onChange={(e) => updateParticipant(i, { value: e.target.value })}
              />
            )}
            <button
              type="button"
              onClick={() => removeParticipant(i)}
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-expense"
              aria-label="Remove participant"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
        <ClayButton type="button" variant="ghost" size="sm" onClick={addParticipant} className="self-start gap-1.5">
          <Plus className="size-3.5" />
          Add person
        </ClayButton>
      </div>

      {error && <p className="text-xs text-expense">{error}</p>}
    </div>
  );
}
