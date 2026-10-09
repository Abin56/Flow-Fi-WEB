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
  Check,
  ChevronDown,
  Loader2,
  X as XIcon,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion, useDragControls, useReducedMotion } from "framer-motion";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { ClayButton } from "@/components/clay/clay-button";
import { transactionsHrefForAccount } from "@/features/transactions/lib/account-filter-param";
import { Stagger } from "@/components/foundation/animated-container";
import {
  BankCombobox,
  BankLogo,
  DestructiveDeleteDialog,
  type DestructiveDeleteImpactRow,
} from "@/components/finance";
import { useGuardedSubmit } from "@/components/finance/use-guarded-submit";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
import { bankById } from "@/lib/data/bank-registry";
import { autoCardName, defaultSharedLimitName, freshCardSaveIds, suggestedDueDay } from "@/features/credit-cards/lib/shared-limit-save";
import { CardEditConflictError, type AtomicCardSaveInput, type SaveLimit } from "@/lib/repositories/credit-card-save";
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
import { CardLimitSection } from "@/features/credit-cards/components/card-limit-section";
import { CardFormPreview, type PreviewCard } from "@/features/credit-cards/components/card-form-preview";
import { useAuthStore } from "@/store/auth-store";
import { fetchCardBillState } from "@/lib/repositories/repository-factory";
import type { CardBillState } from "@/lib/repositories/card-bill-people-gate";
import { useStoredStatementTotalRepair } from "@/features/credit-cards/hooks/use-stored-statement-total-repair";
import { TransactionDetailsModal } from "@/features/transactions/components/transaction-details-modal";
import { useTransactionActions, useTransactionRows } from "@/features/transactions/hooks/use-transactions-data";
import { usePeople } from "@/hooks/use-people";
import { toast } from "@/store/toast-store";
import { startOperation } from "@/store/operation-progress-store";
import { errorDetail } from "@/lib/operation-progress/operation-progress";
import { cn } from "@/lib/utils";
import { handleEnterAdvance } from "@/components/finance/enter-advance";
import { Field, FieldGroup, FormSection, LE_RADIUS, LOAN_EMI_INPUT, choiceClass } from "@/features/loans/components/loan-emi-ui";

const CARD_NETWORK_OPTIONS: CardNetwork[] = ["visa", "mastercard", "rupay", "amex"];

export type LimitSource = "own" | "newShared" | "existingShared";

export interface CardFormState {
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
  /** "Share with a card already in FlowFi" when that card has its own limit — it joins the new group on save. */
  linkCardId: string | null;
  /** Null = no colour picked — the card keeps its automatic list-position colour. */
  color: CardAccent | null;
  /** "Add another card now" — a second physical card created on the chosen shared limit (new or existing). */
  addPairCard: boolean;
  pairName: string;
  pairLastFourDigits: string;
  pairCardNetwork: CardNetwork | "";
  /** Null = same bank as this card. */
  pairBankId: string | null;
  /** Empty = same holder as this card. */
  pairCardHolderName: string;
  /** Null = automatic (the colour after this card's). */
  pairColor: CardAccent | null;
  pairStatementDay: string;
  pairPaymentDueDay: string;
}

