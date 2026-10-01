"use client";

import {
  ArrowRight,
  CalendarClock,
  CreditCard as CreditCardIcon,
  Download,
  FileText,
  LayoutGrid,
  Link2,
  List,
  MoreHorizontal,
  PieChart as PieChartIcon,
  Plus,
  Receipt,
  RefreshCw,
  Settings,
  Settings2,
  ShieldCheck,
  ShoppingBag,
  User,
  Wallet,
  Wifi,
  X as XIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { ClayButton } from "@/components/clay/clay-button";
import { transactionsHrefForAccount } from "@/features/transactions/lib/account-filter-param";
import { Stagger } from "@/components/foundation/animated-container";
import {
  BankCombobox,
  DestructiveDeleteDialog,
  SectionLabel,
  type DestructiveDeleteImpactRow,
} from "@/components/finance";
import { useGuardedSubmit } from "@/components/finance/use-guarded-submit";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useAccounts } from "@/hooks/use-accounts";
import { useSharedCreditLimits } from "@/hooks/use-credit-cards";
import { LinkedFundsPayNotice } from "@/features/people/components/linked-funds";
import { useLinkedFunds } from "@/features/people/hooks/use-linked-funds";
import { linkedPendingForCard } from "@/lib/engines/linked-funds";
import type { Account } from "@/lib/models/account";
import type { CardNetwork } from "@/lib/models/credit-card";
import { formatCurrency } from "@/lib/format";
import {
  ACCENT_CYCLE,
  useCardTransactions,
  useCreditCardActions,
  useCreditCardTotals,
  useCreditCardViewItems,
  useRecentCreditCardTransactions,
  type CreditCardDeletionImpact,
  type CreditCardViewItem,
} from "@/features/credit-cards/hooks/use-credit-cards-data";
import { CARD_GRADIENT, CreditCardTile } from "@/features/credit-cards/components/credit-card-tile";
import { TransactionDetailsModal } from "@/features/transactions/components/transaction-details-modal";
import { useTransactionActions, useTransactionRows } from "@/features/transactions/hooks/use-transactions-data";
import { usePeople } from "@/hooks/use-people";
import { toast } from "@/store/toast-store";
import { startOperation } from "@/store/operation-progress-store";
import { errorDetail } from "@/lib/operation-progress/operation-progress";
import { cn } from "@/lib/utils";
import { handleEnterAdvance } from "@/components/finance/enter-advance";

const CARD_NETWORK_OPTIONS: CardNetwork[] = ["visa", "mastercard", "rupay", "amex"];

type LimitSource = "own" | "newShared" | "existingShared";

interface CardFormState {
  name: string;
  cardHolderName: string;
  creditLimit: string;
  lastFourDigits: string;
  cardNetwork: CardNetwork | "";
  statementDay: string;
  paymentDueDay: string;
  bankId: string | null;
  limitSource: LimitSource;
  sharedLimitName: string;
  sharedLimitAmount: string;
  selectedSharedLimitId: string | null;
}

function emptyCardForm(): CardFormState {
  return {
    name: "",
    cardHolderName: "",
    creditLimit: "",
    lastFourDigits: "",
    cardNetwork: "",
    statementDay: "1",
    paymentDueDay: "15",
    bankId: null,
    limitSource: "own",
    sharedLimitName: "",
    sharedLimitAmount: "",
    selectedSharedLimitId: null,
  };
}

function cardFormFromCard(card: CreditCardViewItem, accounts: Account[]): CardFormState {
  const account = accounts.find((a) => a.id === card.card.accountId);
  return {
    name: card.name,
    cardHolderName: card.card.cardHolderName ?? "",
    creditLimit: String(card.creditLimit),
    lastFourDigits: card.last4 === "----" ? "" : card.last4,
    cardNetwork: (card.card.cardNetwork as CardNetwork | null) ?? "",
    statementDay: String(card.card.statementDay),
    paymentDueDay: String(card.card.paymentDueDay),
    bankId: account?.bankId ?? null,
    limitSource: card.card.sharedLimitId ? "existingShared" : "own",
    sharedLimitName: "",
    sharedLimitAmount: "",
    selectedSharedLimitId: card.card.sharedLimitId ?? null,
  };
}

/**
 * Real `Transaction.type` only distinguishes Income/Expense (see the doc
 * comment atop `use-credit-cards-data.ts` for why a richer fixed category
 * set like the mock's isn't invented here).
 */
const CATEGORY_TONE: Record<string, "primary" | "success" | "warning" | "purple" | "expense" | "neutral"> = {
  Income: "success",
  Expense: "expense",
};

const CATEGORY_CHART_COLOR: Record<string, string> = {
  primary: "var(--primary)",
  success: "var(--success)",
  warning: "var(--warning)",
  purple: "var(--purple)",
  expense: "var(--expense)",
  neutral: "var(--muted-foreground)",
};

const TONE_ICON_CLASS: Record<string, string> = {
  neutral: "bg-muted text-muted-foreground",
  primary: "bg-primary/12 text-primary-accent-text",
  success: "bg-success/15 text-success",
  expense: "bg-expense/12 text-expense",
  warning: "bg-warning/20 text-warning-foreground",
  purple: "bg-purple/15 text-purple",
};

const CATEGORY_ICON: Record<string, LucideIcon> = {
  Income: Wallet,
  Expense: Receipt,
};

function categoryTone(category: string) {
  return CATEGORY_TONE[category] ?? "neutral";
}

function daysUntil(date: Date): number {
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000);
}

