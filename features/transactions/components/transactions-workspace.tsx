"use client";

import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Calendar,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  CreditCard,
  Download,
  Landmark,
  LayoutGrid,
  List,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  Receipt,
  Search,
  Shapes,
  Split,
  StickyNote,
  Tag,
  Trash2,
  Upload,
  Wallet,
  X,
} from "lucide-react";
import { Fragment, useDeferredValue, useEffect, useMemo, useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import {
  ConfirmDialog,
  type FilterDef,
  FormDialog,
} from "@/components/finance";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { formatCurrency } from "@/lib/format";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoans } from "@/hooks/use-loans";
import { usePeople } from "@/hooks/use-people";
import { useExpenses } from "@/hooks/use-expenses";
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { SplitType } from "@/lib/models/expense";
import type { Person } from "@/lib/models/person";
import { compareTransactionsNewestFirst, type Transaction } from "@/lib/models/transaction";
import { startOperation } from "@/store/operation-progress-store";
import {
  categoryIconFor,
  categoryToneFor,
  useTransactionActions,
  useTransactionRows,
  type TransactionRow,
} from "@/features/transactions/hooks/use-transactions-data";
import { TransactionDetailsModal } from "@/features/transactions/components/transaction-details-modal";
import { transactionFlagFor } from "@/features/transactions/lib/transaction-flag";
import { loanTransactionLabel } from "@/features/loans/lib/loan-labels";
import { findSameAmountDateDuplicateIds } from "@/features/transactions/lib/same-amount-date-duplicates";
import { useDuplicateGuardedCreate } from "@/lib/services/duplicate-detection/use-duplicate-guarded-create";
import { cn } from "@/lib/utils";

/**
 * Corner-ribbon tag for a Loan/EMI-generated transaction card — "EMI" only for a payment tied to
 * the standalone EMI feature (`emiId`); every Loan-generated transaction (`loanId`) is tagged
 * "Loan" regardless of the loan's repayment type, since Loan and EMI are separate features and
 * only an actual EMI should ever read "EMI". Returns null for anything not tied to a loan/EMI so
 * ordinary transactions stay untagged.
 */
function loanTagFor(transaction: Pick<Transaction, "loanId" | "emiId">): { label: string } | null {
  if (transaction.emiId != null) return { label: "EMI" };
  if (transaction.loanId != null) return { label: "Loan" };
  return null;
}

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
  primary: "bg-primary/12 text-primary-accent-text",
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

type FormKind = "expense" | "income" | "transfer";

