"use client";

import { AccountSelect } from "@/components/finance/account-label";
import { Stagger } from "@/components/foundation/animated-container";
import {
  Banknote,
  Briefcase,
  Calendar,
  ArrowRight,
  Check,
  CreditCard,
  Gift,
  Globe,
  Landmark,
  Layers,
  Loader2,
  Percent,
  Plus,
  RefreshCw,
  User,
  Wallet,
  X as XIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { transactionsHrefForAccount } from "@/features/transactions/lib/account-filter-param";
import { BankCombobox, DestructiveDeleteDialog, type DestructiveDeleteImpactRow } from "@/components/finance";
import { useGuardedSubmit } from "@/components/finance/use-guarded-submit";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AccountOverviewPanel } from "@/features/accounts/components/account-overview-panel";
import { AccountsHeader } from "@/features/accounts/components/accounts-header";
import { AccountsStats } from "@/features/accounts/components/accounts-stats";
import { AccountsToolbar } from "@/features/accounts/components/accounts-toolbar";
import { AccountTile } from "@/features/accounts/components/account-tile";
import { RecentAccountTransactions } from "@/features/accounts/components/recent-account-transactions";
import { ACCOUNT_COLOR } from "@/features/accounts/lib/account-colors";
import {
  ACCOUNT_COLOR_CYCLE,
  accountColorForColorValue,
  colorValueForAccountColor,
  useAccountActions,
  useAccountsOverview,
  type AccountDeletionImpact,
} from "@/features/accounts/hooks/use-accounts-data";
import { useCreditCardActions, type CreditCardDeletionImpact } from "@/features/credit-cards/hooks/use-credit-cards-data";
import { useAccounts } from "@/hooks/use-accounts";
import { useCreditCards } from "@/hooks/use-credit-cards";
import { useLinkedFunds } from "@/features/people/hooks/use-linked-funds";
import { linkedPendingForAccount } from "@/lib/engines/linked-funds";
import { bankById, GENERIC_BANK } from "@/lib/data/bank-registry";
import type { Account, AccountType, BankAccountSubtype, CardSubtype } from "@/lib/models/account";
import type { AccountColor } from "@/lib/mock/accounts-overview-data";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import { startOperation } from "@/store/operation-progress-store";
import { Skeleton } from "@/components/ui/skeleton";
import {
  availableCredit,
  buildSaveAction,
  fieldVisibilityFor,
  isDepositSubtype,
  validateAccountForm,
  type AccountFormInput,
} from "@/features/accounts/lib/account-product-rules";
import { DateInput } from "@/components/forms/date-input";
import { handleEnterAdvance } from "@/components/finance/enter-advance";
import { FormSection, LE_RADIUS, LOAN_EMI_INPUT, choiceClass } from "@/features/loans/components/loan-emi-ui";

const ACCOUNT_TYPE_OPTIONS: { value: AccountType; label: string; icon: LucideIcon }[] = [
  { value: "bank", label: "Bank", icon: Landmark },
  { value: "cash", label: "Cash", icon: Banknote },
  { value: "wallet", label: "Wallet", icon: Wallet },
  { value: "card", label: "Card", icon: CreditCard },
  { value: "business", label: "Business", icon: Briefcase },
  { value: "other", label: "Other", icon: Layers },
];

const BANK_ACCOUNT_SUBTYPE_OPTIONS: { value: BankAccountSubtype; label: string }[] = [
  { value: "savings", label: "Savings Account" },
  { value: "current", label: "Current Account" },
  { value: "salary", label: "Salary Account" },
  { value: "fixedDeposit", label: "Fixed Deposit (FD)" },
  { value: "recurringDeposit", label: "Recurring Deposit (RD)" },
  { value: "nre", label: "NRE Account" },
  { value: "nro", label: "NRO Account" },
  { value: "other", label: "Other" },
];

const CARD_SUBTYPE_OPTIONS: { value: CardSubtype; label: string; icon: LucideIcon }[] = [
  { value: "credit", label: "Credit Card", icon: CreditCard },
  { value: "debit", label: "Debit Card", icon: Wallet },
  { value: "prepaid", label: "Prepaid Card", icon: RefreshCw },
  { value: "forex", label: "Forex Card", icon: Globe },
  { value: "gift", label: "Gift Card", icon: Gift },
  { value: "other", label: "Other Card", icon: Layers },
];

/** Add/Edit account dialog — compact fields and choice chips in the Loan & EMI control style. */
const AC_INPUT = cn(LOAN_EMI_INPUT, "h-9");
const AC_FIELD = "flex min-w-0 flex-col gap-1";
const AC_LABEL = "text-xs font-medium text-foreground";
const AC_HINT = "text-[11px] leading-snug text-muted-foreground";
const AC_RUPEE = "pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-muted-foreground";
const AC_READONLY = "flex h-9 items-center rounded-[6px] border border-dashed border-border-strong bg-secondary px-3 text-sm font-semibold tabular-nums text-foreground";
const AC_CHOICE = "flex h-8 items-center gap-1 rounded-[6px] border px-2.5 text-xs outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none";
const AC_COMBOBOX =
  "h-9 rounded-[6px] border-border-strong bg-card transition-[border-color,box-shadow] duration-150 hover:border-muted-foreground focus:border-primary-accent-text focus:ring-2 focus:ring-ring dark:bg-input";

const CURRENCY_OPTIONS = ["USD", "EUR", "GBP", "AED", "SGD", "AUD", "JPY"];

