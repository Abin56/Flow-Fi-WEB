"use client";

import { ArrowRight, CalendarClock, Check, ChevronDown, Clock, ExternalLink, Landmark, Layers, Search, TriangleAlert, Users } from "lucide-react";
import Link from "next/link";
import { useContext, useState } from "react";
import { Pagination } from "@/components/finance/pagination";
import { DeferralContext } from "@/features/people/components/workspace/payment-deferral";
import type { GeneralCredit } from "@/features/people/lib/settlement-presentation";
import { cycleName } from "@/lib/engines/person-payment-deferral";
import type { LinkedEmiSource } from "@/features/people/hooks/use-person-cycle-statement";
import { ColumnLabel } from "@/features/people/components/cycle-statement/header-parts";
import { EmiBadge } from "@/features/people/components/cycle-statement/statement-parts";
import type { LinkedEmiInstallmentStatus, LinkedEmiStatus, PersonLinkedEmi } from "@/lib/engines/person-linked-emis";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { emiResponsibility, RESPONSIBILITY_SEGMENTS, type EmiResponsibility } from "@/features/people/lib/emi-responsibility";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";

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

const LENDER_LABEL: Record<PersonLinkedEmi["installments"][number]["lenderStatus"], string> = {
  paid: "Paid",
  partial: "Part paid",
  overdue: "Overdue",
  upcoming: "Scheduled",
};

const shortDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const monthLabel = (d: Date) => d.toLocaleDateString("en-IN", { month: "short", year: "numeric" });

export function StatusPill({ status }: { status: LinkedEmiStatus | LinkedEmiInstallmentStatus }) {
  return <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10.5px] leading-4 font-semibold whitespace-nowrap", STATUS_CLASS[status])}>{STATUS_LABEL[status]}</span>;
}

const POSTPONED_PILL =
  "shrink-0 rounded-full border border-dashed border-primary-accent-text/70 px-2 py-0.5 text-[10.5px] leading-4 font-semibold whitespace-nowrap text-primary-accent-text";

/** Where "View linked loan" goes — the same `?agreement=` deep link every other screen uses. */
export function linkedEmiHref(s: Pick<PersonLinkedEmi, "sourceKind" | "sourceId">): string {
  return `/${s.sourceKind === "loan" ? "loans" : "emi"}?agreement=${encodeURIComponent(s.sourceId)}`;
}

/** The live postponement of one installment share (same `emi-inst:` / `loan-inst:` key the ledger rows use), or null. */
export function usePostponedLookup(): (key: string) => { name: string; date: Date | null } | null {
  const ctx = useContext(DeferralContext);
  return (key) => {
    const view = ctx?.byKey.get(key);
    return view && view.status === "postponed" ? { name: cycleName(view.cycle), date: view.date } : null;
  };
}

/** The postponement facts of one agreement's shares — display only (the shares' remaining stays in the totals). */
function usePostponedFacts(s: PersonLinkedEmi) {
  const postponedOf = usePostponedLookup();
  // Postponed shares are still owed (Remaining keeps them) — they just aren't "overdue" while the new cycle is ahead.
  const pastDue = s.installments.filter((i) => i.remaining > 0.005 && (i.status === "overdue" || i.status === "partial"));
  const postponed = s.installments.filter((i) => i.remaining > 0.005 && postponedOf(i.key) != null);
  const amount = postponed.reduce((t, i) => t + i.remaining, 0);
  const allPastDuePostponed = s.status === "overdue" && pastDue.length > 0 && pastDue.every((i) => postponedOf(i.key) != null);
  const firstMove = postponed[0] ? postponedOf(postponed[0].key) : null;
  return { postponedOf, amount, allPastDuePostponed, firstMove };
}

/** Settlement status in words — from the summary's own figures. */
function settlementLine(s: PersonLinkedEmi, firstName: string, allPastDuePostponed: boolean): { text: string; tone: string } {
  if (s.remaining < 0.005 && s.upcoming < 0.005) return { text: "Fully settled", tone: "text-success" };
  if (s.remaining < 0.005) return { text: "Up to date · nothing due now", tone: "text-success" };
  if (allPastDuePostponed) return { text: `${money(s.remaining)} postponed · still owed`, tone: "text-primary-accent-text" };
  if (s.overdueCount > 0) return { text: `${s.overdueCount} overdue · ${firstName} owes ${money(s.remaining)}`, tone: "text-expense" };
  return { text: `${firstName} owes ${money(s.remaining)} now`, tone: "text-settle-emi-text" };
}