export function TransactionsWorkspace() {
  const { rows, accounts, categories, isLoading } = useTransactionRows();
  const actions = useTransactionActions();
  const { data: people = [] } = usePeople();
  const { data: expenses = [] } = useExpenses();
  const expenseByTransactionId = useMemo(() => new Map(expenses.map((e) => [e.transactionId, e])), [expenses]);
  // Loan-generated rows read as "Loan EMI — Home Loan" / "Extra Principal Payment — …" from their
  // persisted loan metadata instead of the raw stored description; every other row is unchanged.
  const { data: loans = [] } = useLoans();
  const loanById = useMemo(() => new Map(loans.map((l) => [l.id, l])), [loans]);
  const displayDescription = useMemo(() => {
    return (t: Transaction) =>
      (t.loanId != null ? loanTransactionLabel(t, loanById.get(t.loanId) ?? null) : null) ?? t.description;
  }, [loanById]);

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
        (r) =>
          r.transaction.description.toLowerCase().includes(q) ||
          displayDescription(r.transaction).toLowerCase().includes(q) ||
          r.transaction.notes.toLowerCase().includes(q),
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

    return [...list].sort((a, b) => compareTransactionsNewestFirst(a.transaction, b.transaction));
  }, [rows, deferredSearch, accountFilter, categoryFilter, typeFilter, paymentMethodFilter, dateFrom, dateTo, displayDescription]);

  // Computed over the full, unfiltered `rows` — not `filtered` — so a duplicate is still flagged even
  // if its pair got filtered out of the current view.
  const duplicateTransactionIds = useMemo(() => findSameAmountDateDuplicateIds(rows.map((r) => r.transaction)), [rows]);

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

      const op = startOperation({ label: "Adding split expense", successLabel: "Split expense added", errorLabel: "Couldn't add split expense" });
      op.stage("submit", "Saving transaction & shares");
      await actions.createSplitTransaction({
        description: splitForm.description,
        totalAmount,
        date,
        categoryId: splitForm.categoryId,
        accountId: splitForm.accountId,
        splitType: splitForm.splitType,
        participantInputs,
        notes: splitForm.notes,
      }).catch((e: unknown) => {
        op.dismiss();
        throw e;
      });
      op.succeed();
      setSplitOpen(false);
    } catch (e) {
      setSplitError(e instanceof Error ? e.message : "Could not save this split");
    } finally {
      setSplitSaving(false);
    }
  }

  async function handleQuickDelete() {
    if (!actions || !quickDeleteRow) return;
    const op = startOperation({ label: "Deleting transaction", successLabel: "Transaction deleted", errorLabel: "Couldn't delete transaction" });
    try {
      // actions.deleteTransaction already surfaces a failure toast (withErrorToast) — no need to
      // toast again here, only to keep the confirm dialog open on failure.
      const expense = expenseByTransactionId.get(quickDeleteRow.transaction.id) ?? null;
      op.stage("submit", "Removing transaction & restoring balance");
      await actions.deleteTransaction(quickDeleteRow.transaction, expense);
      setQuickDeleteRow(null);
      op.succeed({ toast: { title: "Transaction deleted" } });
    } catch {
      // Already toasted by actions.deleteTransaction.
      op.dismiss();
    }
  }

  function openDetails(row: TransactionRow) {
    setDetailRow(row);
    setAutoFocusAssign(false);
    setDetailOpen(true);
  }

  const hasTransactions = rows.length > 0;
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? "Account";
  const categoryName = (id: string) => categories.find((c) => c.id === id)?.name ?? "Category";
  const activeChips: { key: string; label: string; clear: () => void }[] = [
    ...(search.trim() ? [{ key: "search", label: `“${search.trim()}”`, clear: () => setSearch("") }] : []),
    ...(dateFrom || dateTo
      ? [{ key: "date", label: dateRangeLabel(dateFrom, dateTo), clear: () => (setDateFrom(""), setDateTo("")) }]
      : []),
    ...(typeFilter ? [{ key: "type", label: `Type: ${typeFilter === "income" ? "Income" : "Expense"}`, clear: () => setTypeFilter(null) }] : []),
    ...(accountFilter ? [{ key: "account", label: `Account: ${accountName(accountFilter)}`, clear: () => setAccountFilter(null) }] : []),
    ...(categoryFilter ? [{ key: "category", label: `Category: ${categoryName(categoryFilter)}`, clear: () => setCategoryFilter(null) }] : []),
    ...(paymentMethodFilter ? [{ key: "method", label: `Method: ${paymentMethodFilter}`, clear: () => setPaymentMethodFilter(null) }] : []),
  ];

  const addMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" disabled={!actions} className={TX_PRIMARY}>
          <Plus className="size-4" strokeWidth={2.25} />
          Add Transaction
          <ChevronDown className="size-3.5 opacity-80" strokeWidth={2} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44 rounded-[8px]">
        <DropdownMenuItem onSelect={() => openAdd("expense")}>
          <ArrowUpRight strokeWidth={1.75} />
          Expense
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openAdd("income")}>
          <ArrowDownLeft strokeWidth={1.75} />
          Income
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={openSplit}>
          <Split strokeWidth={1.75} />
          Split Expense
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (isLoading) {
    return (
      <div className="flex min-w-0 flex-col gap-5 px-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Transactions</h1>
            <Skeleton className="h-4 w-64" />
          </div>
          <Skeleton className="h-9 w-44 rounded-[6px]" />
        </div>
        <Skeleton className="h-9 w-full max-w-md rounded-[6px]" />
        <div className="overflow-hidden rounded-[10px] border border-border-strong/60 bg-card">
          <div className="h-9 border-b border-border-strong/60 bg-secondary" />
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0">
              <Skeleton className="h-4 w-6" />
              <Skeleton className="h-8 w-12" />
              <Skeleton className="size-8 shrink-0 rounded-[8px]" />
              <Skeleton className="h-4 max-w-56 flex-1" />
              <Skeleton className="ml-auto h-5 w-24" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-4",
        fullscreen ? "fixed inset-0 z-hero bg-background p-4 sm:p-6" : "px-1",
      )}
    >
      {/* ── Header: title · utilities · primary action ── */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Transactions</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">All your money activity in one place.</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Not built yet — shown for discoverability, clearly marked, never a fake action */}
          <button type="button" disabled title="Coming soon" className={TX_UTILITY}>
            <Upload className="size-4" strokeWidth={1.75} />
            Import statement
            <span className={SOON}>Soon</span>
          </button>
          <button type="button" disabled title="Coming soon" className={TX_UTILITY}>
            <Download className="size-4" strokeWidth={1.75} />
            Export
            <span className={SOON}>Soon</span>
          </button>
          <span className="mx-1 hidden h-5 w-px bg-border-strong/60 sm:block" aria-hidden />
          {addMenu}
        </div>
      </header>

      {/* ── Toolbar: search · date · filters · view ── */}
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-9 w-full min-w-0 items-center gap-2 rounded-[6px] border border-border-strong bg-card px-3 text-sm transition-colors focus-within:border-primary-accent-text focus-within:ring-2 focus-within:ring-ring sm:w-72 dark:bg-input">
            <Search className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search description or notes…"
              aria-label="Search transactions"
              className="w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            {search && (
              <button type="button" aria-label="Clear search" onClick={() => setSearch("")} className="-mr-1 rounded-[4px] p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground">
                <X className="size-3.5" />
              </button>
            )}
          </label>

          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className={cn(TX_FILTER, (dateFrom || dateTo) && TX_FILTER_ACTIVE)}>
                <Calendar className="size-4 text-muted-foreground" strokeWidth={1.75} />
                {dateFrom || dateTo ? dateRangeLabel(dateFrom, dateTo) : "Date"}
                <ChevronDown className="size-3.5 text-muted-foreground" strokeWidth={2} />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 rounded-[10px] p-3">
              <div className="flex flex-col gap-3 text-sm">
                <button type="button" onClick={setThisMonth} className={cn(TX_UTILITY, "justify-center border border-border-strong")}>
                  This month
                </button>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium text-muted-foreground">From</span>
                  <input
                    type="date"
                    className={TX_INPUT}
                    value={dateFrom}
                    onChange={(e) => {
                      setDateFrom(e.target.value);
                      setPage(1);
                    }}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium text-muted-foreground">To</span>
                  <input
                    type="date"
                    className={TX_INPUT}
                    value={dateTo}
                    onChange={(e) => {
                      setDateTo(e.target.value);
                      setPage(1);
                    }}
                  />
                </label>
                {(dateFrom || dateTo) && (
                  <button
                    type="button"
                    onClick={() => {
                      setDateFrom("");
                      setDateTo("");
                    }}
                    className="self-start text-xs font-semibold text-primary-accent-text hover:underline"
                  >
                    Clear dates
                  </button>
                )}
              </div>
            </PopoverContent>
          </Popover>

          {filters.map((f) => (
            <FilterMenu key={f.id} filter={f} label={FILTER_LABEL[f.id] ?? f.label} />
          ))}

          <div className="ml-auto flex items-center gap-1.5">
            <div role="radiogroup" aria-label="View" className="flex items-center rounded-[6px] border border-border-strong bg-card p-0.5">
              {(
                [
                  { value: "list", icon: List, label: "List view" },
                  { value: "grid", icon: LayoutGrid, label: "Grid view" },
                ] as const
              ).map((v) => (
                <button
                  key={v.value}
                  type="button"
                  role="radio"
                  aria-checked={viewMode === v.value}
                  aria-label={v.label}
                  onClick={() => setViewMode(v.value)}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-[4px] transition-colors",
                    viewMode === v.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                  )}
                >
                  <v.icon className="size-4" strokeWidth={1.75} />
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setFullscreen((v) => !v)}
              aria-label={fullscreen ? "Exit full screen" : "Full screen"}
              title={fullscreen ? "Exit full screen (Esc)" : "Full screen"}
              className={cn(TX_UTILITY, "border border-border-strong bg-card")}
            >
              {fullscreen ? <Minimize2 className="size-4" strokeWidth={1.75} /> : <Maximize2 className="size-4" strokeWidth={1.75} />}
              <span className="hidden lg:inline">{fullscreen ? "Exit" : "Expand"}</span>
            </button>
          </div>
        </div>

        {activeChips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {activeChips.map((c) => (
              <span key={c.key} className="inline-flex h-7 items-center gap-1 rounded-[6px] border border-primary-accent-text/40 bg-primary/15 pr-1 pl-2 text-xs font-medium text-foreground">
                {c.label}
                <button
                  type="button"
                  aria-label={`Remove ${c.label}`}
                  onClick={() => {
                    c.clear();
                    setPage(1);
                  }}
                  className="flex size-5 items-center justify-center rounded-[4px] text-muted-foreground hover:bg-card hover:text-foreground"
                >
                  <X className="size-3" strokeWidth={2} />
                </button>
              </span>
            ))}
            <button type="button" onClick={clearFilters} className="ml-1 text-xs font-semibold text-primary-accent-text hover:underline">
              Clear filters
            </button>
          </div>
        )}
      </div>

      {/* ── Ledger ── */}
      {!hasTransactions ? (
        <div className="flex flex-col items-center gap-3 rounded-[10px] border border-dashed border-border-strong bg-card px-6 py-14 text-center">
          <span className="flex size-11 items-center justify-center rounded-full bg-secondary text-muted-foreground">
            <Receipt className="size-5" strokeWidth={1.75} />
          </span>
          <div>
            <p className="font-heading text-base font-semibold text-foreground">No transactions yet</p>
            <p className="mt-1 text-sm text-muted-foreground">Add your first transaction to start tracking your money.</p>
          </div>
          {addMenu}
        </div>
      ) : (
        <section
          aria-label="Transactions"
          className={cn("flex min-h-0 flex-col overflow-hidden rounded-[10px] border border-border-strong/70 bg-card shadow-e1", fullscreen && "flex-1")}
        >
          {count === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
              <p className="text-sm font-semibold text-foreground">No transactions match these filters.</p>
              <button type="button" onClick={clearFilters} className="text-sm font-semibold text-primary-accent-text hover:underline">
                Clear filters
              </button>
            </div>
          ) : viewMode === "list" ? (
            <div className={cn("min-h-0 overflow-auto overscroll-contain", fullscreen ? "flex-1" : "max-h-[calc(100dvh-17rem)] min-h-[18rem]")}>
              <LedgerTable
                rows={pageRows}
                offset={(safePage - 1) * rowsPerPage}
                total={count}
                duplicateIds={duplicateTransactionIds}
                displayDescription={displayDescription}
                isSplit={(id) => expenseByTransactionId.has(id)}
                onOpen={openDetails}
                onDelete={setQuickDeleteRow}
              />
            </div>
          ) : (
            <div className={cn("min-h-0 overflow-auto overscroll-contain p-3", fullscreen ? "flex-1" : "max-h-[calc(100dvh-17rem)]")}>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                {pageRows.map((row) => {
                  const iconKey = row.category?.iconKey ?? "other";
                  const Icon = categoryIconFor(iconKey);
                  const t = row.transaction;
                  const isDuplicate = duplicateTransactionIds.has(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => openDetails(row)}
                      className={cn(
                        "flex min-w-0 flex-col gap-2 rounded-[8px] border border-border-strong/60 bg-card p-3 text-left transition-colors hover:border-border-strong hover:bg-secondary/50",
                        isDuplicate && "border-l-[3px] border-l-danger",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[8px]", TONE_ICON_CLASS[categoryToneFor(iconKey)])}>
                          <Icon className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-foreground">{displayDescription(t) || "(No description)"}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {shortDate(t.dateTime)} {t.dateTime.getFullYear()} · {row.category?.name ?? "Uncategorized"} · {row.account?.name ?? "Unknown"}
                          </span>
                        </span>
                        <Amount transaction={t} />
                      </span>
                      <TxnBadges transaction={t} isSplit={expenseByTransactionId.has(t.id)} isDuplicate={isDuplicate} />
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Pagination — attached to the ledger ── */}
          {count > 0 && (
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border-strong/60 bg-secondary/40 px-3 py-2 sm:px-4">
              <p className="text-xs text-muted-foreground tabular-nums">
                Showing <span className="font-semibold text-foreground">{rangeStart}–{rangeEnd}</span> of <span className="font-semibold text-foreground">{count}</span>
              </p>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-0.5">
                  <button type="button" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} aria-label="Previous page" className={PAGE_BTN}>
                    <ChevronLeft className="size-4" strokeWidth={1.75} />
                  </button>
                  {paginationRange(safePage, totalPages).map((entry, i) =>
                    entry === "ellipsis" ? (
                      <span key={`ellipsis-${i}`} className="px-1 text-xs text-muted-foreground">
                        …
                      </span>
                    ) : (
                      <button
                        key={entry}
                        type="button"
                        onClick={() => setPage(entry)}
                        aria-current={entry === safePage ? "page" : undefined}
                        className={cn(PAGE_BTN, "text-xs tabular-nums", entry === safePage && "border-primary-accent-text bg-primary font-semibold text-primary-foreground hover:bg-primary")}
                      >
                        {entry}
                      </button>
                    ),
                  )}
                  <button type="button" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)} aria-label="Next page" className={PAGE_BTN}>
                    <ChevronRight className="size-4" strokeWidth={1.75} />
                  </button>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" className="flex h-7 items-center gap-1 rounded-[6px] border border-border-strong bg-card px-2 text-xs text-muted-foreground hover:bg-secondary">
                      Rows <span className="font-semibold text-foreground tabular-nums">{rowsPerPage}</span>
                      <ChevronDown className="size-3" strokeWidth={2} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="rounded-[8px]">
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
            </div>
          )}
        </section>
      )}

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
            {categories
              .filter((c) => c.type === "expense" || c.type === "both")
              .map((c) => (
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

/* ───────────────────────── Ledger UI (visual only — every value comes from the existing row data) ───────────────────────── */

const TX_PRIMARY =
  "flex h-9 items-center gap-1.5 rounded-[6px] border border-primary-accent-text bg-primary px-3.5 text-sm font-semibold text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const TX_UTILITY =
  "flex h-9 items-center gap-1.5 rounded-[6px] px-2.5 text-sm font-medium text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent [&_svg]:text-muted-foreground";
const SOON = "rounded-[4px] bg-secondary px-1 py-px text-[10px] font-semibold tracking-wide text-muted-foreground uppercase";
const TX_FILTER =
  "flex h-9 max-w-full min-w-0 items-center gap-1.5 rounded-[6px] border border-border-strong bg-card px-2.5 text-sm font-medium text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:border-primary-accent-text dark:bg-input";
const TX_FILTER_ACTIVE = "border-primary-accent-text bg-primary/15 dark:bg-primary/10";
const TX_INPUT =
  "h-9 rounded-[6px] border border-border-strong bg-card px-2.5 text-sm text-foreground outline-none focus:border-primary-accent-text focus:ring-2 focus:ring-ring dark:bg-input";
const PAGE_BTN =
  "flex h-7 min-w-7 items-center justify-center rounded-[6px] border border-transparent px-1.5 text-muted-foreground transition-colors hover:bg-card hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

/** Short trigger labels for the existing filter definitions (their `label` stays the "All …" option). */
const FILTER_LABEL: Record<string, string> = {
  account: "Account",
  category: "Category",
  type: "Type",
  paymentMethod: "Payment method",
};

const TH =
  "sticky top-0 z-[2] border-r border-b border-r-border-strong/40 border-b-border-strong bg-secondary px-3 py-2 text-left text-[11px] font-semibold tracking-[0.06em] whitespace-nowrap text-muted-foreground uppercase last:border-r-0";
const TD = "border-r border-b border-r-border-strong/30 border-b-border-strong/40 px-3 py-2.5 align-middle last:border-r-0";
const COLS = 7;

function shortDate(d: Date): string {
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

function dateRangeLabel(from: string, to: string): string {
  const fmt = (v: string) => new Date(v).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  if (from && to) return `${fmt(from)} – ${fmt(to)}`;
  return from ? `From ${fmt(from)}` : `Until ${fmt(to)}`;
}

/** Compact dropdown for one existing `FilterDef` — same options and `onChange`; "All" resets it to null. */
function FilterMenu({ filter, label }: { filter: FilterDef; label: string }) {
  const active = filter.options.find((o) => o.value === filter.value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(TX_FILTER, active && TX_FILTER_ACTIVE)}>
          <span className={cn(active && "text-muted-foreground")}>{label}</span>
          {active && <span className="max-w-32 truncate font-semibold">{active.label}</span>}
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 min-w-44 overflow-y-auto rounded-[8px]">
        <DropdownMenuItem onSelect={() => filter.onChange(null)} className={cn(!active && "font-semibold")}>
          {filter.label}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {filter.options.map((option) => (
          <DropdownMenuItem key={option.value} onSelect={() => filter.onChange(option.value)} className={cn(option.value === filter.value && "font-semibold")}>
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type Flow = "in" | "out" | "transfer";
const flowOf = (t: Transaction): Flow => (t.transferId ? "transfer" : t.type === "income" ? "in" : "out");
const FLOW_LABEL: Record<Flow, string> = { in: "Money in", out: "Money out", transfer: "Transfer" };
const TYPE_LABEL: Record<Flow, string> = { in: "Income", out: "Expense", transfer: "Transfer" };

/**
 * The row's headline figure, read by direction — money in (green), money out (strong), transfer
 * (neutral); `size="lg"` for the ledger's Amount column, with the "Money in / out" label beneath.
 */
function Amount({ transaction, withLabel = false, size = "md" }: { transaction: Transaction; withLabel?: boolean; size?: "md" | "lg" }) {
  const flow = flowOf(transaction);
  const Icon = flow === "in" ? ArrowDownLeft : flow === "out" ? ArrowUpRight : ArrowLeftRight;
  return (
    <span className="flex shrink-0 flex-col items-end gap-0.5">
      <span
        className={cn(
          "font-bold tracking-tight whitespace-nowrap tabular-nums",
          size === "lg" ? "text-[18px] leading-tight" : "text-[15px] leading-tight",
          flow === "in" ? "text-success" : flow === "out" ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {flow === "in" ? "+" : flow === "out" ? "−" : ""}
        {formatCurrency(transaction.amount)}
      </span>
      {withLabel && (
        <span className={cn("inline-flex items-center gap-0.5 text-[11px] font-medium", flow === "in" ? "text-success" : flow === "out" ? "text-expense" : "text-muted-foreground")}>
          <Icon className="size-3" strokeWidth={2} aria-hidden />
          {FLOW_LABEL[flow]}
        </span>
      )}
    </span>
  );
}

const BADGE = "inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[4px] border px-1.5 text-[10.5px] font-semibold whitespace-nowrap";

/**
 * The existing markers — Loan/EMI (`loanTagFor`), accounting flag (`transactionFlagFor`), possible
 * duplicate — plus Split (a linked Expense) and Transfer (`transferId`) read from the same row data.
 */
function TxnBadges({ transaction, isSplit, isDuplicate, hideLoan = false }: { transaction: Transaction; isSplit: boolean; isDuplicate: boolean; hideLoan?: boolean }) {
  const loanTag = hideLoan ? null : loanTagFor(transaction);
  const flag = transactionFlagFor(transaction);
  if (!loanTag && !flag && !isSplit && !isDuplicate && !transaction.transferId) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {loanTag && (
        <span className={cn(BADGE, "border-purple/35 bg-purple/12 text-purple")}>
          <Landmark className="size-3" aria-hidden />
          {loanTag.label}
        </span>
      )}
      {isSplit && (
        <span className={cn(BADGE, "border-primary-accent-text/40 bg-primary/20 text-foreground dark:text-primary-accent-text")}>
          <Split className="size-3" aria-hidden />
          Split
        </span>
      )}
      {transaction.transferId && (
        <span className={cn(BADGE, "border-border-strong bg-secondary text-foreground")}>
          <ArrowLeftRight className="size-3" aria-hidden />
          Transfer
        </span>
      )}
      {flag && <span className={cn(BADGE, "border-warning/50 bg-warning/15 text-warning-foreground dark:text-warning")}>{flag.label}</span>}
      {isDuplicate && (
        <span className={cn(BADGE, "border-danger/40 bg-danger/10 text-danger")} title="Another transaction has the same amount and date — check it isn't a duplicate.">
          <Copy className="size-2.5" aria-hidden />
          Possible duplicate
        </span>
      )}
    </span>
  );
}

function LedgerTable({
  rows,
  offset,
  total,
  duplicateIds,
  displayDescription,
  isSplit,
  onOpen,
  onDelete,
}: {
  rows: TransactionRow[];
  offset: number;
  total: number;
  duplicateIds: Set<string>;
  displayDescription: (t: Transaction) => string;
  isSplit: (transactionId: string) => boolean;
  onOpen: (row: TransactionRow) => void;
  onDelete: (row: TransactionRow) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const pad = String(total).length < 2 ? 2 : String(total).length;

  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <th className={cn(TH, "hidden w-12 text-right sm:table-cell")}>#</th>
          <th className={cn(TH, "w-[4.5rem]")}>Date</th>
          <th className={TH}>Description</th>
          <th className={cn(TH, "hidden w-28 md:table-cell")}>Type</th>
          <th className={cn(TH, "hidden w-40 lg:table-cell")}>Account</th>
          <th className={cn(TH, "w-36 text-right")}>Amount</th>
          <th className={cn(TH, "w-[7.25rem]")}>
            <span className="sr-only sm:not-sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => {
          const t = row.transaction;
          const open = openId === t.id;
          const iconKey = row.category?.iconKey ?? "other";
          const Icon = categoryIconFor(iconKey);
          const isDuplicate = duplicateIds.has(t.id);
          const flow = flowOf(t);
          const loanTag = loanTagFor(t);
          const toggle = () => setOpenId((k) => (k === t.id ? null : t.id));
          return (
            <Fragment key={t.id}>
              <tr
                onClick={toggle}
                aria-expanded={open}
                className={cn("group cursor-pointer transition-colors hover:bg-secondary/60", open && "bg-secondary/70", isDuplicate && "bg-danger/[0.04]")}
              >
                <td className={cn(TD, "hidden border-l-[3px] text-right text-[11px] text-muted-foreground tabular-nums sm:table-cell", isDuplicate ? "border-l-danger" : "border-l-transparent")}>
                  {String(offset + i + 1).padStart(pad, "0")}
                </td>
                <td className={cn(TD, "whitespace-nowrap tabular-nums")}>
                  <p className="text-sm leading-tight font-semibold text-foreground">{shortDate(t.dateTime)}</p>
                  <p className="text-[11px] leading-tight text-muted-foreground">{t.dateTime.getFullYear()}</p>
                </td>
                <td className={cn(TD, "relative max-w-0", loanTag && "pr-20")}>
                  {loanTag && <CornerTag label={loanTag.label} />}
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[8px]", TONE_ICON_CLASS[categoryToneFor(iconKey)])}>
                      <Icon className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-foreground">{displayDescription(t) || "(No description)"}</p>
                      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                        <span className="truncate text-xs text-muted-foreground">
                          {row.category?.name ?? "Uncategorized"}
                          <span className="lg:hidden"> · {row.account?.name ?? "Unknown account"}</span>
                        </span>
                        <TxnBadges transaction={t} isSplit={isSplit(t.id)} isDuplicate={isDuplicate} hideLoan />
                      </div>
                    </div>
                  </div>
                </td>
                <td className={cn(TD, "hidden text-xs font-medium text-foreground/85 md:table-cell")}>{TYPE_LABEL[flow]}</td>
                <td className={cn(TD, "hidden truncate text-xs text-foreground/85 lg:table-cell")}>{row.account?.name ?? "Unknown"}</td>
                <td className={cn(TD, "text-right")}>
                  <Amount transaction={t} withLabel size="lg" />
                </td>
                <td className={cn(TD, "px-1.5")} onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-end gap-1.5">
                    {/* Edit · Delete — one compact joined control */}
                    <div className="flex h-7 items-stretch overflow-hidden rounded-[7px] border border-border-strong/70 bg-card shadow-[0_1px_1px_rgb(0_0_0/0.04)]">
                      <button
                        type="button"
                        onClick={() => onOpen(row)}
                        title="Edit transaction"
                        aria-label="Edit transaction"
                        className="flex w-8 items-center justify-center text-foreground/70 transition-colors outline-none hover:bg-primary/20 hover:text-foreground focus-visible:bg-primary/20 dark:hover:text-primary-accent-text"
                      >
                        <Pencil className="size-3.5" strokeWidth={1.75} />
                      </button>
                      <span className="w-px bg-border-strong/60" aria-hidden />
                      <button
                        type="button"
                        onClick={() => onDelete(row)}
                        title="Delete transaction"
                        aria-label="Delete transaction"
                        className="flex w-8 items-center justify-center text-foreground/70 transition-colors outline-none hover:bg-expense/10 hover:text-expense focus-visible:bg-expense/10"
                      >
                        <Trash2 className="size-3.5" strokeWidth={1.75} />
                      </button>
                    </div>
                    <button
                      type="button"
                      aria-label={open ? "Collapse details" : "Expand details"}
                      title={open ? "Hide details" : "Show details"}
                      onClick={toggle}
                      className={cn(
                        "flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                        open && "bg-secondary text-foreground",
                      )}
                    >
                      <ChevronDown className={cn("size-4 transition-transform duration-200 motion-reduce:transition-none", open && "rotate-180")} strokeWidth={1.75} />
                    </button>
                  </div>
                </td>
              </tr>
              <tr aria-hidden={!open}>
                <td colSpan={COLS} className={cn("p-0", open && "border-b border-border-strong/40 bg-secondary/40")}>
                  <div className={cn("grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
                    <div className="min-h-0 overflow-hidden">
                      {open && <RowDetails
                          row={row}
                          displayDescription={displayDescription}
                          onOpen={() => onOpen(row)}
                          onDelete={() => onDelete(row)}
                          isSplit={isSplit(t.id)}
                          isDuplicate={isDuplicate}
                        />}
                    </div>
                  </div>
                </td>
              </tr>
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

const FLOW_HERO: Record<Flow, { panel: string; chip: string; amount: string; edge: string; mark: string }> = {
  in: {
    panel: "bg-gradient-to-br from-success/[0.10] to-success/[0.02] dark:from-success/[0.16] dark:to-success/[0.04]",
    chip: "border-success/35 bg-success/12 text-success",
    amount: "text-success",
    edge: "bg-success",
    mark: "text-success",
  },
  out: {
    panel: "bg-gradient-to-br from-expense/[0.09] to-expense/[0.02] dark:from-expense/[0.16] dark:to-expense/[0.04]",
    chip: "border-expense/30 bg-expense/10 text-expense",
    amount: "text-foreground",
    edge: "bg-expense",
    mark: "text-expense",
  },
  transfer: {
    panel: "bg-gradient-to-br from-secondary to-secondary/30",
    chip: "border-border-strong bg-card text-foreground",
    amount: "text-foreground",
    edge: "bg-border-strong",
    mark: "text-foreground",
  },
};

/** Soft icon tints — one per fact, so the grid scans by colour as well as by label. */
const FACT_TONE = {
  purple: "bg-purple/12 text-purple",
  lime: "bg-primary/25 text-foreground dark:text-primary-accent-text",
  amber: "bg-warning/20 text-warning-foreground dark:text-warning",
  green: "bg-success/12 text-success",
  neutral: "bg-secondary text-foreground/70",
} as const;

/** One labelled fact cell — fills its grid cell and centres its content, so the grid always spans the card. */
function Fact({
  icon: Icon,
  label,
  tone,
  children,
}: {
  icon: typeof Wallet;
  label: string;
  tone: keyof typeof FACT_TONE;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 border-b border-border-strong/40 px-4 py-3 last:border-b-0 sm:border-r sm:[&:nth-child(2n)]:border-r-0 sm:[&:nth-child(n+3)]:border-b-0">
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[8px]", FACT_TONE[tone])}>
        <Icon className="size-4" strokeWidth={1.75} />
      </span>
      <div className="min-w-0">
        <p className="text-[10.5px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">{label}</p>
        <p className="mt-0.5 truncate text-sm font-semibold text-foreground">{children}</p>
      </div>
    </div>
  );
}

/**
 * Expanded row — an attached details card: the amount and what happened on a direction-tinted panel,
 * the supporting facts in a labelled grid, and the row's Edit / Delete. Every value is existing row data.
 */
function RowDetails({
  row,
  displayDescription,
  onOpen,
  onDelete,
  isSplit,
  isDuplicate,
}: {
  row: TransactionRow;
  displayDescription: (t: Transaction) => string;
  onOpen: () => void;
  onDelete: () => void;
  isSplit: boolean;
  isDuplicate: boolean;
}) {
  const t = row.transaction;
  const flow = flowOf(t);
  const hero = FLOW_HERO[flow];
  const FlowIcon = flow === "in" ? ArrowDownLeft : flow === "out" ? ArrowUpRight : ArrowLeftRight;
  return (
    <div className="px-3 pt-1 pb-3.5 sm:pr-4 sm:pl-[4.25rem]">
      <div className="flex flex-col overflow-hidden rounded-[12px] border border-border-strong/60 bg-card shadow-[0_1px_2px_rgb(0_0_0/0.05),0_6px_16px_-8px_rgb(0_0_0/0.12)] md:flex-row">
        {/* What happened — amount first, on a direction-tinted panel with an accent edge */}
        <div className={cn("relative flex flex-col gap-2.5 overflow-hidden border-b border-border-strong/40 py-4 pr-4 pl-5 md:w-80 md:shrink-0 md:border-r md:border-b-0", hero.panel)}>
          <span className={cn("absolute inset-y-0 left-0 w-1", hero.edge)} aria-hidden />
          <FlowIcon className={cn("pointer-events-none absolute -right-3 -bottom-4 size-28 opacity-[0.07]", hero.mark)} strokeWidth={1.5} aria-hidden />
          <span className={cn("relative inline-flex w-fit items-center gap-1 rounded-[5px] border px-1.5 py-0.5 text-[11px] font-semibold", hero.chip)}>
            <FlowIcon className="size-3" strokeWidth={2.25} aria-hidden />
            {FLOW_LABEL[flow]}
          </span>
          <p className={cn("relative font-heading text-[30px] leading-none font-bold tracking-tight tabular-nums", hero.amount)}>
            {flow === "in" ? "+" : flow === "out" ? "−" : ""}
            {formatCurrency(t.amount)}
          </p>
          <div className="relative min-w-0">
            <p className="truncate text-[15px] font-semibold text-foreground">{displayDescription(t) || "(No description)"}</p>
            <p className="mt-1 flex items-center gap-1.5 text-xs font-medium text-foreground/70 tabular-nums">
              <Calendar className="size-3.5" strokeWidth={1.75} aria-hidden />
              {formatFullDate(t.dateTime, true)}
            </p>
          </div>
          <div className="relative">
            <TxnBadges transaction={t} isSplit={isSplit} isDuplicate={isDuplicate} />
          </div>
        </div>

        {/* Supporting facts — a 2×2 grid that fills the card's height */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="grid flex-1 grid-cols-1 sm:grid-cols-2">
            <Fact icon={Tag} label="Type" tone="purple">{TYPE_LABEL[flow]}</Fact>
            <Fact icon={Wallet} label="Account" tone="lime">{row.account?.name ?? "Unknown"}</Fact>
            <Fact icon={Shapes} label="Category" tone="amber">{row.category?.name ?? "Uncategorized"}</Fact>
            <Fact icon={CreditCard} label="Payment method" tone="green">{paymentMethodFor(t, row.account)}</Fact>
          </div>
          {t.notes.trim() && (
            <div className="flex items-start gap-3 border-t border-border-strong/40 px-4 py-3">
              <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[8px]", FACT_TONE.neutral)}>
                <StickyNote className="size-4" strokeWidth={1.75} />
              </span>
              <div className="min-w-0">
                <p className="text-[11px] font-medium tracking-[0.04em] text-muted-foreground uppercase">Notes</p>
                <p className="mt-0.5 text-sm whitespace-pre-wrap text-foreground">{t.notes}</p>
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 border-t border-border-strong/40 px-4 py-3 md:w-40 md:shrink-0 md:flex-col md:items-stretch md:justify-center md:border-t-0 md:border-l">
          <button
            type="button"
            onClick={onOpen}
            className="flex h-8 items-center justify-center gap-1.5 rounded-[6px] border border-primary-accent-text bg-primary px-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Pencil className="size-3.5" strokeWidth={2} />
            Edit
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="flex h-8 items-center justify-center gap-1.5 rounded-[6px] border border-border-strong bg-card px-3 text-sm font-medium text-foreground/80 transition-colors hover:border-expense/40 hover:bg-expense/10 hover:text-expense"
          >
            <Trash2 className="size-3.5" strokeWidth={1.75} />
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Loan/EMI marker — a short stacked tab hanging from the top line at the right end of the Description cell: a solid
 * chip over a lighter, slightly larger back layer (same `loanTagFor` label as before).
 */
function CornerTag({ label, className }: { label: string; className?: string }) {
  return (
    <span className={cn("pointer-events-none absolute top-0 right-1.5 z-[1] flex", className)}>
      {/* back layer — peeks out below and to the sides */}
      <span className="absolute -inset-x-[4px] top-0 h-[20px] rounded-b-[6px] bg-purple/25 dark:bg-purple/35" aria-hidden />
      <span className="relative flex h-[16px] min-w-[3.25rem] items-center justify-center rounded-b-[4px] bg-gradient-to-b from-purple to-[color-mix(in_oklch,var(--color-purple),black_12%)] px-2.5 text-[9px] leading-none font-bold tracking-[0.12em] text-white uppercase shadow-[0_1px_2px_rgb(0_0_0/0.18)]">
        {label}
      </span>
    </span>
  );
}
