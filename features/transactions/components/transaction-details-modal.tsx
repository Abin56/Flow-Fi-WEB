"use client";

/**
 * The "Transaction Details" popup for the plain `/transactions` page — built
 * on the same `TransactionDetailsShell` Transaction Studio's
 * `TransactionManageModal` and SMS Candidates' `CandidateDetailsModal` use,
 * so all three surfaces share one visual implementation. Replaces the former
 * two-step flow (`TransactionManagerSheet` side-drawer + its own "Edit"
 * button opening a second `FormDialog` for description/date/category/
 * account) with a single popup and a single Save action — same shape for
 * both **Add** (`row` null) and **Edit** (`row` set).
 *
 * The dedicated "Split Expense" flow (creating a brand-new multi-person
 * split from scratch) is a separate, untouched dialog elsewhere in
 * `transactions-workspace.tsx` — this modal only ports the *in-place* split
 * editor (converting/editing the split on the transaction already being
 * edited), which `TransactionManagerSheet` already owned.
 *
 * All person-assignment state changes still route through
 * `applyOwesPersonChange` (`owes-person-transition.ts`) — never edit
 * `linkedPersonId`/`owesPersonToggle` directly, or a ledger entry can end up
 * orphaned/duplicated. Saving a split still goes through
 * `ExpenseRepository.editExpense`/`convertToSplit` exactly as before.
 */

import { useState } from "react";
import {
  ArrowLeftRight,
  Banknote,
  Briefcase,
  CalendarClock,
  Check,
  CreditCard as CreditCardIcon,
  EyeOff,
  Info,
  Landmark,
  ListChecks,
  Layers,
  Loader2,
  Plus,
  Save,
  SlidersHorizontal,
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Field, SectionCard, StatChip, TransactionDetailsShell } from "@/components/finance/transaction-details-shell";
import { BankLogo } from "@/components/finance/bank-logo";
import { cn } from "@/lib/utils";
import { formatCurrencyPrecise } from "@/lib/format";
import { toast } from "@/store/toast-store";
import { isSplit, type Expense, type SplitType } from "@/lib/models/expense";
import type { Account, AccountType } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";
import type { ExpenseParticipantInput } from "@/lib/repositories/expense-repository";
import type { EditTransactionParams } from "@/lib/repositories/transaction-repository";
import { formatMonthYear, isSameMonth, transactionFlagFor } from "@/features/transactions/lib/transaction-flag";
import { useDuplicateGuardedCreate } from "@/lib/services/duplicate-detection/use-duplicate-guarded-create";
import { MonthYearStepper } from "./month-year-stepper";
import {
  categoryIconFor,
  categoryToneFor,
  type TransactionRow,
  type useTransactionActions,
} from "@/features/transactions/hooks/use-transactions-data";

const DATE_DISPLAY_FORMAT = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });
const FIELD_BORDER = "border-foreground/15";

const SPLIT_TYPE_OPTIONS: { value: SplitType; label: string }[] = [
  { value: "equal", label: "Split equally" },
  { value: "custom", label: "Custom amounts" },
  { value: "percentage", label: "By percentage" },
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

/** Payment-method-style chip — mirrors the mobile app's `_PaymentMethodChip`: an icon-led,
 *  selectable pill instead of a plain text dropdown, so the account (and its type) is scannable
 *  at a glance rather than requiring a click to even see the options. */
function AccountChipRow({
  accounts,
  value,
  onChange,
}: {
  accounts: Account[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {accounts.map((a) => {
        const Icon = ACCOUNT_TYPE_ICON[a.type];
        const selected = a.id === value;
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => onChange(a.id)}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
              selected ? "border-primary bg-primary/10 text-primary" : cn(FIELD_BORDER, "text-muted-foreground hover:bg-muted"),
            )}
          >
            {a.type === "bank" ? <BankLogo bankId={a.bankId} size={14} shape="square" /> : <Icon className="size-3.5" />}
            {a.name}
          </button>
        );
      })}
    </div>
  );
}

const CATEGORY_TONE_CLASS: Record<string, string> = {
  primary: "bg-primary/12 text-primary",
  success: "bg-success/15 text-success",
  warning: "bg-warning/20 text-warning-foreground",
  purple: "bg-purple/15 text-purple",
  expense: "bg-expense/12 text-expense",
  neutral: "bg-muted text-muted-foreground",
};

/** Category chip — mirrors the mobile category picker's icon+color per row, condensed into a
 *  selectable pill instead of a plain text dropdown. */
