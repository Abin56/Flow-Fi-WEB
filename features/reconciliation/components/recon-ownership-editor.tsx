"use client";

/**
 * Who an imported expense is for — the row's own, someone else's, or split between people with exact amounts. Draft
 * intent only: choosing here writes nothing; the final approval sends it through the same keyed, all-or-nothing write
 * Transaction Studio's statement import uses. Every problem (a repeated person, amounts that don't add up, a person who
 * no longer exists) is said here, beside the allocation, before an approval can start.
 */

import { useState } from "react";
import { AlertTriangle, Plus, SplitSquareHorizontal, Trash2, User, UserPlus, Users, X, type LucideIcon } from "lucide-react";
import { SHEET_FIELD, SheetChoice, SheetPicker, type SheetPickerOption } from "@/components/finance/transaction-sheet";
import { Input } from "@/components/ui/input";
import { SelectItem } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { Person } from "@/lib/models/person";
import { toPaise } from "../lib/amounts-and-days";
import { emptySplit, newShareId, ownershipErrors, parseShareAmount, sharePaise } from "../lib/row-ownership";
import type { ReconRow, RowOwnership, SplitShareDraft } from "../lib/types";

type Mode = "mine" | "person" | "split";

const MODES: { value: Mode; label: string; aria: string; hint: string; icon: LucideIcon }[] = [
  { value: "mine", label: "Mine", aria: "My own expense", hint: "Just my spending", icon: User },
  { value: "person", label: "Someone else's", aria: "Someone else's expense", hint: "They owe the full amount", icon: Users },
  { value: "split", label: "Split", aria: "Split expense", hint: "Share it with people", icon: SplitSquareHorizontal },
];

const NEW_PERSON = "__new__";
const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const initial = (name: string) => name.trim().slice(0, 1).toUpperCase() || "?";

function Problems({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5" data-testid="ownership-errors" aria-label="What to fix">
      {items.map((text, i) => (
        <li key={`${i}-${text}`} className="flex items-start gap-1.5 text-[11.5px] leading-snug font-medium text-[oklch(0.5_0.12_70)] dark:text-warning">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">{text}</span>
        </li>
      ))}
    </ul>
  );
}

/** One person: picked from People, or a name typed for someone not in People yet (created at final approval, reused by name). */
function PersonField({
  label,
  personId,
  name,
  typing,
  people,
  onPick,
  onType,
  onStartTyping,
  onStopTyping,
}: {
  label: string;
  personId: string | null;
  name: string;
  typing: boolean;
  people: Pick<Person, "id" | "name">[];
  onPick: (person: Pick<Person, "id" | "name">) => void;
  onType: (name: string) => void;
  onStartTyping: () => void;
  /** Back to choosing from People (clears the typed name). */
  onStopTyping: () => void;
}) {
  const options: SheetPickerOption[] = people.map((p) => ({ value: p.id, label: p.name, icon: <span className="text-[11px] font-bold text-foreground/75">{initial(p.name)}</span> }));
  if (typing) {
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        <Input aria-label={`${label} name`} autoFocus={name === ""} placeholder="Type their name" value={name} onChange={(e) => onType(e.target.value)} onKeyDown={(e) => e.stopPropagation()} className={SHEET_FIELD} />
        {people.length > 0 && (
          <button type="button" onClick={onStopTyping} className="h-8 shrink-0 rounded-lg px-2 text-[11.5px] font-semibold text-primary-accent-text hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary/45 focus-visible:outline-none">
            Pick from People
          </button>
        )}
      </div>
    );
  }
  return (
    <SheetPicker
      compact
      ariaLabel={label}
      value={personId}
      onValueChange={(v) => {
        if (v === NEW_PERSON) return onStartTyping();
        const person = people.find((p) => p.id === v);
        if (person) onPick(person);
      }}
      options={options}
      placeholder="Choose a person"
      emptyIcon={<UserPlus className="size-4" />}
      extraItems={
        <SelectItem value={NEW_PERSON}>
          <span className="flex items-center gap-1.5">
            <UserPlus className="size-3.5" /> Someone not in People…
          </span>
        </SelectItem>
      }
    />
  );
}

