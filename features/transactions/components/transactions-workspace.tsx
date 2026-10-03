"use client";

import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
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
  User,
  Upload,
  Wallet,
  X,
  Check,
  CheckCircle2,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useDeferredValue, useEffect, useMemo, useState } from "react";
import { readPeopleReturnContext, type PeopleReturnContext } from "@/features/people/lib/people-return-link";
import { toast } from "@/store/toast-store";
import { ClayButton } from "@/components/clay/clay-button";
import { ACCOUNT_FILTER_PARAM, resolveAccountFilter } from "@/features/transactions/lib/account-filter-param";
import { usePeopleLedgerEntries } from "@/features/people/hooks/use-people-data";
import { getTransactionPresentation, type RowTreatment, type TransactionPresentation } from "@/features/transactions/lib/transaction-presentation";
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
import { paidFromLabel } from "@/features/transactions/lib/funding-label";
import { useExpenses } from "@/hooks/use-expenses";
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import { isSplit as isSplitExpense, type SplitType } from "@/lib/models/expense";
import type { Person } from "@/lib/models/person";
import { compareTransactionsNewestFirst, isLoanPrincipalDisbursement, type Transaction } from "@/lib/models/transaction";
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
import { DateInput } from "@/components/forms/date-input";

/**
 * Corner-ribbon tag for a Loan/EMI-generated transaction card — "EMI" only for a payment tied to
 * the standalone EMI feature (`emiId`); every Loan-generated transaction (`loanId`) is tagged
 * "Loan" regardless of the loan's repayment type, since Loan and EMI are separate features and
 * only an actual EMI should ever read "EMI". Returns null for anything not tied to a loan/EMI so
 * ordinary transactions stay untagged.
 */
/** "Assign to a person" — same rule as `isOwed` in `owes-person-transition.ts`: an expense whose
 *  `linkedPersonId` is set with `owesPersonToggle` on. A reference-only link (toggle off) is not one. */