interface AccountFormState {
  name: string;
  type: AccountType;
  bankId: string | null;
  bankAccountSubtype: BankAccountSubtype;
  cardSubtype: CardSubtype;
  cardProvider: string;
  linkedAccountId: string | null;
  reloadable: boolean;
  currency: string;
  openingBalance: string;
  creditLimit: string;
  currentUsed: string;
  statementDay: string;
  paymentDueDay: string;
  minimumBalance: string;
  interestRatePercent: string;
  maturityDate: string;
  tenureMonths: string;
  accountHolderName: string;
  accountNumberLast4: string;
  notes: string;
  color: AccountColor;
}

function emptyAccountForm(color: AccountColor): AccountFormState {
  return {
    name: "",
    type: "bank",
    bankId: null,
    bankAccountSubtype: "savings",
    cardSubtype: "credit",
    cardProvider: "",
    linkedAccountId: null,
    reloadable: true,
    currency: "USD",
    openingBalance: "",
    creditLimit: "",
    currentUsed: "",
    statementDay: "1",
    paymentDueDay: "15",
    minimumBalance: "",
    interestRatePercent: "",
    maturityDate: "",
    tenureMonths: "",
    accountHolderName: "",
    accountNumberLast4: "",
    notes: "",
    color,
  };
}

function accountFormFromAccount(account: Account): AccountFormState {
  return {
    name: account.name,
    type: account.type,
    bankId: account.bankId,
    bankAccountSubtype: account.bankAccountSubtype ?? "savings",
    cardSubtype: account.cardSubtype ?? "credit",
    cardProvider: account.cardProvider ?? "",
    linkedAccountId: account.linkedAccountId,
    reloadable: account.reloadable ?? true,
    currency: account.currency ?? "USD",
    openingBalance: String(account.openingBalance),
    creditLimit: "",
    currentUsed: "",
    statementDay: "1",
    paymentDueDay: "15",
    minimumBalance: account.minimumBalance != null ? String(account.minimumBalance) : "",
    interestRatePercent: account.interestRatePercent != null ? String(account.interestRatePercent) : "",
    maturityDate: account.maturityDate != null ? account.maturityDate.toISOString().slice(0, 10) : "",
    tenureMonths: account.tenureMonths != null ? String(account.tenureMonths) : "",
    accountHolderName: account.accountHolderName ?? "",
    accountNumberLast4: account.accountNumberLast4 ?? "",
    notes: account.notes ?? "",
    color: accountColorForColorValue(account.colorValue),
  };
}

