"use client";

import { CalendarClock, CheckCircle2, ChevronDown, HandCoins, Users, Wallet, type LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Money } from "@/features/loans/components/loan-emi-ui";
import { othersByPerson, type CommitmentRecord, type CommitmentRow, type MonthWindow, type OthersPerson } from "@/features/loans/lib/my-commitments";
import { useLoanPersons } from "@/hooks/use-loans";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export type EmiSheetTab = "mine" | "others";

const rupees = (paise: number) => paise / 100;
const inr = (paise: number) => `₹${rupees(paise).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const dueLabel = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });

const STATE_TONE = { paid: "bg-success/15 text-success", partial: "bg-warning/20 text-warning-foreground dark:text-warning", unpaid: "bg-secondary text-muted-foreground" } as const;
const STATE_LABEL = { paid: "Paid", partial: "Part paid", unpaid: "Unpaid" } as const;

/** One avatar colour per person, stable across renders (hash of the id). */
const AVATARS = [
  "bg-violet-500/20 text-violet-700 dark:text-violet-300",
  "bg-sky-500/20 text-sky-700 dark:text-sky-300",
  "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
  "bg-amber-500/25 text-amber-800 dark:text-amber-300",
  "bg-rose-500/20 text-rose-700 dark:text-rose-300",
] as const;
const avatarOf = (id: string) => AVATARS[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATARS.length];

function Stat({ icon: Icon, label, tone, children }: { icon: LucideIcon; label: string; tone: "primary" | "good" | "warn" | "neutral"; children: React.ReactNode }) {
  const bg = { primary: "bg-primary/15 border-primary-accent-text/30", good: "bg-success/10", warn: "bg-expense/10", neutral: "bg-secondary/50" }[tone];
  return (
    <div className={cn("flex min-w-0 flex-col gap-1 rounded-[10px] border border-border p-3", bg)}>
      <span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
      {children}
    </div>
  );
}

function Bar({ pct, className }: { pct: number; className: string }) {
  return (
    <span aria-hidden className="block h-1.5 w-full overflow-hidden rounded-full bg-secondary">
      <span className={cn("block h-full rounded-full transition-all duration-500", className)} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </span>
  );
}

interface Line {
  id: string;
  label: string;
  due: Date;
  amountPaise: number;
  state: "paid" | "partial" | "unpaid";
}

/** An expandable row: a title block, one amount, a progress bar, and a list of installment lines. */
function Expandable({ avatar, title, subtitle, amountPaise, amountNote, pct, barClass, lines, badge }: {
  avatar: { text: string; className: string };
  title: string;
  subtitle: string;
  amountPaise: number;
  amountNote: string;
  pct: number;
  barClass: string;
  lines: Line[];
  badge?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="overflow-hidden rounded-[12px] border border-border bg-card shadow-e1">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex w-full flex-col gap-2.5 p-3.5 text-left outline-none hover:bg-secondary/40 focus-visible:ring-2 focus-visible:ring-ring">
        <span className="flex items-center gap-3">
          <span aria-hidden className={cn("grid size-9 shrink-0 place-items-center rounded-full font-heading text-sm font-bold uppercase", avatar.className)}>
            {avatar.text}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-2">
              <span className="truncate font-heading text-[15px] font-semibold text-foreground uppercase">{title}</span>
              {badge && <span className="shrink-0 rounded-full bg-secondary px-2 py-px text-[10px] font-semibold text-muted-foreground">{badge}</span>}
            </span>
            <span className="text-xs text-muted-foreground">{subtitle}</span>
          </span>
          <span className="flex shrink-0 flex-col items-end">
            <Money amount={rupees(amountPaise)} className="text-lg leading-none" />
            <span className="mt-0.5 text-[11px] text-muted-foreground">{amountNote}</span>
          </span>
          <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        </span>
        <Bar pct={pct} className={barClass} />
      </button>
      {open && (
        <ul className="flex flex-col divide-y divide-border border-t border-border bg-secondary/20">
          {lines.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-2 px-3.5 py-2 text-xs">
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium text-foreground">{l.label}</span>
                <span className="flex items-center gap-1 text-muted-foreground">
                  <CalendarClock aria-hidden className="size-3" /> due {dueLabel(l.due)}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className={cn("rounded-full px-2 py-px text-[11px] font-semibold", STATE_TONE[l.state])}>{STATE_LABEL[l.state]}</span>
                <span className="w-16 text-right text-sm font-semibold text-foreground tabular-nums">{inr(l.amountPaise)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-[12px] border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{text}</p>;
}

/** My EMI tab — my confirmed share of each EMI due in the month, from the very rows the summary is folded from. */
function MineTab({ rows, window }: { rows: readonly CommitmentRow[]; window: MonthWindow }) {
  const groups = useMemo(() => {
    const by = new Map<string, { name: string; kind: CommitmentRow["kind"]; rows: CommitmentRow[] }>();
    for (const r of rows) {
      if (r.counts !== "mine") continue;
      const g = by.get(r.recordKey) ?? { name: r.name, kind: r.kind, rows: [] };
      g.rows.push(r);
      by.set(r.recordKey, g);
    }
    return [...by.entries()]
      .map(([key, g]) => {
        const share = g.rows.reduce((t, r) => t + (r.minePaise ?? 0), 0);
        const paid = g.rows.reduce((t, r) => t + (r.minePaidPaise ?? 0), 0);
        return { key, ...g, share, paid, remaining: share - paid };
      })
      .sort((a, b) => (b.remaining > 0 ? 1 : 0) - (a.remaining > 0 ? 1 : 0) || b.remaining - a.remaining || b.share - a.share);
  }, [rows]);

  const share = groups.reduce((t, g) => t + g.share, 0);
  const paid = groups.reduce((t, g) => t + g.paid, 0);
  const remaining = share - paid;

  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        <Stat icon={Wallet} label="My EMI" tone="primary"><Money amount={rupees(share)} className="text-lg leading-none" /></Stat>
        <Stat icon={CheckCircle2} label="Paid" tone="good"><Money amount={rupees(paid)} className="text-lg leading-none text-success" /></Stat>
        <Stat icon={CalendarClock} label="Still to pay" tone={remaining > 0 ? "warn" : "good"}>
          <Money amount={rupees(remaining)} className={cn("text-lg leading-none", remaining > 0 && "text-expense")} />
        </Stat>
      </div>
      {groups.length === 0 ? (
        <Empty text={`No confirmed EMI of yours falls due in ${window.label}.`} />
      ) : (
        <ul className="flex flex-col gap-3">
          {groups.map((g) => (
            <Expandable
              key={g.key}
              avatar={{ text: g.name.trim().charAt(0), className: "bg-primary/25 text-foreground" }}
              title={g.name}
              badge={g.kind === "shared" ? "Shared" : "Mine"}
              subtitle={g.remaining > 0 ? `${inr(g.remaining)} still to pay · ${g.rows.length} ${g.rows.length === 1 ? "payment" : "payments"}` : `All paid · ${g.rows.length} ${g.rows.length === 1 ? "payment" : "payments"}`}
              amountPaise={g.share}
              amountNote={g.kind === "shared" ? "my share" : "this month"}
              pct={g.share > 0 ? (g.paid / g.share) * 100 : 0}
              barClass="bg-gradient-to-r from-success/70 to-success"
              lines={g.rows.map((r) => ({ id: r.key, label: `Installment #${r.sequenceNumber}${r.kind === "shared" ? ` · my share of ${inr(r.duePaise)}` : ""}`, due: r.dueDate, amountPaise: r.minePaise ?? 0, state: r.state }))}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/** Others' EMI tab — each person's confirmed share, grouped by EMI. */
