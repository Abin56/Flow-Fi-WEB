"use client";

import { BellRing, X } from "lucide-react";
import { createContext, useContext, useState } from "react";
import { DateInput } from "@/components/forms/date-input";
import { formatStatementDate } from "@/lib/engines/person-cycle-statement";
import { nextCycleStart, tomorrow, type FollowUpKind, type FollowUpStatus, type PersonFollowUp } from "@/lib/models/person-follow-up";
import { cn } from "@/lib/utils";
import { WS_FIELD } from "./person-workspace-ui";

/** When a follow-up reminder should need attention. */
export interface ReminderWhen {
  kind: FollowUpKind;
  remindOn: Date;
}

type Mode = "none" | "tomorrow" | "nextCycle" | "date";

const toInputDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fromInputDate = (s: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};

/** No reminder / Tomorrow / Next cycle (Settings → Month Cycle) / Choose date. Emits null for "No reminder". */
export function ReminderPicker({
  value,
  onChange,
  cycleStartDay,
  allowNone = true,
  className,
}: {
  value: ReminderWhen | null;
  onChange: (next: ReminderWhen | null) => void;
  cycleStartDay: number;
  allowNone?: boolean;
  className?: string;
}) {
  const today = new Date();
  const next = nextCycleStart(today, cycleStartDay);
  const [mode, setMode] = useState<Mode>(() => (value == null ? (allowNone ? "none" : "nextCycle") : value.kind === "nextCycle" ? "nextCycle" : "date"));
  const [dateText, setDateText] = useState(() => toInputDate(value?.remindOn ?? tomorrow(today)));
  const pick = (m: Mode) => {
    setMode(m);
    if (m === "none") onChange(null);
    else if (m === "tomorrow") onChange({ kind: "date", remindOn: tomorrow(today) });
    else if (m === "nextCycle") onChange({ kind: "nextCycle", remindOn: next });
    else {
      const d = fromInputDate(dateText);
      onChange(d ? { kind: "date", remindOn: d } : null);
    }
  };
  const options: { value: Mode; label: string }[] = [
    ...(allowNone ? [{ value: "none" as const, label: "No reminder" }] : []),
    { value: "tomorrow", label: "Tomorrow" },
    { value: "nextCycle", label: `Next cycle · ${formatStatementDate(next)}` },
    { value: "date", label: "Choose date" },
  ];
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <div role="radiogroup" aria-label="Reminder" className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={mode === o.value}
            onClick={() => pick(o.value)}
            className={cn(
              "h-8 rounded-full border px-2.5 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
              mode === o.value ? "border-primary-accent-text bg-primary/15 text-foreground" : "border-border-strong bg-card text-foreground/80 hover:bg-secondary",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      {mode === "date" && (
        <DateInput
          aria-label="Reminder date"
          className={cn(WS_FIELD, "h-8")}
          wrapperClassName="w-40"
          value={dateText}
          onChange={(e) => {
            setDateText(e.target.value);
            const d = fromInputDate(e.target.value);
            onChange(d ? { kind: "date", remindOn: d } : null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Ledger: one person's reminders, by obligation key
// ---------------------------------------------------------------------------------------------------

export interface FollowUpContextValue {
  byKey: ReadonlyMap<string, { followUp: PersonFollowUp; status: FollowUpStatus }>;
  cycleStartDay: number;
  onSet: (key: string, title: string, when: ReminderWhen) => Promise<void>;
  onDismiss: (key: string) => Promise<void>;
  onRemove: (key: string) => Promise<void>;
}

export const FollowUpContext = createContext<FollowUpContextValue | null>(null);

export function followUpText(f: Pick<PersonFollowUp, "kind" | "remindOn">, status: FollowUpStatus): string {
  const day = formatStatementDate(f.remindOn);
  if (status === "dueToday") return "Follow up today";
  if (status === "overdue") return `Follow-up overdue · ${day}`;
  return f.kind === "nextCycle" ? `Follow up next cycle · ${day}` : `Expected ${day}`;
}

/** Secondary line under an open row's remaining — never replaces the financial status. */
export function FollowUpNote({ rowKey, className }: { rowKey: string; className?: string }) {
  const ctx = useContext(FollowUpContext);
  const item = ctx?.byKey.get(rowKey);
  if (!item || item.status === "resolved") return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[11px] font-semibold whitespace-nowrap",
        item.status === "overdue" ? "text-warning" : item.status === "dueToday" ? "text-primary-accent-text" : "text-foreground/65",
        className,
      )}
    >
      <BellRing className="size-3" aria-hidden />
      {followUpText(item.followUp, item.status)}
    </span>
  );
}

/** In a row's expansion: add / change / mark handled / remove — the debt itself is never touched. */
export function FollowUpControl({ rowKey, title, open }: { rowKey: string; title: string; open: boolean }) {
  const ctx = useContext(FollowUpContext);
  const [editing, setEditing] = useState(false);
  const [when, setWhen] = useState<ReminderWhen | null>(null);
  const [busy, setBusy] = useState(false);
  if (!ctx || !open) return null;
  const item = ctx.byKey.get(rowKey);
  const active = item && item.status !== "resolved" ? item : null;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };
  const btn = "h-7 rounded-[6px] border border-border-strong bg-card px-2 text-[12px] font-semibold text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
  return (
    <div className="mt-2.5 border-t border-border-strong/60 pt-2" onClick={(e) => e.stopPropagation()}>
      <p className="mb-1 text-[10.5px] font-bold tracking-[0.08em] text-foreground/65 uppercase">Follow-up</p>
      {!editing ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {active ? <FollowUpNote rowKey={rowKey} className="mr-1" /> : <span className="mr-1 text-[12px] text-foreground/65">No reminder</span>}
          <button
            type="button"
            className={btn}
            disabled={busy}
            onClick={() => {
              setWhen(active ? { kind: active.followUp.kind, remindOn: active.followUp.remindOn } : { kind: "nextCycle", remindOn: nextCycleStart(new Date(), ctx.cycleStartDay) });
              setEditing(true);
            }}
          >
            {active ? "Change date" : "Remind me later"}
          </button>
          {active && (
            <>
              <button type="button" className={btn} disabled={busy} onClick={() => run(() => ctx.onDismiss(rowKey))}>
                Mark handled
              </button>
              <button
                type="button"
                aria-label={`Remove reminder for ${title}`}
                className={cn(btn, "px-1.5")}
                disabled={busy}
                onClick={() => run(() => ctx.onRemove(rowKey))}
              >
                <X className="size-3.5" />
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <ReminderPicker value={active ? { kind: active.followUp.kind, remindOn: active.followUp.remindOn } : null} onChange={setWhen} cycleStartDay={ctx.cycleStartDay} allowNone={false} />
          <button
            type="button"
            className={cn(btn, "border-primary-accent-text bg-primary/15")}
            disabled={busy || !when}
            onClick={() => when && run(() => ctx.onSet(rowKey, title, when))}
          >
            Save reminder
          </button>
          <button type="button" className={btn} disabled={busy} onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      )}
      <p className="mt-1 text-[11px] text-foreground/60">Private to you — doesn&apos;t change what is owed or appear on shared statements.</p>
    </div>
  );
}