function CategoryChipRow({
  categories,
  value,
  onChange,
}: {
  categories: Category[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {categories.map((c) => {
        const Icon = categoryIconFor(c.iconKey);
        const tone = categoryToneFor(c.iconKey);
        const selected = c.id === value;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onChange(c.id)}
            className={cn(
              "flex items-center gap-1.5 rounded-full border py-1 pr-3 pl-1 text-xs font-semibold transition-colors",
              selected ? "border-primary bg-primary/10 text-primary" : cn(FIELD_BORDER, "text-muted-foreground hover:bg-muted"),
            )}
          >
            <span className={cn("flex size-5 items-center justify-center rounded-full", CATEGORY_TONE_CLASS[tone])}>
              <Icon className="size-3" />
            </span>
            {c.name}
          </button>
        );
      })}
    </div>
  );
}

type FormKind = "expense" | "income" | "transfer";

/** Per-type visual identity for the Classification section's chip selector — same semantic tone tokens
 *  (expense/success/primary) used everywhere else this file color-codes a kind (e.g. the Amount stat chip). */
const KIND_META: Record<FormKind, { label: string; icon: LucideIcon; activeClass: string }> = {
  expense: { label: "Expense", icon: TrendingDown, activeClass: "border-expense bg-expense/10 text-expense" },
  income: { label: "Income", icon: TrendingUp, activeClass: "border-success bg-success/10 text-success" },
  transfer: { label: "Transfer", icon: ArrowLeftRight, activeClass: "border-primary bg-primary/10 text-primary" },
};
const FORM_KINDS: FormKind[] = ["expense", "income", "transfer"];

