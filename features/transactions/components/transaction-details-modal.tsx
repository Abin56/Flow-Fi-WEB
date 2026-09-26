"use client";

/**
 * The "Add / Edit Transaction" popup for the plain `/transactions` page.
 *
 * This surface used to share `TransactionDetailsShell` (the wide 3-column
 * layout) with Transaction Studio's `TransactionManageModal` and SMS
 * Candidates' `CandidateDetailsModal`. It's now a standalone, self-contained
 * layout scoped to this page only — a compact single-column "guided flow"
 * (amount-first, chip pickers, progressive disclosure for advanced options)
 * instead of the wide multi-card grid. The other two surfaces still render
 * from the shared shell untouched.
 *
 * All state, validation, and save/delete logic below is unchanged from the
 * shell-based version — only the JSX/markup was rebuilt. In particular:
 * person-assignment state changes still route through `applyOwesPersonChange`
 * (`owes-person-transition.ts`) — never edit `linkedPersonId`/`owesPersonToggle`
 * directly, or a ledger entry can end up orphaned/duplicated. Saving a split
 * still goes through `ExpenseRepository.editExpense`/`convertToSplit` exactly
 * as before.
 */

import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowLeftRight,
  ArrowUpFromLine,
  Banknote,
  Briefcase,
  CalendarClock,
  Check,
  ChevronDown,
  CreditCard as CreditCardIcon,
  EyeOff,
  Info,
  Landmark,
  Layers,
  Loader2,
  Lock,
  Plus,
  Save,
  SplitSquareHorizontal,
  Trash2,
  TrendingDown,
  TrendingUp,
  UserPlus,
  Users,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { BankLogo } from "@/components/finance/bank-logo";
import { ClayButton } from "@/components/clay/clay-button";
import { durations, easings, springs } from "@/lib/motion/tokens";
import { cn } from "@/lib/utils";
import { formatCurrencyPrecise } from "@/lib/format";
import { toast } from "@/store/toast-store";
import { isSplit, type Expense, type SplitType } from "@/lib/models/expense";
import type { Account, AccountType } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { LedgerEntryType, Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";
import type { ExpenseParticipantInput } from "@/lib/repositories/expense-repository";
import type { EditTransactionParams } from "@/lib/repositories/transaction-repository";
import { formatMonthYear, isSameMonth, transactionFlagFor } from "@/features/transactions/lib/transaction-flag";
import { useDuplicateGuardedCreate } from "@/lib/services/duplicate-detection/use-duplicate-guarded-create";
import { usePeopleActions } from "@/features/people/hooks/use-people-data";
import { resolveMixedSplit } from "@/lib/split/mixed-split";
import { MonthYearStepper } from "./month-year-stepper";
import {
  categoryIconFor,
  categoryToneFor,
  type TransactionRow,
  type useTransactionActions,
} from "@/features/transactions/hooks/use-transactions-data";

const DATE_DISPLAY_FORMAT = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });
const FIELD_BORDER = "border-foreground/15";

/** Matches `ExpenseRepository`'s own rounding — only used here for the live split running-total
 *  preview, never for the values actually sent to save. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

const SPLIT_TYPE_OPTIONS: { value: SplitType; label: string }[] = [
  { value: "equal", label: "Split equally" },
  { value: "custom", label: "Custom amounts" },
  { value: "percentage", label: "By percentage" },
];

/** Same options/labels/tones as the People page's "Add Ledger Entry" picker
 *  (`LEDGER_ENTRY_TYPE_OPTIONS` in people-workspace.tsx) — kept in sync by hand since the two
 *  live in different features. Only "gave" has a real expense-assignment behind it
 *  (`applyOwesPersonChange`, unchanged); "borrowed" records a plain reference on the
 *  transaction plus one `addLedgerEntry` call, same as the People page does. "repaid"/
 *  "receivedBack" are settlements against an existing "gave"/"borrowed" entry, not a starting
 *  point for a new one, so they're not offered here. Add mode only — editing an existing
 *  transaction only exposes "gave", since reversing a previously-recorded standalone ledger
 *  entry on an edit has no existing transition logic to reuse safely. */
const PERSON_ENTRY_OPTIONS: { value: LedgerEntryType; label: string; description: string; icon: LucideIcon; tone: "expense" | "success" }[] = [
  { value: "gave", label: "I Gave", description: "They owe me", icon: ArrowUpFromLine, tone: "expense" },
  { value: "borrowed", label: "I Borrowed", description: "I owe them", icon: ArrowDownToLine, tone: "success" },
];

/** Matches the icon set the Add Account dialog already uses for these types — kept visually
 *  consistent so an account reads the same way everywhere it appears as a picker. */
const ACCOUNT_TYPE_ICON: Record<AccountType, LucideIcon> = {
  bank: Landmark,
  cash: Banknote,
  wallet: Wallet,
  card: CreditCardIcon,
  business: Briefcase,
  other: Layers,
};

/** One label-above-control row — the single field pattern this popup uses throughout. */
function FormRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** Shared tile look for a 2-column grid option inside a dropdown popover — same visual language
 *  (rounded pill border, primary tint + checkmark when selected) the old inline chip rows used,
 *  just laid out as a grid tile instead of a flow chip, and hides the default list-style
 *  checkmark-on-the-right indicator in favor of a corner badge that fits the tile shape. */
const GRID_OPTION_CLASS = "relative flex items-center justify-center rounded-xl border py-2.5 text-center [&>span:first-child]:hidden";

/** What a picker's popover shows instead of an empty grid when the underlying list has zero
 *  items — a first-time-user dead end otherwise (e.g. no accounts created yet). `onMouseDown`
 *  fires (and stops propagation) before Radix's own pointerdown-based close/select handling, so
 *  the click reliably navigates instead of being swallowed by the closing popover. */
function EmptyPickerOption({ label, onNavigate }: { label: string; onNavigate: () => void }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onNavigate();
      }}
      className="col-span-2 flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-foreground/20 py-3 text-xs font-semibold text-primary-accent-text hover:bg-primary/5"
    >
      <Plus className="size-3.5" />
      {label}
    </button>
  );
}

/** Account picker — a real dropdown (not an inline chip row) whose options render as an attractive
 *  2-column grid of icon tiles. The list opens in its own floating, self-scrolling popover instead
 *  of ever growing the popup's own height, no matter how many accounts exist. */
