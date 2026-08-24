"use client";

import {
  ArrowRight,
  Award,
  CreditCard as CreditCardIcon,
  FileText,
  Gift,
  LayoutGrid,
  List,
  MoreHorizontal,
  MoreVertical,
  PieChart as PieChartIcon,
  Plane,
  Receipt,
  RefreshCw,
  Settings,
  Settings2,
  ShieldCheck,
  ShoppingBag,
  Wallet,
  X as XIcon,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { ClayBadge } from "@/components/clay/clay-badge";
import { ClayButton } from "@/components/clay/clay-button";
import { Stagger } from "@/components/foundation/animated-container";
import {
  ConfirmDialog,
  CurrencyCell,
  DateCell,
  EmptyState,
  FinanceTable,
  SectionLabel,
  type FinanceTableColumn,
} from "@/components/finance";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useAccounts } from "@/hooks/use-accounts";
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
  type CreditCardViewItem,
} from "@/features/credit-cards/hooks/use-credit-cards-data";
import { CARD_GRADIENT, CreditCardTile } from "@/features/credit-cards/components/credit-card-tile";
import { toast } from "@/store/toast-store";
import { cn } from "@/lib/utils";

const CARD_NETWORK_OPTIONS: CardNetwork[] = ["visa", "mastercard", "rupay", "amex"];

interface CardFormState {
  name: string;
  creditLimit: string;
  lastFourDigits: string;
  cardNetwork: CardNetwork | "";
  statementDay: string;
  paymentDueDay: string;
}

function emptyCardForm(): CardFormState {
  return { name: "", creditLimit: "", lastFourDigits: "", cardNetwork: "", statementDay: "1", paymentDueDay: "15" };
}

