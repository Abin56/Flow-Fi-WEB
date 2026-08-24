"use client";

/**
 * Detail popup for one staged (not-yet-committed) statement row — amount edit,
 * assign/split against a person's ledger, "don't count this in my totals," and
 * "count this in a different month." Structurally modeled on
 * `features/transactions/components/transaction-manager-sheet.tsx` (the same
 * three switches, copy verbatim for mobile-app parity), but everything here
 * writes to the `StagedRecord` itself via `updateFields` — never to
 * `ExpenseRepository`/`TransactionRepository`, since nothing is committed yet.
 * Assign/split writes the exact `ownership`/`actionDetail` axes Transaction
 * Studio's own inspectors and `commit-review-import.ts` already read — this is
 * a second, lighter-weight UI over the same fields, not a second data path.
 */

import { useState } from "react";
import { CalendarClock, Check, EyeOff, Info, Plus, SplitSquareHorizontal, Trash2, UserPlus, UserRound, X } from "lucide-react";
import { ClayBadge } from "@/components/clay/clay-badge";
import { ClayButton } from "@/components/clay/clay-button";
import { DetailDrawer } from "@/components/finance";
import { CurrencyField } from "@/components/forms/currency-field";
import { SettingsRow } from "@/components/settings/settings-row";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { MonthYearStepper } from "@/features/transactions/components/month-year-stepper";
import { formatMonthYear, isSameMonth } from "@/features/transactions/lib/transaction-flag";
import { formatCurrency } from "@/lib/format";
import { ExpenseRepository, type ExpenseParticipantInput } from "@/lib/repositories/expense-repository";
import type { SplitType } from "@/lib/models/expense";
import type { RecordActionDetail, SplitParticipantDraft, StagedRecord } from "@/lib/models/document-import";
import type { Person } from "@/lib/models/person";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";
import { stagedRecordFlagFor } from "@/features/statement-review/lib/staged-record-flag";

const SPLIT_TYPE_OPTIONS: { value: SplitType; label: string }[] = [
  { value: "equal", label: "Split equally" },
  { value: "custom", label: "Custom amounts" },
  { value: "percentage", label: "By percentage" },
];

function formatFullDate(date: Date): string {
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

interface ParticipantForm {
  personId: string | null;
  name: string;
  value: string;
}

export interface StagedRecordManagerSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  record: StagedRecord | null;
  people: Person[];
  updateFields: (recordId: string, patch: Partial<Omit<StagedRecord, "id">>) => Promise<void>;
  createPerson: (name: string) => Promise<Person>;
  onDelete: () => void;
  autoFocusAssign: boolean;
}

