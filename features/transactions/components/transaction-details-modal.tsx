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

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
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
  NotebookPen,
  Plus,
  Save,
  Shapes,
  SplitSquareHorizontal,
  Trash2,
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
import { Input, INPUT_BASE_CLASS } from "@/components/ui/input";
import { DateInput } from "@/components/forms/date-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { BankLogo } from "@/components/finance/bank-logo";
import { ClayButton } from "@/components/clay/clay-button";
import { durations, easings, springs } from "@/lib/motion/tokens";
import { cn } from "@/lib/utils";
import { formatCurrencyPrecise } from "@/lib/format";
import { startOperation } from "@/store/operation-progress-store";
import { isSplit, type Expense, type SplitType } from "@/lib/models/expense";
import type { Account, AccountType } from "@/lib/models/account";
import type { Category, CategoryType } from "@/lib/models/category";
import type { LedgerEntryType, Person } from "@/lib/models/person";
import { PERSON_FUNDED_ACCOUNT_ID, type Transaction } from "@/lib/models/transaction";
import type { ExpenseParticipantInput } from "@/lib/repositories/expense-repository";
import type { EditTransactionParams } from "@/lib/repositories/transaction-repository";
import { formatMonthYear, isSameMonth, transactionFlagFor } from "@/features/transactions/lib/transaction-flag";
import { useDuplicateGuardedCreate } from "@/lib/services/duplicate-detection/use-duplicate-guarded-create";
import { resolveMixedSplit } from "@/lib/split/mixed-split";
import { WS_FIELD, WS_GHOST, WS_PRIMARY, WS_SECONDARY, WS_SELECT_TRIGGER } from "@/features/people/components/workspace/person-workspace-ui";
import { choiceClass } from "@/features/loans/components/loan-emi-ui";
import { MonthYearStepper } from "./month-year-stepper";
import { ManageCategoriesDialog } from "./manage-categories-dialog";
import {
  categoryIconFor,
  categoryToneFor,
  type TransactionRow,
  type useTransactionActions,
} from "@/features/transactions/hooks/use-transactions-data";
import { handleEnterKey } from "@/components/ui/enter-key";
import { handleEnterAdvance } from "@/components/finance/enter-advance";
import { focusInvalidField, type TxnFormField, type TxnValidationError } from "@/features/transactions/lib/focus-invalid-field";
import {
  TXN_KIND_EDGE as KIND_BORDER_CLASS,
  TXN_KIND_META as KIND_META,
  TXN_KIND_SOLID as KIND_SOLID_CLASS,
  TXN_KIND_TEXT as KIND_TEXT_CLASS,
  TxnAccountFlow,
  TxnFieldRow as FormRow,
  TxnModeSwitch,
  TxnSection as FormSection,
  type TxnFormKind,
} from "./transaction-form-ui";
import { PeopleSettlementCard, settleCtaLabel } from "@/features/people/components/linked-people-panel";
import { peopleSettleHref, peopleSettlementGate, type LinkedPeopleReadiness } from "@/lib/engines/linked-people-readiness";

const DATE_DISPLAY_FORMAT = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });
/** Solid `border-strong` edge (People Ledger / Loan & EMI rule) — never an opacity-faded border that
 *  washes out on low-contrast displays. */
const FIELD_BORDER = "border-border-strong";

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
 *  live in different features. "gave" is the expense-assignment (`applyOwesPersonChange`,
 *  unchanged). "borrowed" on an expense is still MY expense; it then asks who paid
 *  (`BORROW_FUNDING_OPTIONS`): the person directly (`createPersonFundedExpense` — no account,
 *  one "I owe them" entry) or me from an account (an ordinary expense, person as reference).
 *  Borrowed CASH received into an account is a different event, recorded from People. "repaid"/
 *  "receivedBack" are settlements against an existing "gave"/"borrowed" entry, not a starting
 *  point for a new one, so they're not offered here. Edit mode offers "gave" as before; it offers
 *  "borrowed" only together with "paid directly", whose transitions `changeExpenseFunding` owns. */
const PERSON_ENTRY_OPTIONS: { value: LedgerEntryType; label: string; description: string; icon: LucideIcon; tone: "expense" | "success" }[] = [
  { value: "gave", label: "Money I Gave", description: "They owe me", icon: ArrowUpFromLine, tone: "expense" },
  { value: "borrowed", label: "Money I Borrowed", description: "I owe them", icon: ArrowDownToLine, tone: "success" },
];

type BorrowFunding = "person" | "account";

/** "Money I Borrowed" → who actually paid. Nothing preselected: the user must say which. */
const BORROW_FUNDING_OPTIONS: { value: BorrowFunding; label: (name: string) => string; description: string }[] = [
  { value: "person", label: (name) => `${name} paid directly`, description: "No money leaves your accounts." },
  { value: "account", label: () => "I paid from my account", description: "Choose the account you used." },
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

/** Add-mode footer recap of what's about to be saved — "−₹450 · Food · HDFC" (a transfer carries no
 *  +/− — it is neither income nor expense). Display only: reads the same form state the save handler
 *  reads, never feeds anything back. Hidden on phones. */
function FooterSummary({ kind, amount, category, account }: { kind: FormKind; amount: string; category?: Category; account?: Account }) {
  const value = Number(amount);
  const hasAmount = amount.trim() !== "" && !Number.isNaN(value) && value > 0;
  return (
    <div className="hidden min-w-0 items-center gap-2 text-xs text-foreground/75 sm:flex">
      <span className={cn("font-heading text-sm font-bold tabular-nums", hasAmount ? KIND_TEXT_CLASS[kind] : "text-muted-foreground")}>
        {kindSign(kind)}
        {hasAmount ? formatCurrencyPrecise(value) : "₹0"}
      </span>
      {category && (
        <>
          <span aria-hidden>·</span>
          <span className="flex min-w-0 items-center gap-1 text-foreground/80">
            {(() => {
              const Icon = categoryIconFor(category.iconKey);
              return <Icon className="size-3 shrink-0" strokeWidth={2} />;
            })()}
            <span className="truncate">{category.name}</span>
          </span>
        </>
      )}
      {account && (
        <>
          <span aria-hidden>·</span>
          <span className="truncate text-foreground/80">{account.name}</span>
        </>
      )}
    </div>
  );
}

const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  bank: "Bank account",
  cash: "Cash",
  wallet: "Wallet",
  card: "Credit card",
  business: "Business",
  other: "Other",
};

/** Shared tile look for a 2-column grid option inside a dropdown popover — same visual language
 *  (rounded pill border, primary tint + checkmark when selected) the old inline chip rows used,
 *  just laid out as a grid tile instead of a flow chip, and hides the default list-style
 *  checkmark-on-the-right indicator in favor of a corner badge that fits the tile shape. */