function isAssignedToPerson(transaction: Pick<Transaction, "type" | "linkedPersonId" | "owesPersonToggle">): boolean {
  return transaction.type === "expense" && transaction.linkedPersonId != null && transaction.owesPersonToggle;
}

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
  purple: "bg-debt-surface text-debt-text",
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
  // "Assign to a person" also creates an `Expense` (via `convertToAssigned`), so having an Expense is
  // not what makes a row a split. The authoritative assignment marker is the one `applyOwesPersonChange`
  // uses (`isOwed`): an expense transaction with `linkedPersonId` AND `owesPersonToggle`. A row is a Split
  // only when its Expense is a real split (`isSplit`) and it is NOT such an assignment.
  const personNameById = useMemo(() => new Map(people.map((p) => [p.id, p.name])), [people]);
  const splitTransactionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const r of rows) {
      const t = r.transaction;
      const expense = expenseByTransactionId.get(t.id);
      if (expense && isSplitExpense(expense) && !isAssignedToPerson(t)) ids.add(t.id);
    }
    return ids;
  }, [rows, expenseByTransactionId]);
  const assigneeFor = (t: Transaction): string | null =>
    isAssignedToPerson(t) ? (personNameById.get(t.linkedPersonId!) ?? "a person") : null;
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
  // `?account=<accountId>` (from Accounts / Credit Cards "View transactions") pre-selects the EXISTING account
  // filter — same filter, same list; a card is an account, so one param covers both.
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [accountFilter, setAccountFilter] = useState<string | null>(() => searchParams.get(ACCOUNT_FILTER_PARAM));
  // A stale/deleted id from the URL falls back to the unfiltered list once accounts are known.
  const resolvedAccountFilter = resolveAccountFilter(accountFilter, accounts, isLoading);
  if (resolvedAccountFilter !== accountFilter) setAccountFilter(resolvedAccountFilter);
  // Keep the URL in step with the filter (replace, not push): clearing the chip clears the param, so a
  // refresh doesn't silently re-filter and Back still returns to the page the user came from.
  useEffect(() => {
    const current = searchParams.get(ACCOUNT_FILTER_PARAM);
    if (current === accountFilter) return;
    const next = new URLSearchParams(searchParams.toString());
    if (accountFilter) next.set(ACCOUNT_FILTER_PARAM, accountFilter);
    else next.delete(ACCOUNT_FILTER_PARAM);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [accountFilter, searchParams, router, pathname]);
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

  // `?transaction=<id>` handoff (e.g. the People Ledger's "Open expense"): open that transaction's details once.
  const [handoffId, setHandoffId] = useState<string | null>(() => searchParams.get("transaction"));
  // Opened from a People ledger (`&return=/people?person=…&cycle=…`): the details show "Back to <name>" and,
  // once the operation finishes (saved, deleted, cancelled or closed), return to that exact ledger.
  const [handoffMissing, setHandoffMissing] = useState(false);
  const [peopleReturn, setPeopleReturn] = useState<PeopleReturnContext | null>(() => (searchParams.get("transaction") ? readPeopleReturnContext(searchParams) : null));
  if (handoffId) {
    const target = rows.find((r) => r.transaction.id === handoffId);
    if (target) {
      setHandoffId(null);
      setDetailRow(target);
      setDetailOpen(true);
    } else if (!isLoading && peopleReturn != null) {
      // The source is gone (deleted since the link was rendered): never a dead editor — straight back.
      setHandoffId(null);
      setHandoffMissing(true);
    }
  }
  useEffect(() => {
    if (!handoffMissing || peopleReturn == null) return;
    toast.error("Original transaction is no longer available");
    router.push(peopleReturn.href);
  }, [handoffMissing, peopleReturn, router]);
  /** Finishing the People-origin operation (saved / deleted / cancelled / closed) goes back to that ledger. */
  const returnToPeople = () => {
    if (peopleReturn == null) return;
    setPeopleReturn(null);
    router.push(peopleReturn.href);
  };

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

    // Transaction date first (so month groups stay contiguous); same day → most recently touched first,
    // and transfer legs stay adjacent.
    return [...list].sort((a, b) => {
      const ta = a.transaction;
      const tb = b.transaction;
      const dayDelta = dayKeyOf(tb.dateTime) - dayKeyOf(ta.dateTime);
      if (dayDelta !== 0) return dayDelta;
      if (ta.transferId && ta.transferId === tb.transferId) return 0;
      return compareTransactionsNewestFirst(ta, tb);
    });
  }, [rows, deferredSearch, accountFilter, categoryFilter, typeFilter, paymentMethodFilter, dateFrom, dateTo, displayDescription]);

  // Computed over the full, unfiltered `rows` — not `filtered` — so a duplicate is still flagged even
  // if its pair got filtered out of the current view.
  const duplicateTransactionIds = useMemo(() => findSameAmountDateDuplicateIds(rows.map((r) => r.transaction)), [rows]);
  // Cash legs of People "Borrowed" entries (`LedgerEntry.transactionRef`) — display only: they get the borrowed outline.
  const { entriesByPersonId } = usePeopleLedgerEntries();
  const borrowedTransactionIds = useMemo(
    () => new Set(Object.values(entriesByPersonId).flat().filter((e) => e.type === "borrowed" && e.deletedAt == null && e.transactionRef).map((e) => e.transactionRef as string)),
    [entriesByPersonId],
  );

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
    ...(accountFilter ? [{ key: "account", label: `${accounts.find((a) => a.id === accountFilter)?.type === "card" ? "Card" : "Account"}: ${accountName(accountFilter)}`, clear: () => setAccountFilter(null) }] : []),
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
                  <DateInput
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
                  <DateInput
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
                borrowedIds={borrowedTransactionIds}
                displayDescription={displayDescription}
                isSplit={(id) => splitTransactionIds.has(id)}
                assigneeFor={assigneeFor}
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
                          <span className="block truncate text-sm font-semibold text-foreground">{displayDescription(t) || (t.transferId ? TRANSFER_SIDE_LABEL[transferSideOf(t)] : "(No description)")}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {shortDate(t.dateTime)} {t.dateTime.getFullYear()} · {row.category?.name ?? "Uncategorized"} · {paidFromLabel(t, row.account?.name, personNameById) ?? "Unknown"}
                          </span>
                        </span>
                        <Amount transaction={t} />
                      </span>
                      <TxnBadges transaction={t} isSplit={splitTransactionIds.has(t.id)} assignedTo={assigneeFor(t)} isDuplicate={isDuplicate} />
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
            // The modal only closes after a successful Save/Delete or on Cancel/close — a failed write keeps
            // it open — so returning here never leaves a failed edit behind.
            returnToPeople();
          }
        }}
        row={detailRow}
        returnLabel={peopleReturn?.label ?? null}
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
        <DateInput
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