export function StagedRecordManagerSheet({
  open,
  onOpenChange,
  record,
  people,
  updateFields,
  createPerson,
  onDelete,
  autoFocusAssign,
}: StagedRecordManagerSheetProps) {
  const [amountInput, setAmountInput] = useState("");
  const [personId, setPersonId] = useState<string | null>(null);
  const [exclude, setExclude] = useState(false);
  const [reassign, setReassign] = useState(false);
  const [month, setMonth] = useState<Date>(new Date());
  const [addingPerson, setAddingPerson] = useState(false);
  const [newPersonName, setNewPersonName] = useState("");
  const [addingPersonBusy, setAddingPersonBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [splitOpen, setSplitOpen] = useState(false);
  const [splitType, setSplitType] = useState<SplitType>("equal");
  const [includeMe, setIncludeMe] = useState(true);
  const [participants, setParticipants] = useState<ParticipantForm[]>([{ personId: null, name: "", value: "" }]);
  const [splitSaving, setSplitSaving] = useState(false);
  const [splitError, setSplitError] = useState<string | null>(null);

  // Re-seed every editable field whenever a different row is opened — same
  // reset-on-prop-change pattern as TransactionManagerSheet (adjusting state
  // during render, per React's documented pattern, rather than in an effect).
  const [seenRecordId, setSeenRecordId] = useState<string | null>(null);
  if (record && record.id !== seenRecordId) {
    setSeenRecordId(record.id);
    setAmountInput(String(record.amount));
    setExclude(record.excludeFromCalculations);
    setReassign(record.accountingMonth != null);
    setMonth(record.accountingMonth ?? record.date);
    setError(null);
    setSplitOpen(false);
    setSplitError(null);
    setNewPersonName("");

    const detail = record.actionDetail;
    if (record.ownership === "someone_else" && detail?.kind === "someone_elses_expense") {
      setPersonId(detail.personId);
      setAddingPerson(false);
    } else {
      setPersonId(null);
      setAddingPerson(autoFocusAssign);
    }
    if (record.ownership === "shared" && detail?.kind === "shared_expense") {
      setSplitType(detail.splitType === "none" ? "equal" : detail.splitType);
      const me = detail.participants.find((p) => p.isMe);
      setIncludeMe(me != null);
      setParticipants(
        detail.participants
          .filter((p) => !p.isMe)
          .map((p) => ({ personId: p.personId, name: p.name, value: String(p.share) })),
      );
    } else {
      setSplitType("equal");
      setIncludeMe(true);
      setParticipants([{ personId: null, name: "", value: "" }]);
    }
  }

  if (!record) {
    return (
      <DetailDrawer open={open} onOpenChange={onOpenChange} title="Transaction Details" className="sm:max-w-lg duration-150">
        {null}
      </DetailDrawer>
    );
  }

  const personName = personId ? (people.find((p) => p.id === personId)?.name ?? "") : "";
  const flag = stagedRecordFlagFor(record);
  const monthChanged = !isSameMonth(month, record.date);
  const isExpense = record.direction === "debit";
  const description = record.counterpartyNormalized ?? record.counterpartyRaw;

  async function handleAddPerson() {
    if (!newPersonName.trim()) return;
    setAddingPersonBusy(true);
    try {
      const person = await createPerson(newPersonName.trim());
      setPersonId(person.id);
      setAddingPerson(false);
      setNewPersonName("");
    } catch (e) {
      toast.error("Couldn't add person", e instanceof Error ? e.message : undefined);
    } finally {
      setAddingPersonBusy(false);
    }
  }

  function commonEdits(amount: number) {
    return {
      amount,
      excludeFromCalculations: exclude,
      accountingMonth: reassign ? month : null,
    };
  }

  async function handleSaveManage() {
    if (!record) return;
    const amount = Number(amountInput);
    if (!amountInput.trim() || Number.isNaN(amount) || amount <= 0) {
      setError("Enter an amount greater than 0.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const assignPatch: Partial<Omit<StagedRecord, "id">> = isExpense
        ? personId != null
          ? { ownership: "someone_else", actionDetail: { kind: "someone_elses_expense", personId, personName } as RecordActionDetail }
          : { ownership: "mine", actionDetail: null }
        : {};
      await updateFields(record.id, { ...commonEdits(amount), ...assignPatch });
      toast.success("Transaction updated");
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save changes");
    } finally {
      setSaving(false);
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

  async function handleSaveSplit() {
    if (!record) return;
    const amount = Number(amountInput);
    if (!amountInput.trim() || Number.isNaN(amount) || amount <= 0) {
      setSplitError("Enter an amount greater than 0.");
      return;
    }
    const named = participants.filter((p) => p.name.trim() !== "" || p.personId != null);
    if (named.length === 0 && !includeMe) {
      setSplitError("Add at least one person to split with.");
      return;
    }
    setSplitSaving(true);
    setSplitError(null);
    try {
      const otherInputs: ExpenseParticipantInput[] = named.map((p) => ({
        personId: p.personId,
        name: p.personId ? (people.find((person) => person.id === p.personId)?.name ?? p.name) : p.name,
        value: splitType === "equal" ? null : Number(p.value),
      }));
      const inputs: ExpenseParticipantInput[] = includeMe
        ? [
            {
              name: "Me",
              isMe: true,
              value: splitType === "equal" ? null : amount - otherInputs.reduce((sum, p) => sum + (p.value ?? 0), 0),
            },
            ...otherInputs,
          ]
        : otherInputs;

      const resolved = ExpenseRepository.resolveShares({ type: splitType, total: amount, inputs });
      const draftParticipants: SplitParticipantDraft[] = resolved.map((p) => ({
        personId: p.personId,
        name: p.name,
        share: p.share,
        isMe: p.isMe,
      }));

      await updateFields(record.id, {
        ...commonEdits(amount),
        ownership: "shared",
        actionDetail: { kind: "shared_expense", participants: draftParticipants, splitType },
      });
      toast.success("Split saved");
      onOpenChange(false);
    } catch (e) {
      setSplitError(e instanceof Error ? e.message : "Could not save this split");
    } finally {
      setSplitSaving(false);
    }
  }

  return (
    <DetailDrawer open={open} onOpenChange={onOpenChange} title="Transaction Details" className="sm:max-w-lg duration-150">
      <div className="flex flex-col gap-5 text-sm">
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-foreground">{description || "(No description)"}</p>
          <p className="truncate text-xs text-muted-foreground">{formatFullDate(record.date)}</p>
        </div>

        <div>
          <p className={cn("font-mono text-2xl font-semibold tabular-nums", record.direction === "credit" ? "text-success" : "text-expense")}>
            {record.direction === "credit" ? "+" : "-"}
            {formatCurrency(record.amount)}
          </p>
          {flag && (
            <ClayBadge tone="warning" className="mt-2">
              {flag.label}
            </ClayBadge>
          )}
        </div>

        {!isExpense && (
          <div className="flex items-start gap-2 rounded-xl bg-muted/60 px-3 py-2.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <p>Assigning to a person or splitting is only available for expenses — this is income, so there&apos;s nothing to collect.</p>
          </div>
        )}

        <div className="flex flex-col gap-1">
          <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Manage</p>

          <div className="rounded-2xl border border-border/60">
            <div className="px-5 pt-4 pb-3">
              <CurrencyField label="Amount" currencySymbol="₹" value={amountInput} onChange={(v) => setAmountInput(String(v))} />
            </div>

            {isExpense && (
              <div className="border-t border-border/60 px-5 py-4">
                <p className="mb-2 text-sm font-medium text-foreground">Assign to a person</p>
                {!addingPerson ? (
                  <Select
                    value={personId ?? "none"}
                    onValueChange={(v) => {
                      if (v === "add-new") {
                        setAddingPerson(true);
                        return;
                      }
                      setPersonId(v === "none" ? null : v);
                    }}
                  >
                    <SelectTrigger className="h-10 w-full rounded-xl">
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
                    <input
                      autoFocus
                      className="clay-pressed h-10 flex-1 rounded-xl px-3 text-sm outline-none"
                      placeholder="Person's name"
                      value={newPersonName}
                      onChange={(e) => setNewPersonName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleAddPerson()}
                    />
                    <ClayButton size="icon" onClick={handleAddPerson} disabled={addingPersonBusy || !newPersonName.trim()} aria-label="Save person">
                      <Check className="size-4" />
                    </ClayButton>
                    <ClayButton size="icon" variant="ghost" onClick={() => setAddingPerson(false)} aria-label="Cancel">
                      <X className="size-4" />
                    </ClayButton>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setSplitOpen((v) => !v)}
                  className="mt-2.5 inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                >
                  <SplitSquareHorizontal className="size-3.5" />
                  {splitOpen ? "Hide split editor" : "Split with more people instead"}
                </button>
              </div>
            )}

            {isExpense && personId && !splitOpen && (
              <SettingsRow
                className="border-t border-border/60"
                icon={<UserRound className="size-4.5" />}
                label="This is fully someone else's expense"
                description="Adds this amount to what they owe you once this statement is imported."
                control={<Check className="size-4 text-primary" />}
              />
            )}

            <SettingsRow
              className="border-t border-border/60"
              icon={<EyeOff className="size-4.5" />}
              label="Don't count this in my totals"
              description="Still shows in your history — just won't affect your balance, budgets, or reports."
              control={<Switch checked={exclude} onCheckedChange={setExclude} />}
            />

            <div className="border-t border-border/60">
              <SettingsRow
                icon={<CalendarClock className="size-4.5" />}
                label="Count this in a different month?"
                description={reassign ? undefined : `Right now: counted in ${formatMonthYear(record.date)} (same as the date above)`}
                control={<Switch checked={reassign} onCheckedChange={(v) => { setReassign(v); if (v) setMonth(record.date); }} />}
              />
              {reassign && (
                <div className="flex flex-col gap-2 px-5 pb-4">
                  <MonthYearStepper value={month} onChange={setMonth} />
                  {monthChanged && (
                    <div className="flex items-start gap-2 rounded-xl bg-warning/12 px-3 py-2.5 text-xs text-warning-foreground">
                      <Info className="mt-0.5 size-3.5 shrink-0" />
                      <p>
                        This was made on {formatFullDate(record.date)}, but won&apos;t count in {formatMonthYear(record.date)}&apos;s totals —
                        instead it&apos;ll count in {formatMonthYear(month)}&apos;s Budget, Cash Flow, Dashboard, and Reports.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {isExpense && splitOpen && (
            <div className="mt-3 flex flex-col gap-3 rounded-2xl border border-border/60 p-4">
              <p className="text-sm font-medium text-foreground">Split this expense</p>
              <Select value={splitType} onValueChange={(v) => setSplitType(v as SplitType)}>
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

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 rounded border-border/60"
                  checked={includeMe}
                  onChange={(e) => setIncludeMe(e.target.checked)}
                />
                Include my own share
              </label>

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
                    {splitType !== "equal" && (
                      <input
                        type="number"
                        className="clay-pressed h-10 w-24 rounded-xl px-3 text-sm outline-none"
                        placeholder={splitType === "percentage" ? "%" : "Amount"}
                        value={p.value}
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
                <ClayButton type="button" variant="ghost" size="sm" onClick={addParticipantRow} className="self-start gap-1.5">
                  <Plus className="size-3.5" />
                  Add person
                </ClayButton>
              </div>

              {splitError && <p className="text-xs text-expense">{splitError}</p>}
              <ClayButton onClick={handleSaveSplit} disabled={splitSaving} className="self-start">
                {splitSaving ? "Saving…" : "Save Split"}
              </ClayButton>
            </div>
          )}

          {error && (
            <p role="alert" className="mt-3 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          {!splitOpen && (
            <ClayButton onClick={handleSaveManage} disabled={saving} className="mt-3 self-start">
              {saving ? "Saving…" : "Save changes"}
            </ClayButton>
          )}
        </div>

        <button
          type="button"
          onClick={onDelete}
          className="flex items-center justify-center gap-1.5 rounded-2xl border border-border/60 bg-card py-3 text-xs font-medium text-expense transition-colors hover:bg-expense/8"
        >
          <Trash2 className="size-4" />
          Delete this row
        </button>
      </div>
    </DetailDrawer>
  );
}