function OthersTab({ records, window }: { records: readonly CommitmentRecord[]; window: MonthWindow }) {
  const { data: persons = [] } = useLoanPersons();
  const list = useMemo(() => othersByPerson(records, window), [records, window]);
  const nameOf = (id: string) => persons.find((p) => p.id === id)?.name ?? "Someone";
  const share = list.reduce((t, p) => t + p.sharePaise, 0);
  const paid = list.reduce((t, p) => t + p.paidPaise, 0);

  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        <Stat icon={HandCoins} label="They owe" tone="primary"><Money amount={rupees(share)} className="text-lg leading-none" /></Stat>
        <Stat icon={CheckCircle2} label="Lender paid" tone="good"><Money amount={rupees(paid)} className="text-lg leading-none text-success" /></Stat>
        <Stat icon={Users} label="People" tone="neutral"><span className="font-heading text-lg leading-none font-bold tabular-nums">{list.length}</span></Stat>
      </div>
      {list.length === 0 ? (
        <Empty text={`No shared installments fall due in ${window.label}.`} />
      ) : (
        <ul className="flex flex-col gap-3">
          {list.map((p: OthersPerson) => {
            const name = nameOf(p.personId);
            return (
              <Expandable
                key={p.personId}
                avatar={{ text: name.charAt(0), className: avatarOf(p.personId) }}
                title={name}
                subtitle={`${p.emis.length} ${p.emis.length === 1 ? "EMI" : "EMIs"} · ${p.installments} ${p.installments === 1 ? "payment" : "payments"} this month`}
                amountPaise={p.sharePaise}
                amountNote="to pay you"
                pct={p.sharePaise > 0 ? (p.paidPaise / p.sharePaise) * 100 : 0}
                barClass="bg-gradient-to-r from-violet-400/70 to-violet-500"
                lines={p.emis.flatMap((e) => e.installments.map((i) => ({ id: `${e.recordKey}:${i.id}`, label: `${e.name} · #${i.sequenceNumber}`, due: i.dueDate, amountPaise: i.sharePaise, state: i.state })))}
              />
            );
          })}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">Status shows whether the lender has been paid. Collecting from people and receipts are tracked in the People Ledger.</p>
    </>
  );
}

const TABS: { value: EmiSheetTab; label: string; icon: LucideIcon }[] = [
  { value: "mine", label: "My EMI", icon: Wallet },
  { value: "others", label: "Others’ EMI", icon: Users },
];

/** Slide-over for the month's EMI lists: what I pay (My EMI) and who pays me what (Others’ EMI). Display only. */
export function EmiListSheet({ open, onOpenChange, tab, onTabChange, records, rows, window }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tab: EmiSheetTab;
  onTabChange: (tab: EmiSheetTab) => void;
  records: readonly CommitmentRecord[];
  rows: readonly CommitmentRow[];
  window: MonthWindow;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="gap-1 border-b border-border bg-gradient-to-b from-secondary/60 to-transparent px-5 pt-5 pb-4 pr-14">
          <SheetTitle className="text-lg">EMI list · {window.label}</SheetTitle>
          <SheetDescription>What you pay, and what others pay you, this month.</SheetDescription>
          <div role="tablist" aria-label="EMI list" className="mt-3 grid grid-cols-2 gap-1 rounded-full bg-secondary p-1">
            {TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={tab === t.value}
                onClick={() => onTabChange(t.value)}
                className={cn(
                  "inline-flex items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  tab === t.value ? "bg-card text-foreground shadow-e1" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <t.icon aria-hidden className="size-4" /> {t.label}
              </button>
            ))}
          </div>
        </SheetHeader>
        {open && (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
            {tab === "mine" ? <MineTab rows={rows} window={window} /> : <OthersTab records={records} window={window} />}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