/**
 * The agreement's shares as one segmented bar — repaid · still owed · postponed · later (see `emiResponsibility`).
 * Its widths are the installment figures themselves; the aria value stays the installments-paid count.
 */
function ResponsibilityBar({ s, r, className, thin }: { s: PersonLinkedEmi; r: EmiResponsibility; className?: string; thin?: boolean }) {
  const pct = s.installmentCount > 0 ? Math.round((s.paidCount / s.installmentCount) * 100) : 0;
  const parts = RESPONSIBILITY_SEGMENTS.filter((seg) => r[seg.key] >= 0.005);
  return (
    <span
      role="progressbar"
      aria-label={`${s.paidCount} of ${s.installmentCount} shares repaid`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      title={RESPONSIBILITY_SEGMENTS.map((seg) => `${seg.label}: ${money(r[seg.key])}`).join(" · ")}
      className={cn("flex gap-[2px] overflow-hidden rounded-full bg-border-strong/40", thin ? "h-1.5" : "h-2", className)}
    >
      {parts.map((seg) => (
        <span key={seg.key} className={cn("h-full transition-[flex-grow] duration-700 ease-out first:rounded-l-full last:rounded-r-full", seg.bar)} style={{ flexGrow: r[seg.key] }} />
      ))}
    </span>
  );
}

/** The live postponement lookup reduced to a yes/no, for `emiResponsibility`. */
function useResponsibility(s: PersonLinkedEmi): EmiResponsibility {
  const postponedOf = usePostponedLookup();
  return emiResponsibility(s, (key) => postponedOf(key) != null);
}

const PILL_BTN =
  "inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-border-strong px-2.5 text-xs font-semibold text-foreground outline-none transition-colors hover:border-primary-accent-text hover:bg-primary/15 focus-visible:ring-2 focus-visible:ring-ring";

function Figure({ label, value, tone, className }: { label: string; value: string; tone?: string; className?: string }) {
  return (
    <div className={cn("min-w-0 rounded-lg bg-secondary/55 px-2.5 py-2 @min-[42rem]:rounded-none @min-[42rem]:bg-transparent @min-[42rem]:py-0", className)}>
      <dt className="text-[11px] font-semibold text-muted-foreground">{label}</dt>
      <dd className={cn("mt-1 font-heading text-base leading-tight font-bold break-words text-foreground tabular-nums @min-[42rem]:mt-0.5", tone)}>{value}</dd>
    </div>
  );
}

/** The card's state in four looks — the edge, the "Due now" tile and the status callout share one tone. */
const CARD_TONE = {
  overdue: { edge: "bg-expense", tile: "bg-expense/[0.07]", value: "text-expense", callout: "bg-expense/[0.08] text-expense", Icon: TriangleAlert },
  postponed: { edge: "bg-primary-accent-text", tile: "bg-primary/10", value: "text-primary-accent-text", callout: "bg-primary/10 text-primary-accent-text", Icon: CalendarClock },
  ok: { edge: "bg-success", tile: "bg-success/[0.07]", value: "text-success", callout: "bg-success/[0.08] text-success", Icon: Check },
  due: { edge: "bg-settle-emi-edge", tile: "bg-settle-emi-tint", value: "text-settle-emi-text", callout: "bg-settle-emi-tint text-settle-emi-text", Icon: Clock },
} as const;

const PILL_GHOST =
  "inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/** Every installment as one pip, in order — paid · partly paid · overdue · pending · not yet due · postponed. Display only. */
function InstallmentPips({ s, postponedOf }: { s: PersonLinkedEmi; postponedOf: ReturnType<typeof usePostponedLookup> }) {
  const count = (st: LinkedEmiInstallmentStatus) => s.installments.filter((i) => i.status === st).length;
  const label = `Shares: ${count("paid")} repaid, ${count("overdue")} overdue, ${count("upcoming") + count("pending")} still to come`;
  return (
    <span role="img" aria-label={label} className="flex min-w-0 flex-wrap gap-[3px]">
      {s.installments.map((i) => {
        const moved = i.remaining > 0.005 ? postponedOf(i.key) : null;
        return (
          <span
            key={i.key}
            title={`#${i.number} · ${monthLabel(i.dueDate)} · ${moved ? "Postponed" : STATUS_LABEL[i.status]}`}
            className={cn("size-[9px] rounded-[3px]", moved ? "bg-primary-accent-text" : i.status === "pending" ? "bg-settle-emi-edge/55" : i.status === "upcoming" ? "bg-border-strong/70" : DOT_CLASS[i.status])}
          />
        );
      })}
    </span>
  );
}

function LinkedEmiCard({ s, personName, source, saving, onToggle }: { s: PersonLinkedEmi; personName: string; source: LinkedEmiSource | undefined; saving: boolean; onToggle: () => void }) {
  const [open, setOpen] = useState(false);
  // The schedule opens on what still matters — the next unpaid installments — so it never needs an inner scroll area.
  const [scheduleAll, setScheduleAll] = useState(false);
  const unpaidRows = s.installments.filter((i) => i.remaining > 0.005);
  const scheduleRows = scheduleAll ? s.installments : (unpaidRows.length > 0 ? unpaidRows : s.installments.slice(-3)).slice(0, 6);
  const hiddenCount = s.installments.length - scheduleRows.length;
  const first = personName.split(" ")[0];
  const { postponedOf, amount: postponedAmount, allPastDuePostponed, firstMove } = usePostponedFacts(s);
  const line = settlementLine(s, first, allPastDuePostponed);
  const r = useResponsibility(s);
  const T = CARD_TONE[allPastDuePostponed ? "postponed" : s.remaining < 0.005 ? "ok" : s.overdueCount > 0 ? "overdue" : "due"];
  const StatusIcon = T.Icon;
  const movedTo = firstMove ? (firstMove.date ? shortDate(firstMove.date) : `${firstMove.name} cycle`) : null;
  const movedLine = movedTo && postponedAmount > 0.005 && !allPastDuePostponed ? `${money(postponedAmount)} moved to ${movedTo} · still owed` : null;
  return (
    <article
      className="@container relative flex min-w-0 animate-in flex-col overflow-hidden rounded-[10px] border border-border bg-card text-xs shadow-e1 fade-in-0 fill-mode-both motion-reduce:animate-none"
      data-testid="linked-emi-card"
    >
      <span aria-hidden className={cn("absolute inset-x-0 top-0 h-[3px] @min-[42rem]:inset-y-0 @min-[42rem]:right-auto @min-[42rem]:h-auto @min-[42rem]:w-0.5", T.edge)} />
      <div className="px-3.5 pt-3.5 @min-[42rem]:px-3 @min-[42rem]:pt-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground @min-[42rem]:size-8"><Landmark className="size-4" strokeWidth={1.75} aria-hidden /></span>
          <div className="min-w-0">
            <h3 className="font-heading text-base font-semibold break-words text-foreground @min-[42rem]:leading-tight">{s.name}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground tabular-nums @min-[42rem]:mt-0">
              {money(s.monthlyShare)} monthly share{s.shared && ` · ${money(s.installmentAmount)} lender installment`}
            </p>
          </div>
          <span className="ml-auto">{allPastDuePostponed ? <span className={POSTPONED_PILL} title="The overdue share was postponed — it is still owed">Postponed</span> : <StatusPill status={s.status} />}</span>
        </div>
        <div className="mt-3 grid items-start gap-3 @min-[42rem]:mt-1.5 @min-[42rem]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] @min-[42rem]:items-center @min-[42rem]:gap-0 @min-[42rem]:border-t @min-[42rem]:border-border-subtle @min-[42rem]:py-2">
          <dl className="grid grid-cols-3 items-stretch gap-2 @min-[42rem]:gap-0 @min-[42rem]:divide-x @min-[42rem]:divide-border-subtle @min-[42rem]:[&>div:first-child]:pl-0">
            <Figure className={T.tile} label="Unpaid to date" value={money(s.remaining)} tone={T.value} />
            <Figure label="Repaid to you" value={money(s.paid)} tone={s.paid > 0 ? "text-success" : undefined} />
            <Figure label="Due later" value={money(s.upcoming)} />
          </dl>
          <div className="flex min-w-0 flex-col gap-2 rounded-[8px] border border-border bg-secondary/20 p-2.5 @min-[42rem]:gap-1 @min-[42rem]:rounded-none @min-[42rem]:border-0 @min-[42rem]:border-l @min-[42rem]:border-border-subtle @min-[42rem]:bg-transparent @min-[42rem]:p-0 @min-[42rem]:pl-3">
            <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs font-medium text-muted-foreground tabular-nums">
              <span className="inline-flex items-center gap-1.5"><Users className="size-3.5" aria-hidden /> {s.paidCount}/{s.installmentCount} shares repaid to you</span>
              <span className="inline-flex items-center gap-1.5"><Landmark className="size-3.5" aria-hidden /> Paid to lender {r.bankPaidCount}/{r.installmentCount}</span>
            </div>
            <ResponsibilityBar s={s} r={r} className="@min-[42rem]:h-1.5" />
            {s.nextDue && <p className="text-xs text-muted-foreground tabular-nums">Next open share due {shortDate(s.nextDue.dueDate)}</p>}
          </div>
        </div>
      </div>

      <div className="@min-[42rem]:flex @min-[42rem]:items-center @min-[42rem]:justify-between @min-[42rem]:gap-2 @min-[42rem]:border-t @min-[42rem]:border-border @min-[42rem]:bg-secondary/30 @min-[42rem]:px-3 @min-[42rem]:py-1">
        <p className={cn("mx-3.5 my-3 flex min-w-0 items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold wrap-anywhere tabular-nums @min-[42rem]:m-0 @min-[42rem]:rounded-none @min-[42rem]:bg-transparent @min-[42rem]:p-0", T.callout)}>
          <StatusIcon className="mt-0.5 size-3.5 shrink-0" strokeWidth={2.25} aria-hidden />
          <span>
            {line.text}
            {movedLine ? ` · ${movedLine}` : allPastDuePostponed && movedTo ? ` · moved to ${movedTo}` : ""}
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border bg-secondary/30 px-3 py-2 @min-[42rem]:shrink-0 @min-[42rem]:flex-nowrap @min-[42rem]:border-0 @min-[42rem]:bg-transparent @min-[42rem]:p-0">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            title="Monthly schedule"
            className={cn(PILL_GHOST, "@min-[42rem]:min-h-7")}
          >
            <ChevronDown className={cn("size-3.5 transition-transform duration-200", open && "rotate-180")} strokeWidth={2} />
            Schedule
          </button>
          {source && (
            <button type="button" disabled={saving} onClick={onToggle} className={cn(PILL_GHOST, "ml-auto @min-[42rem]:ml-0 @min-[42rem]:min-h-7")}>
              Exclude from balance
            </button>
          )}
          <Link href={linkedEmiHref(s)} className={cn(PILL_BTN, !source && "ml-auto", "@min-[42rem]:ml-0 @min-[42rem]:min-h-7")}>
            <ExternalLink className="size-3" strokeWidth={1.75} />
            {s.sourceKind === "loan" ? "View loan" : "View EMI"}
          </Link>
        </div>
      </div>

      {open && (
        <div className="border-t border-border px-4 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
            <span className="font-semibold text-foreground">Share timeline</span>
            <InstallmentPips s={s} postponedOf={postponedOf} />
          </div>
          <ul className="mt-1 divide-y divide-border" aria-label={`${s.name} monthly schedule`}>
            {scheduleRows.map((i) => {
              const moved = i.remaining > 0.005 ? postponedOf(i.key) : null;
              return (
                <li key={i.key} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
                  <span className={cn("size-1.5 shrink-0 rounded-full", moved ? "bg-primary-accent-text" : DOT_CLASS[i.status])} aria-hidden />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium text-foreground">
                      {monthLabel(i.dueDate)} · Installment {i.number}
                    </span>
                    <span className="text-muted-foreground">
                      Due {shortDate(i.dueDate)}
                      {i.paid > 0 && i.remaining > 0 ? ` · ${money(i.paid)} paid, ${money(i.remaining)} left` : ""}
                      {moved ? ` · moved to ${moved.date ? shortDate(moved.date) : `${moved.name} cycle`}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 font-semibold text-foreground tabular-nums">{money(i.amount)}</span>
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-muted-foreground" data-testid="linked-emi-schedule-status">
                    <span className="inline-flex items-center gap-1">Share {moved ? <span className={POSTPONED_PILL}>Postponed</span> : <StatusPill status={i.status} />}</span>
                    <span className="inline-flex items-center gap-1">Lender <span className={cn("rounded-full px-2 py-0.5 font-semibold", STATUS_CLASS[i.lenderStatus])}>{LENDER_LABEL[i.lenderStatus]}</span></span>
                  </span>
                </li>
              );
            })}
            {(scheduleAll || hiddenCount > 0) && (
              <li className="py-1.5">
                <button type="button" onClick={() => setScheduleAll((all) => !all)} className="text-[11.5px] font-semibold text-primary-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                  {scheduleAll ? "Show fewer installments" : `Show all ${s.installments.length} installments`}
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
    </article>
  );
}

/** "Stop counting" / "repays me" — the existing `setRepays`, with its saving state and failure toast. */
export function useRepaysToggle(setRepays: (source: LinkedEmiSource, repays: boolean) => Promise<void>) {
  const [savingId, setSavingId] = useState<string | null>(null);
  const toggle = async (source: LinkedEmiSource) => {
    setSavingId(source.id);
    try {
      await setRepays(source, !source.repays);
    } catch {
      toast.error("Couldn't update the EMI");
    } finally {
      setSavingId(null);
    }
  };
  return { savingId, toggle };
}

/**
 * "Linked EMIs" on a person's page: every Loan / EMI this person carries a share of (an opted-in
 * beneficiary, or a share of a split agreement), with their responsibility and what they have paid.
 * Presentational — every figure comes from `personLinkedEmis`. Agreements linked but not yet counted keep
 * the original one-line "repays me" offer.
 */
const AGREEMENTS_PER_PAGE = 6;

export function LinkedEmisPanel({
  personName,
  summaries,
  sources,
  savingId,
  onToggle,
  generalCredit,
  initialAgreementKey,
}: {
  personName: string;
  summaries: PersonLinkedEmi[];
  sources: LinkedEmiSource[];
  savingId: string | null;
  onToggle: (source: LinkedEmiSource) => void;
  /** Payments toward the overall balance no item carries — the cards' "Paid" never includes them, so say so. */
  generalCredit?: GeneralCredit | null;
  initialAgreementKey?: string | null;
}) {
  const sourcesByKey = new Map(sources.map((source) => [`${source.kind}:${source.id}`, source]));
  const counted = new Set(summaries.map((s) => s.key));
  const notCounted = sources.filter((x) => !counted.has(`${x.kind}:${x.id}`));
  const agreements = [
    ...summaries.map((summary) => ({ key: summary.key, name: summary.name, kind: summary.sourceKind, summary, source: sourcesByKey.get(summary.key) })),
    ...notCounted.map((source) => ({ key: `${source.kind}:${source.id}`, name: source.name, kind: source.kind, summary: null, source })),
  ];
  const [selectedKey, setSelectedKey] = useState(initialAgreementKey ?? null);
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const matching = agreements.filter((item) => `${item.name} ${item.kind}`.toLowerCase().includes(query));
  const selectedIndex = Math.max(0, matching.findIndex((item) => item.key === selectedKey));
  const currentPage = 1 + Math.floor(selectedIndex / AGREEMENTS_PER_PAGE);
  const shown = matching.slice((currentPage - 1) * AGREEMENTS_PER_PAGE, currentPage * AGREEMENTS_PER_PAGE);
  const active = matching[selectedIndex];
  const source = active?.source;
  const toggleActive = () => {
    if (!active || !source) return;
    setSelectedKey(active.key);
    onToggle(source);
  };
  if (agreements.length === 0) return null;
  const untied = generalCredit && generalCredit.theyOwe.credit >= 0.005 ? generalCredit.theyOwe : null;
  return (
    <div data-testid="linked-emis">
        {untied && summaries.length > 0 && (
          <p
            className="mb-2.5 flex min-w-0 items-start gap-2 rounded-[7px] bg-settle-receivable-tint/70 px-3 py-2 text-xs leading-snug text-foreground/80 ring-1 ring-settle-receivable-edge/25 ring-inset"
            data-testid="linked-emis-untied-note"
            title="Paid on each card counts only payments tied to an installment."
          >
            <Layers className="size-3 shrink-0 text-settle-receivable-text" aria-hidden />
            <span>
              {personName} also paid <b className="font-semibold text-foreground tabular-nums">{money(untied.credit)}</b> toward the overall balance, not tied to an installment ·{" "}
              {untied.owed < 0.005 ? "nothing owed overall" : <><b className="font-semibold text-foreground tabular-nums">{money(untied.owed)}</b> still owed overall</>}
            </span>
          </p>
        )}
      <div className="@container">
        <div className={cn("grid items-start gap-2.5", agreements.length > 1 && "@min-[52rem]:grid-cols-[minmax(14rem,0.8fr)_minmax(0,2fr)]")}>
          {agreements.length > 1 && (
            <section aria-label="Linked agreements" className="min-w-0 overflow-hidden rounded-[10px] border border-border bg-card shadow-e1">
              <div className="flex items-center justify-between gap-2 border-b border-border bg-secondary/30 px-3 py-2">
                <h2 className="text-sm font-semibold text-foreground">Linked agreements</h2>
                <span className="text-xs text-muted-foreground tabular-nums">{agreements.length}</span>
              </div>
              {agreements.length > AGREEMENTS_PER_PAGE && (
                <div className="relative border-b border-border px-2.5 py-2">
                  <Search className="pointer-events-none absolute top-1/2 left-5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <input type="search" aria-label="Search linked agreements" placeholder="Search agreements" value={search} onChange={(e) => { setSearch(e.target.value); setSelectedKey(null); }} className="h-8 w-full rounded-[6px] border border-border bg-background px-2 pl-8 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                </div>
              )}
              {shown.length > 0 ? (
                <ul className="divide-y divide-border-subtle" aria-label="Choose agreement">
                  {shown.map((item) => (
                    <li key={item.key}>
                      <button type="button" aria-pressed={active?.key === item.key} onClick={() => setSelectedKey(item.key)} data-testid="linked-emi-choice" className={cn("flex min-h-12 w-full items-center justify-between gap-2 border-l-2 border-transparent px-3 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", active?.key === item.key ? "border-settle-receivable-edge bg-settle-receivable-tint/50" : "hover:bg-secondary/55")}>
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-semibold text-foreground" title={item.name}>{item.name}</span>
                          <span className="block text-[11px] text-muted-foreground">{item.kind === "loan" ? "Loan" : "EMI"}{!item.summary && " · Excluded"}</span>
                        </span>
                        {item.summary && <span className="shrink-0 text-right text-xs font-semibold text-foreground tabular-nums" title="Unpaid to date">{money(item.summary.remaining)}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <p className="px-3 py-3 text-xs text-muted-foreground" role="status">No linked agreements match your search.</p>}
              {matching.length > AGREEMENTS_PER_PAGE && <Pagination page={currentPage} pageSize={AGREEMENTS_PER_PAGE} total={matching.length} onPageChange={(next) => setSelectedKey(matching[(next - 1) * AGREEMENTS_PER_PAGE]?.key ?? null)} className="gap-2 border-t border-border px-3 py-1 [&_button]:size-7 [&_p]:text-xs" />}
            </section>
          )}
          {active?.summary ? (
            <LinkedEmiCard key={active.key} s={active.summary} personName={personName} source={source?.repays ? source : undefined} saving={source != null && savingId === source.id} onToggle={toggleActive} />
          ) : active && source && (
          <article className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-dashed border-border-strong bg-card p-4 text-xs">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <EmiBadge />
                <span className="truncate font-semibold text-foreground">{source.name}</span>
              </span>
              <span className="text-muted-foreground">Excluded from their balance</span>
            </span>
            <button
              type="button"
              disabled={savingId === source.id}
              onClick={toggleActive}
              className="shrink-0 rounded-full border border-border-strong px-2.5 py-1 font-semibold text-foreground transition-colors hover:border-primary-accent-text hover:bg-primary/15 disabled:opacity-50"
            >
              Include in balance
            </button>
          </article>
          )}
        </div>
      </div>
    </div>
  );
}

const BOARD_COLS = "grid grid-cols-[minmax(0,1.5fr)_minmax(0,1.3fr)_repeat(4,minmax(4.6rem,0.62fr))_minmax(4.4rem,0.5fr)] items-center gap-x-3";

/** One agreement as one board row: identity · responsibility bar · the four amounts · the bank's side. */
function BoardRow({ s, personName, onOpen, index }: { s: PersonLinkedEmi; personName: string; onOpen: () => void; index: number }) {
  const { allPastDuePostponed } = usePostponedFacts(s);
  const r = useResponsibility(s);
  const line = settlementLine(s, personName.split(" ")[0], allPastDuePostponed);
  const cell = (v: number, tone: string) => <span className={cn("text-right text-[12.5px] font-semibold tabular-nums", v >= 0.005 ? tone : "text-foreground/30")}>{v >= 0.005 ? money(v) : "—"}</span>;
  return (
    <li className="animate-in fade-in-0 fill-mode-both slide-in-from-bottom-1" style={{ animationDelay: `${index * 35}ms` }}>
      <button
        type="button"
        onClick={onOpen}
        title={`Open ${s.name} on the Linked EMIs tab`}
        className={cn(BOARD_COLS, "w-full rounded-[10px] px-2 py-2 text-left outline-none transition-colors hover:bg-secondary/70 focus-visible:ring-2 focus-visible:ring-ring")}
      >
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[12.5px] font-semibold text-foreground">{s.name}</span>
            {allPastDuePostponed ? <span className={POSTPONED_PILL}>Postponed</span> : s.status === "overdue" && <StatusPill status="overdue" />}
          </span>
          <span className="truncate text-[11px] text-foreground/55 tabular-nums">{money(s.monthlyShare)}/mo{s.shared ? ` of ${money(s.installmentAmount)}` : ""}</span>
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <ResponsibilityBar s={s} r={r} thin />
          <span className={cn("truncate text-[10.5px] font-semibold", line.tone)}>
            {s.paidCount}/{s.installmentCount} · {line.text}
          </span>
        </span>
        {cell(r.repaid, "text-success")}
        {cell(r.owed, "text-expense")}
        {cell(r.postponed, "text-primary-accent-text")}
        {cell(r.later, "text-foreground/75")}
        <span className="text-right text-[11.5px] font-medium text-foreground/60 tabular-nums" title="Installments the bank has been paid — your side with the lender">
          {r.bankPaidCount}/{r.installmentCount}
        </span>
      </button>
    </li>
  );
}

/**
 * The Overview's EMI responsibility board — every linked agreement on one line with the five things to tell apart
 * (Repaid · Still owed · Postponed · Later, and the bank's side), then payments toward the overall balance on their own
 * line so they never read as settling an installment. Figures: `personLinkedEmis` + `GeneralCredit`, unchanged.
 */
export function EmiResponsibilityBoard({
  personName,
  summaries,
  generalCredit,
  onOpen,
}: {
  personName: string;
  summaries: PersonLinkedEmi[];
  generalCredit?: GeneralCredit | null;
  onOpen: () => void;
}) {
  if (summaries.length === 0) return null;
  const first = personName.split(" ")[0];
  const untied = generalCredit && generalCredit.theyOwe.credit >= 0.005 ? generalCredit.theyOwe : null;
  const head = "text-right text-[10px] font-bold tracking-[0.06em] text-foreground/50 uppercase";
  return (
    <div data-testid="linked-emi-snapshot">
      <div className={cn(BOARD_COLS, "border-b border-border-strong/50 px-2 pb-1.5")} aria-hidden>
        <span className="text-[10px] font-bold tracking-[0.06em] text-foreground/50 uppercase">Agreement</span>
        <span className="text-[10px] font-bold tracking-[0.06em] text-foreground/50 uppercase">Progress</span>
        {RESPONSIBILITY_SEGMENTS.map((seg) => (
          <span key={seg.key} className={cn(head, "inline-flex items-center justify-end gap-1")}>
            <span className={cn("size-1.5 rounded-full", seg.dot)} />
            {seg.short}
          </span>
        ))}
        <span className={cn(head, "inline-flex items-center justify-end gap-1")}>
          <Landmark className="size-3" strokeWidth={2} />
          Bank
        </span>
      </div>
      <ul className="mt-0.5">
        {summaries.map((s, i) => (
          <BoardRow key={s.key} s={s} personName={personName} onOpen={onOpen} index={i} />
        ))}
      </ul>
      {untied && (
        <div className="mt-1.5 flex items-center gap-2 rounded-[10px] border border-dashed border-settle-receivable-edge/70 bg-settle-receivable-tint/45 px-2.5 py-1.5 text-[11.5px] text-foreground/80" data-testid="emi-board-general">
          <Layers className="size-3.5 shrink-0 text-settle-receivable-text" aria-hidden />
          <span className="min-w-0">
            <b className="font-semibold text-foreground tabular-nums">{money(untied.credit)}</b> received toward the overall balance — not linked to any installment, so it isn&apos;t in
            Repaid above.
          </span>
          <span className="ml-auto shrink-0 font-semibold text-foreground tabular-nums">{untied.owed < 0.005 ? "Nothing owed overall" : `${money(untied.owed)} still owed overall`}</span>
        </div>
      )}
      <p className="mt-1.5 px-2 text-[11px] text-foreground/50">
        <b className="font-semibold text-foreground/65">Bank</b> = installments paid to the lender. Paying the bank doesn&apos;t settle {first}&apos;s share — only their payments to you do.
      </p>
    </div>
  );
}

/** One agreement, compact: name + status, the responsibility bar, then only the amounts that hold something. */
function AgreementRow({ s, onOpen }: { s: PersonLinkedEmi; onOpen: () => void }) {
  const { allPastDuePostponed } = usePostponedFacts(s);
  const r = useResponsibility(s);
  const parts = RESPONSIBILITY_SEGMENTS.filter((seg) => r[seg.key] >= 0.005);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={`Open ${s.name} on the Linked EMIs tab`}
        className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-[5px] px-1.5 py-2 text-left outline-none transition-colors hover:bg-secondary/55 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 text-sm font-semibold wrap-anywhere text-foreground">{s.name}</span>
          {allPastDuePostponed ? <span className={POSTPONED_PILL}>Postponed</span> : s.status === "overdue" && <StatusPill status="overdue" />}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
          {parts.map((seg) => (
            <span key={seg.key} className="inline-flex items-center gap-1 text-muted-foreground">
              <span className={cn("size-1.5 shrink-0 rounded-full", seg.dot)} aria-hidden />
              {seg.short} <span className={cn("font-semibold", seg.text)}>{money(r[seg.key])}</span>
            </span>
          ))}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
          <span>{s.paidCount}/{s.installmentCount} shares repaid</span>
          <span className="inline-flex items-center gap-1.5"><Landmark className="size-3.5 shrink-0" aria-hidden /> Paid to lender {r.bankPaidCount}/{r.installmentCount}</span>
        </span>
        <ArrowRight className="ml-auto size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </button>
    </li>
  );
}

/**
 * The Overview's compact agreement list — one short block per linked agreement (name, status, bar, the non-zero
 * amounts). Same figures as the board (`personLinkedEmis` + live deferrals); the full board stays on the Linked EMIs tab.
 */
export function EmiAgreementList({ summaries, onOpen }: { summaries: PersonLinkedEmi[]; onOpen: (key: string | null) => void }) {
  if (summaries.length === 0) return null;
  const LIMIT = 3;
  const shown = summaries.slice(0, LIMIT);
  return (
    <div data-testid="linked-emi-snapshot">
      <ul className="divide-y divide-border-subtle">
        {shown.map((s) => (
          <AgreementRow key={s.key} s={s} onOpen={() => onOpen(s.key)} />
        ))}
      </ul>
      {summaries.length > LIMIT && (
        <button
          type="button"
          onClick={() => onOpen(null)}
          className="mt-0.5 rounded-[4px] text-[11.5px] font-semibold text-primary-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          View all {summaries.length} agreements
        </button>
      )}
    </div>
  );
}

/** Kept for callers of the earlier snapshot name. */
export function LinkedEmiSnapshot({ personName, summaries, onViewAll }: { personName: string; summaries: PersonLinkedEmi[]; onViewAll: () => void }) {
  return <EmiResponsibilityBoard personName={personName} summaries={summaries} onOpen={onViewAll} />;
}

/**
 * The person header's EMI column: owed now (the People engine's `emiReceivableOpen`), postponed (open shares moved to a
 * later cycle — part of owed, called out) and later (shares not yet due). Rendered inside the deferral provider.
 */
export function EmiHeaderColumn({ summaries, owedNow, fallbackLater }: { summaries: PersonLinkedEmi[]; owedNow: number; fallbackLater?: { label: string; amount: number } }) {
  const postponedOf = usePostponedLookup();
  const totals = summaries.reduce(
    (t, s) => {
      const r = emiResponsibility(s, (key) => postponedOf(key) != null);
      return { postponed: t.postponed + r.postponed, later: t.later + s.upcoming, overdue: t.overdue + s.overdueCount };
    },
    { postponed: 0, later: 0, overdue: 0 },
  );
  const later = summaries.length > 0 ? { label: "Due later", amount: totals.later } : fallbackLater ?? { label: "Upcoming", amount: 0 };
  const row = (label: React.ReactNode, value: number, tone: string, key: string) => (
    <div key={key} className="flex items-baseline gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("ml-auto text-right font-semibold", value >= 0.005 ? tone : "text-muted-foreground")}>{money(value)}</dd>
    </div>
  );
  return (
    <>
      <ColumnLabel className="flex-wrap" icon={<CalendarClock className="size-3" strokeWidth={2.25} aria-hidden />}>
        EMI shares
        {totals.overdue > 0 && <span className="rounded-full bg-expense/10 px-1.5 py-px text-[9.5px] tracking-normal whitespace-nowrap text-expense normal-case">{totals.overdue} overdue</span>}
      </ColumnLabel>
      <dl className="mt-2 space-y-1.5 text-[12.5px] tabular-nums">
        {row("Owed to you", owedNow, "text-settle-emi-text", "now")}
        {totals.postponed >= 0.005 && row("Of that, postponed", totals.postponed, "text-primary-accent-text", "pp")}
        {row(later.label, later.amount, "text-foreground", "later")}
      </dl>
    </>
  );
}