export function AccountsWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState("");
  const [type, setType] = useState("All Types");
  const [view, setView] = useState<"grid" | "list">("grid");
  // `?account=<id>` reopens that account — so Back from its filtered Transactions lands where the user was.
  const [selectedId, setSelectedId] = useState<string | undefined>(() => searchParams.get("account") ?? undefined);
  const [overviewOpen, setOverviewOpen] = useState(true);

  const { items: accountsOverviewList, isLoading } = useAccountsOverview();
  const { data: rawAccounts = [] } = useAccounts();
  const { data: creditCards = [] } = useCreditCards();
  const actions = useAccountActions();
  const cardActions = useCreditCardActions();
  const { funds: linkedFunds } = useLinkedFunds();

  const [addOpen, setAddOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [deletingAccount, setDeletingAccount] = useState<Account | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deletionImpact, setDeletionImpact] = useState<AccountDeletionImpact | CreditCardDeletionImpact | null>(null);
  const [form, setForm] = useState<AccountFormState>(() => emptyAccountForm("blue"));
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Once a bank is picked (new account only), suggest its name as the Account Name so
  // most people never have to type one — but stop the moment they've typed their own,
  // so we never clobber a name someone intentionally chose (e.g. "HDFC Salary").
  const [nameAutoFillable, setNameAutoFillable] = useState(true);
  const nameInputRef = useRef<HTMLInputElement>(null);

  function openAdd() {
    // Defaults to the next unused color in the cycle, same idea as the credit card tiles'
    // accent — just a sensible starting point, not a lock-in; the picker below lets it be changed.
    setForm(emptyAccountForm(ACCOUNT_COLOR_CYCLE[accountsOverviewList.length % ACCOUNT_COLOR_CYCLE.length]!));
    setFormError(null);
    setNameAutoFillable(true);
    setAddOpen(true);
  }

  function openEdit(account: Account) {
    setEditingAccount(account);
    setForm(accountFormFromAccount(account));
    setFormError(null);
    setNameAutoFillable(false);
  }

  const submitAccount = useGuardedSubmit(handleSave, saving);

  async function handleSave() {
    if (!actions) return;

    const validated = validateAccountForm(form as AccountFormInput, !!editingAccount);
    if (!validated.ok) {
      setFormError(validated.error);
      return;
    }

    const action = buildSaveAction(form as AccountFormInput, validated, !!editingAccount, {
      colorValue: colorValueForAccountColor(form.color),
    });

    setSaving(true);
    setFormError(null);
    const op = startOperation(
      action.kind === "editAccount"
        ? { label: "Updating account", successLabel: "Account updated", errorLabel: "Couldn't update account" }
        : action.kind === "createCreditCard"
          ? { label: "Adding credit card", successLabel: "Card added", errorLabel: "Couldn't add card" }
          : { label: "Creating account", successLabel: "Account created", errorLabel: "Couldn't create account" },
    );
    try {
      op.stage("submit", action.kind === "editAccount" ? "Saving account" : "Saving account & opening balance");
      if (action.kind === "editAccount") {
        if (!editingAccount) return op.dismiss();
        await actions.editAccount(editingAccount, { ...action.params, notes: form.notes || null });
        setEditingAccount(null);
        op.succeed();
      } else if (action.kind === "createCreditCard") {
        if (!cardActions) return op.dismiss();
        await cardActions.createCard(action.params);
        setAddOpen(false);
        op.succeed();
      } else {
        await actions.createAccount({ ...action.params, notes: form.notes || null });
        setAddOpen(false);
        op.succeed();
      }
    } catch (e) {
      // The form keeps everything entered and shows why inline (the action also toasts) — the progress
      // surface just stops and steps aside rather than repeating the same failure.
      op.dismiss();
      setFormError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  // An Account of type "card" with cardSubtype "credit" always has exactly one linked
  // CreditCardProfile (see useCreditCardActions().createCard) — deleting it must go through
  // the credit-card-aware cascade (permanentlyDeleteCreditCardAndHistory), not the plain
  // account cascade, or the CreditCardProfile (plus its linked EMIs/statements/shared limit)
  // would be silently orphaned. Every other account type has no such linked record.
  const deletingCreditCard = deletingAccount
    ? creditCards.find((c) => c.accountId === deletingAccount.id)
    : undefined;

  useEffect(() => {
    if (!deletingAccount) return;
    let cancelled = false;
    if (deletingCreditCard) {
      if (!cardActions) return;
      cardActions.previewCardDeletion(deletingCreditCard).then((impact) => {
        if (!cancelled) setDeletionImpact(impact);
      });
    } else {
      if (!actions) return;
      actions.previewAccountDeletion(deletingAccount).then((impact) => {
        if (!cancelled) setDeletionImpact(impact);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [actions, cardActions, deletingAccount, deletingCreditCard]);

  const deletionImpactRows: DestructiveDeleteImpactRow[] | null = deletionImpact && [
    { label: `${deletionImpact.transactionCount} transaction${deletionImpact.transactionCount === 1 ? "" : "s"}`, count: deletionImpact.transactionCount },
    { label: `${deletionImpact.transferSiblingCount} linked transfer${deletionImpact.transferSiblingCount === 1 ? "" : "s"} on other accounts`, count: deletionImpact.transferSiblingCount },
    { label: `${deletionImpact.expenseCount} shared/assigned expense${deletionImpact.expenseCount === 1 ? "" : "s"}`, count: deletionImpact.expenseCount },
    { label: `${deletionImpact.affectedPersonCount} person${deletionImpact.affectedPersonCount === 1 ? "'s" : "s'"} balance will be recalculated`, count: deletionImpact.affectedPersonCount },
    { label: `${deletionImpact.billCount} bill${deletionImpact.billCount === 1 ? "" : "s"} paying from this account`, count: deletionImpact.billCount },
    ...("emiCount" in deletionImpact
      ? [
          { label: `${deletionImpact.emiCount} linked EMI${deletionImpact.emiCount === 1 ? "" : "s"}`, count: deletionImpact.emiCount },
          { label: `${deletionImpact.statementCount} statement${deletionImpact.statementCount === 1 ? "" : "s"}`, count: deletionImpact.statementCount },
          { label: "Shared credit limit will also be removed (no other card uses it)", count: deletionImpact.sharedLimitWillBeRemoved ? 1 : 0 },
        ]
      : []),
  ];

  async function handleDelete() {
    if (!deletingAccount) return;
    setDeleting(true);
    const op = startOperation(
      deletingCreditCard
        ? { label: "Deleting credit card", successLabel: "Card deleted", errorLabel: "Couldn't delete card" }
        : { label: "Deleting account", successLabel: "Account deleted", errorLabel: "Couldn't delete account" },
    );
    try {
      // One cascade: the account with its transactions, linked transfers and expenses.
      op.stage("submit", "Removing account & its history");
      if (deletingCreditCard) {
        if (!cardActions) return op.dismiss();
        await cardActions.deleteCard(deletingCreditCard);
      } else {
        if (!actions) return op.dismiss();
        await actions.deleteAccount(deletingAccount);
      }
      if (selectedId === deletingAccount.id) setSelectedId(undefined);
      setDeletingAccount(null);
      op.succeed();
    } catch {
      // Failed — the toast from useAccountActions/useCreditCardActions already explains why;
      // keep the dialog open so the user isn't left guessing whether the delete "did nothing".
      op.dismiss();
    } finally {
      setDeleting(false);
    }
  }

  function closeAccountDialog() {
    setAddOpen(false);
    setEditingAccount(null);
  }

  const selectedType = ACCOUNT_TYPE_OPTIONS.find((o) => o.value === form.type) ?? ACCOUNT_TYPE_OPTIONS[0];
  const SelectedTypeIcon = selectedType.icon;
  const selectedBank = bankById(form.bankId);
  const formBankSubtype = form.type === "bank" ? form.bankAccountSubtype : null;
  const formCardSubtype = form.type === "card" ? form.cardSubtype : null;
  const formIsDeposit = isDepositSubtype(formBankSubtype);
  const visibility = fieldVisibilityFor(form.type, formBankSubtype, formCardSubtype, !!editingAccount);
  const linkableBankAccounts = (rawAccounts as Account[]).filter((a) => a.type === "bank");

  // Credit-card accounts are managed in the Credit Cards section (statements, limits, payments).
  // Here they're split out of the money-you-have list into a compact strip so the bank/cash grid,
  // its count and the Total balance (which already excludes cards) all describe the same thing.
  const cardAccountIds = useMemo(() => new Set(creditCards.map((c) => c.accountId)), [creditCards]);
  const moneyAccounts = useMemo(
    () => accountsOverviewList.filter((a) => !cardAccountIds.has(a.id)),
    [accountsOverviewList, cardAccountIds],
  );
  const cardAccounts = useMemo(
    () => accountsOverviewList.filter((a) => cardAccountIds.has(a.id)),
    [accountsOverviewList, cardAccountIds],
  );

  // Type chips: only the types you actually hold, with counts (presentation; same filter value).
  const accountTypeChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of moneyAccounts) counts.set(a.typeLabel, (counts.get(a.typeLabel) ?? 0) + 1);
    return [...counts].map(([label, count]) => ({ label, count }));
  }, [moneyAccounts]);

  const filtered = useMemo(() => {
    return moneyAccounts.filter((account) => {
      const matchesSearch = account.name.toLowerCase().includes(search.toLowerCase());
      const matchesType = type === "All Types" || account.typeLabel === type;
      return matchesSearch && matchesType;
    });
  }, [moneyAccounts, search, type]);

  // Default the selected account once the live list arrives (mirrors the
  // mock's "primary account, else first" default) without fighting the
  // user's own selection on later re-renders.
  const defaultId = accountsOverviewList.find((a) => a.isPrimary)?.id ?? accountsOverviewList[0]?.id;
  const effectiveId = selectedId ?? defaultId;
  const selected = accountsOverviewList.find((a) => a.id === effectiveId);

  if (isLoading) {
    return (
      <div className="flex min-w-0 flex-col gap-5 px-1">
        <AccountsHeader />
        <Skeleton className="h-24 rounded-[10px]" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-36 rounded-[10px]" />
          ))}
        </div>
      </div>
    );
  }

  const addTile = (
    <button
      type="button"
      onClick={openAdd}
      className={cn(
        "group/add flex items-center justify-center gap-2.5 border-dashed border-border-strong text-foreground/60 transition-[background,border-color,color,transform] duration-200 hover:border-primary-accent-text hover:bg-gradient-to-br hover:from-primary/20 hover:to-primary/5 hover:text-foreground",
        view === "grid" ? "min-h-36 flex-col rounded-[14px] border-2 py-6" : "border-t px-4 py-3",
      )}
    >
      <span className="flex size-10 items-center justify-center rounded-full border-2 border-dashed border-current transition-transform duration-200 group-hover/add:scale-110 group-hover/add:rotate-90">
        <Plus className="size-4.5" />
      </span>
      <span className="flex flex-col text-center">
        <span className="text-sm font-semibold">Add account</span>
        {view === "grid" && <span className="text-xs">Bank, card, wallet or cash</span>}
      </span>
    </button>
  );

  return (
    <div className="flex min-w-0 flex-col gap-5 px-1 lg:flex-row lg:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-5">
        <AccountsHeader onAdd={openAdd} />
        <AccountsStats accountCount={moneyAccounts.length} />

        <section aria-label="My accounts" className="flex flex-col gap-3">
          <AccountsToolbar
            count={moneyAccounts.length}
            search={search}
            onSearchChange={setSearch}
            type={type}
            onTypeChange={setType}
            view={view}
            onViewChange={setView}
            types={accountTypeChips}
          />

          {moneyAccounts.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed border-border-strong bg-card py-12 text-center">
              <p className="font-heading text-base font-semibold text-foreground">No accounts yet</p>
              <p className="text-sm text-muted-foreground">Add your first bank, wallet or cash account to get started.</p>
              <button
                type="button"
                onClick={openAdd}
                className="mt-2 flex h-9 items-center gap-1.5 rounded-[6px] border border-primary-accent-text bg-primary px-3.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                <Plus className="size-4" strokeWidth={2.25} />
                Add Account
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-[10px] border border-border-strong/60 bg-card py-10 text-center">
              <p className="text-sm font-semibold text-foreground">No accounts match this search or type.</p>
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setType("All Types");
                }}
                className="text-sm font-semibold text-primary-accent-text hover:underline"
              >
                Clear filters
              </button>
            </div>
          ) : view === "grid" ? (
            <Stagger className="grid grid-cols-1 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]">
              {filtered.map((account) => (
                <AccountTile
                  key={account.id}
                  account={account}
                  active={account.id === effectiveId}
                  onSelect={() => {
                    setSelectedId(account.id);
                    setOverviewOpen(true);
                  }}
                />
              ))}
              {addTile}
            </Stagger>
          ) : (
            <div className="flex flex-col divide-y divide-border-strong/40 overflow-hidden rounded-[14px] border border-border-strong/60 bg-card shadow-e1">
              {filtered.map((account) => (
                <AccountTile
                  key={account.id}
                  variant="list"
                  account={account}
                  active={account.id === effectiveId}
                  onSelect={() => {
                    setSelectedId(account.id);
                    setOverviewOpen(true);
                  }}
                />
              ))}
              {addTile}
            </div>
          )}
        </section>

        {cardAccounts.length > 0 && (
          <section aria-label="Credit cards" className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <h2 className="inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                <CreditCard className="size-3.5 text-foreground" strokeWidth={1.75} />
                Credit cards · {cardAccounts.length}
              </h2>
              <Link
                href="/credit-cards"
                className="inline-flex items-center gap-1 text-xs font-semibold text-primary-accent-text hover:underline"
              >
                Manage in Credit Cards
                <ArrowRight className="size-3.5" />
              </Link>
            </div>
            <p className="text-xs text-muted-foreground">
              Card balances are what you owe, so they aren&apos;t counted in Total balance. Statements, limits and payments live in Credit Cards.
            </p>
            <div className="flex flex-col divide-y divide-border-strong/40 overflow-hidden rounded-[10px] border border-border-strong/70 bg-card shadow-e1">
              {cardAccounts.map((card) => {
                const owed = Math.max(0, -card.balance);
                return (
                  <button
                    key={card.id}
                    type="button"
                    onClick={() => {
                      setSelectedId(card.id);
                      setOverviewOpen(true);
                    }}
                    className={cn(
                      "flex items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-secondary",
                      card.id === effectiveId && overviewOpen && "bg-primary/10",
                    )}
                  >
                    <span
                      className={cn("flex size-8 shrink-0 items-center justify-center rounded-[8px] border border-black/10", ACCOUNT_COLOR[card.color].onGradient)}
                      style={{ background: ACCOUNT_COLOR[card.color].gradient }}
                    >
                      <CreditCard className="size-4" strokeWidth={1.75} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-foreground">{card.name}</span>
                      {card.mask && <span className="block text-xs text-muted-foreground">•••• {card.mask}</span>}
                    </span>
                    <span className="flex flex-col items-end">
                      <span className="text-[11px] text-muted-foreground">Outstanding</span>
                      <span className={cn("text-sm font-semibold tabular-nums", owed > 0 ? "text-expense" : "text-foreground")}>
                        {formatCurrency(owed)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <RecentAccountTransactions />
      </div>

      {overviewOpen && selected && (
        <AccountOverviewPanel
          account={selected}
          linkedFunds={linkedPendingForAccount(linkedFunds, selected.id)}
          onClose={() => setOverviewOpen(false)}
          onViewTransactions={() => {
            router.replace(`/accounts?account=${encodeURIComponent(selected.id)}`, { scroll: false });
            router.push(transactionsHrefForAccount(selected.id));
          }}
          onEdit={() => {
            const raw = (rawAccounts as Account[]).find((a) => a.id === selected.id);
            if (raw) openEdit(raw);
          }}
          onDelete={() => {
            const raw = (rawAccounts as Account[]).find((a) => a.id === selected.id);
            if (raw) {
              setDeletionImpact(null);
              setDeletingAccount(raw);
            }
          }}
        />
      )}

      <Dialog open={addOpen || editingAccount != null} onOpenChange={(open) => !open && closeAccountDialog()}>
        <DialogContent
          showCloseButton={false}
          // Open on the name field (the colour picker sits above it in the DOM).
          onOpenAutoFocus={(e) => {
            if (nameInputRef.current) {
              e.preventDefault();
              nameInputRef.current.focus();
            }
          }}
          overlayClassName="bg-black/20 backdrop-blur-none dark:bg-black/45"
          className={cn(
            "flex flex-col gap-0 overflow-hidden bg-card p-0 ring-0",
            // Right-side drawer (same experience as Add Transaction): slides in from the edge over the current screen, full height.
            "top-0 right-0 left-auto h-dvh max-h-dvh w-full max-w-full translate-x-0 translate-y-0 rounded-none border-0 border-l border-border-strong",
            "shadow-[-24px_0_60px_-20px_rgba(0,0,0,0.45)] duration-300 ease-out data-open:slide-in-from-right data-closed:slide-out-to-right data-closed:duration-200",
            "sm:max-w-[620px] sm:rounded-l-[16px] sm:transition-[max-width]",
          )}
        >
          <DialogHeader className="flex shrink-0 flex-row items-center gap-3 border-b border-border bg-gradient-to-b from-primary/25 via-primary/[0.07] to-transparent pt-5 pr-14 pb-4 pl-5 text-left sm:pl-6">
            <span className={cn(LE_RADIUS.control, "flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-primary text-primary-foreground shadow-[0_6px_14px_-6px_rgba(0,0,0,0.35)]")}>
              <Landmark className="size-4" strokeWidth={2} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0">
              <DialogTitle className="font-heading text-base leading-tight font-semibold tracking-tight">
                {editingAccount ? `Edit ${editingAccount.name}` : "Add an Account"}
              </DialogTitle>
              {!editingAccount && (
                <DialogDescription className="truncate text-xs text-muted-foreground">Track balances and transactions.</DialogDescription>
              )}
            </div>
          </DialogHeader>

          {/* Real <form> (display: contents keeps the layout): Enter in a single-line field saves via the same handler as the primary button. */}
          <form className="contents" noValidate onSubmit={submitAccount} onKeyDown={handleEnterAdvance}>
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain scroll-smooth scroll-pt-4 scroll-pb-24 bg-card px-5 py-5 text-sm sm:px-6 [&>*+*]:border-t [&>*+*]:border-border [&>*+*]:pt-5">
            {/* Live preview with the colour picker beside it — what you pick is what you see. */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className={cn(LE_RADIUS.card, "flex min-w-0 items-center gap-3 border border-border bg-secondary px-3 py-2.5 sm:w-60 sm:shrink-0")}>
                <span
                  className={cn(LE_RADIUS.card, "flex size-10 shrink-0 items-center justify-center border border-black/10 shadow-e1", ACCOUNT_COLOR[form.color].onGradient)}
                  style={{ background: ACCOUNT_COLOR[form.color].gradient }}
                >
                  <SelectedTypeIcon className="size-5" strokeWidth={1.75} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-foreground">{form.name.trim() || "Account Name"}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {form.type === "bank" && selectedBank ? selectedBank.name : selectedType.label}
                    {form.accountNumberLast4 ? ` • •••• ${form.accountNumberLast4}` : ""}
                  </p>
                </div>
              </div>

              <div className="flex min-w-0 flex-col gap-1.5">
                <span className={AC_LABEL}>Colour</span>
                <div className="flex flex-wrap gap-1.5">
                  {ACCOUNT_COLOR_CYCLE.map((c) => {
                    const selected = form.color === c;
                    return (
                      <button
                        key={c}
                        type="button"
                        aria-label={c}
                        aria-pressed={selected}
                        onClick={() => setForm((f) => ({ ...f, color: c }))}
                        className={cn(
                          "flex size-6 items-center justify-center rounded-full shadow-e1 outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring",
                          selected && "ring-2 ring-primary-accent-text ring-offset-2 ring-offset-card",
                        )}
                        style={{ background: ACCOUNT_COLOR[c].gradient }}
                      >
                        {selected && <Check className={cn("size-3.5", ACCOUNT_COLOR[c].onGradient)} strokeWidth={2.5} />}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <FormSection title="Account details" icon={Wallet} className="gap-3">
              <label className={AC_FIELD}>
                <span className={AC_LABEL}>
                  Account Name <span className="text-expense">*</span>
                </span>
                <div className="relative">
                  <SelectedTypeIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.75} />
                  <input
                    ref={nameInputRef}
                    className={cn(AC_INPUT, "pl-9")}
                    placeholder={form.bankId === GENERIC_BANK.id ? "Type your bank's name" : "e.g. HDFC Savings"}
                    value={form.name}
                    onChange={(e) => {
                      setNameAutoFillable(false);
                      setForm((f) => ({ ...f, name: e.target.value }));
                    }}
                  />
                </div>
              </label>

              <div className={AC_FIELD}>
                <span className={AC_LABEL}>
                  Account Type <span className="text-expense">*</span>
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {ACCOUNT_TYPE_OPTIONS.map((o) => {
                    const selected = form.type === o.value;
                    const Icon = o.icon;
                    return (
                      <button
                        key={o.value}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setForm((f) => ({ ...f, type: o.value, bankId: o.value === "bank" ? f.bankId : null }))}
                        className={cn(AC_CHOICE, choiceClass(selected))}
                      >
                        <Icon className="size-3.5" strokeWidth={selected ? 2.25 : 1.75} />
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {form.type === "bank" && (
                <label className={AC_FIELD}>
                  <span className={AC_LABEL}>Bank</span>
                  <BankCombobox
                    value={form.bankId}
                    onChange={(bankId) => {
                      const bank = bankById(bankId);
                      const isGeneric = bankId === GENERIC_BANK.id;
                      if (!nameAutoFillable) {
                        setForm((f) => ({ ...f, bankId }));
                        return;
                      }
                      // A real bank's name is a good name suggestion; "Other / Generic Bank" isn't —
                      // clear the field instead and focus it so the user can type their bank's real name.
                      setForm((f) => ({ ...f, bankId, name: isGeneric ? "" : (bank?.name ?? f.name) }));
                      if (isGeneric) requestAnimationFrame(() => nameInputRef.current?.focus());
                    }}
                    placeholder="Search for your bank…"
                    className={AC_COMBOBOX}
                  />
                </label>
              )}

              {form.type === "bank" && (
                <div className={AC_FIELD}>
                  <span className={AC_LABEL}>Bank Account Type</span>
                  <div className="flex flex-wrap gap-1.5">
                    {BANK_ACCOUNT_SUBTYPE_OPTIONS.map((o) => {
                      const selected = form.bankAccountSubtype === o.value;
                      return (
                        <button
                          key={o.value}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => setForm((f) => ({ ...f, bankAccountSubtype: o.value }))}
                          className={cn(AC_CHOICE, choiceClass(selected))}
                        >
                          {selected && <Check className="size-3.5" strokeWidth={2.5} />}
                          {o.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {form.type === "card" && (
                <div className={AC_FIELD}>
                  <span className={AC_LABEL}>What type of card is this?</span>
                  <div className="flex flex-wrap gap-1.5">
                    {CARD_SUBTYPE_OPTIONS.map((o) => {
                      const selected = form.cardSubtype === o.value;
                      const Icon = o.icon;
                      return (
                        <button
                          key={o.value}
                          type="button"
                          aria-pressed={selected}
                          disabled={!!editingAccount}
                          onClick={() => setForm((f) => ({ ...f, cardSubtype: o.value }))}
                          className={cn(
                            AC_CHOICE,
                            choiceClass(selected),
                            !!editingAccount && "cursor-not-allowed opacity-60 hover:border-border-strong hover:bg-card",
                          )}
                        >
                          <Icon className="size-3.5" strokeWidth={selected ? 2.25 : 1.75} />
                          {o.label}
                        </button>
                      );
                    })}
                  </div>
                  {editingAccount && (
                    <span className={AC_HINT}>Card type can&apos;t be changed after creation.</span>
                  )}
                </div>
              )}

              {form.type === "card" && (visibility.bankCombobox || visibility.cardProvider || visibility.linkedBankAccount) && (
                <div className="grid grid-cols-1 gap-x-3 gap-y-2.5 sm:grid-cols-2">
                  {visibility.bankCombobox && (
                    <label className={AC_FIELD}>
                      <span className={AC_LABEL}>Issuing Bank / Provider</span>
                      <BankCombobox
                        value={form.bankId}
                        onChange={(bankId) => setForm((f) => ({ ...f, bankId }))}
                        placeholder="Search for your bank…"
                        className={AC_COMBOBOX}
                      />
                    </label>
                  )}

                  {visibility.cardProvider && (
                    <label className={AC_FIELD}>
                      <span className={AC_LABEL}>Provider</span>
                      <input
                        className={AC_INPUT}
                        placeholder="e.g. Amazon Pay, Niyo, HDFC"
                        value={form.cardProvider}
                        onChange={(e) => setForm((f) => ({ ...f, cardProvider: e.target.value }))}
                      />
                    </label>
                  )}

                  {visibility.linkedBankAccount && (
                    <label className={AC_FIELD}>
                      <span className={AC_LABEL}>Linked Bank Account</span>
                      <AccountSelect
                        className={AC_INPUT}
                        accounts={linkableBankAccounts}
                        value={form.linkedAccountId ?? ""}
                        onChange={(id) => setForm((f) => ({ ...f, linkedAccountId: id || null }))}
                        placeholder="Select a bank account…"
                      />
                      {linkableBankAccounts.length === 0 && (
                        <span className={AC_HINT}>Add a bank account first to link a debit card to it.</span>
                      )}
                    </label>
                  )}
                </div>
              )}

              {visibility.accountHolderOrCardholder && (
                <div className="grid grid-cols-1 gap-x-3 gap-y-2.5 sm:grid-cols-2">
                  <label className={AC_FIELD}>
                    <span className={AC_LABEL}>
                      {form.type === "card" ? "Card Holder Name" : "Account Holder"} <span className="text-expense">*</span>
                    </span>
                    <div className="relative">
                      <User className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.75} />
                      <input
                        className={cn(AC_INPUT, "pl-9")}
                        value={form.accountHolderName}
                        onChange={(e) => setForm((f) => ({ ...f, accountHolderName: e.target.value }))}
                      />
                    </div>
                  </label>
                  <label className={AC_FIELD}>
                    <span className={AC_LABEL}>
                      {form.type === "card" ? "Card Number (Last 4 Digits)" : "Last 4 Digits"} <span className="text-expense">*</span>
                    </span>
                    <input
                      className={cn(AC_INPUT, "font-mono tracking-widest")}
                      placeholder="4021"
                      maxLength={4}
                      value={form.accountNumberLast4}
                      onChange={(e) => setForm((f) => ({ ...f, accountNumberLast4: e.target.value.replace(/\D/g, "") }))}
                    />
                  </label>
                </div>
              )}
            </FormSection>

            {((form.type !== "card" && visibility.openingBalance) ||
              (form.type === "card" &&
                (visibility.creditLimit ||
                  visibility.openingBalance ||
                  (visibility.currentBalanceReadOnly && !!editingAccount) ||
                  visibility.reloadable ||
                  visibility.currency)) ||
              (form.type === "bank" && (visibility.minimumBalance || visibility.depositFields))) && (
              <FormSection title={form.type === "card" ? "Limit & balance" : "Balance"} icon={Banknote} className="gap-3">
                {((form.type !== "card" && visibility.openingBalance) || (form.type === "bank" && visibility.minimumBalance)) && (
                  <div className="grid grid-cols-1 gap-x-3 gap-y-2.5 sm:grid-cols-2">
                    {/* Already narrowed to a non-card type by the condition above. */}
                    {visibility.openingBalance && (
                      <label className={AC_FIELD}>
                        <span className={AC_LABEL}>{formIsDeposit ? "Deposit Amount" : "Opening Balance"}</span>
                        <div className="relative">
                          <span className={AC_RUPEE}>₹</span>
                          <input
                            type="number"
                            className={cn(AC_INPUT, "pl-7 font-semibold tabular-nums")}
                            placeholder="0.00"
                            value={form.openingBalance}
                            onChange={(e) => setForm((f) => ({ ...f, openingBalance: e.target.value }))}
                          />
                        </div>
                      </label>
                    )}

                    {form.type === "bank" && visibility.minimumBalance && (
                      <label className={AC_FIELD}>
                        <span className={AC_LABEL}>Minimum Balance (optional)</span>
                        <div className="relative">
                          <span className={AC_RUPEE}>₹</span>
                          <input
                            type="number"
                            className={cn(AC_INPUT, "pl-7 tabular-nums")}
                            placeholder="0.00"
                            value={form.minimumBalance}
                            onChange={(e) => setForm((f) => ({ ...f, minimumBalance: e.target.value }))}
                          />
                        </div>
                      </label>
                    )}
                  </div>
                )}

                {form.type === "bank" && visibility.depositFields && (
                  <div className="grid grid-cols-1 gap-x-3 gap-y-2.5 sm:grid-cols-3">
                    <label className={AC_FIELD}>
                      <span className={AC_LABEL}>Interest Rate (% p.a.)</span>
                      <div className="relative">
                        <Percent className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.75} />
                        <input
                          type="number"
                          step="0.01"
                          className={cn(AC_INPUT, "pl-9")}
                          placeholder="e.g. 7.1"
                          value={form.interestRatePercent}
                          onChange={(e) => setForm((f) => ({ ...f, interestRatePercent: e.target.value }))}
                        />
                      </div>
                    </label>
                    <label className={AC_FIELD}>
                      <span className={AC_LABEL}>Tenure (months)</span>
                      <input
                        type="number"
                        className={AC_INPUT}
                        placeholder="e.g. 12"
                        value={form.tenureMonths}
                        onChange={(e) => setForm((f) => ({ ...f, tenureMonths: e.target.value }))}
                      />
                    </label>
                    <label className={AC_FIELD}>
                      <span className={AC_LABEL}>Maturity Date</span>
                      <div className="relative">
                        <Calendar className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.75} />
                        <DateInput
                          className={cn(AC_INPUT, "pl-9")}
                          value={form.maturityDate}
                          onChange={(e) => setForm((f) => ({ ...f, maturityDate: e.target.value }))}
                        />
                      </div>
                    </label>
                  </div>
                )}

                {form.type === "card" && visibility.creditLimit && (
                  <div className="grid grid-cols-1 gap-x-3 gap-y-2.5 sm:grid-cols-3">
                    <label className={AC_FIELD}>
                      <span className={AC_LABEL}>Credit Limit</span>
                      <div className="relative">
                        <span className={AC_RUPEE}>₹</span>
                        <input
                          type="number"
                          className={cn(AC_INPUT, "pl-7 font-semibold tabular-nums")}
                          placeholder="0.00"
                          value={form.creditLimit}
                          onChange={(e) => setForm((f) => ({ ...f, creditLimit: e.target.value }))}
                        />
                      </div>
                    </label>
                    <label className={AC_FIELD}>
                      <span className={AC_LABEL}>Used / Outstanding (optional)</span>
                      <div className="relative">
                        <span className={AC_RUPEE}>₹</span>
                        <input
                          type="number"
                          className={cn(AC_INPUT, "pl-7 tabular-nums")}
                          placeholder="0.00"
                          value={form.currentUsed}
                          onChange={(e) => setForm((f) => ({ ...f, currentUsed: e.target.value }))}
                        />
                      </div>
                    </label>
                    <div className={AC_FIELD} title="Calculated as Credit Limit − Current Used, never entered directly.">
                      <span className={AC_LABEL}>Available Credit</span>
                      <p className={AC_READONLY}>
                        ₹{availableCredit(Number(form.creditLimit) || 0, Number(form.currentUsed) || 0).toLocaleString("en-IN")}
                      </p>
                    </div>
                    <label className={AC_FIELD}>
                      <span className={AC_LABEL}>Statement Day (optional)</span>
                      <input
                        type="number"
                        min={1}
                        max={31}
                        className={AC_INPUT}
                        placeholder="e.g. 1"
                        value={form.statementDay}
                        onChange={(e) => setForm((f) => ({ ...f, statementDay: e.target.value }))}
                      />
                    </label>
                    <label className={AC_FIELD}>
                      <span className={AC_LABEL}>Payment Due Day (optional)</span>
                      <input
                        type="number"
                        min={1}
                        max={31}
                        className={AC_INPUT}
                        placeholder="e.g. 15"
                        value={form.paymentDueDay}
                        onChange={(e) => setForm((f) => ({ ...f, paymentDueDay: e.target.value }))}
                      />
                    </label>
                    <p className={cn(AC_HINT, "self-end pb-1 sm:col-span-1")}>
                      Available = Limit − Used. Days of month can be changed later from Credit Cards.
                    </p>
                  </div>
                )}

                {form.type === "card" && (visibility.openingBalance || (visibility.currentBalanceReadOnly && editingAccount) || visibility.currency) && (
                  <div className="grid grid-cols-1 gap-x-3 gap-y-2.5 sm:grid-cols-2">
                    {visibility.openingBalance && (
                      <label className={AC_FIELD}>
                        <span className={AC_LABEL}>Initial Balance</span>
                        <div className="relative">
                          <span className={AC_RUPEE}>₹</span>
                          <input
                            type="number"
                            className={cn(AC_INPUT, "pl-7 font-semibold tabular-nums")}
                            placeholder="0.00"
                            value={form.openingBalance}
                            onChange={(e) => setForm((f) => ({ ...f, openingBalance: e.target.value }))}
                          />
                        </div>
                        <span className={AC_HINT}>Current balance starts equal to this and updates as the card is used.</span>
                      </label>
                    )}

                    {visibility.currentBalanceReadOnly && editingAccount && (
                      <div className={AC_FIELD}>
                        <span className={AC_LABEL}>Current Balance</span>
                        <p className={AC_READONLY}>₹{editingAccount.currentBalance.toLocaleString("en-IN")}</p>
                        <span className={AC_HINT}>Tracked automatically from this card&apos;s transactions — not editable here.</span>
                      </div>
                    )}

                    {visibility.currency && (
                      <label className={AC_FIELD}>
                        <span className={AC_LABEL}>Currency</span>
                        <select
                          className={AC_INPUT}
                          value={form.currency}
                          onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
                        >
                          {CURRENCY_OPTIONS.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                )}

                {form.type === "card" && visibility.reloadable && (
                  <label
                    className={cn(
                      LE_RADIUS.card,
                      "flex cursor-pointer items-center gap-2 border px-3 py-2 transition-colors",
                      form.reloadable ? "border-primary-accent-text" : "border-border-strong",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-current"
                      checked={form.reloadable}
                      onChange={(e) => setForm((f) => ({ ...f, reloadable: e.target.checked }))}
                    />
                    <span className="text-[13px] font-medium text-foreground">Reloadable (can be topped up again)</span>
                  </label>
                )}
              </FormSection>
            )}

            {formError && (
              <p className={cn(LE_RADIUS.control, "flex items-center gap-1.5 border border-expense/40 bg-expense/8 px-3 py-2 text-xs font-medium text-expense")}>
                {formError}
              </p>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-card px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:rounded-bl-[16px] sm:px-6 sm:pb-3">
            <ClayButton variant="secondary" className="h-10 rounded-[8px] border-border-strong px-4 font-medium" onClick={closeAccountDialog} disabled={saving}>
              Cancel
            </ClayButton>
            <ClayButton
              type="submit"
              variant="primary"
              className="h-10 min-w-36 flex-1 gap-1.5 rounded-[8px] border-primary-accent-text font-semibold sm:flex-none"
              disabled={saving}
              aria-busy={saving}
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              {saving ? "Saving…" : editingAccount ? "Save Changes" : "Save"}
            </ClayButton>
          </div>
          </form>
          {/* Close sits last in the DOM (absolutely positioned top-right, so visually unchanged): focus opens on the
              first field and Tab ends on Close instead of starting there. */}
          <button
            type="button"
            onClick={closeAccountDialog}
            aria-label="Close"
            className={cn(
              LE_RADIUS.control,
              "absolute top-5 right-4 flex size-8 items-center justify-center border border-transparent text-muted-foreground outline-none transition-colors duration-150 hover:border-border hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <XIcon className="size-4" strokeWidth={1.75} />
          </button>
        </DialogContent>
      </Dialog>

      <DestructiveDeleteDialog
        open={deletingAccount != null}
        onOpenChange={(open) => !open && setDeletingAccount(null)}
        entityLabel="account"
        entityName={deletingAccount?.name ?? "this account"}
        impact={deletionImpactRows}
        onConfirm={handleDelete}
        confirming={deleting}
      />
    </div>
  );
}