function AccountSelect({
  accounts,
  value,
  onChange,
  placeholder = "Select account",
}: {
  accounts: Account[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
}) {
  const selected = accounts.find((a) => a.id === value);
  const router = useRouter();
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger className={cn("w-full", FIELD_BORDER)}>
        <SelectValue placeholder={placeholder}>
          {selected && (
            <span className="flex items-center gap-2">
              {selected.type === "bank" ? (
                <BankLogo bankId={selected.bankId} size={16} shape="square" />
              ) : (
                (() => {
                  const Icon = ACCOUNT_TYPE_ICON[selected.type];
                  return <Icon className="size-3.5 text-muted-foreground" />;
                })()
              )}
              {selected.name}
            </span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="min-w-64">
        <div className="grid grid-cols-2 gap-1.5 p-1">
          {accounts.length === 0 && (
            <EmptyPickerOption label="Add account" onNavigate={() => router.push("/accounts")} />
          )}
          {accounts.map((a) => {
            const Icon = ACCOUNT_TYPE_ICON[a.type];
            const isSelected = a.id === value;
            return (
              <SelectItem
                key={a.id}
                value={a.id}
                className={cn(GRID_OPTION_CLASS, isSelected ? "border-primary bg-primary/10" : FIELD_BORDER)}
              >
                <span className={cn("flex flex-col items-center gap-1", isSelected ? "text-primary-accent-text" : "text-foreground")}>
                  {a.type === "bank" ? <BankLogo bankId={a.bankId} size={18} shape="square" /> : <Icon className="size-4" />}
                  <span className="line-clamp-1 text-xs font-semibold">{a.name}</span>
                </span>
                {isSelected && <Check className="absolute top-1.5 right-1.5 size-3 text-primary-accent-text" />}
              </SelectItem>
            );
          })}
        </div>
      </SelectContent>
    </Select>
  );
}

const CATEGORY_TONE_CLASS: Record<string, string> = {
  primary: "bg-primary/12 text-primary-accent-text",
  success: "bg-success/15 text-success",
  warning: "bg-warning/20 text-warning-foreground",
  purple: "bg-purple/15 text-purple",
  expense: "bg-expense/12 text-expense",
  neutral: "bg-muted text-muted-foreground",
};

/** Category picker — same reasoning as `AccountSelect`: an attractive 2-column grid of icon tiles
 *  that opens in a dropdown whose list scrolls inside its own floating popover, so a growing
 *  category list never affects the popup's own height. */
function CategorySelect({ categories, value, onChange }: { categories: Category[]; value: string; onChange: (id: string) => void }) {
  const selected = categories.find((c) => c.id === value);
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger className={cn("w-full", FIELD_BORDER)}>
        <SelectValue placeholder="Select category">
          {selected &&
            (() => {
              const Icon = categoryIconFor(selected.iconKey);
              const tone = categoryToneFor(selected.iconKey);
              return (
                <span className="flex items-center gap-2">
                  <span className={cn("flex size-5 items-center justify-center rounded-full", CATEGORY_TONE_CLASS[tone])}>
                    <Icon className="size-3" />
                  </span>
                  {selected.name}
                </span>
              );
            })()}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="min-w-64">
        <div className="grid grid-cols-2 gap-1.5 p-1">
          {categories.map((c) => {
            const Icon = categoryIconFor(c.iconKey);
            const tone = categoryToneFor(c.iconKey);
            const isSelected = c.id === value;
            return (
              <SelectItem
                key={c.id}
                value={c.id}
                className={cn(GRID_OPTION_CLASS, isSelected ? "border-primary bg-primary/10" : FIELD_BORDER)}
              >
                <span className={cn("flex flex-col items-center gap-1", isSelected ? "text-primary-accent-text" : "text-foreground")}>
                  <span className={cn("flex size-6 items-center justify-center rounded-full", CATEGORY_TONE_CLASS[tone])}>
                    <Icon className="size-3.5" />
                  </span>
                  <span className="line-clamp-1 text-xs font-semibold">{c.name}</span>
                </span>
                {isSelected && <Check className="absolute top-1.5 right-1.5 size-3 text-primary-accent-text" />}
              </SelectItem>
            );
          })}
        </div>
      </SelectContent>
    </Select>
  );
}

type FormKind = "expense" | "income" | "transfer";

const KIND_META: Record<FormKind, { label: string; icon: LucideIcon }> = {
  expense: { label: "Expense", icon: TrendingDown },
  income: { label: "Income", icon: TrendingUp },
  transfer: { label: "Transfer", icon: ArrowLeftRight },
};
const FORM_KINDS: FormKind[] = ["expense", "income", "transfer"];
/** Kinds offered when adding a brand-new transaction — Transfer is intentionally left off (see
 *  `TransactionDetailsModal`'s Add-mode `KindSelector` usage): a new transfer still can't be
 *  created from this popup, but an existing transfer transaction still opens/edits/displays
 *  exactly as before via the Edit-mode `KindSelector` usage, which keeps showing all three so a
 *  locked "Transfer" pill still renders correctly for it. */
const ADD_MODE_FORM_KINDS: FormKind[] = ["expense", "income"];

/** Per-kind tone used for the amount hero, the header icon, and the segmented control's active label. */
const KIND_TEXT_CLASS: Record<FormKind, string> = {
  expense: "text-expense",
  income: "text-success",
  transfer: "text-primary-accent-text",
};
/** Solid kind color + its matched foreground token — for surfaces that need real color instead of a tint. */
const KIND_SOLID_CLASS: Record<FormKind, string> = {
  expense: "bg-expense text-expense-foreground",
  income: "bg-success text-success-foreground",
  transfer: "bg-primary text-primary-foreground",
};
/** Soft radial wash behind the amount hero — colored to match the selected kind. */
const KIND_HERO_BG: Record<FormKind, string> = {
  expense: "bg-gradient-to-br from-expense/12 via-expense/5 to-transparent",
  income: "bg-gradient-to-br from-success/12 via-success/5 to-transparent",
  transfer: "bg-gradient-to-br from-primary/12 via-primary/5 to-transparent",
};
/** Ring tint for the segmented control's sliding active pill, and the hero card's border — written
 *  as full literal class names (never built via string concatenation) so Tailwind's JIT scanner,
 *  which only finds classes that appear verbatim in the source text, can pick them up. */
const KIND_RING_CLASS: Record<FormKind, string> = {
  expense: "ring-expense/25",
  income: "ring-success/25",
  transfer: "ring-primary/25",
};
const KIND_BORDER_CLASS: Record<FormKind, string> = {
  expense: "border-expense/20",
  income: "border-success/20",
  transfer: "border-primary/20",
};

/** Segmented Expense/Income/Transfer control with a sliding active pill. Locked (but still shown,
 *  just disabled) once editing an existing transaction — its kind can't change after creation. */
function KindSelector({
  value,
  onChange,
  locked,
  kinds = FORM_KINDS,
}: {
  value: FormKind;
  onChange: (k: FormKind) => void;
  locked: boolean;
  /** Which kinds to render as options — defaults to all three (Edit mode, so a locked existing
   *  transfer's pill still shows). Add mode passes `ADD_MODE_FORM_KINDS` to leave Transfer out. */
  kinds?: FormKind[];
}) {
  return (
    <div className={cn("grid gap-1 rounded-xl bg-muted p-1", kinds.length === 3 ? "grid-cols-3" : "grid-cols-2")}>
      {kinds.map((k) => {
        const meta = KIND_META[k];
        const Icon = meta.icon;
        const active = value === k;
        return (
          <button
            key={k}
            type="button"
            disabled={locked && !active}
            onClick={() => onChange(k)}
            className={cn(
              "relative flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold",
              locked && !active && "opacity-40",
            )}
          >
            {active && (
              <motion.span
                layoutId="kind-pill"
                className={cn("absolute inset-0 rounded-lg bg-background shadow-sm ring-1", KIND_RING_CLASS[k])}
                transition={springs.snappy}
              />
            )}
            <span className={cn("relative z-10 flex items-center gap-1.5", active ? KIND_TEXT_CLASS[k] : "text-muted-foreground")}>
              <Icon className="size-3.5" />
              {meta.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

interface ParticipantForm {
  personId: string | null;
  name: string;
  value: string;
  /** "Custom amounts" split only — false = auto (shares whatever's left of the total equally
   *  with other unlocked rows); true = manually pinned to `value`. See `resolveMixedSplit`. */
  locked: boolean;
}

function toDateInputValue(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function kindFromRow(row: TransactionRow): FormKind {
  return row.transaction.transferId ? "transfer" : row.transaction.type;
}

export function TransactionDetailsModal({
  open,
  onOpenChange,
  row,
  expense,
  people,
  accounts,
  categories,
  actions,
  defaultKind = "expense",
  autoFocusAssign = false,
  existingTransactions = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` opens the popup in Add mode. */
  row: TransactionRow | null;
  expense: Expense | null;
  people: Person[];
  accounts: Account[];
  categories: Category[];
  actions: NonNullable<ReturnType<typeof useTransactionActions>>;
  /** Which kind the header's "Add Transaction" dropdown pre-selected — Add mode only. */
  defaultKind?: FormKind;
  /** Opens straight into the person-assignment picker — mirrors the table's quick-toggle button opening on a not-yet-linked row. */
  autoFocusAssign?: boolean;
  /** All of the user's transactions, used only for the pre-save `DuplicateDetectionService` check in Add mode — never sent anywhere, never mutated. */
  existingTransactions?: Transaction[];
}) {
  const transaction = row?.transaction ?? null;
  const peopleActions = usePeopleActions();

  const [kind, setKind] = useState<FormKind>(defaultKind);
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => toDateInputValue(new Date()));
  const [notes, setNotes] = useState("");
  const [accountId, setAccountId] = useState("");
  const [destinationAccountId, setDestinationAccountId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [exclude, setExclude] = useState(false);
  const [reassign, setReassign] = useState(false);
  const [month, setMonth] = useState<Date>(new Date());
  const [personId, setPersonId] = useState<string | null>(null);
  const [personEntryType, setPersonEntryType] = useState<LedgerEntryType | null>(null);
  const [addingPerson, setAddingPerson] = useState(false);
  const [newPersonName, setNewPersonName] = useState("");
  const [addingPersonBusy, setAddingPersonBusy] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitType, setSplitType] = useState<SplitType>("equal");
  const [participants, setParticipants] = useState<ParticipantForm[]>([{ personId: null, name: "", value: "", locked: false }]);
  const [includeMe, setIncludeMe] = useState(false);
  const [meValue, setMeValue] = useState("");
  const [meLocked, setMeLocked] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [view, setView] = useState<"form" | "split">("form");
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const duplicateGuard = useDuplicateGuardedCreate(
    existingTransactions.map((t) => ({ id: t.id, description: t.description, amount: t.amount, dateTime: t.dateTime, accountId: t.accountId, type: t.type })),
  );

  const amountRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);

  // Same "reset once per open/row change" render-time-adjustment pattern the old shell-based
  // version used — `seenKey` is `transaction.id` for edit, a stable literal for Add (so
  // reopening Add after closing always starts fresh too).
  const [seenKey, setSeenKey] = useState<string | null>(null);
  const key = transaction ? transaction.id : "__add__";
  if (open && seenKey !== key) {
    setSeenKey(key);
    if (transaction) {
      setKind(kindFromRow(row!));
      setDescription(transaction.description);
      setAmount(String(transaction.amount));
      setDate(toDateInputValue(transaction.dateTime));
      setNotes(transaction.notes);
      setAccountId(transaction.accountId);
      setDestinationAccountId("");
      setCategoryId(transaction.categoryId);
      setExclude(transaction.excludeFromCalculations);
      setReassign(transaction.accountingMonth != null);
      setMonth(transaction.accountingMonth ?? transaction.dateTime);
      setPersonId(transaction.linkedPersonId);
      setPersonEntryType(transaction.owesPersonToggle ? "gave" : null);
      setAddingPerson(autoFocusAssign && transaction.linkedPersonId == null);
    } else {
      const firstCategory = categories.find((c) => (defaultKind === "income" ? c.type !== "expense" : c.type !== "income"));
      const firstAccount = defaultKind === "income" ? accounts.find((a) => a.type !== "card") : accounts[0];
      setKind(defaultKind);
      setDescription("");
      setAmount("");
      setDate(toDateInputValue(new Date()));
      setNotes("");
      setAccountId(firstAccount?.id ?? "");
      setDestinationAccountId("");
      setCategoryId(firstCategory?.id ?? "");
      setExclude(false);
      setReassign(false);
      setMonth(new Date());
      setPersonId(null);
      setPersonEntryType(null);
      setAddingPerson(false);
    }
    setNewPersonName("");
    setFormError(null);
    setSplitOpen(false);
    setSplitType(expense?.splitType && expense.splitType !== "none" ? expense.splitType : "equal");
    // A reopened "Custom amounts" split had every amount hand-typed, so every row starts
    // locked — otherwise the mixed manual/auto engine would treat them all as auto and
    // silently flatten a previously uneven split down to equal shares the moment this opens.
    const reopenedAsLocked = expense?.splitType === "custom";
    setParticipants(
      expense && isSplit(expense)
        ? expense.participants.filter((p) => !p.isMe).map((p) => ({ personId: p.personId, name: p.name, value: String(p.share), locked: reopenedAsLocked }))
        : [{ personId: null, name: "", value: "", locked: false }],
    );
    const meParticipant = expense && isSplit(expense) ? expense.participants.find((p) => p.isMe) : undefined;
    setIncludeMe(!!meParticipant);
    setMeValue(meParticipant ? String(meParticipant.share) : "");
    setMeLocked(reopenedAsLocked);
    setConfirmDeleteOpen(false);
    setMoreOpen(false);
    setJustSaved(false);
    setView("form");
  } else if (!open && seenKey !== null) {
    setSeenKey(null);
  }

  const isTransferLeg = !!transaction?.transferId;
  const personName = personId ? (people.find((p) => p.id === personId)?.name ?? "") : "";
  const flag = transaction ? transactionFlagFor(transaction) : null;
  const monthChanged = transaction ? !isSameMonth(month, transaction.dateTime) : false;
  const filteredCategories = categories.filter((c) => (kind === "income" ? c.type !== "expense" : c.type !== "income"));
  // Income can't be received into a credit card account, so it's excluded from the picker for
  // that kind — same reasoning as `filteredCategories` above, just on the account list instead.
  const filteredAccounts = kind === "income" ? accounts.filter((a) => a.type !== "card") : accounts;

  // Live running total for the percentage split editor — percentages are always hand-typed and
  // must sum to 100, so this is a simple entered-vs-target check.
  const splitEntered =
    participants.reduce((sum, p) => sum + (Number(p.value) || 0), 0) + (includeMe ? Number(meValue) || 0 : 0);
  const splitRemaining = round2(100 - splitEntered);

  // "Custom amounts" split runs through the same mixed manual/auto engine Transaction Studio's
  // shared-expense inspector uses (ported from Finance_App's `SplitExpenseFormSheet`): a locked
  // row keeps its typed amount, every unlocked row auto-shares whatever's left of the total
  // equally — recomputed live on every keystroke, add, remove, and lock toggle. `Me`'s row is
  // included via its own `meLocked`/`meValue` state, keyed "me" instead of a participant index.
  const mixedSplit =
    splitType === "custom"
      ? resolveMixedSplit(Number(amount) || 0, [
          ...participants.map((p, i) => ({ key: `p${i}`, locked: p.locked, value: Number(p.value) || 0 })),
          ...(includeMe ? [{ key: "me", locked: meLocked, value: Number(meValue) || 0 }] : []),
        ])
      : null;

  async function handleAddPerson() {
    if (!newPersonName.trim()) return;
    setAddingPersonBusy(true);
    try {
      // actions.createPerson already surfaces a failure toast (withErrorToast) — this catch only
      // needs to stop the optimistic UI changes below from running, not toast a second time.
      const person = await actions.createPerson({ name: newPersonName.trim(), avatarColorValue: 0, openingBalance: 0 });
      setPersonId(person.id);
      setAddingPerson(false);
      setNewPersonName("");
    } catch {
      // Already toasted by actions.createPerson.
    } finally {
      setAddingPersonBusy(false);
    }
  }

  function updateParticipant(index: number, patch: Partial<ParticipantForm>) {
    setParticipants((list) => list.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }
  function addParticipantRow() {
    setParticipants((list) => [...list, { personId: null, name: "", value: "", locked: false }]);
  }
  /** "Custom amounts" only — locking pins the row at its current live (mixed-engine) share;
   *  unlocking hands it back to auto (value ignored until re-locked). */
  function toggleParticipantLock(index: number) {
    const liveShare = mixedSplit?.shares.find((s) => s.key === `p${index}`)?.share;
    const typed = Number(participants[index]?.value);
    const share = liveShare ?? (Number.isNaN(typed) ? 0 : typed);
    updateParticipant(index, { locked: !participants[index]?.locked, value: String(share) });
  }
  function toggleMeLock() {
    const liveShare = mixedSplit?.shares.find((s) => s.key === "me")?.share;
    const typed = Number(meValue);
    const share = liveShare ?? (Number.isNaN(typed) ? 0 : typed);
    setMeLocked((v) => !v);
    setMeValue(String(share));
  }

  /** Resolves the named participants (+ Me, if included) into `ExpenseParticipantInput[]` for
   *  save — shared by both the Add-mode and Edit-mode save branches. "Custom amounts" pulls each
   *  final value from `mixedSplit.shares` (the live-resolved mixed manual/auto amount) rather than
   *  the raw typed `.value`, so an unlocked row's current auto-share is what actually gets saved
   *  even if its field was never directly edited. */
  function buildParticipantInputs(): ExpenseParticipantInput[] {
    const inputs: ExpenseParticipantInput[] = participants
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.name.trim() !== "" || p.personId != null)
      .map(({ p, i }) => ({
        personId: p.personId,
        name: p.personId ? (people.find((person) => person.id === p.personId)?.name ?? p.name) : p.name,
        value: splitType === "equal" ? null : splitType === "custom" ? (mixedSplit?.shares.find((s) => s.key === `p${i}`)?.share ?? Number(p.value)) : Number(p.value),
      }));
    if (includeMe) {
      inputs.push({
        personId: null,
        name: "Me",
        isMe: true,
        value: splitType === "equal" ? null : splitType === "custom" ? (mixedSplit?.shares.find((s) => s.key === "me")?.share ?? Number(meValue)) : Number(meValue),
      });
    }
    return inputs;
  }
  function removeParticipantRow(index: number) {
    setParticipants((list) => list.filter((_, i) => i !== index));
  }

  function validate(): string | null {
    if (!description.trim() && kind !== "transfer") return "Description is required.";
    const amountValue = Number(amount);
    if (!amount.trim() || Number.isNaN(amountValue) || amountValue <= 0) return "Enter an amount greater than 0.";
    if (amountValue !== Math.round(amountValue * 100) / 100) return "Amounts can have at most 2 decimal places.";
    if (!accountId) return kind === "transfer" ? "Select a source account." : "Select an account.";
    // The destination-account picker only applies to creating a new transfer — an existing
    // transfer leg's amount/account/date are read-only (see isTransferLeg below), so
    // destinationAccountId is never part of what gets saved for one.
    if (kind === "transfer" && !isTransferLeg) {
      if (!destinationAccountId) return "Select a destination account.";
      if (destinationAccountId === accountId) return "Source and destination accounts must differ.";
    }
    if (kind !== "transfer" && !categoryId) return "Select a category.";
    if (!date) return "Select a date.";
    const dateValue = new Date(date);
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (dateValue.getTime() > today.getTime()) return "Date can't be in the future.";
    const earliestAllowed = new Date("2000-01-01");
    if (dateValue.getTime() < earliestAllowed.getTime()) return "Enter a valid date.";
    if (splitOpen) {
      const named = participants.filter((p) => p.name.trim() !== "" || p.personId != null);
      if (named.length === 0) return "Add at least one person to split with.";
      if (splitType === "percentage") {
        for (const p of named) {
          const v = Number(p.value);
          if (p.value.trim() === "" || Number.isNaN(v) || v < 0) {
            return `Enter a valid percentage for ${p.name || "this person"}.`;
          }
        }
        if (includeMe) {
          const v = Number(meValue);
          if (meValue.trim() === "" || Number.isNaN(v) || v < 0) {
            return "Enter a valid percentage for your own share.";
          }
        }
      } else if (splitType === "custom" && mixedSplit?.error) {
        return mixedSplit.error;
      }
    }
    return null;
  }

  async function handleSave() {
    if (saving || justSaved) return;
    const validationError = validate();
    if (validationError) {
      setFormError(validationError);
      return;
    }
    setFormError(null);

    const amountValue = Number(amount);
    const dateTime = new Date(date);

    // Pre-save duplicate gate — Add mode only (editing an existing transaction doesn't create a
    // new one, so there's nothing to check). A transfer writes two legs — an expense on the
    // source account and an income on the destination — so both are checked; a duplicate on
    // either leg surfaces one warning (`guardBatch` collapses multiple matches into a single
    // dialog). This never silently blocks a transfer: same-amount recurring transfers (e.g. a
    // savings sweep) are a legitimate everyday pattern, but the user should still see the
    // warning and decide for themselves each time, exactly like every other creation path.
    if (!transaction) {
      const proceed =
        kind === "transfer"
          ? await duplicateGuard.guardBatch([
              { description, amount: amountValue, date: dateTime, direction: "debit", accountId, referenceNumber: null, requireDescriptionMatch: false },
              { description, amount: amountValue, date: dateTime, direction: "credit", accountId: destinationAccountId, referenceNumber: null, requireDescriptionMatch: false },
            ])
          : await duplicateGuard.guard({
              description,
              amount: amountValue,
              date: dateTime,
              direction: kind === "income" ? "credit" : "debit",
              accountId,
              referenceNumber: null,
              requireDescriptionMatch: false,
            });
      if (!proceed) return;
    }

    setSaving(true);
    try {
      if (!transaction) {
        if (kind === "transfer") {
          await actions.createTransferPair({ amount: amountValue, dateTime, sourceAccountId: accountId, destinationAccountId, categoryId, description, notes });
        } else {
          const newTransaction = await actions.createTransaction({
            type: kind,
            amount: amountValue,
            dateTime,
            accountId,
            categoryId,
            description,
            notes,
            excludeFromCalculations: exclude,
            accountingMonth: reassign ? month : null,
          });

          // Person assignment / split only apply to expenses (same gating the UI already uses).
          // The transaction above already committed, so a failure here would otherwise leave an
          // unlinked, half-configured row silently sitting in the list while surfacing an error —
          // best-effort tear it down instead, mirroring `createTransferPair`'s own
          // best-effort-rollback philosophy for its two-leg write.
          if (kind === "expense" && (personId != null || splitOpen)) {
            try {
              if (splitOpen) {
                const inputs = buildParticipantInputs();
                await actions.expenseRepository.convertToSplit({
                  existingExpense: null,
                  transactionId: newTransaction.id,
                  description,
                  totalAmount: amountValue,
                  date: dateTime,
                  categoryId,
                  accountId,
                  notes,
                  splitType,
                  participantInputs: inputs,
                });
              } else if (personEntryType === "gave") {
                // Same expense-assignment path edit mode uses — never write linkedPersonId/
                // owesPersonToggle directly.
                await actions.applyOwesPersonChange({
                  transaction: newTransaction,
                  existingExpense: null,
                  target: { personId, personName, owesPersonToggle: true },
                });
              } else {
                // Plain descriptive reference (no expense-owed effect) — same shape as
                // `applyOwesPersonChange`'s own "reference-only" branch.
                await actions.editTransaction(newTransaction, { linkedPersonId: personId, owesPersonToggle: false });
                if (personEntryType) {
                  // Borrowed / Repaid / Received Back — not an expense assignment, so it's recorded
                  // as a standalone person-ledger entry instead, the same `addLedgerEntry` action
                  // the People page's own "Add Ledger Entry" dialog uses.
                  const person = people.find((p) => p.id === personId);
                  if (person && peopleActions) {
                    await peopleActions.addLedgerEntry(person, { type: personEntryType, amount: amountValue, date: dateTime, note: description || undefined });
                  }
                }
              }
            } catch (assignError) {
              await actions.deleteTransaction(newTransaction).catch(() => {
                // Best-effort — the original error below is what actually surfaces.
              });
              throw assignError;
            }
          }
        }
        toast.success("Transaction added");
      } else {
        const transactionEdits: Omit<EditTransactionParams, "linkedPersonId" | "clearLinkedPersonId" | "owesPersonToggle"> = {
          amount: amountValue,
          dateTime,
          accountId,
          categoryId,
          description,
          notes,
          excludeFromCalculations: exclude,
          accountingMonth: reassign ? month : null,
          clearAccountingMonth: !reassign,
        };

        if (splitOpen) {
          const inputs = buildParticipantInputs();

          if (expense != null && isSplit(expense)) {
            const currentInstallments = expense.scheduleId == null ? [] : await actions.installmentRepositoryFor(expense.scheduleId).getAll();
            await actions.expenseRepository.editExpense({
              expense,
              currentInstallments,
              description,
              totalAmount: amountValue,
              date: dateTime,
              categoryId,
              accountId,
              notes,
              splitType,
              participantInputs: inputs,
            });
          } else {
            await actions.expenseRepository.convertToSplit({
              existingExpense: expense,
              transactionId: transaction.id,
              description,
              totalAmount: amountValue,
              date: dateTime,
              categoryId,
              accountId,
              notes,
              splitType,
              participantInputs: inputs,
            });
          }

          await actions.editTransaction(transaction, { ...transactionEdits, clearLinkedPersonId: true, owesPersonToggle: false });
        } else {
          await actions.applyOwesPersonChange({
            transaction,
            existingExpense: expense,
            target: { personId, personName, owesPersonToggle: personId != null && personEntryType === "gave" },
            transactionEdits,
          });
        }
        toast.success("Transaction updated");
      }
      setJustSaved(true);
      if (!transaction) {
        // Add mode stays open for rapid entry of the next transaction — date, account, category,
        // description, and notes carry over since they're commonly the same across a run of
        // entries; only the amount (and any person/split assignment) resets.
        setTimeout(() => {
          setJustSaved(false);
          setFormError(null);
          setAmount("");
          setPersonId(null);
          setPersonEntryType(null);
          setAddingPerson(false);
          setNewPersonName("");
          setSplitOpen(false);
          setSplitType("equal");
          setParticipants([{ personId: null, name: "", value: "", locked: false }]);
          setIncludeMe(false);
          setMeValue("");
          setMeLocked(false);
          setView("form");
          amountRef.current?.focus();
        }, 260);
      } else {
        // Brief success flash before closing — purely cosmetic, doesn't delay the actual save.
        setTimeout(() => onOpenChange(false), 260);
      }
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Could not save this transaction");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (deleting || !transaction) return;
    setDeleting(true);
    try {
      // actions.deleteTransaction already surfaces a failure toast (withErrorToast) — no need to
      // toast again here, only to stop the dialog/modal from closing on failure.
      await actions.deleteTransaction(transaction, expense);
      toast.success("Transaction deleted");
      setConfirmDeleteOpen(false);
      onOpenChange(false);
    } catch {
      // Already toasted by actions.deleteTransaction.
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !(saving || deleting) && onOpenChange(next)}>
        <DialogContent
          showCloseButton={false}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (isTransferLeg ? descriptionRef.current : amountRef.current)?.focus();
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void handleSave();
            }
          }}
          className="flex max-h-[94vh] w-full flex-col gap-0 overflow-hidden overflow-y-hidden rounded-2xl border border-border p-0 shadow-[var(--shadow-dialog)] sm:max-w-[640px]"
        >
          <div className={cn("h-1.5 w-full shrink-0", view === "split" ? "bg-primary" : KIND_SOLID_CLASS[kind].split(" ")[0])} />

          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-2.5">
            {view === "split" ? (
              <div className="flex min-w-0 items-center gap-3">
                <Button variant="ghost" size="icon-sm" aria-label="Back to transaction" onClick={() => setView("form")}>
                  <ArrowLeft className="size-4" />
                </Button>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">Split Expense</p>
                  <p className="truncate text-xs text-muted-foreground">Divide this expense among people</p>
                </div>
              </div>
            ) : (
              <div className="flex min-w-0 items-center gap-3">
                <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-xl shadow-[var(--shadow-e1)]", KIND_SOLID_CLASS[kind])}>
                  {(() => {
                    const HeaderIcon = KIND_META[kind].icon;
                    return <HeaderIcon className="size-4" />;
                  })()}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">{transaction ? "Transaction Details" : "Add Transaction"}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {transaction ? `${DATE_DISPLAY_FORMAT.format(transaction.dateTime)} · ${row?.account?.name ?? "Unknown"}` : "⌘/Ctrl + Enter to save"}
                  </p>
                </div>
              </div>
            )}
            <div className="flex shrink-0 items-center gap-1.5">
              {view === "form" && flag && (
                <Badge variant="outline" className="text-[11px]">
                  {flag.label}
                </Badge>
              )}
              <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={() => onOpenChange(false)}>
                <X className="size-4" />
              </Button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <AnimatePresence mode="wait" initial={false}>
              {view === "split" ? (
                <motion.div
                  key="split"
                  initial={{ opacity: 0, x: 16 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 16 }}
                  transition={{ duration: durations.fast, ease: easings.out }}
                  className="flex flex-col gap-3.5 px-5 py-4"
                >
                  <p className="text-sm text-muted-foreground">
                    Splitting{" "}
                    <span className="font-semibold text-foreground">{amount.trim() && !Number.isNaN(Number(amount)) ? formatCurrencyPrecise(Number(amount)) : "this expense"}</span>
                  </p>

                  <FormRow label="Split type">
                    <Select value={splitType} onValueChange={(v) => setSplitType(v as SplitType)}>
                      <SelectTrigger className={cn("w-full", FIELD_BORDER)}>
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
                  </FormRow>

                  <FormRow label="Split with">
                    <div className="flex flex-col gap-2">
                      {participants.map((p, i) => (
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
                            <SelectTrigger className={cn("h-9 w-32 shrink-0", FIELD_BORDER)}>
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
                            <Input
                              placeholder="Name"
                              value={p.name}
                              className={cn("h-9 min-w-0 flex-1", FIELD_BORDER)}
                              onChange={(e) => updateParticipant(i, { name: e.target.value })}
                            />
                          )}
                          {splitType === "percentage" && (
                            <Input
                              type="number"
                              placeholder="%"
                              value={p.value}
                              className={cn("h-9 w-24 shrink-0", FIELD_BORDER)}
                              onChange={(e) => updateParticipant(i, { value: e.target.value })}
                            />
                          )}
                          {splitType === "custom" && (
                            <>
                              <Input
                                type="number"
                                placeholder="Amount"
                                value={p.locked ? p.value : String(mixedSplit?.shares.find((s) => s.key === `p${i}`)?.share ?? 0)}
                                className={cn("h-9 w-24 shrink-0 tabular-nums", !p.locked && "text-muted-foreground", FIELD_BORDER)}
                                onChange={(e) => updateParticipant(i, { value: e.target.value, locked: true })}
                              />
                              <button
                                type="button"
                                onClick={() => toggleParticipantLock(i)}
                                aria-label={p.locked ? `${p.name || "This person"}'s amount is manual — click to switch to auto-share` : `${p.name || "This person"}'s amount auto-shares the remainder — click to lock a manual amount`}
                                className={cn(
                                  "flex h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-[10px] font-semibold",
                                  p.locked ? "bg-primary/10 text-primary-accent-text" : "text-muted-foreground hover:bg-muted",
                                )}
                              >
                                {p.locked ? <Lock className="size-3" /> : null}
                                {p.locked ? "Manual" : "Auto"}
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            onClick={() => removeParticipantRow(i)}
                            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-expense"
                            aria-label="Remove participant"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      ))}
                      <Button type="button" variant="ghost" size="sm" onClick={addParticipantRow} className="w-fit gap-1.5">
                        <Plus className="size-3.5" />
                        Add person
                      </Button>

                      <label className="flex items-center gap-2 border-t border-foreground/10 pt-2.5 text-sm">
                        <Checkbox checked={includeMe} onCheckedChange={(v) => setIncludeMe(v === true)} />
                        <span className="text-foreground">Include me in this split</span>
                      </label>
                      {includeMe && splitType !== "equal" && (
                        <div className="flex items-center gap-2 pl-6">
                          <span className="text-xs text-muted-foreground">My share</span>
                          {splitType === "percentage" ? (
                            <Input
                              type="number"
                              placeholder="%"
                              value={meValue}
                              className={cn("h-9 w-24 shrink-0", FIELD_BORDER)}
                              onChange={(e) => setMeValue(e.target.value)}
                            />
                          ) : (
                            <>
                              <Input
                                type="number"
                                placeholder="Amount"
                                value={meLocked ? meValue : String(mixedSplit?.shares.find((s) => s.key === "me")?.share ?? 0)}
                                className={cn("h-9 w-24 shrink-0 tabular-nums", !meLocked && "text-muted-foreground", FIELD_BORDER)}
                                onChange={(e) => {
                                  setMeValue(e.target.value);
                                  setMeLocked(true);
                                }}
                              />
                              <button
                                type="button"
                                onClick={toggleMeLock}
                                aria-label={meLocked ? "My amount is manual — click to switch to auto-share" : "My amount auto-shares the remainder — click to lock a manual amount"}
                                className={cn(
                                  "flex h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-[10px] font-semibold",
                                  meLocked ? "bg-primary/10 text-primary-accent-text" : "text-muted-foreground hover:bg-muted",
                                )}
                              >
                                {meLocked ? <Lock className="size-3" /> : null}
                                {meLocked ? "Manual" : "Auto"}
                              </button>
                            </>
                          )}
                        </div>
                      )}

                      {splitType === "percentage" && (
                        <div
                          className={cn(
                            "flex items-center justify-between rounded-lg px-3 py-2 text-xs font-medium",
                            splitRemaining === 0 ? "bg-success/10 text-success" : "bg-warning/12 text-warning-foreground",
                          )}
                        >
                          <span>{round2(splitEntered)}% entered</span>
                          <span>{splitRemaining === 0 ? "Matches ✓" : splitRemaining > 0 ? `${splitRemaining}% left` : `${Math.abs(splitRemaining)}% over`}</span>
                        </div>
                      )}

                      {splitType === "custom" && mixedSplit && (
                        <div className={cn("flex flex-col gap-1 rounded-lg px-3 py-2.5 text-xs", mixedSplit.error ? "bg-danger/10 text-danger" : "bg-muted/40")}>
                          <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">Expense total</span>
                            <span className="tabular-nums">{formatCurrencyPrecise(Number(amount) || 0)}</span>
                          </div>
                          {mixedSplit.lockedTotal > 0 && (
                            <div className="flex items-center justify-between">
                              <span className="text-muted-foreground">Manually assigned</span>
                              <span className="tabular-nums">{formatCurrencyPrecise(mixedSplit.lockedTotal)}</span>
                            </div>
                          )}
                          <div className="flex items-center justify-between font-medium">
                            <span className="text-muted-foreground">Remaining balance</span>
                            <span className="tabular-nums">{formatCurrencyPrecise(mixedSplit.remaining)}</span>
                          </div>
                          {mixedSplit.error ? (
                            <p className="mt-0.5 border-t border-danger/20 pt-1">{mixedSplit.error}</p>
                          ) : (
                            <div className="mt-0.5 flex items-center justify-between border-t border-foreground/10 pt-1 text-success">
                              {mixedSplit.autoCount > 0 ? (
                                <span>
                                  {mixedSplit.autoCount} {mixedSplit.autoCount === 1 ? "person shares" : "people share"} equally · {formatCurrencyPrecise(mixedSplit.remaining)} ÷{" "}
                                  {mixedSplit.autoCount} = {formatCurrencyPrecise(mixedSplit.autoShare)} each
                                </span>
                              ) : (
                                <span>Everyone is manually assigned</span>
                              )}
                              <span>✓ Balanced</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </FormRow>
                </motion.div>
              ) : (
                <motion.div
                  key="form"
                  initial={{ opacity: 0, x: -16 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -16 }}
                  transition={{ duration: durations.fast, ease: easings.out }}
                  className="flex flex-col gap-3.5 px-5 py-4"
                >
            {formError && (
              <motion.p
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: durations.fast, ease: easings.out }}
                className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger"
              >
                {formError}
              </motion.p>
            )}
            {isTransferLeg && (
              <div className="flex items-start gap-2 rounded-lg border border-dashed border-foreground/15 bg-muted/30 px-3 py-2.5">
                <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <p className="text-xs text-muted-foreground">
                  This is one leg of a transfer. Amount, account, and date are locked so the two linked transactions can&apos;t drift out of sync — delete the transfer and create a new one to change them.
                </p>
              </div>
            )}

            <KindSelector
              value={kind}
              onChange={(next) => {
                setKind(next);
                // Switching to Income while a credit card account is selected would otherwise leave
                // the picker pointing at an option `filteredAccounts` no longer offers for that kind.
                if (next === "income" && accounts.find((a) => a.id === accountId)?.type === "card") {
                  setAccountId(accounts.find((a) => a.type !== "card")?.id ?? "");
                }
              }}
              locked={!!transaction}
              kinds={transaction ? FORM_KINDS : ADD_MODE_FORM_KINDS}
            />

            <div className={cn("flex flex-col items-center gap-1 rounded-2xl border py-3 transition-colors", KIND_HERO_BG[kind], KIND_BORDER_CLASS[kind])}>
              <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Amount</span>
              <div className="flex items-center gap-1">
                <span className={cn("text-xl font-bold", KIND_TEXT_CLASS[kind])}>{kind === "income" ? "+" : "−"}</span>
                <input
                  ref={amountRef}
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  disabled={isTransferLeg}
                  onChange={(e) => setAmount(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      descriptionRef.current?.focus();
                    }
                  }}
                  className={cn(
                    "w-40 border-none bg-transparent text-center text-3xl font-bold tabular-nums outline-none placeholder:text-tertiary-foreground disabled:opacity-60",
                    KIND_TEXT_CLASS[kind],
                  )}
                />
              </div>
              <span className="text-xs text-muted-foreground">
                {amount.trim() && !Number.isNaN(Number(amount)) ? formatCurrencyPrecise(Number(amount)) : "Enter an amount"}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormRow label={kind === "transfer" ? "Description" : "Description *"}>
                <Input
                  ref={descriptionRef}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      dateRef.current?.focus();
                    }
                  }}
                  placeholder="e.g. Blue Tokai Coffee"
                  className={FIELD_BORDER}
                />
              </FormRow>

              <FormRow label="Date *">
                <Input ref={dateRef} type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={isTransferLeg} className={FIELD_BORDER} />
              </FormRow>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormRow label={kind === "transfer" ? "From Account *" : "Account *"}>
                {isTransferLeg ? (
                  <div className={cn("flex w-fit items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold text-muted-foreground", FIELD_BORDER)}>
                    {(() => {
                      const locked = accounts.find((a) => a.id === accountId);
                      if (!locked) return "Unknown account";
                      const Icon = ACCOUNT_TYPE_ICON[locked.type];
                      return (
                        <>
                          {locked.type === "bank" ? <BankLogo bankId={locked.bankId} size={14} shape="square" /> : <Icon className="size-3.5" />}
                          {locked.name}
                        </>
                      );
                    })()}
                  </div>
                ) : (
                  <AccountSelect accounts={filteredAccounts} value={accountId} onChange={setAccountId} />
                )}
              </FormRow>

              {kind === "transfer" ? (
                !isTransferLeg && (
                  <FormRow label="To Account *">
                    <AccountSelect
                      accounts={accounts.filter((a) => a.id !== accountId)}
                      value={destinationAccountId}
                      onChange={setDestinationAccountId}
                      placeholder="Select destination account"
                    />
                  </FormRow>
                )
              ) : (
                <FormRow label="Category *">
                  <CategorySelect categories={filteredCategories} value={categoryId} onChange={setCategoryId} />
                </FormRow>
              )}
            </div>

            <FormRow label="Notes">
              <Textarea value={notes} placeholder="Add a note (optional)" className={cn("min-h-9 text-sm", FIELD_BORDER)} onChange={(e) => setNotes(e.target.value)} />
            </FormRow>

            {kind !== "expense" ? (
              <div className="flex items-start gap-2 rounded-lg border border-dashed border-foreground/15 bg-muted/30 px-3 py-2">
                <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <p className="text-xs text-muted-foreground">Assigning to a person or splitting is only available for expenses.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2.5 rounded-xl border border-foreground/10 p-3">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  <Users className="size-3.5 text-muted-foreground" />
                  People &amp; Split
                </div>
                <FormRow label="Assign to a person">
                  <AnimatePresence mode="wait" initial={false}>
                    {!addingPerson ? (
                      <motion.div key="select" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: durations.fast }}>
                        <Select
                          value={personId ?? "none"}
                          onValueChange={(v) => {
                            if (v === "add-new") {
                              setAddingPerson(true);
                              return;
                            }
                            setPersonId(v === "none" ? null : v);
                            if (v === "none") setPersonEntryType(null);
                          }}
                        >
                          <SelectTrigger className={cn("w-full", FIELD_BORDER)}>
                            <SelectValue placeholder="No one" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">No one</SelectItem>
                            {people.map((p) => (
                              <SelectItem key={p.id} value={p.id}>
                                {p.name}
                              </SelectItem>
                            ))}
                            <SelectItem value="add-new">
                              <span className="flex items-center gap-1.5">
                                <UserPlus className="size-3.5" /> Add new person
                              </span>
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </motion.div>
                    ) : (
                      <motion.div key="add" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: durations.fast }} className="flex items-center gap-2">
                        <Input
                          autoFocus
                          placeholder="Person's name"
                          value={newPersonName}
                          className={cn("min-w-0", FIELD_BORDER)}
                          onChange={(e) => setNewPersonName(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && void handleAddPerson()}
                        />
                        <Button size="icon-sm" onClick={() => void handleAddPerson()} disabled={addingPersonBusy || !newPersonName.trim()} aria-label="Save person">
                          <Check className="size-4" />
                        </Button>
                        <Button size="icon-sm" variant="ghost" onClick={() => setAddingPerson(false)} aria-label="Cancel">
                          <X className="size-4" />
                        </Button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </FormRow>

                {!personId && !splitOpen && (
                  <p className="text-xs text-muted-foreground">Pick a person above to record I Gave / I Borrowed.</p>
                )}

                {!splitOpen && (
                  <ClayButton
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setSplitOpen(true);
                      setView("split");
                    }}
                    className="w-fit gap-1.5 text-primary-accent-text"
                  >
                    <SplitSquareHorizontal className="size-3.5" />
                    Split with more people
                  </ClayButton>
                )}

                <AnimatePresence initial={false}>
                  {personId && !splitOpen && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: durations.fast, ease: easings.out }}
                      className="overflow-hidden border-t border-foreground/10 pt-3"
                    >
                      {transaction ? (
                        // Edit mode only ever offers "I Gave" — reversing a previously-recorded
                        // standalone ledger entry (Borrowed/Repaid/Received Back) on an edit has no
                        // existing transition logic to reuse safely, unlike `applyOwesPersonChange`
                        // which already handles every "gave" transition (assign/unassign/reassign/
                        // edit-in-place).
                        <button
                          type="button"
                          onClick={() => setPersonEntryType((t) => (t === "gave" ? null : "gave"))}
                          aria-pressed={personEntryType === "gave"}
                          className={cn(
                            "flex w-full items-center gap-2.5 rounded-xl border p-2.5 text-left transition-colors",
                            personEntryType === "gave" ? "border-expense/40 bg-expense/10" : "border-border/50 bg-card hover:border-border",
                          )}
                        >
                          <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", personEntryType === "gave" ? "bg-expense/20 text-expense" : "bg-muted text-muted-foreground")}>
                            <ArrowUpFromLine className="size-4" />
                          </span>
                          <span className="min-w-0">
                            <p className="truncate text-sm font-semibold text-foreground">I Gave</p>
                            <p className="truncate text-xs text-muted-foreground">They owe me — adds this amount to what they owe you.</p>
                          </span>
                        </button>
                      ) : (
                        // Add mode — same "I Gave"/"I Borrowed" picker as the People page's "Add
                        // Ledger Entry" dialog (`LEDGER_ENTRY_TYPE_OPTIONS`). "I Gave" goes through
                        // the same `applyOwesPersonChange` expense-assignment path as edit mode;
                        // "I Borrowed" records a plain descriptive link on the transaction plus one
                        // `addLedgerEntry` call, mirroring what the People page itself does.
                        <div className="grid grid-cols-2 gap-2">
                          {PERSON_ENTRY_OPTIONS.map((o) => {
                            const Icon = o.icon;
                            const active = personEntryType === o.value;
                            return (
                              <button
                                key={o.value}
                                type="button"
                                onClick={() => setPersonEntryType((t) => (t === o.value ? null : o.value))}
                                aria-pressed={active}
                                className={cn(
                                  "flex items-center gap-2 rounded-xl border p-2 text-left transition-colors",
                                  active
                                    ? o.tone === "success"
                                      ? "border-success/40 bg-success/10"
                                      : "border-expense/40 bg-expense/10"
                                    : "border-border/50 bg-card hover:border-border",
                                )}
                              >
                                <span
                                  className={cn(
                                    "flex size-7 shrink-0 items-center justify-center rounded-full",
                                    active ? (o.tone === "success" ? "bg-success/20 text-success" : "bg-expense/20 text-expense") : "bg-muted text-muted-foreground",
                                  )}
                                >
                                  <Icon className="size-3.5" />
                                </span>
                                <span className="min-w-0">
                                  <p className="truncate text-xs font-semibold text-foreground">{o.label}</p>
                                  <p className="truncate text-[11px] text-muted-foreground">{o.description}</p>
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>

                <AnimatePresence initial={false}>
                  {splitOpen && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: durations.fast, ease: easings.out }}
                      className="flex items-center justify-between gap-2 overflow-hidden border-t border-foreground/10 pt-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">
                          {(() => {
                            const named = participants.filter((p) => p.name.trim() !== "" || p.personId != null);
                            const count = named.length + (includeMe ? 1 : 0);
                            return `Split ${splitType === "equal" ? "equally" : splitType === "percentage" ? "by %" : "custom"} · ${count} ${count === 1 ? "person" : "people"}${includeMe ? " (incl. me)" : ""}`;
                          })()}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">Edit to change who&apos;s included or the amounts.</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button type="button" variant="outline" size="sm" onClick={() => setView("split")}>
                          Edit
                        </Button>
                        <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove split" onClick={() => setSplitOpen(false)}>
                          <X className="size-4" />
                        </Button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}

            <div className="flex flex-col gap-1">
              <button
                type="button"
                onClick={() => setMoreOpen((v) => !v)}
                className="flex items-center gap-1.5 self-start text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                <ChevronDown className={cn("size-3.5 transition-transform", moreOpen && "rotate-180")} />
                More options
                <span className="text-tertiary-foreground">(visibility, month)</span>
              </button>
              <AnimatePresence initial={false}>
                {moreOpen && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: durations.fast, ease: easings.out }}
                    className="flex flex-col gap-3 overflow-hidden pt-2.5"
                  >
                    {kind === "transfer" ? (
                      <p className="text-xs text-muted-foreground">Visibility and month reassignment aren&apos;t applicable for transfers.</p>
                    ) : (
                      <>
                        <label className="flex items-start gap-2 border-t border-foreground/10 pt-2.5 text-sm">
                          <Switch checked={exclude} onCheckedChange={setExclude} className="mt-0.5" />
                          <span>
                            <span className="flex items-center gap-1.5 text-foreground">
                              <EyeOff className="size-3.5" /> Don&apos;t count this in my totals
                            </span>
                            <span className="block text-xs text-muted-foreground">Still shows in history — won&apos;t affect balance, budgets, or reports.</span>
                          </span>
                        </label>

                        <label className="flex items-start gap-2 text-sm">
                          <Switch
                            checked={reassign}
                            onCheckedChange={(v) => {
                              setReassign(v);
                              if (v) setMonth(new Date(date));
                            }}
                            className="mt-0.5"
                          />
                          <span>
                            <span className="flex items-center gap-1.5 text-foreground">
                              <CalendarClock className="size-3.5" /> Count this in a different month?
                            </span>
                            {!reassign && <span className="block text-xs text-muted-foreground">Right now: counted in {formatMonthYear(new Date(date))}</span>}
                          </span>
                        </label>
                        <AnimatePresence initial={false}>
                          {reassign && (
                            <motion.div
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: "auto" }}
                              exit={{ opacity: 0, height: 0 }}
                              transition={{ duration: durations.fast, ease: easings.out }}
                              className="flex flex-col gap-2 overflow-hidden"
                            >
                              <MonthYearStepper value={month} onChange={setMonth} />
                              {monthChanged && (
                                <div className="flex items-start gap-2 rounded-lg bg-warning/12 px-3 py-2.5 text-xs text-warning-foreground">
                                  <Info className="mt-0.5 size-3.5 shrink-0" />
                                  <p>This won&apos;t count in this month&apos;s totals — instead it&apos;ll count in {formatMonthYear(month)}&apos;s Budget, Cash Flow, and Reports.</p>
                                </div>
                              )}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <DialogFooter className="shrink-0 flex-row items-center justify-between border-t border-border px-5 py-3 sm:justify-between">
            {view === "split" ? (
              <>
                <ClayButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-danger hover:text-danger"
                  onClick={() => {
                    setSplitOpen(false);
                    setView("form");
                  }}
                >
                  <X className="size-3.5" /> Remove split
                </ClayButton>
                <div className="flex items-center gap-2">
                  <ClayButton type="button" variant="secondary" size="sm" onClick={() => setView("form")}>
                    Back
                  </ClayButton>
                  <ClayButton type="button" size="sm" onClick={() => setView("form")}>
                    <Check className="size-3.5" /> Done
                  </ClayButton>
                </div>
              </>
            ) : (
              <>
                {transaction ? (
                  <Button variant="ghost" size="sm" className="text-danger hover:bg-danger/10 hover:text-danger" onClick={() => setConfirmDeleteOpen(true)}>
                    <Trash2 className="size-3.5" /> {isTransferLeg ? "Delete Transfer" : "Delete"}
                  </Button>
                ) : (
                  <span />
                )}
                <div className="flex items-center gap-2">
                  <ClayButton type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
                    Cancel
                  </ClayButton>
                  <ClayButton type="button" size="sm" onClick={() => void handleSave()} disabled={saving || justSaved}>
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.span
                        key={justSaved ? "saved" : saving ? "saving" : "idle"}
                        initial={{ scale: 0.5, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.5, opacity: 0 }}
                        transition={springs.snappy}
                        className="flex items-center"
                      >
                        {justSaved ? <Check className="size-3.5" /> : saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                      </motion.span>
                    </AnimatePresence>
                    {justSaved ? "Saved" : saving ? "Saving…" : transaction ? "Save changes" : "Add transaction"}
                  </ClayButton>
                </div>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isTransferLeg ? "Delete this transfer?" : "Delete this transaction?"}</DialogTitle>
            <DialogDescription>
              {isTransferLeg
                ? "This removes both linked transactions and reverses the balance change on both accounts. This action cannot be undone."
                : "This action cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDeleteOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleting}>
              {deleting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              {isTransferLeg ? "Delete transfer" : "Delete transaction"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {duplicateGuard.dialog}
    </>
  );
}