function cardFormFromCard(card: CreditCardViewItem): CardFormState {
  return {
    name: card.name,
    creditLimit: String(card.creditLimit),
    lastFourDigits: card.last4 === "----" ? "" : card.last4,
    cardNetwork: (card.card.cardNetwork as CardNetwork | null) ?? "",
    statementDay: String(card.card.statementDay),
    paymentDueDay: String(card.card.paymentDueDay),
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
  primary: "bg-primary/12 text-primary",
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

const STAT_TONE_CLASS = {
  purple: { card: "bg-purple/8 border-purple/20", icon: "bg-purple/20 text-purple", trend: "text-purple" },
  expense: { card: "bg-expense/8 border-expense/20", icon: "bg-expense/20 text-expense", trend: "text-expense" },
  success: { card: "bg-success/8 border-success/20", icon: "bg-success/20 text-success", trend: "text-success" },
  warning: { card: "bg-warning/12 border-warning/25", icon: "bg-warning/25 text-warning-foreground", trend: "text-warning-foreground" },
} as const;

function StatCard({
  label,
  value,
  tone,
  icon: Icon,
}: {
  label: string;
  value: string;
  tone: keyof typeof STAT_TONE_CLASS;
  icon: typeof Wallet;
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

function BenefitRow({ icon: Icon, iconClass, label, value }: { icon: typeof Award; iconClass: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", iconClass)}>
        <Icon className="size-4" />
      </span>
      <span className="flex-1 text-sm text-foreground">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  );
}

export function CreditCardsWorkspace() {
  const { items: creditCards, isLoading: cardsLoading } = useCreditCardViewItems();
  const { totals: engineTotals, isLoading: totalsLoading } = useCreditCardTotals();
  const { rows: recentCardTransactions, isLoading: recentLoading } = useRecentCreditCardTransactions(6);
  const { data: accounts = [] } = useAccounts();
  const actions = useCreditCardActions();

  const [activeCardId, setActiveCardId] = useState<string | undefined>(undefined);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [addOpen, setAddOpen] = useState(false);
  const [editingCard, setEditingCard] = useState<CreditCardViewItem | null>(null);
  const [deletingCard, setDeletingCard] = useState<CreditCardViewItem | null>(null);
  const [form, setForm] = useState<CardFormState>(emptyCardForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function openAdd() {
    setForm(emptyCardForm());
    setFormError(null);
    setAddOpen(true);
  }

  function openEdit(card: CreditCardViewItem) {
    setForm(cardFormFromCard(card));
    setFormError(null);
    setEditingCard(card);
  }

  async function handleSaveCard() {
    if (!actions) return;
    const name = form.name.trim();
    if (!name) {
      setFormError("Card name is required.");
      return;
    }
    const creditLimit = Number(form.creditLimit);
    if (!Number.isFinite(creditLimit) || creditLimit <= 0) {
      setFormError("Credit limit must be greater than 0.");
      return;
    }
    if (form.lastFourDigits && !/^\d{4}$/.test(form.lastFourDigits)) {
      setFormError("Last 4 digits must be exactly 4 numbers.");
      return;
    }
    const statementDay = Number(form.statementDay);
    const paymentDueDay = Number(form.paymentDueDay);
    if (!Number.isInteger(statementDay) || statementDay < 1 || statementDay > 31) {
      setFormError("Statement day must be between 1 and 31.");
      return;
    }
    if (!Number.isInteger(paymentDueDay) || paymentDueDay < 1 || paymentDueDay > 31) {
      setFormError("Payment due day must be between 1 and 31.");
      return;
    }

    setSaving(true);
    setFormError(null);
    try {
      if (editingCard) {
        const account = (accounts as Account[]).find((a) => a.id === editingCard.card.accountId);
        await actions.editCard(editingCard.card, account, {
          name,
          creditLimit,
          lastFourDigits: form.lastFourDigits || null,
        });
        setEditingCard(null);
        toast.success("Card updated");
      } else {
        await actions.createCard({
          name,
          creditLimit,
          lastFourDigits: form.lastFourDigits || null,
          cardNetwork: form.cardNetwork || null,
          statementDay,
          paymentDueDay,
        });
        setAddOpen(false);
        toast.success("Card added");
      }
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteCard() {
    if (!actions || !deletingCard) return;
    const account = (accounts as Account[]).find((a) => a.id === deletingCard.card.accountId);
    try {
      await actions.deleteCard(deletingCard.card, account);
      if (activeCardId === deletingCard.id) setActiveCardId(undefined);
      setDeletingCard(null);
      toast.success("Card deleted");
    } catch (e) {
      toast.error("Could not delete card", e instanceof Error ? e.message : undefined);
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

  const statementColumns: FinanceTableColumn<CreditCardViewItem>[] = [
    {
      id: "card",
      header: "Card",
      accessor: (card) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="flex size-8 shrink-0 items-center justify-center rounded-xl text-[9px] font-bold tracking-wide text-white uppercase italic"
            style={{ background: CARD_GRADIENT[card.accent] }}
          >
            {card.network.slice(0, 2)}
          </span>
          <span className="truncate text-sm font-medium text-foreground">{card.name}</span>
        </div>
      ),
    },
    {
      id: "period",
      header: "Billing Period",
      accessor: (card) => (
        <span className="text-sm text-muted-foreground">
          {card.statementDate ? billingPeriodLabel(card.statementDate) : "—"}
        </span>
      ),
      width: "160px",
    },
    {
      id: "statementDate",
      header: "Statement Date",
      accessor: (card) => (
        <span className="text-sm text-muted-foreground">
          {card.statementDate ? formatShortDate(card.statementDate) : "—"}
        </span>
      ),
      width: "150px",
    },
    {
      id: "totalDue",
      header: "Total Due",
      accessor: (card) => <span className="font-mono text-sm font-semibold tabular-nums text-expense">{formatCurrency(card.currentBalance)}</span>,
      numeric: true,
      width: "130px",
    },
    {
      id: "minDue",
      header: "Minimum Due",
      accessor: (card) => <CurrencyCell amount={card.minimumDue} signed={false} />,
      numeric: true,
      width: "130px",
    },
    {
      id: "actions",
      header: "Actions",
      accessor: (card) => (
        <div className="flex items-center gap-1.5">
          <ClayButton size="sm" className="h-7 min-w-0 px-3 text-xs">
            Pay Now
          </ClayButton>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Statement actions"
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setActiveCardId(card.id)}>View Details</DropdownMenuItem>
              <DropdownMenuItem>Download Statement</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
      width: "150px",
    },
  ];

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
      <DialogContent showCloseButton={false} className="gap-0 overflow-hidden rounded-none border border-border p-0 shadow-lg ring-0 sm:max-w-2xl">
        <div className="h-1 w-full bg-primary" />

        <button
          type="button"
          onClick={closeCardDialog}
          aria-label="Close"
          className="absolute top-4 right-4 flex size-7 items-center justify-center border border-transparent text-muted-foreground transition-colors hover:border-border hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>

        <DialogHeader className="gap-1 border-b border-border bg-muted/40 px-6 py-5 text-left">
          <DialogTitle className="font-heading text-lg font-semibold">
            {editingCard ? `Edit ${editingCard.name}` : "Add a Credit Card"}
          </DialogTitle>
          {!editingCard && (
            <DialogDescription>A few details to start tracking spending, utilization and due dates.</DialogDescription>
          )}
        </DialogHeader>

        <div className="flex flex-col gap-6 px-6 py-5 text-sm">
          <div
            style={{ background: CARD_GRADIENT[previewAccent] }}
            className="relative flex min-h-[132px] flex-col justify-between gap-5 border border-black/10 p-4 text-white shadow-e1"
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
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <SectionLabel>Card Details</SectionLabel>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Card Name</span>
              <div className="relative">
                <CreditCardIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  className="h-10 w-full rounded-none border border-border bg-background pr-3 pl-9 text-sm outline-none transition-colors focus:border-primary"
                  placeholder="e.g. HDFC Regalia"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                />
              </div>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Credit Limit</span>
                <div className="relative">
                  <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground">₹</span>
                  <input
                    type="number"
                    className="h-10 w-full rounded-none border border-border bg-background pr-3 pl-7 text-sm outline-none transition-colors focus:border-primary"
                    placeholder="0.00"
                    value={form.creditLimit}
                    onChange={(e) => setForm((f) => ({ ...f, creditLimit: e.target.value }))}
                  />
                </div>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Last 4 Digits</span>
                <input
                  className="h-10 rounded-none border border-border bg-background px-3 font-mono text-sm tracking-widest outline-none transition-colors focus:border-primary"
                  placeholder="4021"
                  maxLength={4}
                  value={form.lastFourDigits}
                  onChange={(e) => setForm((f) => ({ ...f, lastFourDigits: e.target.value.replace(/\D/g, "") }))}
                />
              </label>
            </div>
          </div>

          {!editingCard && (
            <>
              <div className="flex flex-col gap-3 border-t border-border pt-5">
                <SectionLabel>Network (optional)</SectionLabel>
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
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border text-muted-foreground hover:bg-muted",
                        )}
                      >
                        <span
                          className={cn(
                            "flex h-5 items-center justify-center px-1 text-[9px] font-bold tracking-wide uppercase italic",
                            selected ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground",
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

              <div className="flex flex-col gap-3 border-t border-border pt-5">
                <SectionLabel>Billing Cycle</SectionLabel>
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground">Statement Day</span>
                    <input
                      type="number"
                      min={1}
                      max={31}
                      className="h-10 rounded-none border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-primary"
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
                      className="h-10 rounded-none border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-primary"
                      value={form.paymentDueDay}
                      onChange={(e) => setForm((f) => ({ ...f, paymentDueDay: e.target.value }))}
                    />
                  </label>
                </div>
                <p className="text-[11px] text-muted-foreground">Day of the month your statement generates and payment is due.</p>
              </div>
            </>
          )}

          {formError && (
            <p className="flex items-center gap-1.5 border border-expense/30 bg-expense/8 px-3 py-2 text-xs font-medium text-expense">
              {formError}
            </p>
          )}
        </div>

        <DialogFooter className="border-t border-border bg-muted/20 px-6 py-4">
          <ClayButton variant="ghost" className="rounded-none" onClick={closeCardDialog} disabled={saving}>
            Cancel
          </ClayButton>
          <ClayButton variant="primary" className="rounded-none" onClick={handleSaveCard} disabled={saving}>
            {saving ? "Saving…" : editingCard ? "Save Changes" : "Add Card"}
          </ClayButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6 px-1">
        <div>
          <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Credit Cards</h1>
          <p className="mt-1 text-sm text-muted-foreground">Manage your cards, track spending and pay bills on time</p>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-3xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="h-44 rounded-3xl" />
          ))}
        </div>
      </div>
    );
  }

  if (creditCards.length === 0) {
    return (
      <div className="flex flex-col gap-6 px-1">
        <div>
          <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Credit Cards</h1>
          <p className="mt-1 text-sm text-muted-foreground">Manage your cards, track spending and pay bills on time</p>
        </div>
        <div className="surface-flat rounded-3xl border border-border/50">
          <EmptyState
            icon={CreditCardIcon}
            title="No credit cards yet"
            description="Add your first card to start tracking spending, utilization and due dates."
            actionLabel="Add Card"
            onAction={openAdd}
          />
        </div>

        {cardFormDialog}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-5 px-1 xl:grid-cols-12">
      <div className="flex flex-col gap-5 xl:col-span-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Credit Cards</h1>
            <p className="mt-1 text-sm text-muted-foreground">Manage your cards, track spending and pay bills on time</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ClayButton variant="secondary" size="sm" className="gap-1.5">
              <FileText className="size-3.5" />
              View Statements
            </ClayButton>
            <ClayButton variant="secondary" size="sm" className="gap-1.5" onClick={openAdd}>
              <Settings2 className="size-3.5" />
              Manage Cards
            </ClayButton>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <ClayButton variant="ghost" size="icon" aria-label="More options">
                  <MoreVertical className="size-4" />
                </ClayButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={openAdd}>Add Card</DropdownMenuItem>
                <DropdownMenuItem>Export Statements</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Total Credit Limit" value={formatCurrency(totals.creditLimit)} icon={Wallet} tone="purple" />
          <StatCard label="Total Utilized" value={formatCurrency(totals.utilized)} icon={PieChartIcon} tone="expense" />
          <StatCard label="Available Credit" value={formatCurrency(totals.available)} icon={ShieldCheck} tone="success" />
          <StatCard label="This Month Spent" value={formatCurrency(totals.spentThisMonth)} icon={ShoppingBag} tone="warning" />
        </div>

        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">My Credit Cards ({creditCards.length})</h2>
          <div className="clay-pressed flex items-center gap-1 rounded-xl p-1">
            <button
              type="button"
              onClick={() => setViewMode("grid")}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                viewMode === "grid" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <LayoutGrid className="size-3.5" />
              Card View
            </button>
            <button
              type="button"
              onClick={() => setViewMode("list")}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                viewMode === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <List className="size-3.5" />
              List View
            </button>
          </div>
        </div>

        {viewMode === "grid" ? (
          <Stagger className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {creditCards.map((card) => (
              <CreditCardTile
                key={card.id}
                card={card}
                active={card.id === activeCardId}
                onClick={() => setActiveCardId(card.id)}
                onEdit={() => openEdit(card)}
                onDelete={() => setDeletingCard(card)}
              />
            ))}
          </Stagger>
        ) : (
          <div className="flex flex-col gap-2">
            {creditCards.map((card) => {
              const util = Math.min(100, Math.round(card.utilizationPercent));
              return (
                <button
                  key={card.id}
                  type="button"
                  onClick={() => setActiveCardId(card.id)}
                  className={cn(
                    "flex items-center gap-4 rounded-2xl border border-border/60 bg-card p-4 text-left transition-shadow hover:shadow-e1",
                    card.id === activeCardId && "ring-2 ring-primary",
                  )}
                >
                  <span
                    className="flex size-10 shrink-0 items-center justify-center rounded-2xl text-[10px] font-bold tracking-wide text-white uppercase italic"
                    style={{ background: CARD_GRADIENT[card.accent] }}
                  >
                    {card.network.slice(0, 2)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{card.name}</p>
                    <p className="text-xs text-muted-foreground">•••• {card.last4}</p>
                  </div>
                  <div className="hidden shrink-0 text-right sm:block">
                    <p className="text-xs text-muted-foreground">Outstanding</p>
                    <p className="font-mono text-sm font-semibold tabular-nums text-foreground">{formatCurrency(card.currentBalance)}</p>
                  </div>
                  <div className="w-24 shrink-0 text-right">
                    <p className="text-xs text-muted-foreground">{util}% used</p>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn("h-full rounded-full", util >= 80 ? "bg-expense" : "bg-primary")}
                        style={{ width: `${util}%` }}
                      />
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <div className="surface-flat rounded-3xl border border-border/50 p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Upcoming Statements</h2>
            <button type="button" className="flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
              View All Statements
              <ArrowRight className="size-3.5" />
            </button>
          </div>
          <div className="mt-3">
            <FinanceTable columns={statementColumns} data={creditCards} getRowId={(c) => c.id} />
          </div>
        </div>

        <div className="surface-flat rounded-3xl border border-border/50 p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Recent Card Transactions</h2>
            <button type="button" className="text-xs font-semibold text-primary hover:underline">
              View All
            </button>
          </div>
          <div className="mt-3 flex flex-col gap-1">
            {recentCardTransactions.length === 0 && (
              <p className="py-4 text-center text-sm text-muted-foreground">No recent card transactions.</p>
            )}
            {recentCardTransactions.map((txn) => {
              const Icon = CATEGORY_ICON[txn.category] ?? Receipt;
              const cardView = creditCards.find((c) => c.id === txn.card.id);
              return (
              <div key={txn.id} className="flex items-center gap-3 rounded-xl px-1 py-2 transition-colors hover:bg-muted/50">
                <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", TONE_ICON_CLASS[categoryTone(txn.category)])}>
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{txn.merchant}</p>
                  <ClayBadge tone={categoryTone(txn.category)} className="mt-0.5">
                    {txn.category}
                  </ClayBadge>
                </div>
                <div className="hidden min-w-0 flex-1 sm:block">
                  <p className="truncate text-sm text-foreground">{cardView?.name ?? "Credit Card"}</p>
                  <p className="text-xs text-muted-foreground">•••• {cardView?.last4 ?? "----"}</p>
                </div>
                <div className="shrink-0 text-right">
                  <DateCell date={txn.date} />
                  <p className="font-mono text-sm font-semibold tabular-nums text-expense">-{formatCurrency(txn.amount)}</p>
                </div>
              </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-5 xl:col-span-4">
        {activeCard && (
        <div
          style={{ background: CARD_GRADIENT[activeCard.accent] }}
          className="flex flex-col gap-5 rounded-3xl p-5 text-white shadow-e2"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="font-heading text-lg font-semibold">{activeCard.name}</h3>
              <p className="mt-0.5 font-mono text-sm tracking-widest text-white/80">•••• {activeCard.last4}</p>
            </div>
            <div className="flex flex-col items-end gap-2">
              {activeCard.isPrimary && (
                <span className="rounded-full bg-white/20 px-2.5 py-1 text-[10px] font-semibold">Primary</span>
              )}
              <span className="text-xs font-bold tracking-wide text-white/70 italic uppercase">{activeCard.network}</span>
            </div>
          </div>

          <div className="flex items-center justify-between text-sm">
            <div>
              <p className="text-xs text-white/60">Outstanding Amount</p>
              <p className="mt-0.5 font-mono text-lg font-semibold tabular-nums">{formatCurrency(activeCard.currentBalance)}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-white/60">Available Credit</p>
              <p className="mt-0.5 font-mono text-lg font-semibold tabular-nums">{formatCurrency(available)}</p>
            </div>
          </div>

          <div className="flex items-center justify-between text-xs text-white/70">
            <span>Credit Limit</span>
            <span className="font-mono font-semibold tabular-nums text-white">{formatCurrency(activeCard.creditLimit)}</span>
          </div>

          <div>
            <div className="flex items-center justify-between text-xs text-white/70">
              <span>Utilization</span>
              <span className="font-semibold text-white">{utilization}%</span>
            </div>
            <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-white/20">
              <div
                className={cn("h-full rounded-full", utilization >= 80 ? "bg-red-400" : "bg-white")}
                style={{ width: `${utilization}%` }}
              />
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-white/15 pt-3 text-xs">
            <div>
              <p className="text-white/60">Next Statement</p>
              <p className="mt-0.5 font-medium text-white">
                {activeCard.statementDate ? formatShortDate(activeCard.statementDate) : "—"}
              </p>
            </div>
            <div className="text-right">
              <p className="text-white/60">Payment Due</p>
              <p className={cn("mt-0.5 font-medium", dueInDays != null && dueInDays <= 5 ? "text-red-300" : "text-white")}>
                {dueInDays == null ? "No due date" : dueInDays <= 0 ? "Due today" : `${dueInDays} days left`}
              </p>
            </div>
          </div>
        </div>
        )}

        <div className="surface-flat rounded-3xl border border-border/50 p-5">
          <h2 className="text-sm font-semibold text-foreground">Quick Actions</h2>
          <div className="mt-4 grid grid-cols-4 gap-2">
            {[
              { label: "Pay Bill", icon: Wallet, className: "bg-primary/12 text-primary" },
              { label: "View Statement", icon: FileText, className: "bg-purple/15 text-purple" },
              { label: "Convert to EMI", icon: RefreshCw, className: "bg-success/15 text-success" },
              { label: "Card Settings", icon: Settings, className: "bg-muted text-muted-foreground" },
            ].map((action) => (
              <button
                key={action.label}
                type="button"
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
          <h2 className="text-sm font-semibold text-foreground">Spending Summary <span className="font-normal text-muted-foreground">(This Month)</span></h2>
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
                <span className="text-[9px] text-muted-foreground">Total Spent</span>
                <span className="text-xs font-bold tabular-nums text-foreground">{formatCurrency(spendTotal)}</span>
              </div>
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              {spendByCategory.map((item) => (
                <div key={item.category} className="flex items-center gap-2 text-xs">
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: CATEGORY_CHART_COLOR[categoryTone(item.category)] }}
                  />
                  <span className="min-w-0 flex-1 truncate text-foreground">{item.category}</span>
                  <span className="shrink-0 font-medium tabular-nums text-foreground">{formatCurrency(item.amount)}</span>
                  <span className="w-10 shrink-0 text-right text-muted-foreground">{item.percent}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="surface-flat rounded-3xl border border-border/50 p-5">
          <h2 className="text-sm font-semibold text-foreground">Card Benefits</h2>
          <div className="mt-2 flex flex-col divide-y divide-border/60">
            <BenefitRow icon={Award} iconClass="bg-warning/20 text-warning-foreground" label="Reward Points" value={`${(activeCard?.rewardPoints ?? 0).toLocaleString("en-IN")} pts`} />
            <BenefitRow icon={Gift} iconClass="bg-success/15 text-success" label="Cashback Earned" value={formatCurrency(activeCard?.cashbackEarned ?? 0)} />
            <BenefitRow icon={Plane} iconClass="bg-purple/15 text-purple" label="Lounge Access" value={`${activeCard?.loungeVisitsLeft ?? 0} Visits Left`} />
          </div>
          <button type="button" className="mt-3 flex w-full items-center justify-center gap-1 rounded-xl bg-muted/70 py-2.5 text-xs font-semibold text-foreground transition-colors hover:bg-muted">
            View All Benefits
            <ArrowRight className="size-3.5" />
          </button>
        </div>
      </div>

      {cardFormDialog}

      <ConfirmDialog
        open={deletingCard != null}
        onOpenChange={(open) => !open && setDeletingCard(null)}
        title={`Delete ${deletingCard?.name ?? "card"}?`}
        description="This action cannot be undone."
        variant="destructive"
        confirmLabel="Delete"
        onConfirm={handleDeleteCard}
      />
    </div>
  );
}