function formatShortDate(date: Date): string {
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

/** Statement billing period reads back one month from the statement date — matches how a card's cycle is
 *  usually communicated ("18 Apr – 17 May"). */
function billingPeriodLabel(statementDate: Date): string {
  const end = statementDate;
  const start = new Date(end);
  start.setMonth(start.getMonth() - 1);
  start.setDate(start.getDate() + 1);
  const fmt = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  return `${fmt(start)} – ${fmt(end)}`;
}

export function CreditCardsWorkspace() {
  const { items: creditCards, isLoading: cardsLoading } = useCreditCardViewItems();
  const { totals: engineTotals, isLoading: totalsLoading } = useCreditCardTotals();
  const { rows: recentCardTransactions, isLoading: recentLoading } = useRecentCreditCardTransactions(6);
  const { data: accounts = [] } = useAccounts();
  const { data: sharedLimits = [] } = useSharedCreditLimits();
  const actions = useCreditCardActions();
  const router = useRouter();

  const { data: people = [] } = usePeople();
  const { rows: transactionRows, accounts: txnAccounts, categories: txnCategories } = useTransactionRows();
  const transactionActions = useTransactionActions();
  const [payCard, setPayCard] = useState<CreditCardViewItem | null>(null);
  const { funds: linkedFunds } = useLinkedFunds();

  // `?card=<id>` reopens that card — so Back from its filtered Transactions lands on the same card.
  const cardParams = useSearchParams();
  const [activeCardId, setActiveCardId] = useState<string | undefined>(() => cardParams.get("card") ?? undefined);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [addOpen, setAddOpen] = useState(false);
  const [editingCard, setEditingCard] = useState<CreditCardViewItem | null>(null);
  const [deletingCard, setDeletingCard] = useState<CreditCardViewItem | null>(null);
  const [deletingCardBusy, setDeletingCardBusy] = useState(false);
  const [cardDeletionImpact, setCardDeletionImpact] = useState<CreditCardDeletionImpact | null>(null);
  const [form, setForm] = useState<CardFormState>(emptyCardForm);
  const [saving, setSaving] = useState(false);

  function openAdd() {
    setForm(emptyCardForm());
    setAddOpen(true);
  }

  function openEdit(card: CreditCardViewItem) {
    setForm(cardFormFromCard(card, accounts as Account[]));
    setEditingCard(card);
  }

  const submitCard = useGuardedSubmit(handleSaveCard, saving);

  async function handleSaveCard() {
    if (!actions) return;
    const name = form.name.trim();
    if (!name) {
      toast.error("Card name is required.");
      return;
    }
    const cardHolderName = form.cardHolderName.trim();
    if (!cardHolderName) {
      toast.error("Card holder name is required.");
      return;
    }
    if (!/^\d{4}$/.test(form.lastFourDigits)) {
      toast.error("Last 4 digits are required and must be exactly 4 numbers.");
      return;
    }
    if (!form.bankId) {
      toast.error("Bank is required.");
      return;
    }
    let creditLimit = 0;
    if (form.limitSource === "own") {
      creditLimit = Number(form.creditLimit);
      if (!Number.isFinite(creditLimit) || creditLimit <= 0) {
        toast.error("Credit limit must be greater than 0.");
        return;
      }
    } else if (form.limitSource === "newShared") {
      if (!form.sharedLimitName.trim()) {
        toast.error("Enter a name for the shared credit limit.");
        return;
      }
      const sharedAmount = Number(form.sharedLimitAmount);
      if (!Number.isFinite(sharedAmount) || sharedAmount <= 0) {
        toast.error("Shared credit limit must be greater than 0.");
        return;
      }
    } else if (form.limitSource === "existingShared" && !form.selectedSharedLimitId) {
      toast.error("Choose a shared credit limit.");
      return;
    }
    const statementDay = Number(form.statementDay);
    const paymentDueDay = Number(form.paymentDueDay);
    if (!Number.isInteger(statementDay) || statementDay < 1 || statementDay > 31) {
      toast.error("Statement day must be between 1 and 31.");
      return;
    }
    if (!Number.isInteger(paymentDueDay) || paymentDueDay < 1 || paymentDueDay > 31) {
      toast.error("Payment due day must be between 1 and 31.");
      return;
    }

    setSaving(true);
    const op = startOperation(
      editingCard
        ? { label: "Updating credit card", successLabel: "Card updated", errorLabel: "Couldn't update card" }
        : { label: "Adding credit card", successLabel: "Card added", errorLabel: "Couldn't add card" },
    );
    try {
      let sharedLimitId: string | null = null;
      if (form.limitSource === "newShared") {
        op.stage("submit", "Creating shared limit");
        const sharedLimit = await actions.createSharedLimit({
          name: form.sharedLimitName.trim(),
          creditLimit: Number(form.sharedLimitAmount),
        });
        sharedLimitId = sharedLimit.id;
      } else if (form.limitSource === "existingShared") {
        sharedLimitId = form.selectedSharedLimitId;
      }

      op.stage(form.limitSource === "newShared" ? "related" : "submit", editingCard ? "Saving card details" : "Saving card & account");
      if (editingCard) {
        const account = (accounts as Account[]).find((a) => a.id === editingCard.card.accountId);
        await actions.editCard(editingCard.card, account, {
          name,
          cardHolderName,
          ...(form.limitSource === "own" ? { creditLimit } : {}),
          lastFourDigits: form.lastFourDigits,
          bankId: form.bankId,
          ...(sharedLimitId ? { sharedLimitId } : { clearSharedLimitId: true }),
        });
        setEditingCard(null);
        op.succeed({ toast: { title: "Card updated" } });
      } else {
        await actions.createCard({
          name,
          cardHolderName,
          creditLimit,
          lastFourDigits: form.lastFourDigits,
          cardNetwork: form.cardNetwork || null,
          statementDay,
          paymentDueDay,
          bankId: form.bankId,
          sharedLimitId,
        });
        setAddOpen(false);
        op.succeed({ toast: { title: "Card added" } });
      }
    } catch (e) {
      // The dialog stays open with everything entered.
      op.fail({ detail: errorDetail(e) ?? "Something went wrong. Please try again.", retry: handleSaveCard });
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!actions || !deletingCard) return;
    let cancelled = false;
    actions.previewCardDeletion(deletingCard.card).then((impact) => {
      if (!cancelled) setCardDeletionImpact(impact);
    });
    return () => {
      cancelled = true;
    };
  }, [actions, deletingCard]);

  const cardDeletionImpactRows: DestructiveDeleteImpactRow[] | null = cardDeletionImpact && [
    { label: `${cardDeletionImpact.transactionCount} transaction${cardDeletionImpact.transactionCount === 1 ? "" : "s"}`, count: cardDeletionImpact.transactionCount },
    { label: `${cardDeletionImpact.emiCount} linked EMI${cardDeletionImpact.emiCount === 1 ? "" : "s"}`, count: cardDeletionImpact.emiCount },
    { label: `${cardDeletionImpact.statementCount} statement${cardDeletionImpact.statementCount === 1 ? "" : "s"}`, count: cardDeletionImpact.statementCount },
    { label: "Shared credit limit will also be removed (no other card uses it)", count: cardDeletionImpact.sharedLimitWillBeRemoved ? 1 : 0 },
    { label: `${cardDeletionImpact.transferSiblingCount} linked transfer${cardDeletionImpact.transferSiblingCount === 1 ? "" : "s"} on other accounts`, count: cardDeletionImpact.transferSiblingCount },
    { label: `${cardDeletionImpact.expenseCount} shared/assigned expense${cardDeletionImpact.expenseCount === 1 ? "" : "s"}`, count: cardDeletionImpact.expenseCount },
    { label: `${cardDeletionImpact.affectedPersonCount} person${cardDeletionImpact.affectedPersonCount === 1 ? "'s" : "s'"} balance will be recalculated`, count: cardDeletionImpact.affectedPersonCount },
    { label: `${cardDeletionImpact.billCount} bill${cardDeletionImpact.billCount === 1 ? "" : "s"} paying from this card`, count: cardDeletionImpact.billCount },
  ];

  async function handleDeleteCard() {
    if (!actions || !deletingCard) return;
    setDeletingCardBusy(true);
    const op = startOperation({ label: "Deleting credit card", successLabel: "Card deleted", errorLabel: "Couldn't delete card" });
    try {
      // One cascade: the card, its account, transactions, EMIs and statements.
      op.stage("submit", "Removing card & its history");
      await actions.deleteCard(deletingCard.card);
      if (activeCardId === deletingCard.id) setActiveCardId(undefined);
      setDeletingCard(null);
      op.succeed({ toast: { title: "Card deleted" } });
    } catch (e) {
      op.fail({ detail: errorDetail(e) });
    } finally {
      setDeletingCardBusy(false);
    }
  }

  // Defaults the active card to "primary, else first" once the live list
  // arrives, without fighting the user's own later selection — computed
  // directly during render (no effect needed) so an explicit user click
  // (`activeCardId` set) always wins over this default.
  const defaultActiveCard = creditCards.find((c) => c.isPrimary) ?? creditCards[0];
  const activeCard = (activeCardId != null ? creditCards.find((c) => c.id === activeCardId) : undefined) ?? defaultActiveCard;

  const totals = {
    creditLimit: engineTotals.creditLimit,
    utilized: engineTotals.utilized,
    usedCredit: engineTotals.usedCredit,
    lockedEmiPrincipal: engineTotals.lockedEmiPrincipal,
    utilizationPercent: engineTotals.utilizationPercent,
    available: engineTotals.available,
    spentThisMonth: engineTotals.spentThisMonth,
  };

  // Rounded/capped at 100 for display only — the underlying percentage itself
  // always comes from the engine's creditUtilizationPercent, never recomputed here.
  const utilization = activeCard ? Math.min(100, Math.round(activeCard.utilizationPercent)) : 0;
  const available = activeCard ? activeCard.available : 0;
  const dueInDays = activeCard?.dueDate ? daysUntil(activeCard.dueDate) : null;

  const { transactions: activeCardTransactions } = useCardTransactions(activeCard?.card);

  const spendByCategory = useMemo(() => {
    const totals = new Map<string, number>();
    for (const t of activeCardTransactions) {
      const category = t.type === "income" ? "Income" : "Expense";
      totals.set(category, (totals.get(category) ?? 0) + t.amount);
    }
    const total = [...totals.values()].reduce((s, v) => s + v, 0);
    return [...totals.entries()]
      .map(([category, amount]) => ({ category, amount, percent: total === 0 ? 0 : Math.round((amount / total) * 1000) / 10 }))
      .sort((a, b) => b.amount - a.amount);
  }, [activeCardTransactions]);

  const spendTotal = spendByCategory.reduce((s, c) => s + c.amount, 0);

  const isLoading = cardsLoading || totalsLoading || recentLoading;

  // Preview which gradient this card will actually be assigned — accent is "index in list order"
  // (see ACCENT_CYCLE in use-credit-cards-data.ts), so a new card lands at the current list length.
  const previewAccent = editingCard ? editingCard.accent : ACCENT_CYCLE[creditCards.length % ACCENT_CYCLE.length];

  const closeCardDialog = () => {
    setAddOpen(false);
    setEditingCard(null);
  };

  const cardFormDialog = (
    <Dialog open={addOpen || editingCard != null} onOpenChange={(open) => !open && closeCardDialog()}>
      <DialogContent showCloseButton={false} className="flex max-h-[calc(100vh-2rem)] flex-col gap-0 overflow-hidden rounded-2xl border border-border p-0 shadow-lg ring-0 sm:max-w-2xl">
        <div className="h-1 w-full bg-primary" />

        <DialogHeader className="shrink-0 gap-1 border-b border-border bg-muted/40 px-6 py-5 text-left">
          <DialogTitle className="font-heading text-lg font-semibold">
            {editingCard ? `Edit ${editingCard.name}` : "Add a Credit Card"}
          </DialogTitle>
          {!editingCard && (
            <DialogDescription>A few details to start tracking spending, utilization and due dates.</DialogDescription>
          )}
        </DialogHeader>

        {/* Real <form> (display: contents keeps the layout): Enter in a single-line field saves via the same handler as the primary button. */}
        <form className="contents" noValidate onSubmit={submitCard} onKeyDown={handleEnterAdvance}>

        <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 py-5 text-sm">
          <div
            style={{ background: CARD_GRADIENT[previewAccent] }}
            className="relative flex min-h-[132px] flex-col justify-between gap-5 rounded-2xl border border-black/10 p-4 text-white shadow-e1"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="h-5 w-7 border border-white/40 bg-gradient-to-br from-amber-200/90 to-amber-500/70" />
              {form.cardNetwork && (
                <span className="flex h-6 shrink-0 items-center justify-center border border-white/25 bg-white/10 px-1.5 text-[9px] font-bold tracking-wide uppercase italic">
                  {form.cardNetwork.slice(0, 2)}
                </span>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <p className="font-mono text-base tracking-[0.2em] text-white/90">•••• •••• •••• {form.lastFourDigits || "••••"}</p>
              <p className="truncate text-xs font-semibold tracking-wide text-white/80 uppercase">{form.name.trim() || "Card Name"}</p>
              <p className="truncate text-[11px] font-medium tracking-wide text-white/70 uppercase">{form.cardHolderName.trim() || "Card Holder Name"}</p>
            </div>
          </div>

          <div className="flex flex-col gap-3 rounded-2xl bg-muted/30 p-4">
            <SectionLabel icon={CreditCardIcon}>Card Details</SectionLabel>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Card Name *</span>
              <div className="relative">
                <CreditCardIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  className="h-10 w-full rounded-xl border border-border bg-background pr-3 pl-9 text-sm outline-none transition-colors focus:border-primary"
                  placeholder="e.g. HDFC Regalia"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                />
              </div>
            </label>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Card Holder Name *</span>
                <div className="relative">
                  <User className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    className="h-10 w-full rounded-xl border border-border bg-background pr-3 pl-9 text-sm outline-none transition-colors focus:border-primary"
                    placeholder="e.g. Abin John"
                    value={form.cardHolderName}
                    onChange={(e) => setForm((f) => ({ ...f, cardHolderName: e.target.value }))}
                  />
                </div>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Card Number (Last 4 Digits) *</span>
                <input
                  className="h-10 rounded-xl border border-border bg-background px-3 font-mono text-sm tracking-widest outline-none transition-colors focus:border-primary"
                  placeholder="4021"
                  maxLength={4}
                  value={form.lastFourDigits}
                  onChange={(e) => setForm((f) => ({ ...f, lastFourDigits: e.target.value.replace(/\D/g, "") }))}
                />
              </label>
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Bank *</span>
              <BankCombobox
                value={form.bankId}
                onChange={(bankId) => setForm((f) => ({ ...f, bankId }))}
                placeholder="Search for your bank…"
              />
            </label>
          </div>

          <div className="flex flex-col gap-3 rounded-2xl bg-muted/30 p-4">
            <SectionLabel icon={Wallet}>Credit Limit</SectionLabel>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  { value: "own", label: "Own Limit" },
                  { value: "newShared", label: "New Shared" },
                  ...(sharedLimits.length > 0 ? [{ value: "existingShared", label: "Existing Shared" } as const] : []),
                ] as { value: LimitSource; label: string }[]
              ).map((opt) => {
                const selected = form.limitSource === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, limitSource: opt.value }))}
                    className={cn(
                      "flex items-center gap-1.5 border px-3 py-1.5 text-xs font-semibold transition-colors",
                      selected
                        ? "border-primary bg-primary/10 text-primary-accent-text"
                        : "border-border text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {opt.value !== "own" && <Link2 className="size-3" />}
                    {opt.label}
                  </button>
                );
              })}
            </div>

            {form.limitSource === "own" && (
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Credit Limit *</span>
                <div className="relative">
                  <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-primary-accent-text">₹</span>
                  <input
                    type="number"
                    className="h-10 w-full rounded-xl border border-primary/30 bg-primary/5 pr-3 pl-7 text-base font-semibold outline-none transition-colors focus:border-primary"
                    placeholder="0.00"
                    value={form.creditLimit}
                    onChange={(e) => setForm((f) => ({ ...f, creditLimit: e.target.value }))}
                  />
                </div>
              </label>
            )}

            {form.limitSource === "newShared" && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">Shared Limit Name</span>
                  <input
                    className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-primary"
                    placeholder="e.g. HDFC"
                    value={form.sharedLimitName}
                    onChange={(e) => setForm((f) => ({ ...f, sharedLimitName: e.target.value }))}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">Total Credit Limit</span>
                  <div className="relative">
                    <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-primary-accent-text">₹</span>
                    <input
                      type="number"
                      className="h-10 w-full rounded-xl border border-primary/30 bg-primary/5 pr-3 pl-7 text-base font-semibold outline-none transition-colors focus:border-primary"
                      placeholder="0.00"
                      value={form.sharedLimitAmount}
                      onChange={(e) => setForm((f) => ({ ...f, sharedLimitAmount: e.target.value }))}
                    />
                  </div>
                </label>
              </div>
            )}

            {form.limitSource === "existingShared" && (
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Shared Credit Limit</span>
                <Select
                  value={form.selectedSharedLimitId ?? undefined}
                  onValueChange={(value) => setForm((f) => ({ ...f, selectedSharedLimitId: value }))}
                >
                  <SelectTrigger className="h-10 w-full rounded-xl border-border">
                    <SelectValue placeholder="Choose a shared limit" />
                  </SelectTrigger>
                  <SelectContent>
                    {sharedLimits.map((sl) => (
                      <SelectItem key={sl.id} value={sl.id}>
                        {sl.name} — {formatCurrency(sl.creditLimit)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            )}

            <p className="text-[11px] text-muted-foreground">
              A shared limit is one combined credit line two cards from the same bank draw from — each keeps its own number and bill.
            </p>
          </div>

          <div className="flex flex-col gap-3 rounded-2xl bg-muted/30 p-4">
            <SectionLabel icon={Wifi}>Network (optional)</SectionLabel>
            <div className="flex flex-wrap gap-2">
              {CARD_NETWORK_OPTIONS.map((n) => {
                const selected = form.cardNetwork === n;
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, cardNetwork: f.cardNetwork === n ? "" : n }))}
                    className={cn(
                      "flex items-center gap-1.5 border px-3 py-1.5 text-xs font-semibold transition-colors",
                      selected
                        ? "border-primary bg-primary/10 text-primary-accent-text"
                        : "border-border text-muted-foreground hover:bg-muted",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-5 items-center justify-center px-1 text-[9px] font-bold tracking-wide uppercase italic",
                        selected ? "bg-primary/20 text-primary-accent-text" : "bg-muted text-muted-foreground",
                      )}
                    >
                      {n.slice(0, 2)}
                    </span>
                    {n.toUpperCase()}
                  </button>
                );
              })}
            </div>
          </div>

          {!editingCard && (
            <>
              <div className="flex flex-col gap-3 rounded-2xl bg-muted/30 p-4">
                <SectionLabel icon={CalendarClock}>Billing Cycle</SectionLabel>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground">Statement Day</span>
                    <input
                      type="number"
                      min={1}
                      max={31}
                      className="h-10 rounded-xl border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-primary"
                      value={form.statementDay}
                      onChange={(e) => setForm((f) => ({ ...f, statementDay: e.target.value }))}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground">Payment Due Day</span>
                    <input
                      type="number"
                      min={1}
                      max={31}
                      className="h-10 rounded-xl border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-primary"
                      value={form.paymentDueDay}
                      onChange={(e) => setForm((f) => ({ ...f, paymentDueDay: e.target.value }))}
                    />
                  </label>
                </div>
                <p className="text-[11px] text-muted-foreground">Day of the month your statement generates and payment is due.</p>
              </div>
            </>
          )}

        </div>

        <DialogFooter className="shrink-0 border-t border-border bg-muted/20 px-6 py-4">
          <ClayButton variant="ghost" className="rounded-xl" onClick={closeCardDialog} disabled={saving}>
            Cancel
          </ClayButton>
          <ClayButton type="submit" variant="primary" className="rounded-xl" disabled={saving}>
            {saving ? "Saving…" : editingCard ? "Save Changes" : "Add Card"}
          </ClayButton>
        </DialogFooter>
        </form>
        {/* Close sits last in the DOM (absolutely positioned, so visually unchanged): focus opens on the first field. */}
        <button
          type="button"
          onClick={closeCardDialog}
          aria-label="Close"
          className="absolute top-4 right-4 flex size-7 items-center justify-center border border-transparent text-muted-foreground transition-colors hover:border-border hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>
      </DialogContent>
    </Dialog>
  );

  const header = (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Credit Cards</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">Limits, spending, statements and due dates — all your cards.</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {creditCards.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className={CC_UTILITY}>
                <MoreHorizontal className="size-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">More</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48 rounded-[8px]">
              <DropdownMenuItem onSelect={() => document.getElementById("upcoming-statements")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                <FileText strokeWidth={1.75} />
                View statements
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => document.getElementById("my-credit-cards")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                <Settings2 strokeWidth={1.75} />
                Manage cards
              </DropdownMenuItem>
              <DropdownMenuItem disabled>
                <Download strokeWidth={1.75} />
                Export statements
                <span className={cn(CC_SOON, "ml-auto")}>Soon</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <button type="button" onClick={openAdd} className={CC_PRIMARY}>
          <Plus className="size-4" strokeWidth={2.25} />
          Add Card
        </button>
      </div>
    </header>
  );

  if (isLoading) {
    return (
      <div className="flex min-w-0 flex-col gap-5 px-1">
        {header}
        <Skeleton className="h-24 rounded-[10px]" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="h-44 rounded-[12px]" />
          ))}
        </div>
      </div>
    );
  }

  if (creditCards.length === 0) {
    return (
      <div className="flex min-w-0 flex-col gap-5 px-1">
        {header}
        <div className="flex flex-col items-center gap-3 rounded-[10px] border border-dashed border-border-strong bg-card px-6 py-14 text-center">
          <span className="flex size-11 items-center justify-center rounded-full bg-secondary text-muted-foreground">
            <CreditCardIcon className="size-5" strokeWidth={1.75} />
          </span>
          <div>
            <p className="font-heading text-base font-semibold text-foreground">No credit cards yet</p>
            <p className="mt-1 text-sm text-muted-foreground">Add your first card to start tracking spending, utilization and due dates.</p>
          </div>
          <button type="button" onClick={openAdd} className={CC_PRIMARY}>
            <Plus className="size-4" strokeWidth={2.25} />
            Add Card
          </button>
        </div>

        {cardFormDialog}
      </div>
    );
  }

  // The engine's exposure ratio (outstanding + locked card-EMI principal) — the same one `available` uses,
  // so "used" and "available" always add up to the limit. Rounded/capped for display only.
  const totalUtilization = Math.min(100, Math.round(totals.utilizationPercent));

  return (
    <div className="flex min-w-0 flex-col gap-5 px-1">
      {header}

      {/* ── Summary — one panel: what's used leads, limit / available / this month support it ── */}
      <section aria-label="Summary" className="@container overflow-hidden rounded-[10px] border border-border-strong/60 bg-card shadow-e1">
       <div className="flex flex-col @4xl:flex-row @4xl:items-stretch">
        <div className="flex flex-col gap-2 bg-gradient-to-br from-expense/[0.08] to-transparent px-5 py-4 sm:px-6 @4xl:min-w-[22rem] @4xl:border-r @4xl:border-border-strong/50 dark:from-expense/[0.14]">
          <span className={cn(CC_LABEL, "inline-flex items-center gap-1.5")}>
            <PieChartIcon className="size-3.5 text-foreground" strokeWidth={1.75} />
            Credit used
          </span>
          <p className="text-[32px] leading-none font-bold tracking-tight text-foreground tabular-nums sm:text-[36px]">{formatCurrency(totals.usedCredit)}</p>
          {totals.lockedEmiPrincipal > 0 && (
            <p className="text-xs text-muted-foreground tabular-nums">
              Outstanding <span className="font-semibold text-foreground">{formatCurrency(totals.utilized)}</span> · EMI locked{" "}
              <span className="font-semibold text-foreground">{formatCurrency(totals.lockedEmiPrincipal)}</span>
            </p>
          )}
          <div className="flex items-center gap-2.5">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
              <div className={cn("h-full rounded-full", totalUtilization >= 80 ? "bg-expense" : "bg-primary-accent-text")} style={{ width: `${totalUtilization}%` }} />
            </div>
            <span className="text-xs font-semibold text-foreground tabular-nums">{totalUtilization}% used</span>
          </div>
        </div>
        <div className="grid min-w-0 flex-1 grid-cols-1 border-t border-border-strong/50 @xl:grid-cols-3 @xl:divide-x @xl:divide-border-strong/50 @4xl:border-t-0">
          <SummaryFigure icon={Wallet} tone="bg-purple/12 text-purple" label="Credit limit" value={formatCurrency(totals.creditLimit)} />
          <SummaryFigure icon={ShieldCheck} tone="bg-success/12 text-success" label="Available" value={formatCurrency(totals.available)} />
          <SummaryFigure icon={ShoppingBag} tone="bg-warning/20 text-warning-foreground dark:text-warning" label="Spent this month" value={formatCurrency(totals.spentThisMonth)} />
        </div>
       </div>
      </section>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_23rem] xl:items-start">
        {/* ── Main column ── */}
        <div className="flex min-w-0 flex-col gap-6">
          <section id="my-credit-cards" aria-label="My credit cards" className="flex scroll-mt-4 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 border-b border-border-strong/50 pb-3">
              <h2 className="mr-auto font-heading text-base font-semibold text-foreground">
                My credit cards <span className="ml-0.5 text-sm font-semibold text-muted-foreground tabular-nums">{creditCards.length}</span>
              </h2>
              <div role="radiogroup" aria-label="View" className="flex items-center rounded-[6px] border border-border-strong bg-card p-0.5">
                {(
                  [
                    { value: "grid", icon: LayoutGrid, label: "Cards" },
                    { value: "list", icon: List, label: "List" },
                  ] as const
                ).map((v) => (
                  <button
                    key={v.value}
                    type="button"
                    role="radio"
                    aria-checked={viewMode === v.value}
                    onClick={() => setViewMode(v.value)}
                    className={cn(
                      "flex h-7 items-center gap-1.5 rounded-[4px] px-2.5 text-xs font-semibold transition-colors",
                      viewMode === v.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                    )}
                  >
                    <v.icon className="size-3.5" strokeWidth={1.75} />
                    {v.label}
                  </button>
                ))}
              </div>
            </div>

            {viewMode === "grid" ? (
              <Stagger className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {creditCards.map((card) => (
                  <CreditCardTile
                    key={card.id}
                    card={card}
                    active={card.id === activeCard?.id}
                    onClick={() => setActiveCardId(card.id)}
                    onEdit={() => openEdit(card)}
                    onDelete={() => {
                      setCardDeletionImpact(null);
                      setDeletingCard(card);
                    }}
                  />
                ))}
              </Stagger>
            ) : (
              <div className="overflow-hidden rounded-[10px] border border-border-strong/70 bg-card shadow-e1">
                <table className="w-full border-separate border-spacing-0 text-sm">
                  <thead>
                    <tr>
                      <th className={CC_TH}>Card</th>
                      <th className={cn(CC_TH, "hidden w-36 text-right sm:table-cell")}>Used</th>
                      <th className={cn(CC_TH, "hidden w-36 text-right md:table-cell")}>Limit</th>
                      <th className={cn(CC_TH, "w-36")}>Utilization</th>
                    </tr>
                  </thead>
                  <tbody>
                    {creditCards.map((card) => {
                      const util = Math.min(100, Math.round(card.utilizationPercent));
                      const active = card.id === activeCard?.id;
                      return (
                        <tr
                          key={card.id}
                          onClick={() => setActiveCardId(card.id)}
                          // Keyboard: the row is one tab stop; Enter/Space selects the card, same as a click.
                          tabIndex={0}
                          aria-current={active || undefined}
                          onKeyDown={(e) => {
                            if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                              e.preventDefault();
                              setActiveCardId(card.id);
                            }
                          }}
                          className={cn("cursor-pointer transition-colors hover:bg-secondary/60 [&:last-child>td]:border-b-0", active && "bg-primary/10 hover:bg-primary/15")}
                        >
                          <td className={cn(CC_TD, "max-w-0")}>
                            <div className="flex min-w-0 items-center gap-3">
                              <CardChip card={card} />
                              <div className="min-w-0">
                                <p className="truncate font-semibold text-foreground">{card.name}</p>
                                <p className="text-xs text-muted-foreground tabular-nums">•••• {card.last4}</p>
                              </div>
                            </div>
                          </td>
                          <td className={cn(CC_TD, "hidden text-right sm:table-cell")}>
                            <span className="text-[16px] font-bold text-foreground tabular-nums">{formatCurrency(card.usedCredit)}</span>
                            {card.lockedEmiPrincipal > 0 && (
                              <span className="block text-[11px] text-muted-foreground tabular-nums">incl. {formatCurrency(card.lockedEmiPrincipal)} EMI</span>
                            )}
                          </td>
                          <td className={cn(CC_TD, "hidden text-right text-foreground/85 tabular-nums md:table-cell")}>{formatCurrency(card.creditLimit)}</td>
                          <td className={CC_TD}>
                            <UtilizationBar percent={util} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ── Upcoming statements ── */}
          <section id="upcoming-statements" aria-label="Upcoming statements" className="flex scroll-mt-4 flex-col gap-3">
            <div className="flex items-center justify-between gap-3 border-b border-border-strong/50 pb-3">
              <h2 className="font-heading text-base font-semibold text-foreground">Upcoming statements</h2>
              <button type="button" onClick={() => router.push("/transactions")} className={CC_LINK}>
                View all
                <ArrowRight className="size-3.5" strokeWidth={2} />
              </button>
            </div>
            <div className="overflow-hidden rounded-[10px] border border-border-strong/70 bg-card shadow-e1">
              <table className="w-full border-separate border-spacing-0 text-sm">
                <thead>
                  <tr>
                    <th className={CC_TH}>Card</th>
                    <th className={cn(CC_TH, "hidden w-44 md:table-cell")}>Billing period</th>
                    <th className={cn(CC_TH, "w-36 text-right")}>Total due</th>
                    <th className={cn(CC_TH, "hidden w-32 text-right sm:table-cell")}>Minimum</th>
                    <th className={cn(CC_TH, "w-[8.5rem]")}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {creditCards.map((card) => (
                    <tr key={card.id} className="transition-colors hover:bg-secondary/40 [&:last-child>td]:border-b-0">
                      <td className={cn(CC_TD, "max-w-0")}>
                        <div className="flex min-w-0 items-center gap-3">
                          <CardChip card={card} />
                          <div className="min-w-0">
                            <p className="truncate font-semibold text-foreground">{card.name}</p>
                            <p className="truncate text-xs text-muted-foreground tabular-nums">
                              Statement {card.statementDate ? formatShortDate(card.statementDate) : "—"}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className={cn(CC_TD, "hidden text-xs font-medium text-foreground/85 tabular-nums md:table-cell")}>
                        {card.statementDate ? billingPeriodLabel(card.statementDate) : "—"}
                      </td>
                      <td className={cn(CC_TD, "text-right")}>
                        <span className="text-[17px] font-bold text-expense tabular-nums">{formatCurrency(card.currentBalance)}</span>
                      </td>
                      <td className={cn(CC_TD, "hidden text-right font-semibold text-foreground tabular-nums sm:table-cell")}>{formatCurrency(card.minimumDue)}</td>
                      <td className={cn(CC_TD, "px-2")}>
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => setPayCard(card)}
                            className="flex h-7 items-center gap-1 rounded-[6px] border border-primary-accent-text bg-primary px-2.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
                          >
                            Pay now
                          </button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button type="button" aria-label="Statement actions" className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-secondary hover:text-foreground">
                                <MoreHorizontal className="size-4" strokeWidth={1.75} />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="min-w-44 rounded-[8px]">
                              <DropdownMenuItem onSelect={() => setActiveCardId(card.id)}>View details</DropdownMenuItem>
                              <DropdownMenuItem disabled>
                                Download statement
                                <span className={cn(CC_SOON, "ml-auto")}>Soon</span>
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── Recent card transactions ── */}
          <section aria-label="Recent card transactions" className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3 border-b border-border-strong/50 pb-3">
              <h2 className="font-heading text-base font-semibold text-foreground">Recent card transactions</h2>
              <button type="button" onClick={() => router.push("/transactions")} className={CC_LINK}>
                View all
                <ArrowRight className="size-3.5" strokeWidth={2} />
              </button>
            </div>
            <div className="max-h-[26rem] overflow-auto overscroll-contain rounded-[10px] border border-border-strong/70 bg-card shadow-e1">
              {recentCardTransactions.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-muted-foreground">No recent card transactions.</p>
              ) : (
                <table className="w-full border-separate border-spacing-0 text-sm">
                  <thead>
                    <tr>
                      <th className={cn(CC_TH, "sticky top-0 z-[1] w-[4.5rem]")}>Date</th>
                      <th className={cn(CC_TH, "sticky top-0 z-[1]")}>Description</th>
                      <th className={cn(CC_TH, "sticky top-0 z-[1] hidden w-48 md:table-cell")}>Card</th>
                      <th className={cn(CC_TH, "sticky top-0 z-[1] w-36 text-right")}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentCardTransactions.map((txn) => {
                      const Icon = CATEGORY_ICON[txn.category] ?? Receipt;
                      const cardView = creditCards.find((c) => c.id === txn.card.id);
                      return (
                        <tr key={txn.id} className="transition-colors hover:bg-secondary/40 [&:last-child>td]:border-b-0">
                          <td className={cn(CC_TD, "whitespace-nowrap tabular-nums")}>
                            <p className="text-sm leading-tight font-semibold text-foreground">{txn.date.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</p>
                            <p className="text-[11px] leading-tight text-muted-foreground">{txn.date.getFullYear()}</p>
                          </td>
                          <td className={cn(CC_TD, "max-w-0")}>
                            <div className="flex min-w-0 items-center gap-2.5">
                              <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[8px]", TONE_ICON_CLASS[categoryTone(txn.category)])}>
                                <Icon className="size-4" />
                              </span>
                              <div className="min-w-0">
                                <p className="truncate font-semibold text-foreground">{txn.merchant}</p>
                                <p className="truncate text-xs text-muted-foreground">
                                  {txn.category}
                                  <span className="md:hidden"> · {cardView?.name ?? "Credit card"}</span>
                                </p>
                              </div>
                            </div>
                          </td>
                          <td className={cn(CC_TD, "hidden md:table-cell")}>
                            <p className="truncate text-xs font-medium text-foreground">{cardView?.name ?? "Credit card"}</p>
                            <p className="text-[11px] text-muted-foreground tabular-nums">•••• {cardView?.last4 ?? "----"}</p>
                          </td>
                          <td className={cn(CC_TD, "text-right")}>
                            <span className="text-[17px] font-bold whitespace-nowrap text-foreground tabular-nums">−{formatCurrency(txn.amount)}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>

        {/* ── Selected card ── */}
        <aside className="flex min-w-0 flex-col gap-5 xl:sticky xl:top-0">
          {activeCard && (
            <section aria-label="Selected card" className="overflow-hidden rounded-[10px] border border-border-strong/60 bg-card shadow-e1">
              <div style={{ background: CARD_GRADIENT[activeCard.accent] }} className="flex flex-col gap-4 p-4 text-white">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate font-heading text-lg font-semibold">{activeCard.name}</h3>
                    <p className="mt-0.5 text-sm tracking-[0.18em] text-white/80 tabular-nums">•••• {activeCard.last4}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    {activeCard.isPrimary && <span className="rounded-[4px] bg-white/20 px-1.5 py-0.5 text-[10px] font-semibold">Primary</span>}
                    <span className="text-xs font-bold tracking-wide text-white/75 uppercase italic">{activeCard.network}</span>
                  </div>
                </div>
                <div>
                  <p className="text-[11px] font-semibold tracking-[0.06em] text-white/70 uppercase">Credit used</p>
                  <p className="text-[30px] leading-tight font-bold tracking-tight tabular-nums">{formatCurrency(activeCard.usedCredit)}</p>
                  {activeCard.lockedEmiPrincipal > 0 && (
                    <p className="text-xs text-white/80 tabular-nums">
                      Outstanding {formatCurrency(activeCard.currentBalance)} · EMI locked {formatCurrency(activeCard.lockedEmiPrincipal)}
                    </p>
                  )}
                </div>
                <div>
                  <div className="flex items-center justify-between text-xs text-white/75">
                    <span>Utilization</span>
                    <span className="font-semibold text-white">{utilization}%</span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/20">
                    <div className={cn("h-full rounded-full", utilization >= 80 ? "bg-red-400" : "bg-white")} style={{ width: `${utilization}%` }} />
                  </div>
                </div>
              </div>

              <dl className="grid grid-cols-2 border-b border-border-strong/40">
                <PanelFact label="Available" value={formatCurrency(available)} tone="text-success" />
                <PanelFact label="Credit limit" value={formatCurrency(activeCard.creditLimit)} />
                <PanelFact label="Next statement" value={activeCard.statementDate ? formatShortDate(activeCard.statementDate) : "—"} />
                <PanelFact
                  label="Payment due"
                  value={dueInDays == null ? "No due date" : dueInDays <= 0 ? "Due today" : `${dueInDays} days left`}
                  tone={dueInDays != null && dueInDays <= 5 ? "text-expense" : undefined}
                />
              </dl>

              <div className="grid grid-cols-4 gap-1 p-2">
                <QuickAction icon={Wallet} label="Pay bill" tone="bg-primary/25 text-foreground dark:text-primary-accent-text" onClick={() => setPayCard(activeCard)} />
                <QuickAction
                  icon={FileText}
                  label="Statement"
                  tone="bg-purple/12 text-purple"
                  onClick={() => document.getElementById("upcoming-statements")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                />
                <QuickAction icon={RefreshCw} label="Convert to EMI" tone="bg-success/12 text-success" soon />
                <QuickAction icon={Settings} label="Card settings" tone="bg-secondary text-foreground/75" onClick={() => openEdit(activeCard)} />
              </div>
              {/* People money received for purchases on this card — held in another account until the bill is paid. */}
              <LinkedFundsPayNotice
                funds={linkedPendingForCard(linkedFunds, activeCard.card.accountId)}
                accountName={(id) => accounts.find((a) => a.id === id)?.name}
                className="mx-2 mb-2"
              />
              <div className="border-t border-border-strong/50 p-2">
                <button
                  type="button"
                  onClick={() => {
                    // Only filters the existing Transactions list to this card's account — nothing is re-read as income/expense.
                    router.replace(`/credit-cards?card=${encodeURIComponent(activeCard.id)}`, { scroll: false });
                    router.push(transactionsHrefForAccount(activeCard.card.accountId));
                  }}
                  className="flex h-9 w-full items-center justify-between rounded-[6px] px-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-primary/10"
                >
                  View all card transactions
                  <ArrowRight className="size-3.5" strokeWidth={2} />
                </button>
              </div>
            </section>
          )}

          <section aria-label="Spending summary" className="rounded-[10px] border border-border-strong/60 bg-card p-4 shadow-e1">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="font-heading text-[15px] font-semibold text-foreground">Spending summary</h2>
              <span className="truncate text-xs text-muted-foreground">{activeCard?.name ?? "This month"}</span>
            </div>
            <div className="mt-3 flex items-center gap-4">
              <div className="relative size-28 shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={spendByCategory} dataKey="amount" nameKey="category" innerRadius="68%" outerRadius="100%" paddingAngle={2} stroke="none">
                      {spendByCategory.map((item) => (
                        <Cell key={item.category} fill={CATEGORY_CHART_COLOR[categoryTone(item.category)]} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-[9px] font-medium text-muted-foreground uppercase">Total</span>
                  <span className="text-sm font-bold text-foreground tabular-nums">{formatCurrency(spendTotal)}</span>
                </div>
              </div>
              <div className="min-w-0 flex-1 divide-y divide-border-strong/40">
                {spendByCategory.length === 0 && <p className="text-xs text-muted-foreground">No spending on this card yet.</p>}
                {spendByCategory.map((item) => (
                  <div key={item.category} className="flex items-center gap-2 py-2 text-xs">
                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: CATEGORY_CHART_COLOR[categoryTone(item.category)] }} />
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">{item.category}</span>
                    <span className="shrink-0 font-bold text-foreground tabular-nums">{formatCurrency(item.amount)}</span>
                    <span className="w-11 shrink-0 text-right text-muted-foreground tabular-nums">{item.percent}%</span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </aside>
      </div>

      {cardFormDialog}

      <DestructiveDeleteDialog
        open={deletingCard != null}
        onOpenChange={(open) => !open && setDeletingCard(null)}
        entityLabel="credit card"
        entityName={deletingCard?.name ?? "this card"}
        impact={cardDeletionImpactRows}
        onConfirm={handleDeleteCard}
        confirming={deletingCardBusy}
      />

      {transactionActions && (
        <TransactionDetailsModal
          open={payCard != null}
          onOpenChange={(open) => !open && setPayCard(null)}
          row={null}
          expense={null}
          people={people}
          accounts={txnAccounts}
          categories={txnCategories}
          actions={transactionActions}
          defaultKind="transfer"
          initialDestinationAccountId={payCard?.card.accountId}
          initialAmount={payCard?.currentBalance}
          existingTransactions={transactionRows.map((r) => r.transaction)}
        />
      )}
    </div>
  );
}

/* ───────────────────────── Page UI (visual only) ───────────────────────── */

const CC_PRIMARY =
  "flex h-9 items-center gap-1.5 rounded-[6px] border border-primary-accent-text bg-primary px-3.5 text-sm font-semibold text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring";
const CC_UTILITY =
  "flex h-9 items-center gap-1.5 rounded-[6px] px-2.5 text-sm font-medium text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-secondary [&_svg]:text-muted-foreground";
const CC_LINK = "flex h-8 items-center gap-1 rounded-[6px] px-2 text-sm font-semibold text-primary-accent-text transition-colors hover:bg-primary/15";
const CC_SOON = "rounded-[4px] bg-secondary px-1 py-px text-[10px] font-semibold tracking-wide text-muted-foreground uppercase";
const CC_LABEL = "text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase";
const CC_TH =
  "border-r border-b border-r-border-strong/40 border-b-border-strong bg-secondary px-3 py-2 text-left text-[11px] font-semibold tracking-[0.06em] whitespace-nowrap text-muted-foreground uppercase last:border-r-0";
const CC_TD = "border-r border-b border-r-border-strong/30 border-b-border-strong/40 px-3 py-2.5 align-middle last:border-r-0";

function SummaryFigure({ icon: Icon, tone, label, value }: { icon: typeof Wallet; tone: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-border-strong/40 px-5 py-3.5 last:border-b-0 @xl:border-b-0">
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-[8px]", tone)}>
        <Icon className="size-4" strokeWidth={1.75} />
      </span>
      <div className="min-w-0">
        <p className={CC_LABEL}>{label}</p>
        <p className="mt-0.5 text-lg leading-tight font-bold text-foreground tabular-nums">{value}</p>
      </div>
    </div>
  );
}

/** Small card-art chip — the card's own gradient with its network. */
function CardChip({ card }: { card: CreditCardViewItem }) {
  return (
    <span
      className="flex h-7 w-10 shrink-0 items-end justify-end rounded-[5px] px-1 pb-0.5 text-[8px] font-bold tracking-wide text-white/90 uppercase italic shadow-sm"
      style={{ background: CARD_GRADIENT[card.accent] }}
    >
      {card.network.slice(0, 4)}
    </span>
  );
}

function UtilizationBar({ percent }: { percent: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
        <div className={cn("h-full rounded-full", percent >= 80 ? "bg-expense" : "bg-primary-accent-text")} style={{ width: `${percent}%` }} />
      </div>
      <span className={cn("w-9 shrink-0 text-right text-xs font-semibold tabular-nums", percent >= 80 ? "text-expense" : "text-foreground")}>{percent}%</span>
    </div>
  );
}

function PanelFact({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 border-r border-b border-border-strong/40 px-4 py-2.5 even:border-r-0 [&:nth-child(n+3)]:border-b-0">
      <dt className={CC_LABEL}>{label}</dt>
      <dd className={cn("truncate text-sm font-bold text-foreground tabular-nums", tone)}>{value}</dd>
    </div>
  );
}

function QuickAction({
  icon: Icon,
  label,
  tone,
  onClick,
  soon = false,
}: {
  icon: typeof Wallet;
  label: string;
  tone: string;
  onClick?: () => void;
  soon?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={soon || !onClick}
      title={soon ? "Coming soon" : undefined}
      className="relative flex flex-col items-center gap-1.5 rounded-[8px] px-1 py-2.5 text-center transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:bg-transparent"
    >
      <span className={cn("flex size-9 items-center justify-center rounded-[8px]", tone)}>
        <Icon className="size-4" strokeWidth={1.75} />
      </span>
      <span className="text-[11px] leading-tight font-medium text-foreground">{label}</span>
      {soon && <span className={cn(CC_SOON, "absolute top-1 right-1 px-0.5 text-[8.5px]")}>Soon</span>}
    </button>
  );
}
