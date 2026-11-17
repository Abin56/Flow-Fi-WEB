"use client";

import { CalendarClock, ChevronDown, ExternalLink, Users } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { LinkedEmiSource } from "@/features/people/hooks/use-person-cycle-statement";
import { EmiBadge } from "@/features/people/components/cycle-statement/statement-parts";
import type { LinkedEmiInstallmentStatus, LinkedEmiStatus, PersonLinkedEmi } from "@/lib/engines/person-linked-emis";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<LinkedEmiStatus | LinkedEmiInstallmentStatus, string> = {
  paid: "Paid",
  partial: "Partially paid",
  overdue: "Overdue",
  pending: "Pending",
  upcoming: "Upcoming",
};

const STATUS_CLASS: Record<LinkedEmiStatus | LinkedEmiInstallmentStatus, string> = {
  paid: "bg-success/10 text-success",
  partial: "bg-settle-carried-badge text-settle-carried-text",
  overdue: "bg-expense/10 text-expense",
  pending: "bg-settle-emi-badge text-settle-emi-text",
  upcoming: "bg-secondary text-foreground/70",
};

const DOT_CLASS: Record<LinkedEmiInstallmentStatus, string> = {
  paid: "bg-success",
  partial: "bg-settle-emi-edge",
  overdue: "bg-expense",
  pending: "bg-settle-emi-edge",
  upcoming: "bg-foreground/30",
};

const shortDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const monthLabel = (d: Date) => d.toLocaleDateString("en-IN", { month: "short", year: "numeric" });

export function StatusPill({ status }: { status: LinkedEmiStatus | LinkedEmiInstallmentStatus }) {
  return <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10.5px] leading-4 font-semibold whitespace-nowrap", STATUS_CLASS[status])}>{STATUS_LABEL[status]}</span>;
}

function Metric({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10.5px] font-semibold tracking-wide text-foreground/60 uppercase">{label}</dt>
      <dd className={cn("truncate text-[12.5px] font-semibold text-foreground tabular-nums", tone)}>{value}</dd>
    </div>
  );
}

/** Where "View linked loan" goes — the same `?agreement=` deep link every other screen uses. */
export function linkedEmiHref(s: Pick<PersonLinkedEmi, "sourceKind" | "sourceId">): string {
  return `/${s.sourceKind === "loan" ? "loans" : "emi"}?agreement=${encodeURIComponent(s.sourceId)}`;
}