const GRID_OPTION_CLASS = "relative flex min-h-9 items-center justify-start rounded-[6px] border px-2 py-1.5 pr-5 text-left [&>span:first-child]:hidden [&>span:last-child]:min-w-0";

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
      className="col-span-2 flex items-center justify-center gap-1.5 rounded-[6px] border border-dashed border-border-strong py-1.5 text-[11px] font-semibold text-primary-accent-text hover:bg-primary/5"
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
      <SelectTrigger className={WS_SELECT_TRIGGER}>
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
              <span className="truncate">{selected.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">· {ACCOUNT_TYPE_LABEL[selected.type]}</span>
            </span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="w-(--radix-select-trigger-width) rounded-[8px] border-border-strong">
        <div className="grid max-h-64 grid-cols-2 gap-1 overflow-y-auto p-1">
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
                className={cn(GRID_OPTION_CLASS, choiceClass(isSelected))}
              >
                <span className="flex min-w-0 items-center gap-2">
                  {a.type === "bank" ? <BankLogo bankId={a.bankId} size={14} shape="square" /> : <Icon className="size-3.5" />}
                  <span className="truncate text-xs font-medium">{a.name}</span>
                </span>
                {isSelected && <Check className="absolute top-1/2 right-1.5 size-3 -translate-y-1/2" strokeWidth={2.5} />}
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
function CategorySelect({
  categories,
  value,
  onChange,
  type,
}: {
  categories: Category[];
  value: string;
  onChange: (id: string) => void;
  type: CategoryType;
}) {
  const selected = categories.find((c) => c.id === value);
  const [manageOpen, setManageOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <>
    <Select open={pickerOpen} onOpenChange={setPickerOpen} value={value || undefined} onValueChange={onChange}>
      <SelectTrigger className={WS_SELECT_TRIGGER}>
        <SelectValue placeholder="Select category">
          {selected &&
            (() => {
              const Icon = categoryIconFor(selected.iconKey);
              const tone = categoryToneFor(selected.iconKey);
              return (
                <span className="flex items-center gap-2">
                  <span className={cn("flex size-5 items-center justify-center rounded-[4px]", CATEGORY_TONE_CLASS[tone])}>
                    <Icon className="size-3" strokeWidth={2} />
                  </span>
                  <span className="truncate font-medium">{selected.name}</span>
                </span>
              );
            })()}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="w-(--radix-select-trigger-width) rounded-[8px] border-border-strong">
        <div className="grid max-h-64 grid-cols-2 gap-1 overflow-y-auto p-1">
          {categories.map((c) => {
            const Icon = categoryIconFor(c.iconKey);
            const tone = categoryToneFor(c.iconKey);
            const isSelected = c.id === value;
            return (
              <SelectItem
                key={c.id}
                value={c.id}
                className={cn(GRID_OPTION_CLASS, choiceClass(isSelected))}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-[4px]", CATEGORY_TONE_CLASS[tone])}>
                    <Icon className="size-3" />
                  </span>
                  <span className="truncate text-xs font-medium">{c.name}</span>
                </span>
                {isSelected && <Check className="absolute top-1/2 right-1.5 size-3 -translate-y-1/2" strokeWidth={2.5} />}
              </SelectItem>
            );
          })}
          <EmptyPickerOption
            label="Manage categories"
            onNavigate={() => {
              setPickerOpen(false);
              setManageOpen(true);
            }}
          />
        </div>
      </SelectContent>
    </Select>
    <ManageCategoriesDialog
      open={manageOpen}
      onOpenChange={setManageOpen}
      categories={categories}
      type={type}
      onCreated={onChange}
      onDeleted={(id) => {
        if (id === value) onChange("");
      }}
    />
    </>
  );
}

type FormKind = TxnFormKind;

const FORM_KINDS: FormKind[] = ["expense", "income", "transfer"];
/** Kinds offered when adding a brand-new transaction — Transfer is intentionally left off: a new
 *  transfer can only be started from a flow that opens this popup with `defaultKind: "transfer"`
 *  (card Pay bill), which keeps all three so the Transfer mode has its own visible identity. An
 *  existing transfer still opens/edits exactly as before (Edit mode shows all three, locked). */
const ADD_MODE_FORM_KINDS: FormKind[] = ["expense", "income"];

/** The amount's sign — money out, money in, or none for a transfer (neither income nor expense). */
function kindSign(kind: FormKind): string {
  return kind === "income" ? "+" : kind === "expense" ? "−" : "";
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

/** A lender payment's People settlement gate, computed by the caller from live People data. */
export interface PeopleGateInput {
  /** The lender account being paid (the card). */
  accountId: string;
  readiness: LinkedPeopleReadiness | null;
  /** People data still loading — the gate is unknown, so the payment waits. */
  loading: boolean;
  /** Shown as "Ready to pay {payeeName}". */
  payeeName: string;
  /** In-app path People returns to once the settlement is recorded. */
  returnTo?: string;
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
  initialDestinationAccountId,
  initialAmount,
  peopleGate = null,
  onDestinationAccountChange,
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
  /** Add mode + `defaultKind: "transfer"` only — pre-fills the transfer's destination account (e.g. a credit card being paid off). */
  initialDestinationAccountId?: string;
  /** Add mode only — pre-fills the amount field (e.g. a statement's total due). */
  initialAmount?: number;
  /** Add mode + transfer only — the People settlement gate for paying `accountId` (a card bill): while a
   *  People obligation linked to that bill is still open, this payment can't be saved and the primary
   *  action becomes the exact settlement step. Applies only while the To account is `accountId`. */
  peopleGate?: PeopleGateInput | null;
  /** Add mode + transfer — the To account changed (so the caller can re-target `peopleGate`). */
  onDestinationAccountChange?: (accountId: string) => void;
}) {
  const transaction = row?.transaction ?? null;

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
  /** "Money I Borrowed" only: who actually paid — the person directly (no account), or me from an account. */
  const [borrowFunding, setBorrowFunding] = useState<BorrowFunding | null>(null);
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
  // Which field the last failed submit pointed at — highlighted only while that field is still the first problem.
  const [invalidField, setInvalidField] = useState<TxnFormField | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // Set once Done has been pressed on the split view — from then on the split's own problem (if any) shows
  // live on that view and clears itself as the entries are fixed.
  const [splitAttempted, setSplitAttempted] = useState(false);
  const meShareRef = useRef<HTMLInputElement>(null);
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
      setPersonId(transaction.linkedPersonId ?? transaction.fundedByPersonId ?? null);
      // A person-funded expense reopens as "Money I Borrowed → <person> paid directly".
      setPersonEntryType(transaction.fundedByPersonId != null ? "borrowed" : transaction.owesPersonToggle ? "gave" : null);
      setBorrowFunding(transaction.fundedByPersonId != null ? "person" : null);
      setAddingPerson(autoFocusAssign && transaction.linkedPersonId == null);
    } else {
      const firstCategory = categories.find((c) => (defaultKind === "income" ? c.type !== "expense" : c.type !== "income"));
      const firstAccount = defaultKind === "income" ? accounts.find((a) => a.type !== "card") : accounts[0];
      setKind(defaultKind);
      setDescription("");
      setAmount(initialAmount != null ? String(initialAmount) : "");
      setDate(toDateInputValue(new Date()));
      setNotes("");
      setAccountId(firstAccount?.id ?? "");
      setDestinationAccountId(defaultKind === "transfer" ? (initialDestinationAccountId ?? "") : "");
      setCategoryId(firstCategory?.id ?? "");
      setExclude(false);
      setReassign(false);
      setMonth(new Date());
      setPersonId(null);
      setPersonEntryType(null);
      setBorrowFunding(null);
      setAddingPerson(false);
    }
    setNewPersonName("");
    setFormError(null);
    setInvalidField(null);
    setSplitAttempted(false);
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
  /** "Money I Borrowed" is on — the form must know who paid before it can save. */
  const borrowedChosen = kind === "expense" && personId != null && !splitOpen && personEntryType === "borrowed";
  /** The person paid this expense directly: no account is part of the transaction (any selected one is ignored). */
  const personPaysDirectly = borrowedChosen && borrowFunding === "person";
  const personName = personId ? (people.find((p) => p.id === personId)?.name ?? "") : "";
  const flag = transaction ? transactionFlagFor(transaction) : null;
  const monthChanged = transaction ? !isSameMonth(month, transaction.dateTime) : false;
  const filteredCategories = categories.filter((c) => (kind === "income" ? c.type !== "expense" : c.type !== "income"));
  // Income can't be received into a credit card account, so it's excluded from the picker for
  // that kind — same reasoning as `filteredCategories` above, just on the account list instead.
  const filteredAccounts = kind === "income" ? accounts.filter((a) => a.type !== "card") : accounts;
  const destinationAccount = kind === "transfer" ? accounts.find((a) => a.id === destinationAccountId) : undefined;
  const paysCardBill = destinationAccount?.type === "card";

  // People settlement gate — only a new transfer paying the gated card. Obligations linked to that bill
  // (by key, from the caller's readiness) gate it; nothing else about the person does.
  const gateActive = !transaction && kind === "transfer" && peopleGate != null && peopleGate.accountId === destinationAccountId;
  const settlement = peopleSettlementGate(gateActive ? peopleGate.readiness : null);
  const gateLoading = gateActive && peopleGate.loading;
  const gateBlocked = gateActive && (settlement.blocked || gateLoading);
  /** The footer's Settle action — where Enter / Ctrl+Enter / Save land while the payment is blocked. */
  const settleCtaRef = useRef<HTMLAnchorElement>(null);

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

  /** First invalid required field in the form's visual order (Amount → Description → Category → Date → Account →
   *  To Account → Money given/borrowed → Split), so a failed submit always lands on the topmost problem. */
  function validate(): TxnValidationError | null {
    const fail = (field: TxnFormField, message: string): TxnValidationError => ({ field, message });
    const amountValue = Number(amount);
    if (!amount.trim() || Number.isNaN(amountValue) || amountValue <= 0) return fail("amount", "Enter an amount greater than 0.");
    if (amountValue !== Math.round(amountValue * 100) / 100) return fail("amount", "Amounts can have at most 2 decimal places.");
    if (!description.trim() && kind !== "transfer") return fail("description", "Description is required.");
    if (kind !== "transfer" && !categoryId) return fail("category", "Select a category.");
    if (!date) return fail("date", "Select a date.");
    const dateValue = new Date(date);
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (dateValue.getTime() > today.getTime()) return fail("date", "Date can't be in the future.");
    const earliestAllowed = new Date("2000-01-01");
    if (dateValue.getTime() < earliestAllowed.getTime()) return fail("date", "Enter a valid date.");
    if (!accountId && !personPaysDirectly) return fail("account", kind === "transfer" ? "Select a source account." : "Select an account.");
    // The destination-account picker only applies to creating a new transfer — an existing
    // transfer leg's amount/account/date are read-only (see isTransferLeg below), so
    // destinationAccountId is never part of what gets saved for one.
    if (kind === "transfer" && !isTransferLeg) {
      if (!destinationAccountId) return fail("destination", "Select a destination account.");
      if (destinationAccountId === accountId) return fail("destination", "Source and destination accounts must differ.");
    }
    // Assigning to a person needs an explicit direction — never defaulted for the user.
    if (!transaction && kind === "expense" && personId != null && !splitOpen && !personEntryType) {
      return fail("personDirection", "Select Money given or Money borrowed.");
    }
    if (borrowedChosen && borrowFunding == null) {
      return fail("personFunding", "Choose who paid this expense.");
    }
    if (splitOpen) {
      const problem = validateSplit();
      if (problem) return fail("split", problem);
    }
    return null;
  }

  /** Whether the split itself is complete — what the split view's Done button and the final save both require. */
  function validateSplit(): string | null {
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
          return splitRemaining > 0
            ? `Enter your share (%) — ${splitRemaining}% is still left to assign.`
            : "Enter your share (%) for this expense.";
        }
      }
      if (splitRemaining !== 0) {
        return splitRemaining > 0
          ? `Percentages add up to ${round2(splitEntered)}% — they must total 100% (${splitRemaining}% left).`
          : `Percentages add up to ${round2(splitEntered)}% — they must total 100% (${Math.abs(splitRemaining)}% over).`;
      }
    } else if (splitType === "custom" && mixedSplit?.error) {
      return mixedSplit.error;
    }
    return null;
  }

  /** Done on the split view: only go back to the transaction once the split is complete; otherwise stay and say what's missing. */
  function handleSplitDone() {
    setSplitAttempted(true);
    if (validateSplit()) {
      if (splitType === "percentage" && includeMe && meValue.trim() === "") meShareRef.current?.focus();
      return;
    }
    setView("form");
  }
  const splitProblem = splitAttempted && splitOpen ? validateSplit() : null;
  // Live field highlight: the field the last submit flagged stays marked until it's fixed.
  const liveInvalid = invalidField != null ? validate() : null;
  const fieldError = (field: TxnFormField) => (liveInvalid?.field === field ? liveInvalid.message : null);
  // A field-validation banner clears together with its field's highlight once that field is fixed.
  const showFormError = formError != null && (invalidField == null || liveInvalid?.field === invalidField);

  // Re-entry gate for handleSave: `saving` only flips after the async duplicate check, so without this a
  // rapid double Enter (or Enter + click) could start two saves. Gates re-entry only — no save logic here.
  const saveInFlight = useRef(false);
  async function handleSave() {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    try {
      await handleSaveOnce();
    } finally {
      saveInFlight.current = false;
    }
  }

  async function handleSaveOnce() {
    if (saving || justSaved) return;
    // People settlement gate: the bill payment can't be saved yet — no keyboard path bypasses it. Point at
    // the exact next step instead (never a dead end).
    if (gateBlocked) {
      settleCtaRef.current?.focus();
      return;
    }
    const validationError = validate();
    if (validationError) {
      // No save: jump straight to the first invalid field (scrolled into view, focused) so the user can fix it.
      setFormError(validationError.message);
      setInvalidField(validationError.field);
      focusInvalidField(formRef.current, validationError.field);
      return;
    }
    setFormError(null);
    setInvalidField(null);

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
      // Paying a card bill: the source leg naturally shares amount/date with the card purchases
      // being paid off — those are the other side of the liability, not duplicates of this payment.
      const isCardBillPayment = kind === "transfer" && paysCardBill;
      const proceed =
        kind === "transfer"
          ? await duplicateGuard.guardBatch([
              {
                description,
                amount: amountValue,
                date: dateTime,
                direction: "debit",
                accountId,
                referenceNumber: null,
                requireDescriptionMatch: false,
                ignoreAccountIds: isCardBillPayment ? [destinationAccountId] : undefined,
              },
              { description, amount: amountValue, date: dateTime, direction: "credit", accountId: destinationAccountId, referenceNumber: null, requireDescriptionMatch: false },
            ])
          : await duplicateGuard.guard({
              description,
              amount: amountValue,
              date: dateTime,
              direction: kind === "income" ? "credit" : "debit",
              accountId: personPaysDirectly ? PERSON_FUNDED_ACCOUNT_ID : accountId,
              referenceNumber: null,
              requireDescriptionMatch: false,
            });
      if (!proceed) return;
    }

    setSaving(true);
    const op = startOperation(
      transaction
        ? { label: "Updating transaction", successLabel: "Transaction updated", errorLabel: "Couldn't update transaction" }
        : kind === "transfer"
          ? { label: "Adding transfer", successLabel: "Transfer added", errorLabel: "Couldn't add transfer" }
          : { label: "Adding transaction", successLabel: "Transaction added", errorLabel: "Couldn't add transaction" },
    );
    try {
      op.stage("submit", kind === "transfer" && !transaction ? "Saving both legs & balances" : "Saving transaction & balance");
      if (!transaction) {
        // "Money I Borrowed" on an expense is always a real expense of mine (My Spend). WHO PAID decides the
        // rest — never a borrowed-cash receipt into an account (that is its own People event, recorded from
        // People → Add entry):
        //  - the person paid directly → the expense with NO account + one "borrowed" entry (I owe them),
        //    atomically; an account still selected in the form is ignored, never written or moved;
        //  - I paid from my account → an ordinary expense on that account, the person a plain reference.
        if (personPaysDirectly) {
          const person = people.find((p) => p.id === personId);
          if (!person) throw new Error("Couldn't find this person — refresh and try again");
          op.stage("related", `Recording that ${person.name} paid`);
          await actions.createPersonFundedExpense(person, {
            amount: amountValue,
            date: dateTime,
            categoryId,
            description,
            notes,
            excludeFromCalculations: exclude,
            accountingMonth: reassign ? month : null,
          });
        } else if (kind === "transfer") {
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
            op.stage("related", splitOpen ? "Splitting with people" : "Linking person");
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
                // `applyOwesPersonChange`'s own "reference-only" branch. "Money I Borrowed → I paid from
                // my account" lands here: my account paid, so this expense creates nothing owed.
                await actions.editTransaction(newTransaction, { linkedPersonId: personId, owesPersonToggle: false });
              }
            } catch (assignError) {
              await actions.deleteTransaction(newTransaction).catch(() => {
                // Best-effort — the original error below is what actually surfaces.
              });
              throw assignError;
            }
          }
        }
        op.succeed({ toast: { title: "Transaction added" } });
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

        const wasPersonFunded = transaction.fundedByPersonId != null;
        if (personPaysDirectly && personId != null) {
          // → paid directly by a person (from an account, or from another/the same person): one atomic
          // write takes the expense off its account (old debit reversed once) and keeps exactly one
          // "I owe them" entry. An existing "they owe me" assignment is cleared first (its own path).
          op.stage("related", `Recording that ${personName || "this person"} paid`);
          if (!wasPersonFunded && expense != null) {
            await actions.applyOwesPersonChange({
              transaction,
              existingExpense: expense,
              target: { personId: null, personName: "", owesPersonToggle: false },
            });
          }
          const { accountId: _account, ...fundingEdits } = transactionEdits;
          void _account;
          await actions.changeExpenseFunding(transaction, { kind: "person", personId }, fundingEdits);
        } else if (wasPersonFunded) {
          // Paid directly by a person → paid from my account: that person's entry is removed and the
          // account debited exactly once, atomically. Then the usual person assignment, if any.
          if (splitOpen) throw new Error("Move this payment to your account and save first, then split it.");
          op.stage("related", "Moving payment to your account");
          const { accountId: _account, ...fundingEdits } = transactionEdits;
          void _account;
          await actions.changeExpenseFunding(transaction, { kind: "account", accountId }, fundingEdits);
          const moved: Transaction = { ...transaction, amount: amountValue, dateTime, categoryId, description, notes, accountId, fundedByPersonId: null };
          await actions.applyOwesPersonChange({
            transaction: moved,
            existingExpense: null,
            target: { personId, personName, owesPersonToggle: personId != null && personEntryType === "gave" },
          });
        } else if (splitOpen) {
          const inputs = buildParticipantInputs();
          op.stage("related", "Updating split");

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
        op.succeed({ toast: { title: "Transaction updated" } });
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
          setBorrowFunding(null);
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
      // The form keeps everything entered and shows why inline (the action also toasts) — the progress
      // surface just stops and steps aside rather than repeating the same failure.
      op.dismiss();
      setFormError(e instanceof Error ? e.message : "Could not save this transaction");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (deleting || !transaction) return;
    setDeleting(true);
    const op = startOperation({ label: "Deleting transaction", successLabel: "Transaction deleted", errorLabel: "Couldn't delete transaction" });
    try {
      // actions.deleteTransaction already surfaces a failure toast (withErrorToast) — no need to
      // toast again here, only to stop the dialog/modal from closing on failure.
      op.stage("submit", "Removing transaction & restoring balance");
      await actions.deleteTransaction(transaction, expense);
      op.succeed({ toast: { title: "Transaction deleted" } });
      setConfirmDeleteOpen(false);
      onOpenChange(false);
    } catch {
      // Already toasted by actions.deleteTransaction.
      op.dismiss();
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
          className="flex max-h-[94dvh] w-[calc(100%-1.5rem)] flex-col gap-0 overflow-hidden rounded-[10px] border border-border-strong p-0 shadow-[var(--shadow-dialog)] sm:max-w-[600px]"
        >
          <div className={cn("h-1 w-full shrink-0 transition-colors", view === "split" ? "bg-primary" : KIND_SOLID_CLASS[kind].split(" ")[0])} />

          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-strong px-4 py-2.5 sm:px-5">
            {view === "split" ? (
              <div className="flex min-w-0 items-center gap-3">
                <Button variant="ghost" size="icon-sm" aria-label="Back to transaction" onClick={() => setView("form")}>
                  <ArrowLeft className="size-4" />
                </Button>
                <div className="min-w-0">
                  <DialogTitle className="truncate text-sm font-semibold text-foreground">Split Expense</DialogTitle>
                  <DialogDescription className="truncate text-xs text-foreground/70">Divide this expense among people</DialogDescription>
                </div>
              </div>
            ) : (
              <div className="flex min-w-0 items-center gap-3">
                <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[6px] transition-colors", KIND_SOLID_CLASS[kind])}>
                  {(() => {
                    const HeaderIcon = KIND_META[kind].icon;
                    return <HeaderIcon className="size-4" strokeWidth={2} aria-hidden />;
                  })()}
                </span>
                <div className="min-w-0">
                  <DialogTitle className="truncate font-heading text-[15px] leading-tight font-semibold tracking-tight text-foreground">
                    {transaction ? "Transaction Details" : `Add ${KIND_META[kind].label}`}
                  </DialogTitle>
                  <DialogDescription className="truncate text-xs text-foreground/70">
                    {transaction
                      ? `${DATE_DISPLAY_FORMAT.format(transaction.dateTime)} · ${row?.account?.name ?? "Unknown"}`
                      : `${paysCardBill ? `Card bill payment · ${destinationAccount?.name}` : KIND_META[kind].hint} · ⌘/Ctrl + Enter to save`}
                  </DialogDescription>
                </div>
              </div>
            )}
            <div className="flex shrink-0 items-center gap-1.5">
              {view === "form" && flag && (
                <Badge variant="outline" className="hidden text-[11px] min-[400px]:inline-flex">
                  {flag.label}
                </Badge>
              )}
              <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={() => onOpenChange(false)}>
                <X className="size-4" />
              </Button>
            </div>
          </div>

          {/* Real <form> (display: contents keeps the flex layout): Enter in a single-line field saves through
              the same handleSave as the button. On the split view, Enter / Done checks the split is complete before returning. */}
          <form
            ref={formRef}
            className="contents"
            noValidate
            onKeyDown={(e) => {
              // Bill payment blocked on People: Enter in a field goes to the Settle step — never a submit underneath.
              // (A field's own Enter handling — e.g. Amount stepping to an empty Description — still runs first.)
              if (gateBlocked && e.key === "Enter" && !e.defaultPrevented && !e.shiftKey && !e.nativeEvent.isComposing && e.target instanceof HTMLInputElement) {
                e.preventDefault();
                settleCtaRef.current?.focus();
                return;
              }
              handleEnterAdvance(e);
            }}
            onSubmit={(e) => {
              e.preventDefault();
              if (e.target !== e.currentTarget) return;
              if (view === "split") {
                handleSplitDone();
                return;
              }
              void handleSave();
            }}
          >
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
                              ref={meShareRef}
                              type="number"
                              placeholder="%"
                              value={meValue}
                              aria-invalid={splitProblem != null && meValue.trim() === "" ? true : undefined}
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

                      {/* Done was pressed with the split incomplete (e.g. your own share % left blank): stay here and say so. */}
                      {splitProblem && !(splitType === "custom" && mixedSplit?.error) && (
                        <p role="alert" className="flex items-start gap-2 rounded-[6px] border border-danger/50 bg-danger/10 px-3 py-2 text-xs font-medium text-danger">
                          <Info className="mt-px size-3.5 shrink-0" strokeWidth={2} />
                          {splitProblem}
                        </p>
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
                  className="flex flex-col"
                >
            <div className="flex flex-col gap-2.5 px-4 pt-3 pb-3 sm:px-5">
            {showFormError && (
              <motion.p
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: durations.fast, ease: easings.out }}
                role="alert"
                className="flex items-start gap-2 rounded-[6px] border border-danger/50 bg-danger/10 px-3 py-2 text-xs font-medium text-danger"
              >
                <Info className="mt-px size-3.5 shrink-0" strokeWidth={2} />
                {formError}
              </motion.p>
            )}
            {isTransferLeg && (
              <div className="flex items-start gap-2 rounded-[6px] border border-dashed border-border-strong bg-secondary px-3 py-2">
                <Info className="mt-0.5 size-3.5 shrink-0 text-foreground/70" />
                <p className="text-xs text-foreground/75">
                  This is one leg of a transfer. Amount, account, and date are locked so the two linked transactions can&apos;t drift out of sync — delete the transfer and create a new one to change them.
                </p>
              </div>
            )}

            <TxnModeSwitch
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
              // A transfer flow (card Pay bill) shows Transfer as its own selected mode, never a blank Expense/Income pair.
              kinds={transaction || defaultKind === "transfer" ? FORM_KINDS : ADD_MODE_FORM_KINDS}
            />

            <div
              data-field="amount"
              data-invalid={fieldError("amount") ? "true" : undefined}
              // One amount surface: label, currency and figure share it — the kind reads from the solid left edge.
              className={cn(
                "flex flex-col gap-0.5 rounded-[8px] border border-l-[4px] border-border-strong bg-card px-3.5 pt-2 pb-1.5 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-[var(--focus-ring)] has-[input:focus-visible]:outline-solid",
                KIND_BORDER_CLASS[kind],
                fieldError("amount") && "border-danger ring-2 ring-danger focus-within:ring-danger",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="txn-amount" className="text-[11px] font-bold tracking-[0.08em] text-foreground/80 uppercase">
                  Amount *
                </label>
                {amount.trim() !== "" && !Number.isNaN(Number(amount)) && Number(amount) > 0 && (
                  <span className="truncate text-xs font-medium text-foreground/70 tabular-nums">{formatCurrencyPrecise(Number(amount))}</span>
                )}
              </div>
              <div className="flex min-w-0 items-baseline gap-1">
                {kindSign(kind) && <span className={cn("font-heading text-2xl font-bold", KIND_TEXT_CLASS[kind])}>{kindSign(kind)}</span>}
                <span className="font-heading text-xl font-semibold text-foreground/70">₹</span>
                <input
                  id="txn-amount"
                  ref={amountRef}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  value={amount}
                  disabled={isTransferLeg}
                  onChange={(e) => {
                    const next = e.target.value;
                    if (next === "" || /^\d*\.?\d*$/.test(next)) setAmount(next);
                  }}
                  onKeyDown={(e) => {
                    // Description is required: until it's filled, Enter steps there instead of hitting a
                    // validation error; once filled, Enter falls through to the form's submit (Save).
                    if (e.key === "Enter" && !e.shiftKey && !description.trim()) {
                      e.preventDefault();
                      descriptionRef.current?.focus();
                    }
                  }}
                  className={cn(
                    "h-10 min-w-0 flex-1 border-none bg-transparent shadow-none outline-none! focus-visible:outline-none! font-heading text-[28px] leading-none font-bold tracking-tight tabular-nums placeholder:text-foreground/35 disabled:opacity-60",
                    kind === "transfer" ? "text-foreground" : KIND_TEXT_CLASS[kind],
                  )}
                />
              </div>
              {fieldError("amount") && (
                <p role="alert" className="text-[11px] font-medium text-danger">
                  {fieldError("amount")}
                </p>
              )}
            </div>
            </div>

            <FormSection icon={Shapes} title="Details">
              {/* Description → Category → Date (validation order). A transfer has no category, so Date sits beside Description. */}
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <div className={cn("min-w-0", kind !== "transfer" && "sm:col-span-2")}>
              <FormRow label={kind === "transfer" ? "Description" : "Description *"} field="description" error={fieldError("description")}>
                <Input
                  ref={descriptionRef}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={kind === "income" ? "e.g. Salary, Freelance payment" : kind === "transfer" ? (paysCardBill ? "e.g. Card bill payment" : "e.g. Savings sweep") : "e.g. Blue Tokai Coffee"}
                  className={cn(WS_FIELD, "bg-card")}
                />
              </FormRow>
              </div>
                {kind !== "transfer" && (
                  <FormRow label="Category *" field="category" error={fieldError("category")}>
                    <CategorySelect
                      categories={filteredCategories}
                      value={categoryId}
                      onChange={setCategoryId}
                      type={kind === "income" ? "income" : "expense"}
                    />
                  </FormRow>
                )}
                <FormRow label="Date *" field="date" error={fieldError("date")}>
                  <DateInput
                    ref={dateRef}
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    disabled={isTransferLeg}
                    className={cn(INPUT_BASE_CLASS, WS_FIELD, "disabled:opacity-60 dark:[color-scheme:dark]")}
                  />
                </FormRow>
              </div>
            </FormSection>

            <FormSection
              icon={kind === "income" ? ArrowDownToLine : personPaysDirectly ? Users : Wallet}
              title={kind === "income" ? "Received in" : kind === "transfer" ? "Accounts" : personPaysDirectly ? "Paid by" : "Paid from"}
            >
            {(() => {
              // The person paid directly: no account is part of this expense — the picker is replaced (not
              // just disabled) and whatever account was selected before is never saved or moved.
              if (personPaysDirectly) {
                return (
                  <div data-testid="paid-by-person" className="grid grid-cols-2 gap-2">
                    <div className={cn("rounded-[6px] border border-success bg-card px-3 py-2", FIELD_BORDER)}>
                      <p className="text-[11px] font-medium uppercase tracking-wide text-foreground/70">Paid by</p>
                      <p className="truncate text-sm font-semibold text-foreground">{personName || "This person"}</p>
                    </div>
                    <div className={cn("rounded-[6px] border bg-secondary px-3 py-2", FIELD_BORDER)}>
                      <p className="text-[11px] font-medium uppercase tracking-wide text-foreground/70">Your account</p>
                      <p className="text-sm font-semibold text-foreground">Not used</p>
                    </div>
                  </div>
                );
              }
              const fromRow = (
              <FormRow label={kind === "transfer" ? "From Account *" : "Account *"} field="account" error={fieldError("account")}>
                {isTransferLeg ? (
                  <div className={cn("flex h-9 w-full items-center gap-1.5 rounded-[6px] border bg-secondary px-3 text-sm font-medium text-foreground/80", FIELD_BORDER)}>
                    <Lock className="size-3.5 text-muted-foreground" strokeWidth={1.75} />
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
              );
              // A new transfer reads as one direction: From → To (stacked ↓ on phones).
              if (kind !== "transfer" || isTransferLeg) return fromRow;
              return (
                <TxnAccountFlow
                  from={fromRow}
                  to={
                    <FormRow label="To Account *" field="destination" error={fieldError("destination")}>
                      <AccountSelect
                        accounts={accounts.filter((a) => a.id !== accountId)}
                        value={destinationAccountId}
                        onChange={(id) => {
                          setDestinationAccountId(id);
                          onDestinationAccountChange?.(id);
                        }}
                        placeholder="Select destination account"
                      />
                    </FormRow>
                  }
                />
              );
            })()}
            </FormSection>

            {gateActive && (gateLoading || (peopleGate.readiness?.people.length ?? 0) > 0) && (
              <div className="border-t border-border px-4 py-3 sm:px-5">
                <PeopleSettlementCard
                  readiness={peopleGate.readiness}
                  gate={settlement}
                  loading={gateLoading}
                  dueLabel="Bill"
                  subject="this card bill"
                  payeeName={peopleGate.payeeName}
                  returnTo={peopleGate.returnTo}
                />
              </div>
            )}

            {kind === "expense" && (
              <FormSection
                icon={Users}
                title="People & Split"
                aside={<span className="text-[11px] font-medium text-foreground/70">Optional</span>}
              >
                {!splitOpen && (
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
                            if (v === "none") {
                              setPersonEntryType(null);
                            } else {
                              setSplitOpen(false);
                            }
                          }}
                        >
                          <SelectTrigger className={WS_SELECT_TRIGGER}>
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
                          className={cn(WS_FIELD, "min-w-0")}
                          onChange={(e) => setNewPersonName(e.target.value)}
                          onKeyDown={(e) => {
                            // Enter adds the person — it must not also submit the transaction form.
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void handleAddPerson();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              e.stopPropagation();
                              setAddingPerson(false);
                            }
                          }}
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
                )}

                {!personId && !splitOpen && (
                  <p className="text-xs text-foreground/70">Pick a person above to record Money I Gave or Money I Borrowed.</p>
                )}

                {!splitOpen && !personId && (
                  <button
                    type="button"
                    onClick={() => {
                      setSplitOpen(true);
                      setView("split");
                    }}
                    className={cn(WS_SECONDARY, "h-8 w-fit px-3 text-xs")}
                  >
                    <SplitSquareHorizontal className="size-3.5" strokeWidth={1.75} />
                    Split with more people
                  </button>
                )}

                <AnimatePresence initial={false}>
                  {personId && !splitOpen && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: durations.fast, ease: easings.out }}
                      className="overflow-hidden"
                    >
                      {transaction ? (
                        // Edit mode offers "I Gave" (every transition via `applyOwesPersonChange`) and
                        // "I Borrowed" — the latter only as "<person> paid directly", whose transitions
                        // (account ↔ person, amount/date) `changeExpenseFunding` owns atomically. Never a
                        // standalone borrowed-cash ledger entry. Both are optional toggles here.
                        <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
                        <button
                          type="button"
                          onClick={() => setPersonEntryType((t) => (t === "gave" ? null : "gave"))}
                          aria-pressed={personEntryType === "gave"}
                          className={cn(
                            "flex w-full items-center gap-2.5 rounded-[6px] border p-2.5 text-left transition-colors",
                            personEntryType === "gave" ? "border-expense bg-expense/10 ring-1 ring-expense" : "border-border-strong bg-card hover:border-muted-foreground hover:bg-secondary",
                          )}
                        >
                          <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-[4px]", personEntryType === "gave" ? "bg-expense text-expense-foreground" : "bg-secondary text-muted-foreground")}>
                            <ArrowUpFromLine className="size-3.5" strokeWidth={2} />
                          </span>
                          <span className="min-w-0">
                            <p className="truncate text-sm font-semibold text-foreground">Money I Gave</p>
                            <p className="truncate text-xs text-muted-foreground">They owe me — adds this amount to what they owe you.</p>
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setPersonEntryType((t) => (t === "borrowed" ? null : "borrowed"));
                            // Editing only supports "paid directly" for a borrowing — said explicitly below.
                            setBorrowFunding("person");
                          }}
                          aria-pressed={personEntryType === "borrowed"}
                          className={cn(
                            "flex w-full items-center gap-2.5 rounded-[6px] border p-2.5 text-left transition-colors",
                            personEntryType === "borrowed" ? "border-success bg-success/10 ring-1 ring-success" : "border-border-strong bg-card hover:border-muted-foreground hover:bg-secondary",
                          )}
                        >
                          <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-[4px]", personEntryType === "borrowed" ? "bg-success text-success-foreground" : "bg-secondary text-muted-foreground")}>
                            <ArrowDownToLine className="size-3.5" strokeWidth={2} />
                          </span>
                          <span className="min-w-0">
                            <p className="truncate text-sm font-semibold text-foreground">Money I Borrowed</p>
                            <p className="truncate text-xs text-muted-foreground">They paid this for me — I owe them.</p>
                          </span>
                        </button>
                        </div>
                      ) : (
                        // Add mode — same "I Gave"/"I Borrowed" picker as the People page's "Add
                        // Ledger Entry" dialog (`LEDGER_ENTRY_TYPE_OPTIONS`). "I Gave" goes through
                        // the same `applyOwesPersonChange` expense-assignment path as edit mode;
                        // "I Borrowed" records a plain descriptive link on the transaction plus one
                        // `addLedgerEntry` call, mirroring what the People page itself does.
                        //
                        // One required, mutually exclusive choice (radio group, roving tabindex): nothing is
                        // preselected, picking one clears the other, arrow keys move + select, Space/Enter select.
                        <div
                          data-field="personDirection"
                          data-invalid={fieldError("personDirection") ? "true" : undefined}
                          role="radiogroup"
                          aria-label="Money given or Money borrowed"
                          aria-required="true"
                          aria-invalid={fieldError("personDirection") ? true : undefined}
                          aria-describedby={fieldError("personDirection") ? "txn-person-direction-error" : undefined}
                          className={cn(
                            "grid grid-cols-1 gap-2 rounded-[6px] min-[420px]:grid-cols-2",
                            fieldError("personDirection") && "bg-danger/5 p-1.5 ring-2 ring-danger",
                          )}
                        >
                          {PERSON_ENTRY_OPTIONS.map((o, index) => {
                            const Icon = o.icon;
                            const active = personEntryType === o.value;
                            const tabbable = active || (personEntryType == null && index === 0);
                            return (
                              <button
                                key={o.value}
                                type="button"
                                role="radio"
                                aria-checked={active}
                                tabIndex={tabbable ? 0 : -1}
                                onClick={() => setPersonEntryType(o.value)}
                                onKeyDown={(e) => {
                                  const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
                                  if (!step) return;
                                  e.preventDefault();
                                  const nextIndex = (index + step + PERSON_ENTRY_OPTIONS.length) % PERSON_ENTRY_OPTIONS.length;
                                  setPersonEntryType(PERSON_ENTRY_OPTIONS[nextIndex].value);
                                  e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]')[nextIndex]?.focus();
                                }}
                                className={cn(
                                  "flex items-center gap-2 rounded-[6px] border p-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                                  active
                                    ? o.tone === "success"
                                      ? "border-success bg-success/10 ring-1 ring-success"
                                      : "border-expense bg-expense/10 ring-1 ring-expense"
                                    : "border-border-strong bg-card hover:border-muted-foreground hover:bg-secondary",
                                )}
                              >
                                <span
                                  className={cn(
                                    "flex size-7 shrink-0 items-center justify-center rounded-[4px]",
                                    active ? (o.tone === "success" ? "bg-success text-success-foreground" : "bg-expense text-expense-foreground") : "bg-secondary text-muted-foreground",
                                  )}
                                >
                                  <Icon className="size-3.5" strokeWidth={2} />
                                </span>
                                <span className="min-w-0">
                                  <p className="truncate text-xs font-semibold text-foreground">{o.label}</p>
                                  <p className="truncate text-[11px] text-muted-foreground">{o.description}</p>
                                </span>
                              </button>
                            );
                          })}
                          {fieldError("personDirection") && (
                            <p id="txn-person-direction-error" role="alert" className="col-span-full px-1 text-[11px] font-medium text-danger">
                              {fieldError("personDirection")}
                            </p>
                          )}
                        </div>
                      )}
                      {personEntryType === "borrowed" && (
                        // Who actually paid — required, nothing preselected in Add mode. Same radio-group
                        // keyboard contract as the direction picker above.
                        <div className="mt-2.5">
                          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-foreground/80">How was this paid?</p>
                          <div
                            data-field="personFunding"
                            data-invalid={fieldError("personFunding") ? "true" : undefined}
                            role="radiogroup"
                            aria-label="How was this paid?"
                            aria-required="true"
                            aria-invalid={fieldError("personFunding") ? true : undefined}
                            aria-describedby={fieldError("personFunding") ? "txn-person-funding-error" : undefined}
                            className={cn(
                              "grid grid-cols-1 gap-2 rounded-[6px] min-[420px]:grid-cols-2",
                              fieldError("personFunding") && "bg-danger/5 p-1.5 ring-2 ring-danger",
                            )}
                          >
                            {BORROW_FUNDING_OPTIONS.map((o, index) => {
                              const active = borrowFunding === o.value;
                              const tabbable = active || (borrowFunding == null && index === 0);
                              const Icon = o.value === "person" ? Users : Wallet;
                              return (
                                <button
                                  key={o.value}
                                  type="button"
                                  role="radio"
                                  aria-checked={active}
                                  tabIndex={tabbable ? 0 : -1}
                                  onClick={() => setBorrowFunding(o.value)}
                                  onKeyDown={(e) => {
                                    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
                                    if (!step) return;
                                    e.preventDefault();
                                    const nextIndex = (index + step + BORROW_FUNDING_OPTIONS.length) % BORROW_FUNDING_OPTIONS.length;
                                    setBorrowFunding(BORROW_FUNDING_OPTIONS[nextIndex].value);
                                    e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]')[nextIndex]?.focus();
                                  }}
                                  className={cn(
                                    "flex items-center gap-2 rounded-[6px] border-2 p-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                                    active ? "border-foreground bg-card" : "border-border-strong bg-card hover:border-muted-foreground hover:bg-secondary",
                                  )}
                                >
                                  <span
                                    className={cn(
                                      "flex size-7 shrink-0 items-center justify-center rounded-[4px]",
                                      active ? "bg-foreground text-background" : "bg-secondary text-muted-foreground",
                                    )}
                                  >
                                    {active ? <Check className="size-3.5" strokeWidth={2.5} /> : <Icon className="size-3.5" strokeWidth={2} />}
                                  </span>
                                  <span className="min-w-0">
                                    <p className="truncate text-xs font-semibold text-foreground">{o.label(personName || "They")}</p>
                                    <p className="truncate text-[11px] text-muted-foreground">{o.description}</p>
                                  </span>
                                </button>
                              );
                            })}
                            {fieldError("personFunding") && (
                              <p id="txn-person-funding-error" role="alert" className="col-span-full px-1 text-[11px] font-medium text-danger">
                                {fieldError("personFunding")}
                              </p>
                            )}
                          </div>
                          {borrowFunding === "person" && (
                            <p data-testid="person-funded-helper" className="mt-2 flex items-start gap-1.5 rounded-[6px] border border-border-strong bg-secondary px-2.5 py-2 text-[11px] text-foreground/85">
                              <Info className="mt-px size-3.5 shrink-0" strokeWidth={1.75} />
                              <span>
                                <span className="font-semibold text-foreground">{personName || "They"}</span> paid
                                {Number(amount) > 0 ? ` ${formatCurrencyPrecise(Number(amount))}` : " this"} for you. It counts as your spending and you owe{" "}
                                <span className="font-semibold text-foreground">{personName || "them"}</span>
                                {Number(amount) > 0 ? ` ${formatCurrencyPrecise(Number(amount))}` : " this amount"}. No money moves through your accounts.
                              </span>
                            </p>
                          )}
                          {borrowFunding === "account" && (
                            <p className="mt-2 flex items-start gap-1.5 rounded-[6px] border border-border-strong bg-secondary px-2.5 py-2 text-[11px] text-foreground/85">
                              <Info className="mt-px size-3.5 shrink-0" strokeWidth={1.75} />
                              <span>
                                A normal expense from your account. Money {personName || "they"} lent you earlier is recorded separately in People.
                              </span>
                            </p>
                          )}
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
                      className="overflow-hidden"
                    >
                      <div className="flex items-center justify-between gap-2 rounded-[6px] border border-primary-accent-text/60 bg-primary/10 px-3 py-2">
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
                        <Button type="button" variant="outline" size="sm" className="rounded-[6px] border-border-strong bg-card" onClick={() => setView("split")}>
                          Edit
                        </Button>
                        <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove split" onClick={() => setSplitOpen(false)}>
                          <X className="size-4" />
                        </Button>
                      </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </FormSection>
            )}

            <FormSection icon={NotebookPen} title="Notes & options">
              <Textarea
                value={notes}
                placeholder="Add a note (optional)"
                aria-label="Notes"
                className={cn(WS_FIELD, "h-auto min-h-10 resize-y py-2")}
                onChange={(e) => setNotes(e.target.value)}
              />

            <div className="flex flex-col gap-1">
              <button
                type="button"
                onClick={() => setMoreOpen((v) => !v)}
                aria-expanded={moreOpen}
                className="-mx-1 flex h-7 items-center gap-1.5 self-start rounded-[6px] px-1 text-xs font-medium text-foreground/75 transition-colors hover:bg-secondary hover:text-foreground"
              >
                <ChevronDown className={cn("size-3.5 transition-transform", moreOpen && "rotate-180")} strokeWidth={2} />
                More options
                <span className="text-foreground/60">(visibility, month)</span>
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
                        <label className="flex items-start gap-2 border-t border-border pt-2.5 text-sm">
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
                                <div className="flex items-start gap-2 rounded-[6px] border border-warning/50 bg-warning/12 px-3 py-2.5 text-xs text-warning-foreground">
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
            </FormSection>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <DialogFooter className="shrink-0 flex-row flex-wrap items-center justify-between gap-2 border-t border-border-strong bg-secondary/60 px-4 py-3 sm:justify-between sm:px-5">
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
                <div className="ml-auto flex items-center gap-2">
                  <ClayButton type="button" variant="secondary" size="sm" onClick={() => setView("form")}>
                    Back
                  </ClayButton>
                  <ClayButton type="submit" size="sm">
                    <Check className="size-3.5" /> Done
                  </ClayButton>
                </div>
              </>
            ) : (
              <>
                {transaction ? (
                  <Button variant="ghost" size="sm" className="shrink-0 text-danger hover:bg-danger/10 hover:text-danger" onClick={() => setConfirmDeleteOpen(true)}>
                    <Trash2 className="size-3.5" /> {isTransferLeg ? "Delete Transfer" : "Delete"}
                  </Button>
                ) : (
                  <FooterSummary
                    kind={kind}
                    amount={amount}
                    category={kind === "transfer" ? undefined : filteredCategories.find((c) => c.id === categoryId)}
                    account={accounts.find((a) => a.id === accountId)}
                  />
                )}
                <div className="flex min-w-[13.5rem] flex-1 items-center justify-end gap-2">
                  <button type="button" className={WS_GHOST} onClick={() => onOpenChange(false)} disabled={saving}>
                    Cancel
                  </button>
                  {gateBlocked ? (
                    // People settlement first: the bill payment stays unavailable, and the primary action is the
                    // exact next step — never a bare "can't continue".
                    settlement.next ? (
                      <Link
                        ref={settleCtaRef}
                        href={peopleSettleHref(settlement.next.personId, settlement.next.obligationKey, peopleGate?.returnTo)}
                        data-gate="settle"
                        className={cn(WS_PRIMARY, "min-w-0 flex-1 sm:min-w-44 sm:flex-none")}
                      >
                        <span className="truncate">{settleCtaLabel(settlement)}</span>
                        <ArrowRight className="size-3.5 shrink-0" aria-hidden />
                      </Link>
                    ) : (
                      <button type="button" disabled className={cn(WS_PRIMARY, "min-w-0 flex-1 sm:min-w-36 sm:flex-none")}>
                        <Loader2 className="size-3.5 animate-spin" aria-hidden />
                        <span className="truncate">Checking People…</span>
                      </button>
                    )
                  ) : (
                  <button
                    type="submit"
                    className={cn(WS_PRIMARY, "min-w-0 flex-1 sm:flex-none sm:min-w-36", (saving || justSaved) && "disabled:opacity-80")}
                    disabled={saving || justSaved}
                  >
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
                    <span className="truncate">
                      {justSaved
                        ? "Saved"
                        : saving
                          ? "Saving…"
                          : transaction
                            ? "Save changes"
                            : paysCardBill && Number(amount) > 0
                              ? `Pay ${formatCurrencyPrecise(Number(amount))}`
                              : `Add ${KIND_META[kind].label}`}
                    </span>
                  </button>
                  )}
                </div>
              </>
            )}
          </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <DialogContent onKeyDown={(e) => handleEnterKey(e, handleDelete, { enabled: !deleting, fromButtons: true })}>
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