interface ParticipantForm {
  personId: string | null;
  name: string;
  value: string;
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
  const [owesToggle, setOwesToggle] = useState(false);
  const [addingPerson, setAddingPerson] = useState(false);
  const [newPersonName, setNewPersonName] = useState("");
  const [addingPersonBusy, setAddingPersonBusy] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitType, setSplitType] = useState<SplitType>("equal");
  const [participants, setParticipants] = useState<ParticipantForm[]>([{ personId: null, name: "", value: "" }]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const duplicateGuard = useDuplicateGuardedCreate(
    existingTransactions.map((t) => ({ id: t.id, description: t.description, amount: t.amount, dateTime: t.dateTime, accountId: t.accountId, type: t.type })),
  );

  // Same "reset once per open/row change" render-time-adjustment pattern `TransactionManageModal`/
  // `CandidateDetailsModal` use — `seenKey` is `transaction.id` for edit, a stable literal for Add
  // (so reopening Add after closing always starts fresh too).
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
      setOwesToggle(transaction.owesPersonToggle);
      setAddingPerson(autoFocusAssign && transaction.linkedPersonId == null);
    } else {
      const firstCategory = categories.find((c) => (defaultKind === "income" ? c.type !== "expense" : c.type !== "income"));
      setKind(defaultKind);
      setDescription("");
      setAmount("");
      setDate(toDateInputValue(new Date()));
      setNotes("");
      setAccountId(accounts[0]?.id ?? "");
      setDestinationAccountId("");
      setCategoryId(firstCategory?.id ?? "");
      setExclude(false);
      setReassign(false);
      setMonth(new Date());
      setPersonId(null);
      setOwesToggle(false);
      setAddingPerson(false);
    }
    setNewPersonName("");
    setFormError(null);
    setSplitOpen(false);
    setSplitType(expense?.splitType && expense.splitType !== "none" ? expense.splitType : "equal");
    setParticipants(
      expense && isSplit(expense)
        ? expense.participants.filter((p) => !p.isMe).map((p) => ({ personId: p.personId, name: p.name, value: String(p.share) }))
        : [{ personId: null, name: "", value: "" }],
    );
    setConfirmDeleteOpen(false);
  } else if (!open && seenKey !== null) {
    setSeenKey(null);
  }

  const isTransferLeg = !!transaction?.transferId;
  const personName = personId ? (people.find((p) => p.id === personId)?.name ?? "") : "";
  const flag = transaction ? transactionFlagFor(transaction) : null;
  const monthChanged = transaction ? !isSameMonth(month, transaction.dateTime) : false;
  const filteredCategories = categories.filter((c) => (kind === "income" ? c.type !== "expense" : c.type !== "income"));

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
    setParticipants((list) => [...list, { personId: null, name: "", value: "" }]);
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
      if (splitType !== "equal") {
        for (const p of named) {
          const v = Number(p.value);
          if (p.value.trim() === "" || Number.isNaN(v) || v < 0) {
            return `Enter a valid ${splitType === "percentage" ? "percentage" : "amount"} for ${p.name || "this person"}.`;
          }
        }
      }
    }
    return null;
  }

  async function handleSave() {
    if (saving) return;
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
          await actions.createTransaction({
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
          const named = participants.filter((p) => p.name.trim() !== "" || p.personId != null);
          const inputs: ExpenseParticipantInput[] = named.map((p) => ({
            personId: p.personId,
            name: p.personId ? (people.find((person) => person.id === p.personId)?.name ?? p.name) : p.name,
            value: splitType === "equal" ? null : Number(p.value),
          }));

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
            target: { personId, personName, owesPersonToggle: personId != null && owesToggle },
            transactionEdits,
          });
        }
        toast.success("Transaction updated");
      }
      onOpenChange(false);
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

  const identityName = description.trim() || (transaction ? "(No description)" : "New transaction");

  return (
    <>
      <TransactionDetailsShell
        open={open}
        onOpenChange={onOpenChange}
        busy={saving || deleting}
        headerIcon={ListChecks}
        headerTitle="Transaction Details"
        headerDescription={transaction ? "Review and manage this transaction" : "Add a new transaction"}
        identityAvatarName={identityName}
        identityCredit={kind === "income"}
        identityTitle={identityName}
        identitySubtitle={transaction ? `${DATE_DISPLAY_FORMAT.format(transaction.dateTime)} · ${row?.account?.name ?? "Unknown"}` : "Not saved yet"}
        statChips={
          <>
            <StatChip label="Amount">
              <span className={cn("text-base font-semibold tabular-nums", kind === "income" ? "text-success" : "text-expense")}>
                {kind === "income" ? "+" : "−"}
                {amount ? formatCurrencyPrecise(Number(amount) || 0) : "—"}
              </span>
            </StatChip>
            {flag && (
              <StatChip label="Flag">
                <Badge variant="outline" className="w-fit text-[11px]">
                  {flag.label}
                </Badge>
              </StatChip>
            )}
          </>
        }
        leftColumn={
          <SectionCard icon={ListChecks} title="Transaction Details">
            {formError && <p className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{formError}</p>}
            {isTransferLeg && (
              <div className="flex items-start gap-2 rounded-lg border border-dashed border-foreground/15 bg-muted/30 px-3 py-2.5">
                <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <p className="text-xs text-muted-foreground">
                  This is one leg of a transfer. Amount, account, and date are locked so the two linked transactions can&apos;t drift out of sync — delete the transfer and create a new one to change them.
                </p>
              </div>
            )}
            <Field label="Description *">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Blue Tokai Coffee" className={FIELD_BORDER} />
            </Field>
            <Field label="Amount *">
              <Input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={isTransferLeg} className={cn("tabular-nums", FIELD_BORDER)} />
            </Field>
            <Field label="Date *">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={isTransferLeg} className={FIELD_BORDER} />
            </Field>
            <Field label={kind === "transfer" ? "From Account *" : "Account *"}>
              {isTransferLeg ? (
                <div className={cn("flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold text-muted-foreground", FIELD_BORDER)}>
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
                <AccountChipRow accounts={accounts} value={accountId} onChange={setAccountId} />
              )}
            </Field>
            {kind === "transfer" ? (
              !isTransferLeg && (
                <Field label="To Account *">
                  <AccountChipRow
                    accounts={accounts.filter((a) => a.id !== accountId)}
                    value={destinationAccountId}
                    onChange={setDestinationAccountId}
                  />
                </Field>
              )
            ) : (
              <Field label="Category *">
                <CategoryChipRow categories={filteredCategories} value={categoryId} onChange={setCategoryId} />
              </Field>
            )}
            <Field label="Notes">
              <Textarea value={notes} placeholder="Add a note (optional)" className={cn("min-h-12 text-sm", FIELD_BORDER)} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </SectionCard>
        }
        middleColumn={
          <>
            <SectionCard icon={Layers} title="Classification">
              {transaction ? (
                <Badge variant="outline" className="w-fit text-[11px] capitalize">
                  {kind}
                </Badge>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  {FORM_KINDS.map((k) => {
                    const meta = KIND_META[k];
                    const Icon = meta.icon;
                    const active = kind === k;
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setKind(k)}
                        className={cn(
                          "flex flex-col items-center gap-1.5 border px-3 py-2.5 text-xs font-semibold transition-colors",
                          active ? meta.activeClass : cn(FIELD_BORDER, "text-muted-foreground hover:bg-muted"),
                        )}
                      >
                        <Icon className="size-4" />
                        {meta.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </SectionCard>

            <SectionCard icon={Users} title="People & Split">
              {kind !== "expense" ? (
                <div className="flex items-start gap-2 rounded-lg border border-dashed border-foreground/15 bg-muted/30 px-3 py-2.5">
                  <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <p className="text-xs text-muted-foreground">Assigning to a person or splitting is only available for expenses.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <Field label="Assign to a person">
                    {!addingPerson ? (
                      <Select
                        value={personId ?? "none"}
                        onValueChange={(v) => {
                          if (v === "add-new") {
                            setAddingPerson(true);
                            return;
                          }
                          setPersonId(v === "none" ? null : v);
                          if (v === "none") setOwesToggle(false);
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
                    ) : (
                      <div className="flex items-center gap-2">
                        <Input
                          autoFocus
                          placeholder="Person's name"
                          value={newPersonName}
                          className={FIELD_BORDER}
                          onChange={(e) => setNewPersonName(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && void handleAddPerson()}
                        />
                        <Button size="icon-sm" onClick={() => void handleAddPerson()} disabled={addingPersonBusy || !newPersonName.trim()} aria-label="Save person">
                          <Check className="size-4" />
                        </Button>
                        <Button size="icon-sm" variant="ghost" onClick={() => setAddingPerson(false)} aria-label="Cancel">
                          <X className="size-4" />
                        </Button>
                      </div>
                    )}
                  </Field>

                  {!splitOpen && (
                    <button
                      type="button"
                      onClick={() => setSplitOpen(true)}
                      className="inline-flex items-center gap-1.5 self-start text-xs font-medium text-primary hover:underline"
                    >
                      <SplitSquareHorizontal className="size-3.5" />
                      Split with more people instead
                    </button>
                  )}

                  {personId && !splitOpen && (
                    <label className="flex items-start gap-2 border-t border-foreground/10 pt-3 text-sm">
                      <Switch checked={owesToggle} onCheckedChange={setOwesToggle} className="mt-0.5" />
                      <span>
                        <span className="block text-foreground">This person owes me this expense</span>
                        <span className="block text-xs text-muted-foreground">Adds this amount to what they owe you.</span>
                      </span>
                    </label>
                  )}

                  {splitOpen && (
                    <div className="flex flex-col gap-3 border-t border-foreground/10 pt-3">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium text-foreground">Split this expense</p>
                        <button type="button" onClick={() => setSplitOpen(false)} className="text-xs text-muted-foreground hover:underline">
                          Hide split editor
                        </button>
                      </div>
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
                              <Input placeholder="Name" value={p.name} className={cn("h-9", FIELD_BORDER)} onChange={(e) => updateParticipant(i, { name: e.target.value })} />
                            )}
                            {splitType !== "equal" && (
                              <Input
                                type="number"
                                placeholder={splitType === "percentage" ? "%" : "Amount"}
                                value={p.value}
                                className={cn("h-9 w-24 shrink-0", FIELD_BORDER)}
                                onChange={(e) => updateParticipant(i, { value: e.target.value })}
                              />
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
                      </div>
                    </div>
                  )}
                </div>
              )}
            </SectionCard>
          </>
        }
        rightColumn={
          <>
            <SectionCard icon={SlidersHorizontal} title="Advanced Options">
              {kind === "transfer" ? (
                <p className="text-xs text-muted-foreground">Not applicable for transfers.</p>
              ) : (
                <>
                  <label className="flex items-start gap-2 border-b border-foreground/10 pb-3 text-sm">
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
                  {reassign && (
                    <div className="flex flex-col gap-2">
                      <MonthYearStepper value={month} onChange={setMonth} />
                      {monthChanged && (
                        <div className="flex items-start gap-2 rounded-lg bg-warning/12 px-3 py-2.5 text-xs text-warning-foreground">
                          <Info className="mt-0.5 size-3.5 shrink-0" />
                          <p>This won&apos;t count in this month&apos;s totals — instead it&apos;ll count in {formatMonthYear(month)}&apos;s Budget, Cash Flow, and Reports.</p>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </SectionCard>

            {transaction && (
              <SectionCard icon={Trash2} title={isTransferLeg ? "Delete Transfer" : "Delete Transaction"} tone="danger">
                <p className="text-xs text-muted-foreground">
                  {isTransferLeg
                    ? "This action cannot be undone. Both linked transactions (this account and the other side of the transfer) will be deleted together."
                    : "This action cannot be undone."}
                </p>
                <Button variant="destructive" size="sm" className="w-full" onClick={() => setConfirmDeleteOpen(true)}>
                  <Trash2 /> {isTransferLeg ? "Delete Transfer" : "Delete Transaction"}
                </Button>
              </SectionCard>
            )}
          </>
        }
        footerActions={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              {transaction ? "Save changes" : "Add transaction"}
            </Button>
          </>
        }
      />

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