const monthKeyOf = (d: Date) => d.getFullYear() * 12 + d.getMonth();
const dayKeyOf = (d: Date) => monthKeyOf(d) * 32 + d.getDate();

const TH =
  "sticky top-0 z-[2] border-r border-b border-r-border-strong/40 border-b-border-strong bg-secondary px-2 py-2 text-left text-[11px] font-semibold tracking-[0.06em] whitespace-nowrap text-muted-foreground uppercase last:border-r-0 sm:px-3";
const TD = "border-r border-b border-r-border-strong/30 border-b-border-strong/40 px-2 py-2.5 align-middle last:border-r-0 sm:px-3";
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

/** "debt" = money that only moves a liability/receivable: a Loan principal disbursement or a People-ledger
 *  cash movement (Borrowed / Repaid / Received Back). The same set `isNonIncomeExpenseMovement` already
 *  keeps out of income/expense totals — so the list never shows borrowed cash as Income. */
type Flow = "in" | "out" | "transfer" | "debt";
/** Violet text that stays readable on light low-contrast screens (the raw token is light for small text):
 *  darkened in light mode, the token itself in dark mode (already lifted there). */
const PURPLE_TEXT = "text-debt-text";
const flowOf = (t: Transaction): Flow =>
  t.transferId ? "transfer" : isLoanPrincipalDisbursement(t) || t.isPersonLedgerMovement ? "debt" : t.type === "income" ? "in" : "out";
const FLOW_LABEL: Record<Flow, string> = { in: "Money in", out: "Money out", transfer: "Transfer", debt: "Loan" };
const TYPE_LABEL: Record<Flow, string> = { in: "Income", out: "Expense", transfer: "Transfer", debt: "Loan / People" };

/** Direction wording for a "debt" row, from its stored type (income = cash in, expense = cash out). */
function debtLabel(t: Transaction): string {
  const incoming = t.type === "income";
  if (isLoanPrincipalDisbursement(t)) return incoming ? "Borrowed" : "Lent";
  return incoming ? "Received from person" : "Paid to person";
}

/** Which side of a transfer a leg is — read from the leg's stored type exactly as
 *  `TransactionRepository.createTransfer` writes it (source leg = "expense", destination = "income"). */
const transferSideOf = (t: Transaction): "sent" | "received" => (t.type === "income" ? "received" : "sent");
const TRANSFER_SIDE_LABEL = { sent: "Transfer sent", received: "Transfer received" } as const;

/**
 * The row's headline figure, read by direction — money in (green), money out (strong), transfer
 * (neutral, signed by side but never green/red — moving your own money isn't income or spending);
 * `size="lg"` for the ledger's Amount column, with the direction label beneath.
 */
