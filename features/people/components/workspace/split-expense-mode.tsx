"use client";

import { Check, Divide, Percent, Plus, SlidersHorizontal, Split, Trash2, UserRound } from "lucide-react";
import { useMemo, useState } from "react";
import { ClayAvatar } from "@/components/clay/clay-avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCurrency } from "@/lib/format";
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { ExpenseParticipant, ReceivedStatus, SplitType } from "@/lib/models/expense";
import type { Person } from "@/lib/models/person";
import { ExpenseRepository, type ExpenseParticipantInput } from "@/lib/repositories/expense-repository";
import { useTransactionActions } from "@/features/transactions/hooks/use-transactions-data";
import { cn } from "@/lib/utils";
import {
  ModeFooter,
  ModeHeader,
  MoneyInput,
  WS_FIELD,
  WS_GHOST,
  WS_PAD,
  WS_PRIMARY,
  WS_SELECT_TRIGGER,
  WsField,
  WsLabel,
  WsSegmented,
} from "./person-workspace-ui";

const SPLIT_TYPE_OPTIONS: { value: SplitType; label: string; icon: typeof Divide }[] = [
  { value: "equal", label: "Equal", icon: Divide },
  { value: "custom", label: "Custom", icon: SlidersHorizontal },
  { value: "percentage", label: "Percentage", icon: Percent },
];

/** Collectible-only statuses — see `ExpenseParticipant.receivedStatus`. Plain-language labels only. */
const RECEIVED_STATUS_OPTIONS: { value: Exclude<ReceivedStatus, "notApplicable" | "excluded">; label: string }[] = [
  { value: "yetToReceive", label: "Owes me" },
  { value: "received", label: "Already paid" },
];

/**
 * One allocation grid for every participant row: avatar · name · controls · amount · remove. On phones
 * the controls drop to a second line under the name; the amount column never moves.
 */
const ALLOC_ROW =
  "grid grid-cols-[1.75rem_minmax(0,1fr)_5.5rem_1.75rem] items-center gap-x-3 gap-y-2 py-2.5 sm:grid-cols-[1.75rem_minmax(0,1fr)_auto_5.5rem_1.75rem]";
const ALLOC_AVATAR = "col-start-1 row-start-1";
const ALLOC_NAME = "col-start-2 row-start-1 min-w-0";
const ALLOC_CONTROLS = "col-start-2 col-end-5 row-start-2 flex items-center gap-2 sm:col-start-3 sm:col-end-4 sm:row-start-1 sm:justify-end";
const ALLOC_AMOUNT = "col-start-3 row-start-1 text-right text-sm font-semibold text-foreground tabular-nums sm:col-start-4";
const ALLOC_END = "col-start-4 row-start-1 sm:col-start-5";
const ALLOC_ERROR = "col-start-2 col-end-5 text-xs font-medium text-expense sm:col-end-6";

interface ExtraParticipant {
  personId: string | null;
  name: string;
  value: string;
  receivedStatus: ReceivedStatus;
}

type FieldErrors = Partial<Record<"description" | "amount" | "account" | "category" | "date" | "personShare", string>> & {
  extra?: Record<number, string>;
};