export function ReconOwnershipEditor({ row, ownership, people, onChange }: { row: ReconRow; ownership: RowOwnership | null | undefined; people: Pick<Person, "id" | "name">[]; onChange: (next: RowOwnership | null) => void }) {
  // Rows the user chose to type a name into (a draft restored from earlier already has typed names, which count too).
  const [typing, setTyping] = useState<ReadonlySet<string>>(() => new Set());
  const mode: Mode = ownership?.kind ?? "mine";
  const errors = ownershipErrors(row, ownership, people);
  const total = row.amount != null ? toPaise(row.amount) : 0;

  const choose = (next: Mode) => {
    if (next === mode) return;
    if (next === "mine") onChange(null);
    else if (next === "person") onChange({ kind: "person", personId: null, name: "" });
    else onChange(emptySplit());
  };

  const isTyping = (share: { id: string; personId: string | null; name: string }) => typing.has(share.id) || (share.personId == null && share.name.trim() !== "");
  const startTyping = (id: string) => setTyping((s) => new Set(s).add(id));
  const stopTyping = (id: string) => setTyping((s) => { const next = new Set(s); next.delete(id); return next; });

  return (
    <div className="flex flex-col gap-2" data-testid="ownership-editor">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[12px] font-semibold text-foreground/80">
          Whose expense? <span className="font-normal text-foreground/65">(optional)</span>
        </span>
        <div className="w-full max-w-[22rem] min-w-[16rem] flex-1">
          <SheetChoice compact label="Whose expense" value={mode} onChange={choose} options={MODES} />
        </div>
      </div>

      {ownership?.kind === "person" && (
        <div className="grid gap-2 rounded-lg border border-border bg-secondary/50 p-2.5" data-testid="ownership-person">
          <PersonField
            label="Person"
            personId={ownership.personId}
            name={ownership.name}
            typing={isTyping({ id: "person", personId: ownership.personId, name: ownership.name })}
            people={people}
            onPick={(p) => onChange({ kind: "person", personId: p.id, name: p.name })}
            onType={(name) => onChange({ kind: "person", personId: null, name })}
            onStartTyping={() => {
              startTyping("person");
              onChange({ kind: "person", personId: null, name: "" });
            }}
            onStopTyping={() => {
              stopTyping("person");
              onChange({ kind: "person", personId: null, name: "" });
            }}
          />
          <p className="text-[11.5px] text-foreground/72">They owe the full amount — it is recorded in their People ledger when you approve.</p>
          <Problems items={errors} />
        </div>
      )}

      {ownership?.kind === "split" && (
        <SplitEditor
          row={row}
          split={ownership}
          people={people}
          total={total}
          errors={errors}
          isTyping={isTyping}
          startTyping={startTyping}
          stopTyping={stopTyping}
          onChange={onChange}
        />
      )}
    </div>
  );
}