function Amount({
  transaction,
  presentation = getTransactionPresentation(transaction),
  withLabel = false,
  size = "md",
}: {
  transaction: Transaction;
  /** From `getTransactionPresentation` (with the row's card context) — never the sign alone. */
  presentation?: TransactionPresentation;
  withLabel?: boolean;
  size?: "md" | "lg";
}) {
  const { incoming, row, settled, status } = presentation;
  // Borrowed: the note points at the obligation ('repay', outward), not at the money coming in.
  const Icon = settled ? Check : row === "borrowed" ? ArrowUpRight : incoming ? ArrowDownLeft : ArrowUpRight;
  return (
    <span className="flex shrink-0 flex-col items-end gap-0.5">
      <span
        className={cn(
          "font-bold tracking-tight whitespace-nowrap tabular-nums",
          size === "lg" ? "text-[15px] leading-tight sm:text-[18px]" : "text-[15px] leading-tight",
          // Only real income is green; a paid obligation is money out, shown in strong neutral text.
          row === "income" ? "text-success" : "text-foreground",
        )}
      >
        {incoming ? "+" : "−"}
        {formatCurrency(transaction.amount)}
      </span>
      {withLabel && (
        <span
          className={cn(
            "inline-flex items-center gap-0.5 text-[11px]",
            settled
              ? "rounded-[4px] border border-success/60 bg-success/12 px-1 font-bold tracking-wide text-success uppercase"
              : row === "borrowed"
                ? "rounded-[4px] border border-debt-strong px-1 font-bold text-debt-strong"
                : row === "income"
                ? "font-medium text-success"
                : row === "expense"
                  ? "font-medium text-expense"
                  : row === "debt"
                    ? cn("font-medium", PURPLE_TEXT)
                    : "font-medium text-foreground/70",
          )}
        >
          <Icon className="size-3" strokeWidth={settled ? 2.75 : 2} aria-hidden />
          {status}
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
function TxnBadges({
  transaction,
  isSplit,
  assignedTo = null,
  isDuplicate,
  hideLoan = false,
}: {
  transaction: Transaction;
  isSplit: boolean;
  /** Person name when the expense was assigned to one person ("Assign to a person") — never a split. */
  assignedTo?: string | null;
  isDuplicate: boolean;
  hideLoan?: boolean;
}) {
  const loanTag = hideLoan ? null : loanTagFor(transaction);
  const flag = transactionFlagFor(transaction);
  if (!loanTag && !flag && !isSplit && !assignedTo && !isDuplicate && !transaction.transferId) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {loanTag && (
        <span className={cn(BADGE, "border-debt-border bg-debt-surface text-debt-text")}>
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
      {assignedTo && (
        <span className={cn(BADGE, "max-w-40 border-border-strong bg-card text-foreground")} title={`Assigned to ${assignedTo} — they owe you this amount`}>
          <User className="size-3 shrink-0" aria-hidden />
          <span className="truncate">For {assignedTo}</span>
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
  borrowedIds,
  displayDescription,
  isSplit,
  assigneeFor,
  onOpen,
  onDelete,
}: {
  rows: TransactionRow[];
  offset: number;
  total: number;
  duplicateIds: Set<string>;
  /** People "Borrowed" cash legs — money in that must be repaid. */
  borrowedIds: ReadonlySet<string>;
  displayDescription: (t: Transaction) => string;
  isSplit: (transactionId: string) => boolean;
  assigneeFor: (t: Transaction) => string | null;
  onOpen: (row: TransactionRow) => void;
  onDelete: (row: TransactionRow) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const pad = String(total).length < 2 ? 2 : String(total).length;
  // Two legs are drawn as one connected transfer only when they share the same stored `transferId`
  // AND sit next to each other on this page — never inferred from amount/date/description. A leg whose
  // partner is on another page or filtered out keeps its "Transfer sent/received" identity, unconnected.
  const pairedWithNext = rows.map((r, i) => {
    const next = rows[i + 1];
    return r.transaction.transferId != null && next != null && next.transaction.id !== r.transaction.id && next.transaction.transferId === r.transaction.transferId;
  });
  const pairRole = (i: number): "first" | "second" | null => (pairedWithNext[i] ? "first" : i > 0 && pairedWithNext[i - 1] ? "second" : null);

  return (
    // `isolate` keeps the transfer centre line's z-index inside the table, so it can sit above the next
    // row but never above dialogs/popovers opened over the page.
    <table className="isolate w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <th className={cn(TH, "hidden w-12 text-right lg:table-cell")}>#</th>
          <th className={cn(TH, "w-[4.5rem]")}>Date</th>
          <th className={TH}>Description</th>
          <th className={cn(TH, "hidden w-28 xl:table-cell")}>Type</th>
          <th className={cn(TH, "hidden w-40 lg:table-cell")}>Account</th>
          <th className={cn(TH, "w-24 text-right sm:w-36")}>Amount</th>
          {/* Edit / Delete move into the expanded row wherever the table is narrow (phones, and the md range where the
              sidebar takes a third of the screen) — tap a row — so Description keeps room. */}
          <th className={cn(TH, "hidden w-[7.25rem] sm:table-cell md:hidden lg:table-cell")}>
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
          const role = pairRole(i);
          const mate = role === "first" ? rows[i + 1] : role === "second" ? rows[i - 1] : null;
          const side = flow === "transfer" ? transferSideOf(t) : null;
          const mateName = mate?.account?.name ?? "Unknown account";
          const ownName = row.account?.name ?? "Unknown account";
          // Direction from each leg's stored side — never from row order (sort can put "received" first).
          const route = mate ? (side === "sent" ? `${ownName} → ${mateName}` : `${mateName} → ${ownName}`) : null;
          // Same rule the Add/Edit popup uses for a card bill payment: a transfer touching a card account
          // (either this leg's account or its paired leg's). Read-only account data — display only.
          // A possible duplicate keeps its row's own meaning (tint) — the warning is its badge + red edge only,
          // so a flagged People/Income row never turns into a generic pink row.
          const presentation = getTransactionPresentation(t, {
            touchesCard: row.account?.type === "card" || mate?.account?.type === "card",
            borrowedFromPerson: borrowedIds.has(t.id),
          });
          const tone: RowTone = presentation.row;
          const edge = isDuplicate ? ROW_TONE.duplicate.edge : ROW_TONE[tone].edge;
          return (
            <Fragment key={t.id}>
              {(i === 0 || monthKeyOf(rows[i - 1].transaction.dateTime) !== monthKeyOf(t.dateTime)) && (
                <tr>
                  <td
                    colSpan={7}
                    className="border-b border-border bg-muted/60 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    {t.dateTime.toLocaleDateString("en-IN", { month: "long", year: "numeric" })}
                  </td>
                </tr>
              )}
              <tr
                onClick={toggle}
                aria-expanded={open}
                className={cn(
                  "group relative cursor-pointer transition-colors",
                  // One wash on the <tr> (cells are transparent), so the tint reads as a single row/group.
                  open ? ROW_TONE[tone].open : ROW_TONE[tone].rest,
                  // One combined outline around both legs: strong top on the first, strong bottom on the
                  // second, strong right edge on both, rounded outer corners, no rule between them.
                  role && "[&>td:last-child]:border-r [&>td:last-child]:border-r-border-strong",
                  role === "first" && "[&>td]:border-t [&>td]:border-t-border-strong [&>td]:border-b-transparent",
                  role === "second" && "[&>td]:border-b-border-strong",
                  // Borrowed money: one outline around the whole logical row, drawn on the cells' own
                  // borders so the grid's vertical separators stay intact.
                  tone === "borrowed" && !isDuplicate && BORROWED_OUTLINE,
                )}
              >
                <td
                  className={cn(
                    TD,
                    "hidden border-l-[3px] text-right text-[11px] text-muted-foreground tabular-nums lg:table-cell",
                    edge,
                  )}
                >
                  {String(offset + i + 1).padStart(pad, "0")}
                </td>
                <td
                  className={cn(
                    TD,
                    "border-l-[3px] whitespace-nowrap tabular-nums lg:border-l-0",
                    edge,
                  )}
                >
                  {role === "first" && route && <TransferCenterLine route={route} />}
                  <p className="text-sm leading-tight font-semibold text-foreground">{shortDate(t.dateTime)}</p>
                  <p className="text-[11px] leading-tight text-muted-foreground">{t.dateTime.getFullYear()}</p>
                </td>
                <td className={cn(TD, "relative max-w-0", loanTag && "pr-20")}>
                  {loanTag && <CornerTag label={loanTag.label} />}
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className={cn("hidden size-8 shrink-0 items-center justify-center rounded-[8px] sm:flex", TONE_ICON_CLASS[categoryToneFor(iconKey)])}>
                      <Icon className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-foreground">
                        {displayDescription(t) ||
                          (side
                            ? mate
                              ? `Transfer ${side === "sent" ? "to" : "from"} ${mateName}`
                              : TRANSFER_SIDE_LABEL[side]
                            : "(No description)")}
                      </p>
                      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                        <span className="truncate text-xs text-muted-foreground">
                          {row.category?.name ?? "Uncategorized"}
                          <span className="lg:hidden"> · {paidFromLabel(row.transaction, row.account?.name) ?? "Unknown account"}</span>
                        </span>
                        <TxnBadges transaction={t} isSplit={isSplit(t.id)} assignedTo={assigneeFor(t)} isDuplicate={isDuplicate} hideLoan />
                      </div>
                    </div>
                  </div>
                </td>
                <td className={cn(TD, "hidden xl:table-cell")}>
                  <TypeTag transaction={t} presentation={presentation} />
                </td>
                <td className={cn(TD, "hidden max-w-0 lg:table-cell")}>
                  <p className="truncate text-xs text-foreground/85">{paidFromLabel(row.transaction, row.account?.name) ?? "Unknown"}</p>
                  {mate && (
                    <p className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground" title={route ?? undefined}>
                      {side === "sent" ? <ArrowRight className="size-3 shrink-0" strokeWidth={2} /> : <ArrowLeft className="size-3 shrink-0" strokeWidth={2} />}
                      <span className="truncate">
                        {side === "sent" ? "to" : "from"} <span className="font-medium text-foreground/80">{mateName}</span>
                      </span>
                    </p>
                  )}
                </td>
                <td className={cn(TD, "text-right")}>
                  <Amount transaction={t} presentation={presentation} withLabel size="lg" />
                </td>
                <td className={cn(TD, "hidden px-1.5 sm:table-cell md:hidden lg:table-cell")} onClick={(e) => e.stopPropagation()}>
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
                          assignedTo={assigneeFor(t)}
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

type RowTone = RowTreatment | "duplicate";

/** 2px deep-violet frame on every cell edge of a borrowed row (top/bottom on all cells, right on the last). */
const BORROWED_OUTLINE =
  "[&>td]:border-y-2 [&>td]:border-y-debt-strong [&>td:last-child]:border-r-2 [&>td:last-child]:border-r-debt-strong";

/**
 * Semantic row wash + leading edge. Edge = clearly visible; wash = a light tint of an existing theme
 * token (stronger alpha in dark mode, where the same tint reads fainter). Only Income is a filled green
 * row; a paid obligation is a neutral row with a thick success rail + ✓; a transfer is a neutral grey;
 * debt created is violet. Expense keeps its existing plain row. Tone comes from `getTransactionPresentation`.
 */
const ROW_TONE: Record<RowTone, { edge: string; rest: string; open: string }> = {
  income: {
    edge: "border-l-success",
    rest: "bg-success/[0.12] hover:bg-success/[0.18] dark:bg-success/[0.16] dark:hover:bg-success/[0.22]",
    open: "bg-success/[0.2] dark:bg-success/[0.24]",
  },
  expense: { edge: "border-l-transparent", rest: "hover:bg-secondary/70", open: "bg-secondary" },
  transfer: {
    edge: "border-l-muted-foreground",
    rest: "bg-foreground/[0.06] hover:bg-foreground/[0.09] dark:bg-foreground/[0.08] dark:hover:bg-foreground/[0.12]",
    open: "bg-foreground/[0.1] dark:bg-foreground/[0.13]",
  },
  // Loan/People cash IN (borrowed, received from person) — debt created: a clearly visible soft violet
  // surface (the old ~11% read as white on low-contrast FHD panels), never Income green.
  debt: {
    edge: "border-l-debt-border",
    rest: "bg-debt-surface hover:bg-debt-surface-hover",
    open: "bg-debt-surface-hover",
  },
  // Borrowed money in (People "Borrowed", Loan principal taken) — NOT income: a neutral row whose 2px
  // deep-violet OUTLINE is the signal (see `BORROWED_OUTLINE`), a slightly stronger left edge, and only
  // a faint inner tint. Badge, icon and "You need to repay" carry the meaning too.
  borrowed: {
    edge: "border-l-[4px] border-l-debt-strong",
    rest: "bg-debt-surface/[0.22] hover:bg-debt-surface/[0.4] dark:bg-debt-surface/[0.3] dark:hover:bg-debt-surface/[0.5]",
    open: "bg-debt-surface/[0.5]",
  },
  // A paid / reduced obligation (EMI, loan repayment, card bill, paid back to a person): a NEUTRAL row
  // with a thick, high-contrast success rail + the ✓ status chip — never Income's filled green. The wash
  // is only a whisper so the rail, icon and wording carry the meaning on low-contrast screens.
  settled: {
    edge: "border-l-[5px] border-l-success",
    rest: "bg-success/[0.035] hover:bg-secondary/70 dark:bg-success/[0.05]",
    open: "bg-secondary",
  },
  duplicate: { edge: "border-l-danger", rest: "bg-danger/[0.08] hover:bg-danger/[0.12]", open: "bg-danger/[0.14]" },
};

/** Type column tag — label + icon + tone, so meaning never rests on colour alone. Transfer legs read as
 *  "Sent"/"Received" in the neutral transfer tone, never as Income/Expense. */
function TypeTag({ transaction, presentation = getTransactionPresentation(transaction) }: { transaction: Transaction; presentation?: TransactionPresentation }) {
  const { row, label, detail } = presentation;
  if (row === "transfer") {
    return (
      <span className="inline-flex flex-col gap-0.5">
        <span className={cn(BADGE, "w-fit border-border-strong bg-secondary text-foreground")}>
          <ArrowLeftRight className="size-3" strokeWidth={2} aria-hidden />
          {label}
        </span>
        <span className="text-[11px] font-medium text-foreground/70">{detail}</span>
      </span>
    );
  }
  if (row === "settled") {
    // Neutral badge, success outline + ✓ — "an obligation was paid", not "money came in".
    return (
      <span className="inline-flex flex-col gap-0.5">
        <span className={cn(BADGE, "w-fit border-success/70 bg-card text-foreground")}>
          <CheckCircle2 className="size-3 text-success" strokeWidth={2.5} aria-hidden />
          {label}
        </span>
        <span className="text-[11px] font-medium text-foreground/75">{detail}</span>
      </span>
    );
  }
  if (row === "borrowed") {
    // Deep-violet outlined badge + inbound icon: "money received" — the amount column says it must be repaid.
    return (
      <span className="inline-flex flex-col gap-0.5">
        <span className={cn(BADGE, "w-fit border-debt-strong bg-card font-bold text-debt-strong")}>
          <ArrowDownLeft className="size-3" strokeWidth={2.5} aria-hidden />
          {label}
        </span>
        <span className="text-[11px] font-medium text-foreground/75">{detail}</span>
      </span>
    );
  }
  if (row === "debt") {
    return (
      <span className="inline-flex flex-col gap-0.5">
        <span className={cn(BADGE, "w-fit border-debt-border bg-card text-debt-text")}>
          <Landmark className="size-3" strokeWidth={2} aria-hidden />
          {label}
        </span>
        <span className="text-[11px] font-medium text-foreground/70">{detail}</span>
      </span>
    );
  }
  if (row === "income") {
    return (
      <span className={cn(BADGE, "border-success/50 bg-success/12 text-success")}>
        <ArrowDownLeft className="size-3" strokeWidth={2.25} aria-hidden />
        Income
      </span>
    );
  }
  return <span className="text-xs font-medium text-foreground/85">{label}</span>;
}

/**
 * Links two adjacent legs of one transfer (same `transferId`) with a dashed line drawn exactly on the
 * border between them and a "⇅ Transfer · From → To" badge in its centre. Rendered inside the first
 * row but positioned against the (relative) `<tr>`, zero-height, so it adds no row height and never
 * blocks clicks. Presentation only — each leg stays its own clickable row with its own actions.
 */
function TransferCenterLine({ route }: { route: string }) {
  return (
    <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex h-0 items-center gap-2 px-3">
      <span className="flex-1 border-t border-dashed border-border-strong" />
      <span className="inline-flex h-5 min-w-0 items-center gap-1.5 border border-border-strong bg-card px-2 text-[10.5px] font-medium whitespace-nowrap text-foreground/85">
        <ArrowUpDown className="size-3 shrink-0" strokeWidth={1.75} />
        Transfer
        <span className="hidden text-muted-foreground sm:inline">· {route}</span>
      </span>
      <span className="flex-1 border-t border-dashed border-border-strong" />
    </span>
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
  debt: {
    panel: "bg-debt-surface",
    chip: "border-debt-border bg-card text-debt-text",
    amount: "text-foreground",
    edge: "bg-debt-border",
    mark: "text-debt-text",
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
  purple: "bg-debt-surface text-debt-text",
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
  assignedTo,
  isDuplicate,
}: {
  row: TransactionRow;
  displayDescription: (t: Transaction) => string;
  onOpen: () => void;
  onDelete: () => void;
  isSplit: boolean;
  assignedTo: string | null;
  isDuplicate: boolean;
}) {
  const t = row.transaction;
  const flow = flowOf(t);
  const hero = FLOW_HERO[flow];
  const FlowIcon =
    flow === "in" || (flow === "debt" && t.type === "income") ? ArrowDownLeft : flow === "out" || flow === "debt" ? ArrowUpRight : ArrowLeftRight;
  return (
    <div className="px-3 pt-1 pb-3.5 sm:pr-4 sm:pl-[4.25rem]">
      <div className="flex flex-col overflow-hidden rounded-[12px] border border-border-strong/60 bg-card shadow-[0_1px_2px_rgb(0_0_0/0.05),0_6px_16px_-8px_rgb(0_0_0/0.12)] md:flex-row">
        {/* What happened — amount first, on a direction-tinted panel with an accent edge */}
        <div className={cn("relative flex flex-col gap-2.5 overflow-hidden border-b border-border-strong/40 py-4 pr-4 pl-5 md:w-80 md:shrink-0 md:border-r md:border-b-0", hero.panel)}>
          <span className={cn("absolute inset-y-0 left-0 w-1", hero.edge)} aria-hidden />
          <FlowIcon className={cn("pointer-events-none absolute -right-3 -bottom-4 size-28 opacity-[0.07]", hero.mark)} strokeWidth={1.5} aria-hidden />
          <span className={cn("relative inline-flex w-fit items-center gap-1 rounded-[5px] border px-1.5 py-0.5 text-[11px] font-semibold", hero.chip)}>
            <FlowIcon className="size-3" strokeWidth={2.25} aria-hidden />
            {flow === "debt" ? debtLabel(t) : FLOW_LABEL[flow]}
          </span>
          <p className={cn("relative font-heading text-[30px] leading-none font-bold tracking-tight tabular-nums", hero.amount)}>
            {flow === "in" || (flow === "debt" && t.type === "income") ? "+" : flow === "out" || flow === "debt" ? "−" : ""}
            {formatCurrency(t.amount)}
          </p>
          <div className="relative min-w-0">
            <p className="truncate text-[15px] font-semibold text-foreground">{displayDescription(t) || (t.transferId ? TRANSFER_SIDE_LABEL[transferSideOf(t)] : "(No description)")}</p>
            <p className="mt-1 flex items-center gap-1.5 text-xs font-medium text-foreground/70 tabular-nums">
              <Calendar className="size-3.5" strokeWidth={1.75} aria-hidden />
              {formatFullDate(t.dateTime, true)}
            </p>
          </div>
          <div className="relative">
            <TxnBadges transaction={t} isSplit={isSplit} assignedTo={assignedTo} isDuplicate={isDuplicate} />
          </div>
        </div>

        {/* Supporting facts — a 2×2 grid that fills the card's height */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="grid flex-1 grid-cols-1 sm:grid-cols-2">
            <Fact icon={Tag} label="Type" tone="purple">{TYPE_LABEL[flow]}</Fact>
            <Fact icon={Wallet} label="Account" tone="lime">{paidFromLabel(row.transaction, row.account?.name) ?? "Unknown"}</Fact>
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