const EMPTY_PAIR_FIELDS = {
  addPairCard: false,
  pairName: "",
  pairLastFourDigits: "",
  pairCardNetwork: "",
  pairBankId: null,
  pairCardHolderName: "",
  pairColor: null,
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
    paymentDueDay: "21",
    bankId: null,
    limitSource: "own",
    sharedLimitName: "",
    sharedLimitAmount: "",
    selectedSharedLimitId: null,
    linkCardId: null,
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
    // Prefilled with the group's current combined limit; saving a different value changes it for every card on the group.
    sharedLimitAmount: card.sharedLimit ? String(card.sharedLimit.creditLimit) : "",
    selectedSharedLimitId: card.card.sharedLimitId ?? null,
    linkCardId: null,
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
  const { rows: recentCardTransactions, isLoading: recentLoading } = useRecentCreditCardTransactions(Number.POSITIVE_INFINITY);
  const { data: accounts = [] } = useAccounts();
  const { data: sharedLimits = [] } = useSharedCreditLimits();
  const actions = useCreditCardActions();
  const router = useRouter();

  const { data: people = [] } = usePeople();
  const { rows: transactionRows, accounts: txnAccounts, categories: txnCategories } = useTransactionRows();
  const transactionActions = useTransactionActions();
  // One-time repair of stored statement totals written by the old credit-as-charge formula (writes only when provably affected).
  useStoredStatementTotalRepair();
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
  // "Refresh bill" result — an authoritative Firestore read (`fetchCardBillState`) of the To card's bill,
  // shown in the dialog in place of the live-feed figures until the dialog closes or the To card changes.
  const uid = useAuthStore((s) => s.user?.uid);
  const [freshPay, setFreshPay] = useState<{ accountId: string; state: CardBillState } | null>(null);
  const freshPayState = payDestCard && freshPay?.accountId === payDestCard.card.accountId ? freshPay.state : null;
  const payDestScope = freshPayState?.scope ?? (payDestCard ? payScopeOf(payDestCard) : null);
  async function refreshPayBill(accountId: string) {
    if (!uid) throw new Error("Not signed in");
    const state = await fetchCardBillState(uid, accountId);
    if (state == null) return null;
    setFreshPay({ accountId, state });
    const current = state.scope.current;
    return current ? { accountId, statementId: current.id, remaining: current.remaining } : null;
  }
  // The statement normal Pay Now is paying (the dialog snapshots it per payment action).
  const payCurrentStatement = payDestScope?.current ?? null;
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
  // Card activity tabs — follow the selected card; "All cards" widens the same view (presentation only).
  const [activityTab, setActivityTab] = useState<ActivityTab>("bills");
  const [activityAllCards, setActivityAllCards] = useState(false);
  // Card activity bottom sheet — opens over the page so the summary and cards above stay put.
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetDrag = useDragControls();
  // True only in the browser (after hydration) — the sheet is portalled to <body>.
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => {
      // Esc closes the sheet — unless a dialog (e.g. Pay bill) is open on top and should take it.
      if (e.key === "Escape" && !document.querySelector('[role="dialog"][data-state="open"]')) setSheetOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheetOpen]);
  // Where the pushed-up panel sits: the page's content column (never over the sidebar or top bar), from just
  // under the summary strip — capped so the panel always gets most of the height — down to the bottom.
  const [sheetBox, setSheetBox] = useState<{ top: number; left: number; width: number; mainTop: number; mainLeft: number; mainWidth: number } | null>(null);
  const measureSheet = () => {
    const main = document.querySelector("main");
    if (!main) return;
    const r = main.getBoundingClientRect();
    const cs = getComputedStyle(main);
    const inner = Math.min(r.width - (parseFloat(cs.paddingLeft) || 16) - (parseFloat(cs.paddingRight) || 16), 1600);
    const summary = document.getElementById("cc-summary")?.getBoundingClientRect();
    const minTop = r.top + 12;
    const maxTop = r.top + r.height * 0.3;
    const top = summary && summary.bottom > r.top ? Math.min(Math.max(summary.bottom + 12, minTop), maxTop) : minTop;
    setSheetBox({ top, left: r.left + (r.width - inner) / 2, width: inner, mainTop: r.top, mainLeft: r.left, mainWidth: r.width });
  };
  useEffect(() => {
    if (!sheetOpen) return;
    window.addEventListener("resize", measureSheet);
    return () => window.removeEventListener("resize", measureSheet);
  });
  const openActivitySheet = (tab?: ActivityTab, all?: boolean) => {
    if (tab) setActivityTab(tab);
    if (all != null) setActivityAllCards(all);
    measureSheet();
    setSheetOpen(true);
  };
  // Card picked → its activity opens in the sheet; tab/scope change → the sheet's content starts at its top.
  const revealActivity = (mode: "card" | "content") => {
    if (mode === "card") {
      measureSheet();
      setSheetOpen(true);
      return;
    }
    requestAnimationFrame(() => document.getElementById("card-activity-body")?.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" }));
  };
  // Picking a card shows that card's activity (not "All cards").
  const selectCard = (id: string) => {
    setActiveCardId(id);
    setActivityAllCards(false);
    revealActivity("card");
  };
  const changeActivityTab = (tab: ActivityTab) => {
    setActivityTab(tab);
    revealActivity("content");
  };
  const changeActivityScope = (all: boolean) => {
    setActivityAllCards(all);
    revealActivity("content");
  };
  // Hovering a shared-limit card lights up its partner card(s) — presentation only.
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
  // The issuing bank of a card, from its linked account — for showing its logo.
  const bankIdOf = (c: CreditCardViewItem) => (accounts as Account[]).find((a) => a.id === c.card.accountId)?.bankId ?? null;
  const [hoveredSharedLimitId, setHoveredSharedLimitId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editingCard, setEditingCard] = useState<CreditCardViewItem | null>(null);
  const [deletingCard, setDeletingCard] = useState<CreditCardViewItem | null>(null);
  const [deletingCardBusy, setDeletingCardBusy] = useState(false);
  const [cardDeletionImpact, setCardDeletionImpact] = useState<CreditCardDeletionImpact | null>(null);
  const [form, setForm] = useState<CardFormState>(emptyCardForm);
  const [saving, setSaving] = useState(false);
  // Adding a second card widens the dialog and folds this card's details into a summary (until reopened).
  const [detailsOpen, setDetailsOpen] = useState(false);
  const pairWide = form.limitSource !== "own" && form.addPairCard;
  const pairFocus = pairWide && !detailsOpen;
  const reduceMotion = useReducedMotion();
  // New-document ids for this dialog session — fixed when it opens, so a retried save (even one whose first
  // attempt committed but whose response was lost) can never create a second limit or card.
  const saveIds = useRef(freshCardSaveIds());

  function openAdd() {
    saveIds.current = freshCardSaveIds();
    setDetailsOpen(false);
    setForm(emptyCardForm());
    setAddOpen(true);
  }

  /** Mobile's "Add another physical card" — a new card joining `sharedLimitId`, which supplies the limit. */
  function openAddToSharedLimit(sharedLimitId: string) {
    saveIds.current = freshCardSaveIds();
    setDetailsOpen(false);
    const group = sharedLimits.find((sl) => sl.id === sharedLimitId);
    setForm({
      ...emptyCardForm(),
      limitSource: "existingShared",
      selectedSharedLimitId: sharedLimitId,
      sharedLimitAmount: group ? String(group.creditLimit) : "",
    });
    setAddOpen(true);
  }

  function openEdit(card: CreditCardViewItem) {
    saveIds.current = freshCardSaveIds();
    setDetailsOpen(false);
    setForm(cardFormFromCard(card, accounts as Account[]));
    setEditingCard(card);
  }

  const submitCard = useGuardedSubmit(handleSaveCard, saving);

  async function handleSaveCard() {
    if (!actions) return;
    if (!/^\d{4}$/.test(form.lastFourDigits)) {
      setDetailsOpen(true);
      toast.error("Last 4 digits are required and must be exactly 4 numbers.");
      return;
    }
    if (!form.bankId) {
      setDetailsOpen(true);
      toast.error("Choose the bank that issued this card.");
      return;
    }
    // Optional: a blank name becomes e.g. "HDFC Visa"; a blank holder is simply not recorded.
    const name = form.name.trim() || autoCardName(bankById(form.bankId), form.cardNetwork || null, form.lastFourDigits);
    const cardHolderName = form.cardHolderName.trim() || null;
    let creditLimit = 0;
    let limit: SaveLimit = { kind: "own" };
    if (form.limitSource === "own") {
      creditLimit = Number(form.creditLimit);
      if (!Number.isFinite(creditLimit) || creditLimit <= 0) {
        toast.error("Credit limit must be greater than 0.");
        return;
      }
    } else {
      const combined = Number(form.sharedLimitAmount);
      if (form.limitSource === "newShared") {
        if (!Number.isFinite(combined) || combined <= 0) {
          toast.error("Shared credit limit must be greater than 0.");
          return;
        }
        limit = { kind: "new", name: form.sharedLimitName.trim() || defaultSharedLimitName(bankById(form.bankId)), creditLimit: combined };
      } else {
        const group = sharedLimits.find((sl) => sl.id === form.selectedSharedLimitId);
        if (!group) {
          toast.error("Choose the other card that shares this limit.");
          return;
        }
        if (form.sharedLimitAmount.trim() !== "" && (!Number.isFinite(combined) || combined <= 0)) {
          toast.error("Shared credit limit must be greater than 0.");
          return;
        }
        const changed = form.sharedLimitAmount.trim() !== "" && combined !== group.creditLimit;
        limit = { kind: "existing", sharedLimitId: group.id, newCreditLimit: changed ? combined : null };
      }
    }
    const addPair = form.limitSource !== "own" && form.addPairCard;
    // An existing card picked as "the other card" — put on the target limit (no-op if it is already on it).
    const linkCard = form.limitSource !== "own" && form.linkCardId ? (creditCards.find((c) => c.id === form.linkCardId) ?? null) : null;
    if (addPair) {
      if (!/^\d{4}$/.test(form.pairLastFourDigits)) {
        toast.error("The other card's last 4 digits are required and must be exactly 4 numbers.");
        return;
      }
      if (form.pairLastFourDigits === form.lastFourDigits) {
        toast.error("The two cards must have different last 4 digits.");
        return;
      }
      if (limit.kind === "existing" && creditCards.some((c) => c.card.sharedLimitId === form.selectedSharedLimitId && c.last4 === form.pairLastFourDigits)) {
        toast.error(`A card ending ${form.pairLastFourDigits} already uses this shared limit.`);
        return;
      }
    }
    const statementDay = Number(form.statementDay);
    const paymentDueDay = Number(form.paymentDueDay);
    if (!Number.isInteger(statementDay) || statementDay < 1 || statementDay > 31) {
      setDetailsOpen(true);
      toast.error("Statement day must be between 1 and 31.");
      return;
    }
    if (!Number.isInteger(paymentDueDay) || paymentDueDay < 1 || paymentDueDay > 31) {
      setDetailsOpen(true);
      toast.error("Payment due day must be between 1 and 31.");
      return;
    }
    const pairStatementDay = form.pairStatementDay.trim() === "" ? statementDay : Number(form.pairStatementDay);
    const pairPaymentDueDay = form.pairPaymentDueDay.trim() === "" ? paymentDueDay : Number(form.pairPaymentDueDay);
    if (addPair && ![pairStatementDay, pairPaymentDueDay].every((d) => Number.isInteger(d) && d >= 1 && d <= 31)) {
      toast.error("The other card's bill and due days must be between 1 and 31.");
      return;
    }

    const baseAccount = editingCard ? ((accounts as Account[]).find((a) => a.id === editingCard.card.accountId) ?? null) : null;
    const input: AtomicCardSaveInput = {
      ids: saveIds.current,
      limit,
      primary: editingCard
        ? {
            kind: "edit",
            base: { card: editingCard.card, account: baseAccount },
            desired: {
              name,
              bankId: form.bankId,
              cardHolderName,
              lastFourDigits: form.lastFourDigits,
              cardNetwork: form.cardNetwork || null,
              statementDay,
              paymentDueDay,
              // A shared-limit card's own stored limit is left as it is — the shared limit supplies it.
              creditLimit: form.limitSource === "own" ? creditLimit : editingCard.card.creditLimit,
              colorValue: form.color ? colorValueForCardAccent(form.color) : (baseAccount?.colorValue ?? 0),
            },
          }
        : {
            kind: "create",
            card: {
              name,
              bankId: form.bankId,
              cardHolderName,
              lastFourDigits: form.lastFourDigits,
              cardNetwork: form.cardNetwork || null,
              statementDay,
              paymentDueDay,
              creditLimit,
              colorValue: colorValueForCardAccent(form.color),
            },
          },
      // The second physical card: its own number/network/bill, ₹0 own limit (Flutter's `_createLinkedPairCard`).
      pair: addPair
        ? {
            name:
              form.pairName.trim() ||
              autoCardName(bankById(form.pairBankId ?? form.bankId), form.pairCardNetwork || null, form.pairLastFourDigits),
            bankId: form.pairBankId ?? form.bankId,
            cardHolderName: form.pairCardHolderName.trim() || cardHolderName,
            lastFourDigits: form.pairLastFourDigits,
            cardNetwork: form.pairCardNetwork || null,
            statementDay: pairStatementDay,
            paymentDueDay: pairPaymentDueDay,
            creditLimit: 0,
            colorValue: colorValueForCardAccent(pairAccent),
          }
        : null,
      link: linkCard ? { cardId: linkCard.id, baseSharedLimitId: linkCard.card.sharedLimitId } : null,
    };

    setSaving(true);
    const op = startOperation(
      editingCard
        ? { label: "Updating credit card", successLabel: "Card updated", errorLabel: "Couldn't update card" }
        : { label: "Adding credit card", successLabel: "Card added", errorLabel: "Couldn't add card" },
    );
    try {
      op.stage("submit", addPair || linkCard ? "Saving both cards" : editingCard ? "Saving card details" : "Saving card & account");
      await actions.saveCardAtomically(input);
      const both = addPair || linkCard != null;
      if (editingCard) {
        setEditingCard(null);
        op.succeed({ toast: { title: both ? "Cards now share one limit" : "Card updated" } });
      } else {
        setAddOpen(false);
        op.succeed({ toast: { title: both ? "Cards now share one limit" : "Card added" } });
      }
    } catch (e) {
      // One transaction: nothing was written. The dialog stays open with everything entered; a retry reuses the same ids.
      if (e instanceof CardEditConflictError) op.fail({ detail: e.message });
      else op.fail({ detail: errorDetail(e) ?? "Something went wrong. Please try again.", retry: handleSaveCard });
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
  // What the Card activity tabs show: the selected card, or every card with "All cards".
  const activityCards = activityAllCards || !activeCard ? creditCards : creditCards.filter((c) => c.id === activeCard.id);
  // Every loaded card transaction (newest first) for the scope, so an empty list really means none recorded.
  const activityPool = activityAllCards || !activeCard ? recentCardTransactions : recentCardTransactions.filter((t) => t.card.id === activeCard.id);
  const activityTransactions = activityPool.slice(0, 8);

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
  // The other card on the limit, peeking out behind this one: the card being added, a linked card, or a current member.
  const previewCard: PreviewCard = {
    name: form.name.trim() || autoCardName(bankById(form.bankId), form.cardNetwork || null, form.lastFourDigits || "••••"),
    holder: form.cardHolderName.trim(),
    last4: form.lastFourDigits,
    network: form.cardNetwork || null,
  };
  // The second card's colour: its own pick, else the next colour after this card's so the two read apart.
  const pairAccent: CardAccent = form.pairColor ?? CARD_ACCENTS[(CARD_ACCENTS.indexOf(previewAccent) + 1) % CARD_ACCENTS.length];
  const previewPartner: PreviewCard | null = (() => {
    if (form.limitSource === "own") return null;
    if (form.addPairCard) {
      const bank = bankById(form.pairBankId ?? form.bankId);
      return {
        name: form.pairName.trim() || autoCardName(bank, form.pairCardNetwork || null, form.pairLastFourDigits || "••••"),
        holder: form.pairCardHolderName.trim() || form.cardHolderName.trim(),
        last4: form.pairLastFourDigits,
        network: form.pairCardNetwork || null,
        background: CARD_GRADIENT[pairAccent],
        bankId: form.pairBankId ?? form.bankId,
      };
    }
    const other =
      creditCards.find((c) => c.id === form.linkCardId) ??
      creditCards.find((c) => c.id !== editingCard?.id && c.card.sharedLimitId != null && c.card.sharedLimitId === form.selectedSharedLimitId);
    return other
      ? { name: other.name, holder: other.card.cardHolderName ?? "", last4: other.last4, network: other.card.cardNetwork ?? null, background: CARD_GRADIENT[other.accent], bankId: bankIdOf(other) }
      : null;
  })();
  const previewAmount = Number(form.limitSource === "own" ? form.creditLimit : form.sharedLimitAmount);
  const previewLimitLine =
    previewAmount > 0
      ? form.limitSource === "own"
        ? `Credit limit ${formatCurrency(previewAmount)}`
        : `${previewPartner ? "Both cards share" : "Shared limit"} ${formatCurrency(previewAmount)} — counted once`
      : null;

  const closeCardDialog = () => {
    setAddOpen(false);
    setEditingCard(null);
  };

  const cardFormDialog = (
    <Dialog open={addOpen || editingCard != null} onOpenChange={(open) => !open && closeCardDialog()}>
      <DialogContent
        showCloseButton={false}
        // Open on the first text field (the appearance pickers sit above it in the DOM).
        onOpenAutoFocus={(e) => {
          const first = document.getElementById(editingCard ? "cc-form-card-name" : "cc-form-last4");
          if (first) {
            e.preventDefault();
            first.focus();
          }
        }}
        className={cn(
          "flex flex-col gap-0 overflow-hidden border border-border bg-card p-0 shadow-[var(--shadow-e4)] ring-0",
          // Phone: full-height sheet. Desktop: centered panel — same surface as the Loan & EMI dialogs.
          "top-0 left-0 h-[100dvh] max-h-[100dvh] max-w-none translate-x-0 translate-y-0 rounded-none",
          "sm:top-1/2 sm:left-1/2 sm:h-auto sm:max-h-[min(90vh,48rem)] sm:max-w-2xl sm:transition-[max-width] sm:duration-300 sm:ease-out",
          pairWide && "sm:max-w-4xl",
          "sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[10px]",
        )}
      >
        <DialogHeader className="flex shrink-0 flex-row items-center gap-3 border-b border-border bg-card py-3 pr-14 pl-5 text-left">
          <span className={cn(LE_RADIUS.control, "flex size-8 shrink-0 items-center justify-center bg-primary text-primary-foreground")}>
            <CreditCardIcon className="size-4" strokeWidth={2} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0">
            <DialogTitle className="font-heading text-base leading-tight font-semibold tracking-tight">
              {editingCard ? `Edit ${editingCard.name}` : "Add a Credit Card"}
            </DialogTitle>
            {!editingCard && (
              <DialogDescription className="truncate text-xs text-muted-foreground">
                Track spending, utilization and due dates.
              </DialogDescription>
            )}
          </div>
        </DialogHeader>

        {/* Real <form> (display: contents keeps the layout): Enter in a single-line field saves via the same handler as the primary button. */}
        <form className="contents" noValidate onSubmit={submitCard} onKeyDown={handleEnterAdvance}>

        <div className="flex min-h-0 flex-1">
          {/* Adding a second card: both cards stay in view beside the form while it scrolls. */}
          {pairWide && (
            <motion.aside
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.25, ease: "easeOut" }}
              className="hidden w-[260px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-border bg-secondary/40 px-4 py-4 sm:flex"
            >
              <CardFormPreview variant="pair" card={previewCard} partner={previewPartner} background={CARD_GRADIENT[previewAccent]} bank={form.bankId} limitLine={previewLimitLine} />
            </motion.aside>
          )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-card px-5 py-4 text-sm [&>*+*]:border-t [&>*+*]:border-border [&>*+*]:pt-4">
          {/* Live preview beside the appearance pickers — what you pick is what you see. */}
          <div className={cn("grid grid-cols-1 gap-4 sm:items-center", pairWide ? "sm:grid-cols-1" : "sm:grid-cols-[240px_1fr]")}>
            {/* In wide pair mode the side panel shows the cards; phones keep this one. */}
            <div className={cn(pairWide && "sm:hidden")}>
              <CardFormPreview
                card={previewCard}
                partner={previewPartner}
                background={CARD_GRADIENT[previewAccent]}
                bank={form.bankId}
                limitLine={previewLimitLine}
              />
            </div>

            <div className="flex min-w-0 flex-col gap-3">
              <FieldGroup label="Card colour" className="gap-1.5">
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Card colour">
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
                          "flex size-7 items-center justify-center rounded-full text-white shadow-e1 outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring",
                          selected && "ring-2 ring-primary-accent-text ring-offset-2 ring-offset-card",
                        )}
                      >
                        {selected && <Check className="size-3.5" strokeWidth={2.5} />}
                      </button>
                    );
                  })}
                </div>
              </FieldGroup>

              <FieldGroup label="Network (optional)" className="gap-1.5">
                <div className="flex flex-wrap gap-1.5">
                  {CARD_NETWORK_OPTIONS.map((n) => {
                    const selected = form.cardNetwork === n;
                    return (
                      <button
                        key={n}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setForm((f) => ({ ...f, cardNetwork: f.cardNetwork === n ? "" : n }))}
                        className={cn(CC_FORM_CHOICE, choiceClass(selected))}
                      >
                        {selected && <Check className="size-3.5" strokeWidth={2.5} />}
                        {n.toUpperCase()}
                      </button>
                    );
                  })}
                </div>
              </FieldGroup>
            </div>
          </div>

          {/* Adding a second card: this card's details fold into a one-line summary so the new card has the room. */}
          <AnimatePresence initial={false} mode="popLayout">
            {pairFocus ? (
              <motion.div
                key="details-summary"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: reduceMotion ? 0 : 0.18 }}
              >
                <button
                  type="button"
                  onClick={() => setDetailsOpen(true)}
                  className={cn(
                    LE_RADIUS.card,
                    "flex w-full items-center gap-3 border border-border-strong bg-secondary/60 px-3 py-2 text-left outline-none transition-colors hover:border-muted-foreground focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                >
                  <CreditCardIcon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px] font-semibold text-foreground">
                      {form.name.trim() || autoCardName(bankById(form.bankId), form.cardNetwork || null, form.lastFourDigits || "••••")}
                      <span className="ml-1.5 font-mono font-normal tracking-widest text-muted-foreground">•••• {form.lastFourDigits || "••••"}</span>
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {bankById(form.bankId)?.name ?? "No bank yet"} · Statement {form.statementDay || "—"} · Due {form.paymentDueDay || "—"}
                    </span>
                  </span>
                  <span className="text-xs font-medium text-muted-foreground">Edit</span>
                </button>
              </motion.div>
            ) : (
              <motion.div
                key="details-full"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.22, ease: "easeOut" }}
                className="flex flex-col gap-4 overflow-hidden [&>*+*]:border-t [&>*+*]:border-border [&>*+*]:pt-4"
              >
          <FormSection title="Card details" icon={CreditCardIcon} className="gap-3">
            <div className="grid grid-cols-1 gap-x-3 gap-y-2.5 sm:grid-cols-2">
              <Field label="Bank *" className="gap-1">
                <BankCombobox
                  value={form.bankId}
                  onChange={(bankId) => setForm((f) => ({ ...f, bankId }))}
                  placeholder="Search for your bank…"
                  className={CC_FORM_COMBOBOX}
                />
              </Field>

              <Field label="Last 4 digits *" className="gap-1">
                <input
                  id="cc-form-last4"
                  className={cn(CC_INPUT, "font-mono tracking-widest")}
                  placeholder="4021"
                  maxLength={4}
                  inputMode="numeric"
                  value={form.lastFourDigits}
                  onChange={(e) => setForm((f) => ({ ...f, lastFourDigits: e.target.value.replace(/\D/g, "") }))}
                />
              </Field>

              <Field label="Card name" className="gap-1">
                <div className="relative">
                  <CreditCardIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.75} />
                  <input
                    id="cc-form-card-name"
                    className={cn(CC_INPUT, "pl-9")}
                    placeholder={autoCardName(bankById(form.bankId), form.cardNetwork || null, form.lastFourDigits || "••••")}
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  />
                </div>
              </Field>

              <Field label="Card holder" className="gap-1">
                <div className="relative">
                  <User className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.75} />
                  <input
                    className={cn(CC_INPUT, "pl-9")}
                    placeholder="Optional"
                    value={form.cardHolderName}
                    onChange={(e) => setForm((f) => ({ ...f, cardHolderName: e.target.value }))}
                  />
                </div>
              </Field>
            </div>
          </FormSection>

          <FormSection
            title="Billing cycle"
            description="Day of the month, as printed on your statement"
            icon={CalendarClock}
            className="gap-3"
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label="Statement day" className="gap-1">
                <input
                  type="number"
                  min={1}
                  max={31}
                  inputMode="numeric"
                  className={CC_INPUT}
                  value={form.statementDay}
                  onChange={(e) => {
                    const statementDay = e.target.value;
                    setForm((f) => {
                      // Keep the due day following the statement day until the user sets it themselves.
                      const prev = Number(f.statementDay);
                      const followed = !Number.isInteger(prev) || f.paymentDueDay === String(suggestedDueDay(prev)) || f.paymentDueDay === "";
                      const next = Number(statementDay);
                      const autoDue = followed && Number.isInteger(next) && next >= 1 && next <= 31 ? String(suggestedDueDay(next)) : f.paymentDueDay;
                      return { ...f, statementDay, paymentDueDay: editingCard ? f.paymentDueDay : autoDue };
                    });
                  }}
                />
              </Field>
              <Field label="Payment due day" className="gap-1">
                <input
                  type="number"
                  min={1}
                  max={31}
                  inputMode="numeric"
                  className={CC_INPUT}
                  value={form.paymentDueDay}
                  onChange={(e) => setForm((f) => ({ ...f, paymentDueDay: e.target.value }))}
                />
              </Field>
            </div>
            {editingCard &&
              (form.statementDay !== String(editingCard.card.statementDay) || form.paymentDueDay !== String(editingCard.card.paymentDueDay)) && (
                <p className="text-[11px] leading-snug text-muted-foreground">
                  Bills already saved keep their dates; unsaved past cycles are worked out with the new days.
                </p>
              )}
          </FormSection>
              </motion.div>
            )}
          </AnimatePresence>

          <CardLimitSection form={form} setForm={setForm} sharedLimits={sharedLimits} creditCards={creditCards} editingCard={editingCard} pairAccent={pairAccent} bankIdOf={bankIdOf} />

        </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-secondary px-5 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] sm:pb-2.5">
          <ClayButton variant="secondary" className="h-9 rounded-[6px] border-border-strong font-medium" onClick={closeCardDialog} disabled={saving}>
            Cancel
          </ClayButton>
          <ClayButton
            type="submit"
            variant="primary"
            className="h-9 min-w-28 flex-1 gap-1.5 rounded-[6px] border-primary-accent-text font-semibold sm:flex-none"
            disabled={saving}
            aria-busy={saving}
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            {saving ? "Saving…" : editingCard ? "Save Changes" : "Add Card"}
          </ClayButton>
        </div>
        </form>
        {/* Close sits last in the DOM (absolutely positioned, so visually unchanged): focus opens on the first field. */}
        <button
          type="button"
          onClick={closeCardDialog}
          aria-label="Close"
          className={cn(
            LE_RADIUS.control,
            "absolute top-3 right-4 flex size-8 items-center justify-center border border-transparent text-muted-foreground outline-none transition-colors duration-150 hover:border-border hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <XIcon className="size-4" strokeWidth={1.75} />
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
      <section id="cc-summary" aria-label="Summary" className="@container overflow-hidden rounded-[10px] border border-border-strong/60 bg-card shadow-e1">
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

      {/* Eases back slightly while the activity panel is pushed up over it — one stacked layer, not a modal. */}
      <motion.div
        className="grid origin-top grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start"
        animate={sheetOpen && !reduceMotion ? { scale: 0.985, opacity: 0.55 } : { scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 30 }}
      >
        {/* ── Card selection ── */}
        <div className="flex min-w-0 flex-col gap-6 xl:col-start-1 xl:row-start-1">
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
              <Stagger className="grid grid-cols-1 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(15.5rem,1fr))]">
                {creditCards.map((card) => (
                  <CreditCardTile
                    key={card.id}
                    card={card}
                    bankId={bankIdOf(card)}
                    active={card.id === activeCard?.id}
                    partnerHighlighted={hoveredSharedLimitId != null && card.sharedLimit?.id === hoveredSharedLimitId && card.id !== hoveredCardId}
                    onHoverChange={(hovered) => {
                      setHoveredCardId(hovered ? card.id : null);
                      setHoveredSharedLimitId(hovered ? (card.sharedLimit?.id ?? null) : null);
                    }}
                    onClick={() => selectCard(card.id)}
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
                          onClick={() => selectCard(card.id)}
                          // Keyboard: the row is one tab stop; Enter/Space selects the card, same as a click.
                          tabIndex={0}
                          aria-current={active || undefined}
                          onKeyDown={(e) => {
                            if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                              e.preventDefault();
                              selectCard(card.id);
                            }
                          }}
                          className={cn("cursor-pointer transition-colors hover:bg-secondary/60 [&:last-child>td]:border-b-0", active && "bg-primary/10 hover:bg-primary/15")}
                        >
                          <td className={cn(CC_TD, "max-w-0")}>
                            <div className="flex min-w-0 items-center gap-3">
                              <CardChip card={card} bankId={bankIdOf(card)} />
                              <div className="min-w-0">
                                <CardTitleLine card={card} />
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
        </div>

        <aside className="flex min-w-0 flex-col gap-5 xl:sticky xl:top-0 xl:col-start-2 xl:row-span-2 xl:row-start-1">
          {activeCard && (
            <SelectedCardPanel
              card={activeCard}
              bankId={bankIdOf(activeCard)}
              siblingBankId={(id) => {
                const sibling = creditCards.find((c) => c.id === id);
                return sibling ? bankIdOf(sibling) : null;
              }}
              utilization={utilization}
              available={available}
              dueInDays={dueInDays}
              reduceMotion={reduceMotion}
              onPayBill={() => {
                setPayChoice("statement");
                setPayCard(activeCard);
              }}
              onStatement={() => {
                openActivitySheet("bills", false);
              }}
              onEdit={() => openEdit(activeCard)}
              onAddToShared={() => openAddToSharedLimit(activeCard.sharedLimit!.id)}
              onViewTransactions={() => {
                // Only filters the existing Transactions list to this card's account — nothing is re-read as income/expense.
                router.replace(`/credit-cards?card=${encodeURIComponent(activeCard.id)}`, { scroll: false });
                router.push(transactionsHrefForAccount(activeCard.card.accountId));
              }}
              payScope={
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
              }
              linkedNotice={
                <LinkedFundsPayNotice
                  funds={linkedPendingForCard(linkedFunds, activeCard.card.accountId)}
                  accountName={(id) => accounts.find((a) => a.id === id)?.name}
                  className="mx-4 mb-3"
                />
              }
            />
          )}

        </aside>

        {/* ── Card activity: the selected card's bills, transactions and spending, one tab at a time ── */}
        <ActivityLauncher
          card={activeCard}
          bankId={activeCard ? bankIdOf(activeCard) : null}
          onOpen={(tab, all) => openActivitySheet(tab, all)}
        />
      </motion.div>

      {/* The activity bottom sheet — slides up over the page, so the summary and cards above never move. Portalled
          to <body> (the page sits inside a transformed container, which would trap `fixed`); on the app's
          `attached` layer, under dialogs, so Pay bill etc. still open on top of it. */}
      {mounted && createPortal(
      <AnimatePresence>
        {sheetOpen && (
          <>
            <motion.div
              key="activity-backdrop"
              aria-hidden
              style={sheetBox ? { top: sheetBox.mainTop, left: sheetBox.mainLeft, width: sheetBox.mainWidth, bottom: 0 } : undefined}
              className="fixed z-attached bg-black/10"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.2 }}
              onClick={() => setSheetOpen(false)}
            />
            <motion.section
              key="activity-sheet"
              id="card-activity"
              role="dialog"
              aria-label="Card activity"
              initial={reduceMotion ? { opacity: 0 } : { y: "100%" }}
              animate={reduceMotion ? { opacity: 1 } : { y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { y: "100%" }}
              transition={{ type: "spring", stiffness: 320, damping: 34, mass: 0.9 }}
              drag={reduceMotion ? false : "y"}
              dragListener={false}
              dragControls={sheetDrag}
              dragConstraints={{ top: 0, bottom: 0 }}
              dragElastic={{ top: 0, bottom: 0.6 }}
              onDragEnd={(_, info) => {
                if (info.offset.y > 110 || info.velocity.y > 600) setSheetOpen(false);
              }}
              style={sheetBox ? { top: sheetBox.top, left: sheetBox.left, width: sheetBox.width, bottom: 0 } : undefined}
              className="fixed z-attached flex flex-col rounded-t-[18px] border border-b-0 border-border-strong/60 bg-card shadow-[0_-24px_60px_-20px_rgba(0,0,0,0.4)]"
            >
              {/* Grab handle (drag down) + collapse back to the cards */}
              <div className="relative flex shrink-0 items-center justify-center pt-2 pb-2">
                <button
                  type="button"
                  aria-label="Drag down to close"
                  onPointerDown={(e) => sheetDrag.start(e)}
                  className="h-5 w-16 cursor-grab touch-none rounded-full outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="mx-auto block h-1.5 w-10 rounded-full bg-border-strong" />
                </button>
                <button
                  type="button"
                  onClick={() => setSheetOpen(false)}
                  className="absolute top-1.5 right-3 flex h-8 items-center gap-1 rounded-full border border-border-strong/70 bg-card pr-3 pl-2 text-xs font-semibold text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronDown className="size-4" strokeWidth={2.25} />
                  Back to cards
                </button>
              </div>
              <div id="card-activity-body" className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
          <ActivityHeader
            card={activeCard}
            bankId={activeCard ? bankIdOf(activeCard) : null}
            tab={activityTab}
            onTab={changeActivityTab}
            allCards={activityAllCards}
            onAllCards={changeActivityScope}
            cardCount={creditCards.length}
          />

          {/* Only the chosen tab, for the chosen card and scope — a short fade when any of them changes. */}
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={`${activityTab}:${activityAllCards ? "all" : (activeCard?.id ?? "none")}`}
              initial={reduceMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -4 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
            >
          {activityTab === "bills" && (
            <div id="upcoming-statements" className="scroll-mt-28">
              {!activityAllCards && activeCard ? (
                <SelectedCardBill
                  card={activeCard}
                  nextClose={statementWindowForDate(activeCard.card, new Date()).periodEnd}
                  onPayStatement={() => {
                    setPayChoice("statement");
                    setPayCard(activeCard);
                  }}
                  onPayFull={() => {
                    setPayChoice("full");
                    setPayCard(activeCard);
                  }}
                  onHistory={() => {
                    router.replace(`/credit-cards?card=${encodeURIComponent(activeCard.id)}`, { scroll: false });
                    router.push(transactionsHrefForAccount(activeCard.card.accountId));
                  }}
                />
              ) : (
                <div className="overflow-x-auto">
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
                      {activityCards.map((card) => {
                        const scope = card.statementPayment;
                        const bill = scope.current;
                        const nextClose = statementWindowForDate(card.card, new Date()).periodEnd;
                        return (
                          <tr key={card.id} className="transition-colors hover:bg-secondary/40 [&:last-child>td]:border-b-0">
                            <td className={cn(CC_TD, "max-w-0")}>
                              <div className="flex min-w-0 items-center gap-3">
                                <CardChip card={card} bankId={bankIdOf(card)} />
                                <div className="min-w-0">
                                  <CardTitleLine card={card} />
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
                                    <DropdownMenuItem onSelect={() => selectCard(card.id)}>View details</DropdownMenuItem>
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
              )}
            </div>
          )}

          {activityTab === "transactions" && (
            <div className="flex flex-col">
              {activityTransactions.length === 0 ? (
                <ActivityEmpty
                  icon={Receipt}
                  title={recentLoading ? "Loading transactions…" : "No transactions in this activity preview"}
                  detail={
                    recentLoading
                      ? undefined
                      : activityAllCards || !activeCard
                        ? "Card purchases and payments will appear here."
                        : "Older or filtered transactions are in the full history below."
                  }
                />
              ) : (
                <ul className="flex flex-col">
                  {activityTransactions.map((txn, i) => {
                    const Icon = CATEGORY_ICON[txn.category] ?? Receipt;
                    const cardView = creditCards.find((c) => c.id === txn.card.id);
                    const incoming = txn.category === "Income";
                  // Date heading whenever the day changes (Today / Yesterday / 12 Oct 2026).
                  const day = activityDayLabel(txn.date);
                  const newDay = i === 0 || activityDayLabel(activityTransactions[i - 1].date) !== day;
                    return (
                    <Fragment key={txn.id}>
                      {newDay && (
                        <li className="sticky top-[3.75rem] z-[1] bg-card/95 px-4 pt-3 pb-1 text-[11px] font-semibold tracking-[0.06em] text-foreground/60 uppercase backdrop-blur">{day}</li>
                      )}
                      <motion.li
                        initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.2, delay: Math.min(i, 10) * 0.03 }}
                        className="mx-2 flex items-center gap-3 rounded-[10px] px-2 py-2.5 transition-colors hover:bg-secondary/60"
                      >
                        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[8px]", TONE_ICON_CLASS[categoryTone(txn.category)])}>
                          <Icon className="size-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-foreground">{txn.merchant}</p>
                          <p className="flex min-w-0 items-center gap-1.5 truncate text-xs text-foreground/70">
                            <span className="tabular-nums">{txn.date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span>
                            <span aria-hidden>·</span>
                            <span>{incoming ? "Credit" : "Debit"}</span>
                            {(activityAllCards || !activeCard) && cardView && (
                              <>
                                <span aria-hidden>·</span>
                                <span className="truncate">
                                  {cardView.name} •••• {cardView.last4}
                                </span>
                              </>
                            )}
                          </p>
                        </div>
                        <span className={cn("shrink-0 text-[15px] font-bold whitespace-nowrap tabular-nums", incoming ? "text-success" : "text-foreground")}>
                          {incoming ? "+" : "−"}
                          {formatCurrency(txn.amount)}
                        </span>
                      </motion.li>
                    </Fragment>
                    );
                  })}
                </ul>
              )}
              <div className="border-t border-border-strong/50 p-2">
                <ActivityFooterLink
                  label={activityAllCards || !activeCard ? "Full card transaction history" : `Full ${activeCard.name} •••• ${activeCard.last4} history`}
                  note={activityPool.length > activityTransactions.length ? `Showing latest ${activityTransactions.length} of ${activityPool.length}` : undefined}
                  onClick={() => {
                    if (activityAllCards || !activeCard) {
                      router.push("/transactions");
                      return;
                    }
                    router.replace(`/credit-cards?card=${encodeURIComponent(activeCard.id)}`, { scroll: false });
                    router.push(transactionsHrefForAccount(activeCard.card.accountId));
                  }}
                />
              </div>
            </div>
          )}

          {activityTab === "spending" && (
            <div aria-label="Spending summary" className="p-4">
              {spendByCategory.length === 0 ? (
                <ActivityEmpty icon={PieChartIcon} title="No spending to show yet" detail={`Purchases on ${activeCard?.name ?? "this card"} will be grouped by category here.`} />
              ) : (
                <div className="grid grid-cols-1 items-center gap-5 sm:grid-cols-[10rem_minmax(0,1fr)]">
                  <div className="relative mx-auto size-40">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={spendByCategory} dataKey="amount" nameKey="category" innerRadius="70%" outerRadius="100%" paddingAngle={2} stroke="none">
                          {spendByCategory.map((item) => (
                            <Cell key={item.category} fill={CATEGORY_CHART_COLOR[categoryTone(item.category)]} />
                          ))}
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                      <span className="text-[10px] font-semibold tracking-wide text-foreground/65 uppercase">Total</span>
                      <span className="text-base font-bold text-foreground tabular-nums">{formatCurrency(spendTotal)}</span>
                    </div>
                  </div>
                  <ul className="flex min-w-0 flex-col gap-3">
                    {spendByCategory.map((item) => (
                      <li key={item.category} className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-2 text-sm">
                          <span className="size-2.5 shrink-0 rounded-full" style={{ background: CATEGORY_CHART_COLOR[categoryTone(item.category)] }} />
                          <span className="min-w-0 flex-1 truncate font-medium text-foreground">{item.category}</span>
                          <span className="shrink-0 font-bold text-foreground tabular-nums">{formatCurrency(item.amount)}</span>
                          <span className="w-10 shrink-0 text-right text-xs font-medium text-foreground/65 tabular-nums">{item.percent}%</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                          <div className="h-full rounded-full" style={{ width: `${item.percent}%`, background: CATEGORY_CHART_COLOR[categoryTone(item.category)] }} />
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
            </motion.div>
          </AnimatePresence>
              </div>
            </motion.section>
          </>
        )}
      </AnimatePresence>,
      document.body,
      )}

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
            setFreshPay(null);
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
          onDestinationAccountChange={(id) => {
            setPayDestAccountId(id);
            setFreshPay(null);
          }}
          onRefreshBill={refreshPayBill}
          statementIntent={
            payDestCard && payCurrentStatement
              ? { accountId: payDestCard.card.accountId, statementId: payCurrentStatement.id, remaining: payCurrentStatement.remaining }
              : null
          }
          paymentScope={
            payDestCard
              ? {
                  accountId: payDestCard.card.accountId,
                  content: (
                    <PayBillDialogScope
                      scope={payDestScope ?? payScopeOf(payDestCard)}
                      ownOutstanding={freshPayState ? freshPayState.scope.cardOutstanding : payDestCard.ownUsage}
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
                  // After Refresh: People readiness recomputed from the freshly read scope (its charge ids).
                  readiness: freshPayState ? freshPayState.readinessFor(freshPayState.scope.cardOutstanding) : payCardPeople,
                  // Only the current bill's own charges gate an amount within that bill (by transaction id);
                  // paying beyond it (explicit full outstanding) falls back to oldest-first reach.
                  readinessFor: freshPayState
                    ? freshPayState.readinessFor
                    : payCardPeopleFor
                      ? (amount: number) => payCardPeopleFor(amount, payBillChargeScope(payScopeOf(payDestCard), amount))
                      : null,
                  loading: freshPayState ? false : payCardPeopleLoading,
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
const CC_SOON = "rounded-[4px] bg-secondary px-1 py-px text-[10px] font-semibold tracking-wide text-muted-foreground uppercase";
const CC_LABEL = "text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase";
const CC_TH =
  "border-r border-b border-r-border-strong/40 border-b-border-strong bg-secondary px-3 py-2 text-left text-[11px] font-semibold tracking-[0.06em] whitespace-nowrap text-muted-foreground uppercase last:border-r-0";
const CC_TD = "border-r border-b border-r-border-strong/30 border-b-border-strong/40 px-3 py-2.5 align-middle last:border-r-0";
/** Add/Edit card dialog — option chips and the bank/shared-limit pickers, in the Loan & EMI control style. */
const CC_FORM_CHOICE = "flex h-8 items-center gap-1 rounded-[6px] border px-2.5 text-xs outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring";
const CC_FORM_COMBOBOX =
  "h-9 rounded-[6px] border-border-strong bg-card transition-[border-color,box-shadow] duration-150 hover:border-muted-foreground focus:border-primary-accent-text focus:ring-2 focus:ring-ring dark:bg-input";
const CC_INPUT = cn(LOAN_EMI_INPUT, "h-9");

function SummaryFigure({ icon: Icon, tone, label, value }: { icon: typeof Wallet; tone: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-border-strong/40 px-4 py-2.5 last:border-b-0 @xl:border-b-0">
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

type ActivityTab = "bills" | "transactions" | "spending";

const noopSubscribe = () => () => {};

/** "Today", "Yesterday", or "12 Oct 2026" — headings for the activity transaction list. */
function activityDayLabel(date: Date): string {
  const d = daysUntil(date);
  if (d === 0) return "Today";
  if (d === -1) return "Yesterday";
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

const ACTIVITY_TABS: { value: ActivityTab; label: string; icon: LucideIcon }[] = [
  { value: "bills", label: "Bills", icon: FileText },
  { value: "transactions", label: "Transactions", icon: Receipt },
  { value: "spending", label: "Spending", icon: PieChartIcon },
];

/**
 * Card activity header — which card (logo, name, network, last 4), the This card / All cards scope, the
 * Bills · Transactions · Spending tabs, and one line saying exactly what's shown. Pinned (compact) so the
 * card context stays visible while the content scrolls; sits on the app's `attached` layer, under dialogs.
 */
function ActivityHeader({
  card,
  bankId,
  tab,
  onTab,
  allCards,
  onAllCards,
  cardCount,
}: {
  card: CreditCardViewItem | undefined;
  bankId: string | null;
  tab: ActivityTab;
  onTab: (tab: ActivityTab) => void;
  allCards: boolean;
  onAllCards: (all: boolean) => void;
  cardCount: number;
}) {
  // Spending is always the selected card's, so the scope only applies to Bills and Transactions.
  const scoped = tab !== "spending";
  const showingAll = scoped && (allCards || !card);
  const network = card ? (NETWORK_NAME[card.card.cardNetwork ?? ""] ?? null) : null;
  const what = tab === "bills" ? "Current bill" : tab === "transactions" ? "Recent transactions" : "Spending by category";
  const context = showingAll ? `${tab === "bills" ? "Bills" : "Recent transactions"} across all ${cardCount} cards` : what;
  const dueIn = card?.dueDate ? daysUntil(card.dueDate) : null;
  const dueLabel = dueIn == null ? "No bill due" : dueIn <= 0 ? "Due today" : `Due in ${dueIn}d`;

  return (
    <>
      {/* Hero — the selected card's own colour, its identity and the three figures that matter. Scrolls away. */}
      <div
        className="relative overflow-hidden px-5 pt-4 pb-4 text-white transition-[background] duration-300"
        style={{ background: !showingAll && card ? CARD_GRADIENT[card.accent] : "linear-gradient(135deg, #1f2430 0%, #3a4252 100%)" }}
      >
        <span aria-hidden className="pointer-events-none absolute -top-20 -right-16 size-56 rounded-full bg-white/10 blur-3xl" />
        <span aria-hidden className="pointer-events-none absolute -bottom-24 -left-10 size-48 rounded-full border border-white/10" />

        <div className="relative flex flex-wrap items-start gap-x-4 gap-y-3">
          <div className="mr-auto flex min-w-0 items-center gap-3">
            {!showingAll && card ? (
              bankId ? (
                <BankLogo bankId={bankId} size={40} className="shadow-md ring-2 ring-white/40" />
              ) : (
                <span className="h-8 w-11 shrink-0 rounded-[6px] border border-white/30 bg-white/15" />
              )
            ) : (
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white/15 ring-1 ring-white/25">
                <CreditCardIcon className="size-5" strokeWidth={1.9} />
              </span>
            )}
            <div className="min-w-0">
              <p className="flex min-w-0 items-center gap-2">
                <span className="truncate font-heading text-lg leading-tight font-semibold">{!showingAll && card ? card.name : "All cards"}</span>
                {!showingAll && network && (
                  <span className="shrink-0 rounded-[4px] bg-white/20 px-1.5 py-0.5 text-[10px] leading-none font-bold tracking-wide italic">{network}</span>
                )}
              </p>
              <p className="mt-0.5 truncate text-xs text-white/80">
                {!showingAll && card ? <span className="mr-1.5 font-mono tracking-[0.14em]">•••• {card.last4}</span> : null}
                {context}
              </p>
            </div>
          </div>

          {scoped && (
            <div role="radiogroup" aria-label="Show activity for" className="flex items-center rounded-full bg-black/20 p-0.5 ring-1 ring-white/15 backdrop-blur-sm">
              {[
                { all: false, label: "This card", title: card ? `Only ${card.name} •••• ${card.last4}` : undefined },
                { all: true, label: `All cards · ${cardCount}`, title: `All ${cardCount} cards` },
              ].map((opt) => {
                const selected = allCards === opt.all;
                return (
                  <button
                    key={opt.title ?? opt.label}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    title={opt.title}
                    onClick={() => onAllCards(opt.all)}
                    className={cn(
                      "h-8 rounded-full px-3.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white",
                      selected ? "bg-white font-semibold text-neutral-900 shadow-sm" : "font-medium text-white/80 hover:text-white",
                    )}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {!showingAll && card && (
          <dl className="relative mt-4 grid grid-cols-3 gap-2">
            {[
              { label: card.sharedLimit ? "This card used" : "Used", value: formatCurrency(card.ownUsage) },
              { label: card.sharedLimit ? "Shared available" : "Available", value: formatCurrency(card.available) },
              { label: "Payment", value: dueLabel, warn: dueIn != null && dueIn <= 5 },
            ].map((m) => (
              <div key={m.label} className="min-w-0 rounded-[10px] bg-white/12 px-3 py-2 ring-1 ring-white/15 backdrop-blur-sm">
                <dt className="truncate text-[10.5px] font-semibold tracking-[0.06em] text-white/75 uppercase">{m.label}</dt>
                <dd className={cn("truncate text-[15px] font-bold tabular-nums", m.warn && "text-red-200")}>{m.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {/* Tabs — pinned while the content scrolls; on the app's `attached` layer, under dialogs. */}
      <div className="sticky top-0 z-attached border-b border-border-strong/60 bg-card/95 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-card/85">
        <div role="tablist" aria-label="Card activity" className="relative grid grid-cols-3 gap-1 rounded-[10px] bg-secondary p-1">
          {ACTIVITY_TABS.map(({ value, label, icon: Icon }) => {
            const selected = tab === value;
            return (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => onTab(value)}
                className={cn(
                  "relative flex h-9 items-center justify-center gap-1.5 rounded-[8px] text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  selected ? "font-semibold text-foreground" : "font-medium text-foreground/65 hover:text-foreground",
                )}
              >
                {selected && (
                  <motion.span
                    layoutId="card-activity-tab"
                    aria-hidden
                    className="absolute inset-0 rounded-[8px] bg-card shadow-sm ring-1 ring-border-strong/60"
                    transition={{ type: "spring", stiffness: 500, damping: 40 }}
                  />
                )}
                <Icon className="relative size-4" strokeWidth={selected ? 2.25 : 1.9} />
                <span className="relative">{label}</span>
                {selected && <span aria-hidden className="relative size-1.5 rounded-full bg-primary-accent-text" />}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

/**
 * Slim in-page entry to the Card activity sheet — the selected card, then one button per tab and "All cards".
 * Clicking a card opens the sheet too; this keeps it discoverable (and reopenable) without a click on a card.
 */
function ActivityLauncher({
  card,
  bankId,
  onOpen,
}: {
  card: CreditCardViewItem | undefined;
  bankId: string | null;
  onOpen: (tab: ActivityTab, allCards: boolean) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-[10px] border border-border-strong/60 bg-card px-3 py-2.5 shadow-e1 xl:col-start-1 xl:row-start-2">
      <div className="mr-auto flex min-w-0 items-center gap-2.5">
        {card &&
          (bankId ? (
            <BankLogo bankId={bankId} size={26} />
          ) : (
            <span className="h-5 w-7 shrink-0 rounded-[4px]" style={{ background: CARD_GRADIENT[card.accent] }} />
          ))}
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">
            {card ? `${card.name} •••• ${card.last4}` : "Card activity"}
          </p>
          <p className="truncate text-xs text-foreground/70">Bills, transactions and spending — opens over the page</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {ACTIVITY_TABS.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            disabled={!card}
            onClick={() => onOpen(value, false)}
            className="flex h-8 items-center gap-1.5 rounded-[8px] border border-border-strong/70 bg-card px-3 text-xs font-semibold text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <Icon className="size-3.5" strokeWidth={2} />
            {label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onOpen("bills", true)}
          className="flex h-8 items-center gap-1.5 rounded-[8px] px-3 text-xs font-semibold text-foreground/80 outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          All cards
          <ArrowRight className="size-3.5" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

/** Compact, honest empty state for an activity tab. */
function ActivityEmpty({ icon: Icon, title, detail }: { icon: LucideIcon; title: string; detail?: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-6">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-foreground/60">
        <Icon className="size-4" strokeWidth={2} />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        {detail && <p className="text-xs text-foreground/70">{detail}</p>}
      </div>
    </div>
  );
}

/**
 * The selected card's current bill — the one its Pay now pays (`statementPayment.current`), shown as a
 * summary instead of a one-row table. Amounts and the pay rules come straight from the existing scope.
 */
function SelectedCardBill({
  card,
  nextClose,
  onPayStatement,
  onPayFull,
  onHistory,
}: {
  card: CreditCardViewItem;
  nextClose: Date;
  onPayStatement: () => void;
  onPayFull: () => void;
  onHistory: () => void;
}) {
  const scope = card.statementPayment;
  const bill = scope.current;
  const canPayFull = card.ownUsage > scope.statementDue + 0.005;
  const dueIn = bill ? daysUntil(bill.dueDate) : null;
  const status = !bill
    ? { label: "No bill due", tone: "bg-secondary text-foreground/75" }
    : scope.currentOverdue
      ? { label: "Overdue", tone: "bg-expense/12 text-expense" }
      : dueIn != null && dueIn <= 5
        ? { label: dueIn <= 0 ? "Due today" : `Due in ${dueIn} day${dueIn === 1 ? "" : "s"}`, tone: "bg-warning/15 text-foreground" }
        : { label: dueIn != null ? `Due in ${dueIn} days` : "Due", tone: "bg-success/12 text-success" };

  if (!bill) {
    return (
      <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-foreground/60">
            <FileText className="size-4" strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">No bill due on this card</p>
            <p className="text-xs text-foreground/70">
              Next statement closes {formatShortDate(nextClose)}
              {card.ownUsage > 0.005 ? ` · ${formatCurrency(card.ownUsage)} spent, not billed yet` : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canPayFull && (
            <button type="button" onClick={onPayFull} className={CC_ACTIVITY_SECONDARY}>
              Pay full outstanding {formatCurrency(card.ownUsage)}
            </button>
          )}
          <button type="button" onClick={onHistory} className={CC_ACTIVITY_GHOST}>
            Statement history
            <ArrowRight className="size-3.5" strokeWidth={2} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={CC_LABEL}>Bill amount</span>
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", status.tone)}>{status.label}</span>
          </div>
          <p className={cn("mt-1 text-[28px] leading-none font-bold tracking-tight tabular-nums", scope.currentOverdue ? "text-expense" : "text-foreground")}>
            {formatCurrency(scope.statementDue)}
          </p>
          {scope.cardOutstanding > scope.statementDue + 0.005 && (
            <p className="mt-1 text-xs font-medium text-foreground/70 tabular-nums">of {formatCurrency(scope.cardOutstanding)} outstanding on this card</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canPayFull && (
            <button type="button" onClick={onPayFull} className={CC_ACTIVITY_SECONDARY}>
              Pay full {formatCurrency(card.ownUsage)}
            </button>
          )}
          <button
            type="button"
            onClick={onPayStatement}
            className="flex h-9 items-center gap-1.5 rounded-[8px] border border-primary-accent-text bg-primary px-4 text-sm font-semibold text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Wallet className="size-4" strokeWidth={2} />
            Pay bill
          </button>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border-strong/40 pt-3 sm:grid-cols-4">
        <div className="min-w-0">
          <dt className={CC_LABEL}>Statement</dt>
          <dd className="truncate text-sm font-semibold text-foreground tabular-nums">{billPeriodLabel(bill)}</dd>
        </div>
        <div className="min-w-0">
          <dt className={CC_LABEL}>Due date</dt>
          <dd className={cn("truncate text-sm font-semibold tabular-nums", scope.currentOverdue ? "text-expense" : "text-foreground")}>{formatShortDate(bill.dueDate)}</dd>
        </div>
        <div className="min-w-0">
          <dt className={CC_LABEL}>Minimum due</dt>
          <dd className="truncate text-sm font-semibold text-foreground tabular-nums">
            {/* Only an issuer figure from a stored statement — never a made-up ₹0. */}
            {bill.minimumDue != null ? formatCurrency(bill.minimumDue) : <span className="font-medium text-foreground/65">Not tracked</span>}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className={CC_LABEL}>Next statement</dt>
          <dd className="truncate text-sm font-semibold text-foreground tabular-nums">{formatShortDate(nextClose)}</dd>
        </div>
      </dl>

      <button type="button" onClick={onHistory} className={cn(CC_ACTIVITY_GHOST, "self-start")}>
        Statement history
        <ArrowRight className="size-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}

const CC_ACTIVITY_SECONDARY =
  "flex h-9 items-center rounded-[8px] border border-border-strong bg-card px-3 text-sm font-semibold text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring";
const CC_ACTIVITY_GHOST =
  "flex h-8 items-center gap-1 rounded-[6px] px-2 text-xs font-semibold text-foreground/80 outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";


function ActivityFooterLink({ label, note, onClick }: { label: string; note?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-9 items-center justify-between gap-3 rounded-[8px] border border-border-strong/70 bg-card px-3 py-1.5 text-left text-sm font-semibold text-foreground transition-colors hover:bg-secondary"
    >
      <span className="min-w-0 truncate">{label}</span>
      <span className="flex shrink-0 items-center gap-2">
        {note && <span className="text-xs font-medium text-muted-foreground tabular-nums">{note}</span>}
        <ArrowRight className="size-3.5" strokeWidth={2} />
      </span>
    </button>
  );
}

const NETWORK_NAME: Record<string, string> = { visa: "VISA", mastercard: "Mastercard", rupay: "RuPay", amex: "AMEX" };

/** Table-row card mark — the issuing bank's logo, with a dot in the card's own colour so rows of the same
 *  bank (e.g. two Freedom cards) still read apart. Falls back to a mini card face when no bank is set. */
function CardChip({ card, bankId }: { card: CreditCardViewItem; bankId?: string | null }) {
  return (
    <span className="relative flex size-9 shrink-0 items-center justify-center">
      {bankId ? (
        <BankLogo bankId={bankId} size={36} />
      ) : (
        <span className="flex h-6 w-9 rounded-[5px] shadow-sm" style={{ background: CARD_GRADIENT[card.accent] }} />
      )}
      <span
        aria-hidden
        className="absolute -right-0.5 -bottom-0.5 size-3.5 rounded-full ring-2 ring-card"
        style={{ background: CARD_GRADIENT[card.accent] }}
      />
    </span>
  );
}

/** Card name, then a readable network badge and the last 4 — on one line. */
function CardTitleLine({ card }: { card: CreditCardViewItem }) {
  const network = NETWORK_NAME[card.card.cardNetwork ?? ""] ?? null;
  return (
    <p className="flex min-w-0 items-center gap-1.5">
      <span className="truncate font-semibold text-foreground">{card.name}</span>
      {network && (
        <span className="shrink-0 rounded-[4px] border border-border-strong/70 px-1 py-px text-[10px] leading-none font-semibold tracking-wide text-muted-foreground">
          {network}
        </span>
      )}
      <span className="shrink-0 font-mono text-[11px] tracking-wider text-muted-foreground">•••• {card.last4}</span>
    </p>
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

/**
 * Right-hand selected-card panel. Presentation only — every figure is the card's existing standing
 * (`usedCredit`, `available`, `creditLimit`, `ownUsage`, `currentBalance`, `statementPayment`) and every
 * button calls the workspace's existing handler.
 */
function SelectedCardPanel({
  card,
  bankId,
  siblingBankId,
  utilization,
  available,
  dueInDays,
  reduceMotion,
  payScope,
  linkedNotice,
  onPayBill,
  onStatement,
  onEdit,
  onAddToShared,
  onViewTransactions,
}: {
  card: CreditCardViewItem;
  bankId: string | null;
  siblingBankId: (siblingId: string) => string | null;
  utilization: number;
  available: number;
  dueInDays: number | null;
  reduceMotion: boolean | null;
  payScope: React.ReactNode;
  linkedNotice: React.ReactNode;
  onPayBill: () => void;
  onStatement: () => void;
  onEdit: () => void;
  onAddToShared: () => void;
  onViewTransactions: () => void;
}) {
  const shared = card.sharedLimit;
  const network = NETWORK_NAME[card.card.cardNetwork ?? ""] ?? null;
  const limit = card.creditLimit;
  // Shared bar: this card's own usage, the other cards' share of the shared outstanding, then what's free.
  const othersUsage = shared ? Math.max(0, card.currentBalance - card.ownUsage) : 0;
  const pct = (v: number) => (limit > 0 ? Math.min(100, Math.max(0, (v / limit) * 100)) : 0);
  const dueTone = dueInDays != null && dueInDays <= 5 ? "text-expense" : "text-foreground";

  return (
    <motion.section
      key={card.id}
      aria-label="Selected card"
      initial={reduceMotion ? false : { opacity: 0, y: 10, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="overflow-hidden rounded-[12px] border border-border-strong/60 bg-card shadow-e1"
    >
      {/* Card face */}
      <div style={{ background: CARD_GRADIENT[card.accent] }} className="relative flex flex-col gap-3 overflow-hidden p-4 text-white">
        <span className="pointer-events-none absolute -top-14 -right-10 size-36 rounded-full bg-white/10 blur-2xl" aria-hidden />
        <div className="relative flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            {bankId && <BankLogo bankId={bankId} size={30} className="ring-white/40" />}
            <div className="min-w-0">
              <h3 className="truncate font-heading text-base leading-tight font-semibold">{card.name}</h3>
              <p className="mt-0.5 font-mono text-xs tracking-[0.16em] text-white/80">•••• {card.last4}</p>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {network && <span className="text-xs font-bold tracking-wide text-white/85 italic">{network}</span>}
            {card.isPrimary && <span className="rounded-[4px] bg-white/20 px-1.5 py-0.5 text-[10px] font-semibold">Primary</span>}
          </div>
        </div>

        <div className="relative">
          <p className="text-[11px] font-semibold tracking-[0.06em] text-white/75 uppercase">{shared ? "This card used" : "Credit used"}</p>
          <p className="text-[26px] leading-tight font-bold tracking-tight tabular-nums">{formatCurrency(card.usedCredit)}</p>
          {card.lockedEmiPrincipal > 0 && (
            <p className="text-xs text-white/80 tabular-nums">
              Outstanding {formatCurrency(card.currentBalance)} · EMI locked {formatCurrency(card.lockedEmiPrincipal)}
            </p>
          )}
        </div>

        <div className="relative">
          <div className="flex items-center justify-between text-xs text-white/80">
            <span>{shared ? "Shared limit used" : "Utilization"}</span>
            <span className="font-semibold text-white tabular-nums">{utilization}%</span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/20">
            <motion.div
              className={cn("h-full rounded-full", utilization >= 80 ? "bg-red-400" : "bg-white")}
              initial={reduceMotion ? false : { width: 0 }}
              animate={{ width: `${utilization}%` }}
              transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
        </div>
      </div>

      {/* Limit */}
      <div className="flex flex-col gap-3 px-4 py-3.5">
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className={CC_LABEL}>{shared ? "Shared available" : "Available"}</p>
            <p className="text-xl font-bold text-success tabular-nums">{formatCurrency(available)}</p>
          </div>
          <div className="text-right">
            <p className={CC_LABEL}>{shared ? "Shared limit" : "Credit limit"}</p>
            <p className="text-sm font-semibold text-foreground tabular-nums">{formatCurrency(limit)}</p>
          </div>
        </div>

        {shared && (
          <>
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-secondary" aria-hidden>
              <span className="h-full bg-foreground/80" style={{ width: `${pct(card.ownUsage)}%` }} />
              <span className="h-full bg-foreground/35" style={{ width: `${pct(othersUsage)}%` }} />
            </div>
            <dl className="grid grid-cols-3 gap-2 text-xs">
              <div className="min-w-0">
                <dt className="flex items-center gap-1 text-foreground/70">
                  <span className="size-2 rounded-full bg-foreground/80" />
                  This card
                </dt>
                <dd className="font-semibold text-foreground tabular-nums">{formatCurrency(card.ownUsage)}</dd>
              </div>
              <div className="min-w-0">
                <dt className="flex items-center gap-1 text-foreground/70">
                  <span className="size-2 rounded-full bg-foreground/35" />
                  Other cards
                </dt>
                <dd className="font-semibold text-foreground tabular-nums">{formatCurrency(othersUsage)}</dd>
              </div>
              <div className="min-w-0">
                <dt className="flex items-center gap-1 text-foreground/70">
                  <span className="size-2 rounded-full bg-secondary ring-1 ring-border-strong" />
                  Shared total
                </dt>
                <dd className="font-semibold text-foreground tabular-nums">{formatCurrency(card.currentBalance)}</dd>
              </div>
            </dl>
            {shared.siblings.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-foreground/70">Shared with</span>
                {shared.siblings.map((s) => (
                  <span key={s.id} className="inline-flex items-center gap-1.5 rounded-full border border-border-strong/70 py-0.5 pr-2 pl-0.5 text-xs font-medium text-foreground">
                    {siblingBankId(s.id) ? <BankLogo bankId={siblingBankId(s.id)} size={18} /> : <Link2 className="ml-1 size-3" />}
                    {s.name}
                    <span className="font-mono text-[11px] text-foreground/65">•••• {s.last4}</span>
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Dates */}
      <div className="grid grid-cols-2 gap-2 px-4 pb-3.5">
        <div className="rounded-[8px] bg-secondary/60 px-3 py-2">
          <p className={CC_LABEL}>Next statement</p>
          <p className="text-sm font-semibold text-foreground tabular-nums">{card.statementDate ? formatShortDate(card.statementDate) : "—"}</p>
        </div>
        <div className="rounded-[8px] bg-secondary/60 px-3 py-2">
          <p className={CC_LABEL}>Payment due</p>
          <p className={cn("text-sm font-semibold tabular-nums", dueTone)}>
            {dueInDays == null ? "No due date" : dueInDays <= 0 ? "Due today" : `${dueInDays} days left`}
          </p>
        </div>
      </div>

      {/* Pay — the existing pay scope (current bill / pay full), unchanged */}
      {payScope}

      {/* Actions */}
      <div className="grid grid-cols-2 gap-2 border-t border-border-strong/40 px-4 py-3">
        <button
          type="button"
          onClick={onPayBill}
          className="col-span-2 flex h-10 items-center justify-center gap-1.5 rounded-[8px] border border-primary-accent-text bg-primary text-sm font-semibold text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Wallet className="size-4" strokeWidth={2} />
          Pay bill
        </button>
        <button type="button" onClick={onStatement} className={CC_PANEL_ACTION}>
          <FileText className="size-4 text-purple" strokeWidth={2} />
          Statement
        </button>
        <button type="button" onClick={onEdit} className={CC_PANEL_ACTION}>
          <Settings className="size-4 text-foreground/70" strokeWidth={2} />
          Card settings
        </button>
        <button type="button" disabled className={cn(CC_PANEL_ACTION, "col-span-2 cursor-not-allowed opacity-60")}>
          <RefreshCw className="size-4 text-success" strokeWidth={2} />
          Convert to EMI
          <span className={cn(CC_SOON, "ml-1")}>Soon</span>
        </button>
      </div>

      {/* People money received for purchases on this card — held in another account until the bill is paid. */}
      {linkedNotice}

      <div className="flex flex-col border-t border-border-strong/40">
        {shared && (
          <button type="button" onClick={onAddToShared} className={CC_PANEL_LINK}>
            <span className="flex items-center gap-2">
              <Link2 className="size-4 text-foreground/70" />
              Add another card to this shared limit
            </span>
            <Plus className="size-4 text-foreground/60" />
          </button>
        )}
        <button type="button" onClick={onViewTransactions} className={CC_PANEL_LINK}>
          <span className="flex items-center gap-2">
            <Receipt className="size-4 text-foreground/70" />
            View all card transactions
          </span>
          <ArrowRight className="size-4 text-foreground/60" />
        </button>
      </div>
    </motion.section>
  );
}

const CC_PANEL_ACTION =
  "flex h-9 items-center justify-center gap-1.5 rounded-[8px] border border-border-strong/70 bg-card text-[13px] font-semibold text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring";
const CC_PANEL_LINK =
  "flex h-11 items-center justify-between px-4 text-sm font-semibold text-foreground outline-none transition-colors [&+&]:border-t [&+&]:border-border-strong/40 hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

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
