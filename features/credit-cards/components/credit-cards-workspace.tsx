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
  Check,
  Palette,
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
import { payBillAmount, payBillChargeScope, type CardBill, type CardStatementPaymentScope, type PayBillChoice } from "@/lib/engines/card-cycle-bills";
import { statementWindowForDate } from "@/lib/repositories/credit-card-repository";
import { LinkedFundsPayNotice } from "@/features/people/components/linked-funds";
import { useLinkedFunds } from "@/features/people/hooks/use-linked-funds";
import { linkedPendingForCard } from "@/lib/engines/linked-funds";
import { useLinkedPeopleReadiness } from "@/features/people/hooks/use-linked-people-readiness";
import type { Account } from "@/lib/models/account";
import type { CardNetwork } from "@/lib/models/credit-card";
import { formatCurrency } from "@/lib/format";
import {
  ACCENT_CYCLE,
  CARD_ACCENTS,
  colorValueForCardAccent,
  pickedCardAccent,
  type CardAccent,
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
  /** Null = no colour picked — the card keeps its automatic list-position colour. */
  color: CardAccent | null;
  /** Mobile's "add the paired card too" — only with a NEW shared limit; the second physical card on it. */
  addPairCard: boolean;
  pairName: string;
  pairLastFourDigits: string;
  pairCardNetwork: CardNetwork | "";
  pairStatementDay: string;
  pairPaymentDueDay: string;
}

const EMPTY_PAIR_FIELDS = {
  addPairCard: false,
  pairName: "",
  pairLastFourDigits: "",
  pairCardNetwork: "",
  pairStatementDay: "",
  pairPaymentDueDay: "",
} as const;

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
    color: null,
    ...EMPTY_PAIR_FIELDS,
  };
}