/** "Owes me" / "Already paid" — a two-state control instead of a dropdown. */
function StatusToggle({ value, onChange, label }: { value: ReceivedStatus; onChange: (v: ReceivedStatus) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex h-8 shrink-0 rounded-[6px] border border-border-strong p-[3px]">
      {RECEIVED_STATUS_OPTIONS.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex h-full items-center gap-1 rounded-[4px] px-2 text-[11px] whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active ? "bg-foreground font-semibold text-background" : "font-medium text-muted-foreground hover:text-foreground",
            )}
          >
            {active && <Check className="size-3" strokeWidth={2.5} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function ShareInput({
  value,
  onChange,
  splitType,
  label,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  splitType: SplitType;
  label: string;
  invalid?: boolean;
}) {
  const pct = splitType === "percentage";
  return (
    <div className="relative w-24 shrink-0">
      {!pct && <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-xs text-muted-foreground">₹</span>}
      <input
        type="number"
        inputMode="decimal"
        aria-label={label}
        aria-invalid={invalid || undefined}
        className={cn(WS_FIELD, "h-8 text-right tabular-nums", pct ? "pr-7" : "pl-6")}
        placeholder="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {pct && <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">%</span>}
    </div>
  );
}

/** A summary line — label left, figure right, one baseline. */
function SummaryLine({ label, value, className }: { label: React.ReactNode; value: string; className?: string }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3", className)}>
      <dt className="min-w-0 truncate">{label}</dt>
      <dd className="shrink-0 tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * Split mode — web port of Flutter's `AddExpenseChooser` -> `SplitExpenseFormSheet`/`AssignExpenseSheet`,
 * inside the Person workspace with this person already a participant (mirrors `forPerson` prefill).
 * "Assign fully" mirrors `AssignExpenseSheet`/`ExpenseRepository.assignToPerson` — the degenerate
 * one-participant-owes-it-all case. Multi-person splits reuse the same `ExpenseRepository.createExpense`/
 * `resolveShares` engine the Transactions page's split dialog calls; the live summary is that same
 * `resolveShares` over the same participant inputs the save sends — no arithmetic of its own.
 */
export function SplitExpenseMode({
  person,
  accounts,
  categories,
  people,
  onBack,
  onDone,
  backLabel,
}: {
  person: Person;
  accounts: Account[];
  categories: Category[];
  people: Person[];
  onBack: () => void;
  onDone: () => void;
  /** Label of the back link — the person's name by default ("Back to Transactions" from the expanded ledger). */
  backLabel?: string;
}) {
  const actions = useTransactionActions();

  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [accountIdState, setAccountId] = useState("");
  const [categoryIdState, setCategoryId] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [splitType, setSplitType] = useState<SplitType>("equal");
  const [includeMe, setIncludeMe] = useState(true);
  const [assignFully, setAssignFully] = useState(false);
  const [personShare, setPersonShare] = useState("");
  const [personReceivedStatus, setPersonReceivedStatus] = useState<ReceivedStatus>("yetToReceive");
  const [extraParticipants, setExtraParticipants] = useState<ExtraParticipant[]>([]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Defaults resolve once the lists have loaded — same picks the dialog made on open.
  const accountId = accountIdState || accounts[0]?.id || "";
  const categoryId = categoryIdState || categories.find((c) => c.type !== "income")?.id || "";
  const firstName = person.name.split(" ")[0];
  const selectablePeople = people.filter((p) => p.id !== person.id);
  const unitLabel = splitType === "percentage" ? "percentage" : "amount";

  function addExtraParticipant() {
    setExtraParticipants((p) => [...p, { personId: null, name: "", value: "", receivedStatus: "yetToReceive" }]);
  }

  function updateExtraParticipant(index: number, patch: Partial<ExtraParticipant>) {
    setExtraParticipants((p) => p.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function removeExtraParticipant(index: number) {
    setExtraParticipants((p) => p.filter((_, i) => i !== index));
  }

  function validate(): FieldErrors {
    const e: FieldErrors = {};
    if (!description.trim()) e.description = "Description is required.";
    const total = Number(amount);
    if (!amount.trim() || Number.isNaN(total) || total <= 0) e.amount = "Enter an amount greater than 0.";
    if (!accountId) e.account = "Select an account.";
    if (!categoryId) e.category = "Select a category.";
    if (!date) e.date = "Select a date.";
    if (assignFully) return e;
    if (splitType !== "equal") {
      const share = Number(personShare);
      if (personShare.trim() === "" || Number.isNaN(share) || share < 0) {
        e.personShare = `Enter a valid ${unitLabel} for ${person.name}.`;
      }
      extraParticipants.forEach((p, i) => {
        if (p.name.trim() === "") return;
        const v = Number(p.value);
        if (p.value.trim() === "" || Number.isNaN(v) || v < 0) {
          e.extra = { ...e.extra, [i]: `Enter a valid ${unitLabel} for ${p.name}.` };
        }
      });
    }
    return e;
  }

  /** The exact participant inputs and split type the save sends — unchanged from the dialog. */
  function buildParticipantInputs(totalAmount: number): { participantInputs: ExpenseParticipantInput[]; effectiveSplitType: SplitType } {
    if (assignFully) {
      return {
        effectiveSplitType: "custom",
        participantInputs: [{ personId: person.id, name: person.name, value: totalAmount, receivedStatus: personReceivedStatus }],
      };
    }
    const others = extraParticipants
      .filter((p) => p.name.trim() !== "")
      .map((p) => ({
        personId: p.personId,
        name: p.name.trim(),
        value: splitType === "equal" ? null : Number(p.value),
        receivedStatus: p.receivedStatus,
      }));
    const personInput = {
      personId: person.id,
      name: person.name,
      value: splitType === "equal" ? null : Number(personShare),
      receivedStatus: personReceivedStatus,
    };
    const participantInputs = includeMe
      ? [
          {
            name: "Me",
            isMe: true,
            value: splitType === "equal" ? null : totalAmount - (personInput.value ?? 0) - others.reduce((sum, p) => sum + (p.value ?? 0), 0),
          },
          personInput,
          ...others,
        ]
      : [personInput, ...others];
    return { participantInputs, effectiveSplitType: splitType };
  }

  // Live preview: the engine's own resolution of the inputs above (or the engine's own error).
  const totalAmount = Number(amount);
  const preview = useMemo((): { shares: ExpenseParticipant[] } | { error: string } | null => {
    if (!amount.trim() || !Number.isFinite(totalAmount) || totalAmount <= 0) return null;
    if (!assignFully && splitType !== "equal" && personShare.trim() === "") return null;
    try {
      const { participantInputs, effectiveSplitType } = buildParticipantInputs(totalAmount);
      return { shares: ExpenseRepository.resolveShares({ type: effectiveSplitType, total: totalAmount, inputs: participantInputs }) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "These amounts don't add up yet." };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- buildParticipantInputs reads exactly these values
  }, [amount, totalAmount, assignFully, splitType, includeMe, personShare, personReceivedStatus, extraParticipants, person.id, person.name]);
  const shares = preview && "shares" in preview ? preview.shares : null;
  const shareFor = (match: (p: ExpenseParticipant) => boolean) => shares?.find(match)?.share;

  async function handleSave() {
    if (!actions || saving) return;
    const fieldErrors = validate();
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const { participantInputs, effectiveSplitType } = buildParticipantInputs(Number(amount));
      await actions.createSplitTransaction({
        description: description.trim(),
        totalAmount: Number(amount),
        date: new Date(date),
        categoryId,
        accountId,
        splitType: effectiveSplitType,
        participantInputs,
        notes: "",
      });
      onDone();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Could not save this expense");
      setSaving(false);
    }
  }

  const clear = (key: keyof FieldErrors) => errors[key] && setErrors((e) => ({ ...e, [key]: undefined }));

  const personShareValue = shareFor((p) => p.personId === person.id);

  return (
    <div className="flex min-h-full flex-col">
      <ModeHeader backLabel={backLabel ?? person.name} onBack={onBack} title="Split expense" subtitle="Record an expense and track what each person owes." />

      <div className={cn(WS_PAD, "mt-5 flex-1")}>
        {/* The expense */}
        <WsLabel>Expense</WsLabel>
        <input
          aria-label="Description"
          aria-invalid={!!errors.description || undefined}
          className={cn(WS_FIELD, "mt-2 h-10 text-[15px] font-medium")}
          placeholder="What was it for? e.g. Dinner at Cafe"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            clear("description");
          }}
        />
        {errors.description && <p className="mt-1 text-xs font-medium text-expense">{errors.description}</p>}

        <div className="mt-4 grid gap-x-6 gap-y-3.5 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">Amount</span>
            <MoneyInput
              label="Total amount"
              value={amount}
              onChange={(v) => {
                setAmount(v);
                clear("amount");
              }}
              invalid={!!errors.amount}
            />
            {errors.amount && <span className="text-xs font-medium text-expense">{errors.amount}</span>}
          </div>
          <WsField label="Date" error={errors.date} className="sm:self-end">
            <input type="date" className={WS_FIELD} value={date} onChange={(e) => setDate(e.target.value)} />
          </WsField>
          <WsField label="Category" error={errors.category}>
            <Select
              value={categoryId}
              onValueChange={(v) => {
                setCategoryId(v);
                clear("category");
              }}
            >
              <SelectTrigger className={WS_SELECT_TRIGGER} aria-invalid={!!errors.category || undefined}>
                <SelectValue placeholder="Select category" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </WsField>
          <WsField label="Account" error={errors.account}>
            <Select
              value={accountId}
              onValueChange={(v) => {
                setAccountId(v);
                clear("account");
              }}
            >
              <SelectTrigger className={WS_SELECT_TRIGGER} aria-invalid={!!errors.account || undefined}>
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
          </WsField>
        </div>

        {/* The split */}
        <WsLabel className="mt-7">Split</WsLabel>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
          <WsSegmented
            label="Who pays"
            value={assignFully ? "assign" : "split"}
            onChange={(v) => setAssignFully(v === "assign")}
            options={[
              { value: "split", label: "Split it", icon: Split },
              { value: "assign", label: `${firstName} pays all`, icon: UserRound },
            ]}
            className="sm:w-72"
          />
          {!assignFully && (
            <WsSegmented label="Split type" value={splitType} onChange={setSplitType} options={SPLIT_TYPE_OPTIONS} className="sm:flex-1" />
          )}
        </div>

        <div key={assignFully ? "assign" : "split"} className="animate-in duration-200 fade-in-0">
          {!assignFully && (
            <div className="mt-4 flex items-center justify-between gap-3">
              <span className="text-[11px] font-medium text-muted-foreground">
                {splitType === "equal" ? "Everyone pays equally" : splitType === "custom" ? "Set exact amounts" : "Split by percentage"}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={includeMe}
                onClick={() => setIncludeMe((v) => !v)}
                className="flex items-center gap-2 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
              >
                Include my own share
                <span
                  className={cn(
                    "relative h-4.5 w-8 rounded-full border transition-colors",
                    includeMe ? "border-primary-accent-text bg-primary" : "border-border-strong bg-secondary",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-1/2 size-3 -translate-y-1/2 rounded-full transition-[left] duration-200",
                      includeMe ? "left-[calc(100%-0.875rem)] bg-primary-foreground" : "left-0.5 bg-muted-foreground",
                    )}
                  />
                </span>
              </button>
            </div>
          )}

          {/* Allocation — one grid for every person */}
          <ul className={cn("divide-y divide-border border-y border-border", assignFully ? "mt-3" : "mt-2")}>
            {!assignFully && includeMe && (
              <li className={ALLOC_ROW}>
                <span className={cn(ALLOC_AVATAR, "flex size-7 items-center justify-center rounded-full bg-secondary text-[10px] font-semibold text-foreground")}>
                  You
                </span>
                <span className={ALLOC_NAME}>
                  <span className="block truncate text-sm font-medium text-foreground">You</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {splitType === "equal" ? "Your share" : "Your share · what's left after the others"}
                  </span>
                </span>
                <span className={ALLOC_AMOUNT}>{shareFor((p) => p.isMe) != null ? formatCurrency(shareFor((p) => p.isMe)!) : "—"}</span>
              </li>
            )}

            <li className={ALLOC_ROW}>
              <span className={ALLOC_AVATAR}>
                <ClayAvatar name={person.name} size={28} />
              </span>
              <span className={ALLOC_NAME}>
                <span className="block truncate text-sm font-medium text-foreground">{person.name}</span>
                <span className={cn("block truncate text-xs", personReceivedStatus === "received" ? "text-muted-foreground" : "text-success")}>
                  {personReceivedStatus === "received" ? "Already paid you" : "They owe you"}
                </span>
              </span>
              <span className={ALLOC_CONTROLS}>
                <StatusToggle value={personReceivedStatus} onChange={setPersonReceivedStatus} label={`${person.name}'s payment status`} />
                {!assignFully && splitType !== "equal" && (
                  <ShareInput
                    value={personShare}
                    onChange={(v) => {
                      setPersonShare(v);
                      clear("personShare");
                    }}
                    splitType={splitType}
                    label={`${person.name}'s ${unitLabel}`}
                    invalid={!!errors.personShare}
                  />
                )}
              </span>
              <span className={ALLOC_AMOUNT}>{personShareValue != null ? formatCurrency(personShareValue) : "—"}</span>
              {errors.personShare && <p className={ALLOC_ERROR}>{errors.personShare}</p>}
            </li>

            {!assignFully &&
              extraParticipants.map((p, i) => {
                const resolved = p.name.trim()
                  ? shareFor((s) => (p.personId != null ? s.personId === p.personId : !s.isMe && s.personId == null && s.name === p.name.trim()))
                  : undefined;
                return (
                  <li key={i} className={cn(ALLOC_ROW, "animate-in duration-200 fade-in-0")}>
                    <span className={ALLOC_AVATAR}>
                      {p.name.trim() ? (
                        <ClayAvatar name={p.name} size={28} />
                      ) : (
                        <span className="flex size-7 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                          <UserRound className="size-3.5" strokeWidth={1.75} />
                        </span>
                      )}
                    </span>
                    <span className={cn(ALLOC_NAME, "flex gap-2")}>
                      <Select
                        value={p.personId ?? "custom"}
                        onValueChange={(v) => {
                          if (v === "custom") {
                            updateExtraParticipant(i, { personId: null, name: "" });
                            return;
                          }
                          const picked = selectablePeople.find((sp) => sp.id === v);
                          updateExtraParticipant(i, { personId: v, name: picked?.name ?? "" });
                        }}
                      >
                        <SelectTrigger className={cn(WS_SELECT_TRIGGER, "h-8 min-w-0", p.personId == null ? "w-32 shrink-0" : "flex-1")} aria-label="Person">
                          <SelectValue placeholder="Person" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="custom">Custom name</SelectItem>
                          {selectablePeople.map((sp) => (
                            <SelectItem key={sp.id} value={sp.id}>
                              {sp.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {p.personId == null && (
                        <input
                          aria-label="Name"
                          className={cn(WS_FIELD, "h-8 min-w-0 flex-1")}
                          placeholder="Name"
                          value={p.name}
                          onChange={(e) => updateExtraParticipant(i, { name: e.target.value })}
                        />
                      )}
                    </span>
                    <span className={ALLOC_CONTROLS}>
                      <StatusToggle
                        value={p.receivedStatus}
                        onChange={(v) => updateExtraParticipant(i, { receivedStatus: v })}
                        label={`${p.name || "This person"}'s payment status`}
                      />
                      {splitType !== "equal" && (
                        <ShareInput
                          value={p.value}
                          onChange={(v) => updateExtraParticipant(i, { value: v })}
                          splitType={splitType}
                          label={`${p.name || "This person"}'s ${unitLabel}`}
                          invalid={!!errors.extra?.[i]}
                        />
                      )}
                    </span>
                    <span className={ALLOC_AMOUNT}>{resolved != null ? formatCurrency(resolved) : "—"}</span>
                    <button
                      type="button"
                      onClick={() => removeExtraParticipant(i)}
                      className={cn(
                        ALLOC_END,
                        "flex size-7 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-secondary hover:text-expense",
                      )}
                      aria-label="Remove participant"
                    >
                      <Trash2 className="size-3.5" strokeWidth={1.75} />
                    </button>
                    {errors.extra?.[i] && <p className={ALLOC_ERROR}>{errors.extra[i]}</p>}
                  </li>
                );
              })}
          </ul>
          {!assignFully && (
            <button
              type="button"
              onClick={addExtraParticipant}
              className="mt-1.5 -ml-1.5 flex h-8 items-center gap-1.5 rounded-[6px] px-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-secondary"
            >
              <Plus className="size-3.5" strokeWidth={2} />
              Add another person
            </button>
          )}
        </div>

        {/* Live summary — the engine's resolution of exactly what Save will send */}
        <section aria-live="polite" className="mt-5 rounded-[8px] border border-border bg-secondary/40 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <WsLabel>Summary</WsLabel>
            {shares && (
              <span className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                <Check className="size-3 text-success" strokeWidth={2.5} /> Fully allocated
              </span>
            )}
          </div>
          {preview == null ? (
            <p className="mt-1.5 text-sm text-muted-foreground">
              Enter the total{!assignFully && splitType !== "equal" ? ` and ${firstName}'s ${unitLabel}` : ""} to see who owes what.
            </p>
          ) : "error" in preview ? (
            <>
              <dl className="mt-2 text-sm">
                <SummaryLine label="Total" value={formatCurrency(totalAmount)} className="font-medium text-foreground" />
              </dl>
              <p className="mt-2 rounded-[6px] border border-expense/40 bg-expense/8 px-2.5 py-1.5 text-xs font-medium text-expense">{preview.error}</p>
            </>
          ) : (
            <>
              <dl className="mt-2 space-y-1 text-sm">
                <SummaryLine label="Total" value={formatCurrency(totalAmount)} className="font-medium text-foreground" />
                {preview.shares.map((s, i) => (
                  <SummaryLine
                    key={`${s.personId ?? s.name}-${i}`}
                    label={s.isMe ? "Your share" : `${s.name}'s share`}
                    value={formatCurrency(s.share)}
                    className="text-muted-foreground"
                  />
                ))}
              </dl>
              {preview.shares.some((s) => !s.isMe && s.share > 0) && (
                <dl className="mt-2.5 space-y-1 border-t border-border-strong/70 pt-2.5">
                  {preview.shares
                    .filter((s) => !s.isMe && s.share > 0)
                    .map((s, i) => (
                      <SummaryLine
                        key={`${s.personId ?? s.name}-owe-${i}`}
                        label={s.receivedStatus === "received" ? `${s.name} has already paid you` : `${s.name} owes you`}
                        value={formatCurrency(s.share)}
                        className={cn(
                          "font-heading text-[15px] font-semibold tracking-tight",
                          s.receivedStatus === "received" ? "text-muted-foreground" : "text-foreground [&_dd]:text-success",
                        )}
                      />
                    ))}
                </dl>
              )}
            </>
          )}
        </section>
      </div>

      <ModeFooter>
        {saveError && <p className="mr-auto text-xs font-medium text-expense">{saveError}</p>}
        <button type="button" onClick={onBack} disabled={saving} className={WS_GHOST}>
          Cancel
        </button>
        <button type="button" onClick={() => void handleSave()} disabled={saving} className={WS_PRIMARY}>
          {saving ? "Saving…" : "Save Split"}
        </button>
      </ModeFooter>
    </div>
  );
}