function LinkedEmiCard({ s, personName, source, saving, onToggle }: { s: PersonLinkedEmi; personName: string; source: LinkedEmiSource | undefined; saving: boolean; onToggle: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-xl bg-card px-3 py-2.5 text-xs ring-1 ring-border" data-testid="linked-emi-card">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <EmiBadge />
            <span className="truncate font-semibold text-foreground">{s.name}</span>
          </span>
          <span className="flex items-center gap-1 text-foreground/70">
            <Users className="size-3 shrink-0" strokeWidth={1.75} />
            {s.shared ? `Shared · ${personName}'s share ${money(s.monthlyShare)} of ${money(s.installmentAmount)}` : `${personName} repays you ${money(s.monthlyShare)} a month`}
          </span>
        </div>
        <StatusPill status={s.status} />
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-3">
        <Metric label="Monthly share" value={money(s.monthlyShare)} />
        <Metric label="Next due" value={s.nextDue ? `${shortDate(s.nextDue.dueDate)}` : "—"} />
        <Metric label="Due so far" value={money(s.dueToDate)} />
        <Metric label="Paid" value={money(s.paid)} tone={s.paid > 0 ? "text-success" : undefined} />
        <Metric label="Remaining" value={money(s.remaining)} tone={s.remaining > 0 ? (s.overdueCount > 0 ? "text-expense" : undefined) : "text-success"} />
        <Metric label="Later" value={money(s.upcoming)} />
      </dl>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1 rounded-md font-semibold text-foreground/80 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <CalendarClock className="size-3.5" strokeWidth={1.75} />
          Monthly schedule · {s.paidCount}/{s.installmentCount} paid
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} strokeWidth={1.75} />
        </button>
        <span className="flex items-center gap-1.5">
          {source && (
            <button
              type="button"
              disabled={saving}
              onClick={onToggle}
              className="rounded-full border border-border-strong px-2 py-0.5 font-semibold text-foreground transition-colors hover:border-primary-accent-text hover:bg-primary/15 disabled:opacity-50"
            >
              Stop counting
            </button>
          )}
          <Link
            href={linkedEmiHref(s)}
            className="inline-flex items-center gap-1 rounded-full border border-border-strong px-2 py-0.5 font-semibold text-foreground transition-colors hover:border-primary-accent-text hover:bg-primary/15"
          >
            <ExternalLink className="size-3" strokeWidth={1.75} />
            {s.sourceKind === "loan" ? "View loan" : "View EMI"}
          </Link>
        </span>
      </div>

      {open && (
        <ul className="mt-2 divide-y divide-border-strong/50 border-t border-border-strong/50" aria-label={`${s.name} monthly schedule`}>
          {s.installments.map((i) => (
            <li key={i.key} className="flex items-center gap-2 py-1.5">
              <span className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[i.status])} aria-hidden />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium text-foreground">
                  {monthLabel(i.dueDate)} · {s.sourceKind === "loan" ? "Loan EMI" : "EMI"} – Installment {i.number}
                </span>
                <span className="text-foreground/65">
                  Due {shortDate(i.dueDate)}
                  {i.paid > 0 && i.remaining > 0 ? ` · ${money(i.paid)} paid, ${money(i.remaining)} left` : ""}
                  {i.lenderStatus === "paid" ? " · bank paid" : ""}
                </span>
              </span>
              <span className="shrink-0 font-semibold text-foreground tabular-nums">{money(i.amount)}</span>
              <StatusPill status={i.status} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * "Linked EMIs" on a person's page: every Loan / EMI this person carries a share of (an opted-in
 * beneficiary, or a share of a split agreement), with their responsibility and what they have paid.
 * Presentational — every figure comes from `personLinkedEmis`. Agreements linked but not yet counted keep
 * the original one-line "repays me" offer.
 */
export function LinkedEmisPanel({
  personName,
  summaries,
  sources,
  savingId,
  onToggle,
}: {
  personName: string;
  summaries: PersonLinkedEmi[];
  sources: LinkedEmiSource[];
  savingId: string | null;
  onToggle: (source: LinkedEmiSource) => void;
}) {
  const sourceOf = (kind: "emi" | "loan", id: string) => sources.find((x) => x.kind === kind && x.id === id);
  const counted = new Set(summaries.map((s) => s.key));
  const notCounted = sources.filter((x) => !counted.has(`${x.kind}:${x.id}`));
  if (summaries.length === 0 && notCounted.length === 0) return null;
  return (
    <div data-testid="linked-emis">
      <p className="text-[11px] font-bold tracking-[0.08em] text-foreground/75 uppercase">Linked EMIs</p>
      <ul className="mt-2 space-y-2">
        {summaries.map((s) => {
          const src = sourceOf(s.sourceKind, s.sourceId);
          return <LinkedEmiCard key={s.key} s={s} personName={personName} source={src?.repays ? src : undefined} saving={src != null && savingId === src.id} onToggle={() => src && onToggle(src)} />;
        })}
        {notCounted.map((x) => (
          <li key={`${x.kind}:${x.id}`} className="flex items-center justify-between gap-3 rounded-xl bg-card px-3 py-2 text-xs ring-1 ring-border">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <EmiBadge />
                <span className="truncate font-semibold text-foreground">{x.name}</span>
              </span>
              <span className="text-foreground/70">For them, not counted</span>
            </span>
            <button
              type="button"
              disabled={savingId === x.id}
              onClick={() => onToggle(x)}
              className="shrink-0 rounded-full border border-border-strong px-2.5 py-1 font-semibold text-foreground transition-colors hover:border-primary-accent-text hover:bg-primary/15 disabled:opacity-50"
            >
              {`${personName} repays me`}
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[11px] text-foreground/65">Paying the bank doesn&apos;t settle this — record what they pay you with Settle Up.</p>
    </div>
  );
}