function SplitEditor({
  row,
  split,
  people,
  total,
  errors,
  isTyping,
  startTyping,
  stopTyping,
  onChange,
}: {
  row: ReconRow;
  split: Extract<RowOwnership, { kind: "split" }>;
  people: Pick<Person, "id" | "name">[];
  total: number;
  errors: string[];
  isTyping: (s: SplitShareDraft) => boolean;
  startTyping: (id: string) => void;
  stopTyping: (id: string) => void;
  onChange: (next: RowOwnership | null) => void;
}) {
  const { shares, splitType } = split;
  const paise = sharePaise(shares, splitType, total);
  const set = (next: Partial<typeof split>) => onChange({ ...split, ...next });
  const patch = (id: string, p: Partial<SplitShareDraft>) => set({ shares: shares.map((s) => (s.id === id ? { ...s, ...p } : s)) });
  const pickedElsewhere = (id: string) => new Set(shares.filter((s) => s.id !== id && s.personId != null).map((s) => s.personId));
  const assigned = paise.every((p) => p != null) ? (paise as number[]).reduce((a, b) => a + b, 0) : null;
  const left = assigned != null ? total - assigned : null;
  const me = shares.find((s) => s.isMe);

  /** Gives "Me" whatever the other amounts leave of the total — only offered while that is not negative. */
  const giveMeTheRest = () => {
    const others = shares.filter((s) => !s.isMe).reduce((sum, s) => sum + (parseShareAmount(s.amount) != null ? toPaise(parseShareAmount(s.amount)!) : 0), 0);
    if (me && others <= total) patch(me.id, { amount: ((total - others) / 100).toFixed(2) });
  };

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-secondary/50 p-2.5" data-testid="ownership-split">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="radiogroup" aria-label="How to split" className="inline-grid grid-cols-2 gap-1 rounded-[10px] bg-secondary p-1 ring-1 ring-border-strong/60 ring-inset">
          {(["equal", "custom"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={splitType === t}
              onClick={() => splitType !== t && set({ splitType: t })}
              className={cn("h-8 rounded-[8px] px-3 text-[12.5px] font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-primary/45 focus-visible:outline-none", splitType === t ? "bg-card text-foreground shadow-e2" : "text-foreground/72 hover:text-foreground")}
            >
              {t === "equal" ? "Equal shares" : "Exact amounts"}
            </button>
          ))}
        </div>
        {splitType === "custom" && left != null && (
          <p className={cn("text-[12px] font-semibold tabular-nums", left === 0 ? "text-[oklch(0.44_0.13_149)] dark:text-success" : "text-[oklch(0.5_0.12_70)] dark:text-warning")} data-testid="split-left" aria-live="polite">
            {left === 0 ? `${rupees(total)} fully assigned` : left > 0 ? `${rupees(left)} left to assign` : `${rupees(-left)} over`}
          </p>
        )}
      </div>

      <ul className="flex flex-col gap-2" aria-label="People in this split">
        {shares.map((s, i) => {
          const open = people.filter((p) => p.id === s.personId || !pickedElsewhere(s.id).has(p.id));
          const label = s.isMe ? "Me" : `Person ${i}`;
          return (
            <li key={s.id} className="grid grid-cols-[minmax(0,1fr)_7.5rem_auto] items-center gap-2" data-testid="split-share">
              {s.isMe ? (
                <div className="flex h-10 items-center gap-2.5 rounded-[10px] border border-border bg-card px-3">
                  <span className="grid size-7 shrink-0 place-items-center rounded-[8px] bg-primary/15 text-[11px] font-bold text-primary-accent-text">Me</span>
                  <span className="truncate text-sm font-semibold text-foreground">Me (my share)</span>
                </div>
              ) : (
                <PersonField
                  label={label}
                  personId={s.personId}
                  name={s.name}
                  typing={isTyping(s)}
                  people={open}
                  onPick={(p) => patch(s.id, { personId: p.id, name: p.name })}
                  onType={(name) => patch(s.id, { personId: null, name })}
                  onStartTyping={() => {
                    startTyping(s.id);
                    patch(s.id, { personId: null, name: "" });
                  }}
                  onStopTyping={() => {
                    stopTyping(s.id);
                    patch(s.id, { personId: null, name: "" });
                  }}
                />
              )}
              {splitType === "custom" ? (
                <Input
                  aria-label={s.isMe ? "My share" : `${s.name.trim() || label} share`}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={s.amount}
                  onChange={(e) => patch(s.id, { amount: e.target.value })}
                  onKeyDown={(e) => e.stopPropagation()}
                  className={cn(SHEET_FIELD, "text-right font-semibold tabular-nums")}
                />
              ) : (
                <span className="text-right text-sm font-semibold text-foreground tabular-nums" aria-label={`${s.isMe ? "My" : s.name.trim() || label} share`}>
                  {paise[i] != null ? rupees(paise[i]!) : "—"}
                </span>
              )}
              {s.isMe ? (
                splitType === "custom" ? (
                  <button type="button" onClick={giveMeTheRest} className="h-8 rounded-lg px-2 text-[11.5px] font-semibold text-primary-accent-text hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary/45 focus-visible:outline-none" title="Give me whatever the other amounts leave">
                    The rest
                  </button>
                ) : (
                  <span className="size-8" aria-hidden />
                )
              ) : (
                <button
                  type="button"
                  aria-label={`Remove ${s.name.trim() || label}`}
                  onClick={() => set({ shares: shares.filter((x) => x.id !== s.id) })}
                  className="grid size-8 place-items-center rounded-lg text-foreground/65 hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/45 focus-visible:outline-none"
                >
                  {shares.filter((x) => !x.isMe).length > 1 ? <Trash2 className="size-4" /> : <X className="size-4" />}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => set({ shares: [...shares, { id: newShareId(), personId: null, name: "", isMe: false, amount: "" }] })}
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-dashed border-border-strong bg-card px-3 text-[12px] font-semibold text-foreground transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-primary/45 focus-visible:outline-none"
        >
          <Plus className="size-3.5" aria-hidden /> Add person
        </button>
        {splitType === "equal" && <p className="text-[11.5px] text-foreground/72">Equal shares of {row.amount != null ? rupees(total) : "the amount"} — the last person takes any odd paisa.</p>}
      </div>
      <Problems items={errors} />
    </div>
  );
}