function cardFormFromCard(card: CreditCardViewItem, accounts: Account[]): CardFormState {
  const account = accounts.find((a) => a.id === card.card.accountId);
  return {
    name: card.name,
    cardHolderName: card.card.cardHolderName ?? "",
    // The card's OWN stored limit (₹0 on a shared-limit member) — never the facility's inherited one.
    creditLimit: card.card.creditLimit > 0 ? String(card.card.creditLimit) : "",
    lastFourDigits: card.last4 === "----" ? "" : card.last4,
    cardNetwork: (card.card.cardNetwork as CardNetwork | null) ?? "",
    statementDay: String(card.card.statementDay),
    paymentDueDay: String(card.card.paymentDueDay),
    bankId: account?.bankId ?? null,
    limitSource: card.card.sharedLimitId ? "existingShared" : "own",
    sharedLimitName: "",
    sharedLimitAmount: "",
    selectedSharedLimitId: card.card.sharedLimitId ?? null,
    color: pickedCardAccent(account?.colorValue),
    ...EMPTY_PAIR_FIELDS,
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

/** A bill's own statement period, e.g. "2 Aug – 1 Sep". */
function billPeriodLabel(b: Pick<CardBill, "periodStart" | "periodEnd">): string {
  const fmt = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  return `${fmt(b.periodStart)} – ${fmt(b.periodEnd)}`;
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
  // Pay bill defaults to what the CLOSED statements still owe (card statement cycle); paying the whole
  // outstanding is a separate, explicit choice.
  const [payChoice, setPayChoice] = useState<PayBillChoice>("statement");
  // The ONE canonical Pay Now scope (`cardStatementPaymentScope`, computed once in the standings) — every
  // Pay bill surface reads it; nothing here recomputes a bill.
  const payScopeOf = (c: CreditCardViewItem): CardStatementPaymentScope => c.statementPayment;
  const { funds: linkedFunds } = useLinkedFunds();
  // The card Pay bill is currently paying — the dialog's To account (starts as `payCard`, follows a change).
  const [payDestAccountId, setPayDestAccountId] = useState<string | null>(null);
  const payDestCard = payCard ? (creditCards.find((c) => c.card.accountId === (payDestAccountId ?? payCard.card.accountId)) ?? null) : null;
  // Card bill: people's shares of charges this card still carries — they must be settled before Pay bill completes.
  const { readiness: payCardPeople, readinessFor: payCardPeopleFor, isLoading: payCardPeopleLoading } = useLinkedPeopleReadiness(
    // This physical card's own bill — a shared facility's pooled total belongs to its sibling cards too.
    payDestCard ? { kind: "card", cardAccountId: payDestCard.card.accountId, lenderDue: Math.max(0, payDestCard.ownUsage) } : null,
  );

  // `?card=<id>` reopens that card — so Back from its filtered Transactions lands on the same card.
  const cardParams = useSearchParams();
  // `?card=<id>&pay=1` (People returns here after a settlement) reopens that card's Pay bill once, then drops `pay`.
  const reopenPayId = cardParams.get("pay") === "1" ? cardParams.get("card") : null;
  const [reopenedPay, setReopenedPay] = useState(false);
  if (reopenPayId && !reopenedPay && !cardsLoading) {
    setReopenedPay(true);
    const target = creditCards.find((c) => c.id === reopenPayId);
    if (target) {
      setPayChoice("statement");
      setPayCard(target);
    }
  }
  useEffect(() => {
    if (!reopenedPay || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("pay")) return;
    url.searchParams.delete("pay");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }, [reopenedPay]);
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

  /** Mobile's "Add another physical card" — a new card joining `sharedLimitId`, which supplies the limit. */
  function openAddToSharedLimit(sharedLimitId: string) {
    setForm({ ...emptyCardForm(), limitSource: "existingShared", selectedSharedLimitId: sharedLimitId });
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
    const addPair = !editingCard && form.limitSource === "newShared" && form.addPairCard;
    if (addPair) {
      if (!/^\d{4}$/.test(form.pairLastFourDigits)) {
        toast.error("The other card's last 4 digits are required and must be exactly 4 numbers.");
        return;
      }
      if (form.pairLastFourDigits === form.lastFourDigits) {
        toast.error("The two cards must have different last 4 digits.");
        return;
      }
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
          ...(form.cardNetwork ? { cardNetwork: form.cardNetwork } : {}),
          statementDay,
          paymentDueDay,
          bankId: form.bankId,
          ...(form.color ? { colorValue: colorValueForCardAccent(form.color) } : {}),
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
          colorValue: colorValueForCardAccent(form.color),
        });
        if (addPair && sharedLimitId) {
          // The second physical card on the new facility: own number/network/bill, ₹0 own limit (Flutter's `_createLinkedPairCard`).
          op.stage("related", "Adding the other card");
          await actions.createCard({
            name: form.pairName.trim() || `${name} ${form.pairCardNetwork ? form.pairCardNetwork.toUpperCase() : `•••• ${form.pairLastFourDigits}`}`,
            cardHolderName,
            creditLimit: 0,
            lastFourDigits: form.pairLastFourDigits,
            cardNetwork: form.pairCardNetwork || null,
            statementDay: Number(form.pairStatementDay) || statementDay,
            paymentDueDay: Number(form.pairPaymentDueDay) || paymentDueDay,
            bankId: form.bankId,
            sharedLimitId,
          });
        }
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
  const previewAccent = form.color ?? (editingCard ? editingCard.accent : ACCENT_CYCLE[creditCards.length % ACCENT_CYCLE.length]);

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

            {form.limitSource === "existingShared" && form.selectedSharedLimitId && (() => {
              // The facility supplies the limit — show what this card inherits and who it shares it with.
              const facility = sharedLimits.find((sl) => sl.id === form.selectedSharedLimitId);
              const members = creditCards.filter((c) => c.card.sharedLimitId === form.selectedSharedLimitId && c.id !== editingCard?.id);
              if (!facility) return null;
              return (
                <div className="flex flex-col gap-1 rounded-xl border border-border-strong/60 bg-background px-3 py-2.5 text-xs">
                  <span className="text-muted-foreground">Shares limit with</span>
                  {members.length > 0 ? (
                    members.map((m) => (
                      <span key={m.id} className="font-semibold text-foreground">
                        {m.name} <span className="font-mono tracking-widest">•••• {m.last4}</span>
                        {m.network !== "—" && <span className="ml-1 text-muted-foreground uppercase">{m.network}</span>}
                      </span>
                    ))
                  ) : (
                    <span className="font-semibold text-foreground">{facility.name}</span>
                  )}
                  <span className="mt-1 text-foreground/85">
                    Shared credit limit <span className="font-semibold tabular-nums">{formatCurrency(facility.creditLimit)}</span> — inherited, not entered again.
                    This is a separate card with its own number, bill and transactions.
                  </span>
                </div>
              );
            })()}

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

            {!editingCard && form.limitSource === "newShared" && (
              <div className="flex flex-col gap-3 rounded-xl border border-border-strong/60 bg-background p-3">
                <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-foreground">
                  <input
                    type="checkbox"
                    className="size-4 accent-current"
                    checked={form.addPairCard}
                    onChange={(e) => setForm((f) => ({ ...f, addPairCard: e.target.checked }))}
                  />
                  Also add the other card on this shared limit
                </label>
                {form.addPairCard && (
                  <>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-muted-foreground">Other card name (optional)</span>
                        <input
                          className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-primary"
                          placeholder="e.g. OCTANE Visa"
                          value={form.pairName}
                          onChange={(e) => setForm((f) => ({ ...f, pairName: e.target.value }))}
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-muted-foreground">Other card number (last 4 digits) *</span>
                        <input
                          className="h-10 rounded-xl border border-border bg-background px-3 font-mono text-sm tracking-widest outline-none transition-colors focus:border-primary"
                          placeholder="5678"
                          maxLength={4}
                          inputMode="numeric"
                          value={form.pairLastFourDigits}
                          onChange={(e) => setForm((f) => ({ ...f, pairLastFourDigits: e.target.value.replace(/\D/g, "") }))}
                        />
                      </label>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-muted-foreground">Other card network</span>
                      <div className="flex flex-wrap gap-2">
                        {CARD_NETWORK_OPTIONS.map((n) => {
                          const selected = form.pairCardNetwork === n;
                          return (
                            <button
                              key={n}
                              type="button"
                              onClick={() => setForm((f) => ({ ...f, pairCardNetwork: f.pairCardNetwork === n ? "" : n }))}
                              className={cn(
                                "border px-3 py-1.5 text-xs font-semibold transition-colors",
                                selected ? "border-primary bg-primary/10 text-primary-accent-text" : "border-border text-muted-foreground hover:bg-muted",
                              )}
                            >
                              {n.toUpperCase()}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-muted-foreground">Its bill day</span>
                        <input
                          type="number"
                          className="h-10 rounded-xl border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-primary"
                          placeholder={`Same (${form.statementDay || "—"})`}
                          value={form.pairStatementDay}
                          onChange={(e) => setForm((f) => ({ ...f, pairStatementDay: e.target.value }))}
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-muted-foreground">Its due day</span>
                        <input
                          type="number"
                          className="h-10 rounded-xl border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-primary"
                          placeholder={`Same (${form.paymentDueDay || "—"})`}
                          value={form.pairPaymentDueDay}
                          onChange={(e) => setForm((f) => ({ ...f, pairPaymentDueDay: e.target.value }))}
                        />
                      </label>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      A separate card with its own number, bill and transactions — it uses this same shared limit, so the limit isn&apos;t entered twice.
                    </p>
                  </>
                )}
              </div>
            )}

            <p className="text-[11px] text-muted-foreground">
              A shared limit is one combined credit line two cards from the same bank draw from — each keeps its own number and bill.
            </p>

          </div>

          <div className="flex flex-col gap-3 rounded-2xl bg-muted/30 p-4">
            <SectionLabel icon={Palette}>Card colour</SectionLabel>
            <div className="flex flex-wrap gap-2.5" role="radiogroup" aria-label="Card colour">
              {CARD_ACCENTS.map((accent) => {
                const selected = previewAccent === accent;
                return (
                  <button
                    key={accent}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={accent}
                    title={accent}
                    onClick={() => setForm((f) => ({ ...f, color: accent }))}
                    style={{ background: CARD_GRADIENT[accent] }}
                    className={cn(
                      "flex size-8 items-center justify-center rounded-full text-white shadow-e1 outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring",
                      selected && "ring-2 ring-primary-accent-text ring-offset-2 ring-offset-background",
                    )}
                  >
                    {selected && <Check className="size-4" />}
                  </button>
                );
              })}
            </div>
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

          {/* ── Card bills: the ONE bill each card's Pay now pays (`statementPayment.current`) ── */}
          <section id="upcoming-statements" aria-label="Card bills" className="flex scroll-mt-4 flex-col gap-3">
            <div className="flex items-center justify-between gap-3 border-b border-border-strong/50 pb-3">
              <h2 className="font-heading text-base font-semibold text-foreground">Card bills</h2>
              <button type="button" onClick={() => router.push("/transactions")} className={CC_LINK}>
                View all
                <ArrowRight className="size-3.5" strokeWidth={2} />
              </button>
            </div>
            <div className="overflow-hidden rounded-[10px] border border-border-strong/70 bg-card shadow-e1">
              <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
                <thead>
                  <tr>
                    <th className={CC_TH}>Card</th>
                    <th className={cn(CC_TH, "hidden w-40 md:table-cell")}>Statement</th>
                    <th className={cn(CC_TH, "w-32 text-right sm:w-36")}>Bill due</th>
                    <th className={cn(CC_TH, "hidden w-28 text-right lg:table-cell")}>Minimum</th>
                    <th className={cn(CC_TH, "w-[7.5rem] sm:w-[8.5rem]")}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {creditCards.map((card) => {
                    const scope = card.statementPayment;
                    const bill = scope.current;
                    const nextClose = statementWindowForDate(card.card, new Date()).periodEnd;
                    return (
                      <tr key={card.id} className="transition-colors hover:bg-secondary/40 [&:last-child>td]:border-b-0">
                        <td className={cn(CC_TD, "max-w-0")}>
                          <div className="flex min-w-0 items-center gap-3">
                            <CardChip card={card} />
                            <div className="min-w-0">
                              <p className="truncate font-semibold text-foreground">{card.name}</p>
                              <p className={cn("truncate text-xs font-medium tabular-nums", scope.currentOverdue ? "text-expense" : "text-foreground/75")}>
                                {bill == null
                                  ? `No bill due · closes ${formatShortDate(nextClose)}`
                                  : scope.currentOverdue
                                    ? `Overdue · was due ${formatShortDate(bill.dueDate)}`
                                    : `Due ${formatShortDate(bill.dueDate)}`}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className={cn(CC_TD, "hidden text-xs font-medium text-foreground/85 tabular-nums md:table-cell")}>
                          {bill ? billPeriodLabel(bill) : <span className="text-foreground/70">Next closes {formatShortDate(nextClose)}</span>}
                        </td>
                        <td className={cn(CC_TD, "text-right")}>
                          {bill ? (
                            <span className={cn("text-[17px] font-bold tabular-nums", scope.currentOverdue ? "text-expense" : "text-foreground")}>{formatCurrency(scope.statementDue)}</span>
                          ) : (
                            <span className="text-sm font-semibold text-foreground/70 tabular-nums">{formatCurrency(0)}</span>
                          )}
                          {scope.cardOutstanding > scope.statementDue + 0.005 && (
                            <p className="text-[11px] font-medium text-foreground/70 tabular-nums">of {formatCurrency(scope.cardOutstanding)} outstanding</p>
                          )}
                        </td>
                        <td className={cn(CC_TD, "hidden text-right tabular-nums lg:table-cell")}>
                          {/* Only an issuer figure from a stored statement — never a made-up ₹0. */}
                          {bill?.minimumDue != null ? (
                            <span className="font-semibold text-foreground">{formatCurrency(bill.minimumDue)}</span>
                          ) : (
                            <span className="text-xs font-medium text-foreground/65">{bill ? "Not tracked" : "—"}</span>
                          )}
                        </td>
                        <td className={cn(CC_TD, "px-2")}>
                          <div className="flex items-center justify-end gap-1">
                            {bill && (
                              <button
                                type="button"
                                onClick={() => {
                                  setPayChoice("statement");
                                  setPayCard(card);
                                }}
                                className="flex h-7 items-center gap-1 rounded-[6px] border border-primary-accent-text bg-primary px-2.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
                              >
                                Pay now
                              </button>
                            )}
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button type="button" aria-label="Bill actions" className="flex size-7 items-center justify-center rounded-[6px] text-foreground/70 hover:bg-secondary hover:text-foreground">
                                  <MoreHorizontal className="size-4" strokeWidth={1.75} />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="min-w-52 rounded-[8px]">
                                <DropdownMenuItem onSelect={() => setActiveCardId(card.id)}>View details</DropdownMenuItem>
                                {card.ownUsage > scope.statementDue + 0.005 && (
                                  <DropdownMenuItem
                                    onSelect={() => {
                                      setPayChoice("full");
                                      setPayCard(card);
                                    }}
                                  >
                                    Pay full outstanding {formatCurrency(card.ownUsage)}
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem disabled>
                                  Download statement
                                  <span className={cn(CC_SOON, "ml-auto")}>Soon</span>
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
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
                    {activeCard.sharedLimit && (
                      <p className="mt-1 flex items-center gap-1 text-xs text-white/85">
                        <Link2 className="size-3 shrink-0" />
                        <span className="truncate">
                          Shares {formatCurrency(activeCard.sharedLimit.creditLimit)} limit
                          {activeCard.sharedLimit.siblings.length > 0
                            ? ` with ${activeCard.sharedLimit.siblings.map((s) => `${s.name} •••• ${s.last4}`).join(", ")}`
                            : ` (${activeCard.sharedLimit.name})`}
                        </span>
                      </p>
                    )}
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
                <PanelFact label={activeCard.sharedLimit ? "Shared available" : "Available"} value={formatCurrency(available)} tone="text-success" />
                <PanelFact label={activeCard.sharedLimit ? "Shared limit" : "Credit limit"} value={formatCurrency(activeCard.creditLimit)} />
                {activeCard.sharedLimit && (
                  <>
                    <PanelFact label="This card usage" value={formatCurrency(activeCard.ownUsage)} />
                    <PanelFact label="Shared outstanding" value={formatCurrency(activeCard.currentBalance)} />
                  </>
                )}

                <PanelFact label="Next statement" value={activeCard.statementDate ? formatShortDate(activeCard.statementDate) : "—"} />
                <PanelFact
                  label="Payment due"
                  value={dueInDays == null ? "No due date" : dueInDays <= 0 ? "Due today" : `${dueInDays} days left`}
                  tone={dueInDays != null && dueInDays <= 5 ? "text-expense" : undefined}
                />
              </dl>

              <div className="grid grid-cols-4 gap-1 p-2">
                <QuickAction icon={Wallet} label="Pay bill" tone="bg-primary/25 text-foreground dark:text-primary-accent-text" onClick={() => {
                    setPayChoice("statement");
                    setPayCard(activeCard);
                  }}
                />
                <QuickAction
                  icon={FileText}
                  label="Statement"
                  tone="bg-purple/12 text-purple"
                  onClick={() => document.getElementById("upcoming-statements")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                />
                <QuickAction icon={RefreshCw} label="Convert to EMI" tone="bg-success/12 text-success" soon />
                <QuickAction icon={Settings} label="Card settings" tone="bg-secondary text-foreground/75" onClick={() => openEdit(activeCard)} />
              </div>
              <PayScope
                scope={payScopeOf(activeCard)}
                ownOutstanding={activeCard.ownUsage}
                onPayStatement={() => {
                  setPayChoice("statement");
                  setPayCard(activeCard);
                }}
                onPayFull={() => {
                  setPayChoice("full");
                  setPayCard(activeCard);
                }}
              />
              {activeCard.sharedLimit && (
                <div className="border-t border-border-strong/50 p-2">
                  <button
                    type="button"
                    onClick={() => openAddToSharedLimit(activeCard.sharedLimit!.id)}
                    className="flex w-full items-center justify-center gap-1.5 rounded-[6px] border border-border-strong/70 px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-secondary"
                  >
                    <Link2 className="size-3.5" />
                    Add another card to this shared limit
                  </button>
                </div>
              )}
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
          onOpenChange={(open) => {
            if (open) return;
            setPayCard(null);
            setPayDestAccountId(null);
          }}
          row={null}
          expense={null}
          people={people}
          accounts={txnAccounts}
          categories={txnCategories}
          actions={transactionActions}
          defaultKind="transfer"
          initialDestinationAccountId={payCard?.card.accountId}
          initialAmount={payCard ? payBillAmount(payScopeOf(payCard), payChoice, payCard.ownUsage) : undefined}
          onDestinationAccountChange={setPayDestAccountId}
          paymentScope={
            payDestCard
              ? {
                  accountId: payDestCard.card.accountId,
                  content: (
                    <PayBillDialogScope
                      scope={payScopeOf(payDestCard)}
                      ownOutstanding={payDestCard.ownUsage}
                      // The choice made outside belongs to the card it was made on; a switched To card reads as a statement payment.
                      choice={payDestCard.id === payCard?.id ? payChoice : "statement"}
                    />
                  ),
                }
              : null
          }
          peopleGate={
            payDestCard
              ? {
                  accountId: payDestCard.card.accountId,
                  readiness: payCardPeople,
                  // Only the current bill's own charges gate an amount within that bill (by transaction id);
                  // paying beyond it (explicit full outstanding) falls back to oldest-first reach.
                  readinessFor: payCardPeopleFor
                    ? (amount: number) => payCardPeopleFor(amount, payBillChargeScope(payScopeOf(payDestCard), amount))
                    : null,
                  loading: payCardPeopleLoading,
                  payeeName: payDestCard.name,
                  returnTo: `/credit-cards?card=${encodeURIComponent(payDestCard.id)}&pay=1`,
                }
              : null
          }
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

/**
 * What "Pay bill" pays, on this physical card's own statement cycle: the ONE current bill (primary
 * action), then what stays on the card for later (next statements + new purchases). Paying the whole
 * outstanding is a separate, secondary action; with no closed statement unpaid, nothing reads as "due".
 */
function PayScope({
  scope,
  ownOutstanding,
  onPayStatement,
  onPayFull,
}: {
  scope: CardStatementPaymentScope;
  ownOutstanding: number;
  onPayStatement: () => void;
  onPayFull: () => void;
}) {
  if (scope.statementDue <= 0 && ownOutstanding <= 0) return null;
  const bill = scope.current;
  const later = Math.round((scope.closedDue - scope.statementDue + scope.unbilled) * 100) / 100;
  return (
    <div className="flex flex-col gap-2 border-t border-border-strong/40 px-4 py-2.5 text-xs" data-testid="cc-pay-scope">
      <dl className="min-w-0 space-y-0.5">
        {bill ? (
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            <dt className="text-foreground/75">{scope.currentOverdue ? "Overdue bill" : "Current bill"}</dt>
            <dd className="font-semibold text-foreground tabular-nums">{formatCurrency(scope.statementDue)}</dd>
            <dd className={cn("text-foreground/75", scope.currentOverdue && "font-semibold text-expense")}>
              · {billPeriodLabel(bill)} · {scope.currentOverdue ? "was due" : "due"} {formatShortDate(bill.dueDate)}
            </dd>
          </div>
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            <dt className="text-foreground/75">Current outstanding</dt>
            <dd className="font-semibold text-foreground tabular-nums">{formatCurrency(ownOutstanding)}</dd>
            <dd className="text-foreground/75">· no bill due yet</dd>
          </div>
        )}
        {bill && later > 0.005 && (
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            <dt className="text-foreground/75">Later bills</dt>
            <dd className="font-medium text-foreground/85 tabular-nums">{formatCurrency(later)}</dd>
            <dd className="text-foreground/75">· not part of this payment</dd>
          </div>
        )}
      </dl>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1">
        {bill && (
          <button
            type="button"
            onClick={onPayStatement}
            className="h-7 rounded-[6px] border border-primary-accent-text bg-primary px-2.5 font-semibold text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring"
          >
            Pay bill {formatCurrency(scope.statementDue)}
          </button>
        )}
        {ownOutstanding > scope.statementDue + 0.005 && (
          <button
            type="button"
            onClick={onPayFull}
            className="font-semibold text-primary-accent-text underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Pay full outstanding {formatCurrency(ownOutstanding)}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Inside Pay bill, under the amount: which ONE bill the pre-filled amount pays — its period, due date and
 * (when partly paid) what's left — then, quieter, what stays on the card for later. Full mode says
 * plainly it pays the card's whole current outstanding, itemised.
 */
function PayBillDialogScope({ scope, ownOutstanding, choice }: { scope: CardStatementPaymentScope; ownOutstanding: number; choice: PayBillChoice }) {
  const row = "flex items-baseline justify-between gap-3";
  const label = "text-foreground/75";
  const figure = "font-semibold text-foreground tabular-nums";
  const bill = scope.current;
  const full = choice === "full";
  const eyebrow = "text-[11px] font-bold tracking-[0.08em] uppercase";
  return (
    <div className="mt-2 overflow-hidden rounded-[8px] border border-border-strong text-xs" data-testid="pay-bill-scope">
      {full ? (
        <div className="bg-secondary/40 px-3.5 py-2.5">
          <p className={cn(eyebrow, "mb-1.5 text-foreground/80")}>Paying full card outstanding</p>
          <dl className="space-y-0.5">
            {bill && (
              <div className={row}>
                <dt className={label}>Current bill · {billPeriodLabel(bill)}</dt>
                <dd className={figure}>{formatCurrency(bill.remaining)}</dd>
              </div>
            )}
            {scope.later.map((b) => (
              <div key={b.id} className={row}>
                <dt className={label}>Next statement · {billPeriodLabel(b)}</dt>
                <dd className={figure}>{formatCurrency(b.remaining)}</dd>
              </div>
            ))}
            {scope.unbilled > 0 && (
              <div className={row}>
                <dt className={label}>New purchases (not billed yet)</dt>
                <dd className={figure}>{formatCurrency(scope.unbilled)}</dd>
              </div>
            )}
            <div className={cn(row, "border-t border-border-strong pt-1")}>
              <dt className="font-semibold text-foreground">Card outstanding</dt>
              <dd className={cn(figure, "text-sm")}>{formatCurrency(ownOutstanding)}</dd>
            </div>
          </dl>
        </div>
      ) : bill == null ? (
        <p className="bg-secondary/40 px-3.5 py-2.5 font-medium text-foreground/80">No bill is due on this card — nothing has been billed and left unpaid.</p>
      ) : (
        <>
          <div className={cn("px-3.5 py-2.5", scope.currentOverdue ? "bg-expense/8" : "bg-primary/10")}>
            <div className={row}>
              <p className={cn(eyebrow, scope.currentOverdue ? "text-expense" : "text-foreground/80")}>{scope.currentOverdue ? "Overdue bill" : "Current bill"}</p>
              <p className="text-base font-bold text-foreground tabular-nums">{formatCurrency(bill.remaining)}</p>
            </div>
            <dl className="mt-1 space-y-0.5">
              <div className={row}>
                <dt className={label}>Statement period</dt>
                <dd className="font-medium text-foreground tabular-nums">{billPeriodLabel(bill)}</dd>
              </div>
              <div className={row}>
                <dt className={label}>{scope.currentOverdue ? "Was due" : "Due date"}</dt>
                <dd className={cn("font-medium tabular-nums", scope.currentOverdue ? "text-expense" : "text-foreground")}>{formatShortDate(bill.dueDate)}</dd>
              </div>
              {bill.amountPaid > 0.005 && (
                <>
                  <div className={row}>
                    <dt className={label}>Original bill</dt>
                    <dd className={figure}>{formatCurrency(bill.totalAmount)}</dd>
                  </div>
                  <div className={row}>
                    <dt className={label}>Already paid</dt>
                    <dd className={figure}>{formatCurrency(bill.amountPaid)}</dd>
                  </div>
                </>
              )}
            </dl>
          </div>
          {(scope.later.length > 0 || scope.unbilled > 0) && (
            <dl className="space-y-0.5 border-t border-border-strong/70 px-3.5 py-2 text-foreground/80">
              <p className={cn(eyebrow, "mb-0.5 text-foreground/70")}>Stays on the card · not in this payment</p>
              {scope.later.map((b) => (
                <div key={b.id} className={row}>
                  <dt className={label}>
                    Next statement · {billPeriodLabel(b)} · due {formatShortDate(b.dueDate)}
                  </dt>
                  <dd className="font-medium text-foreground/85 tabular-nums">{formatCurrency(b.remaining)}</dd>
                </div>
              ))}
              {scope.unbilled > 0 && (
                <div className={row}>
                  <dt className={label}>New purchases (not billed yet)</dt>
                  <dd className="font-medium text-foreground/85 tabular-nums">{formatCurrency(scope.unbilled)}</dd>
                </div>
              )}
              <div className={cn(row, "border-t border-border-strong/60 pt-1")}>
                <dt className={label}>Card outstanding</dt>
                <dd className="font-semibold text-foreground/90 tabular-nums">{formatCurrency(scope.cardOutstanding)}</dd>
              </div>
            </dl>
          )}
        </>
      )}
    </div>
  );
}
