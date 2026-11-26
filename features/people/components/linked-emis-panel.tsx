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
import { TD, TH } from "@/features/people/components/money-in-out-list";
import type { LinkedEmiInstallmentStatus, LinkedEmiStatus, PersonLinkedEmi } from "@/lib/engines/person-linked-emis";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { emiResponsibility, RESPONSIBILITY_SEGMENTS, type EmiResponsibility } from "@/features/people/lib/emi-responsibility";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";
import { RepaymentLinkLockedError } from "@/lib/repositories/repayment-link-guard";

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

const shortDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

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
  const allPastDuePostponed = s.status === "overdue" && pastDue.length > 0 && pastDue.every((i) => postponedOf(i.key) != null);
  return { postponedOf, allPastDuePostponed };
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

function ShareAmounts({ total, paid, remaining, className }: { total: number; paid: number; remaining: number; className?: string }) {
  return (
    <span className={cn("grid grid-cols-3 gap-x-3 text-xs tabular-nums", className)}>
      <span className="flex min-w-0 flex-col text-muted-foreground">Share total
        <span className="font-semibold break-words text-foreground">{money(total)}</span>
      </span>
      <span className="flex min-w-0 flex-col text-muted-foreground">Paid toward share
        <span className={cn("font-semibold break-words", paid >= 0.005 && "text-success")}>{paid >= 0.005 ? "+" : ""}{money(paid)}</span>
      </span>
      <span className="flex min-w-0 flex-col text-muted-foreground">Remaining balance
        <span className={cn("font-semibold break-words", remaining >= 0.005 && "text-expense")}>{remaining >= 0.005 ? "−" : ""}{money(remaining)}</span>
      </span>
    </span>
  );
}

function BalanceTiming({ responsibility: r }: { responsibility: EmiResponsibility }) {
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
      <span>Due now <strong className={cn("font-semibold", r.owed >= 0.005 && "text-expense")}>{money(r.owed)}</strong></span>
      {r.postponed >= 0.005 && <span>Postponed <strong className="font-semibold text-primary-accent-text">{money(r.postponed)}</strong></span>}
      {r.later >= 0.005 && <span>Due later <strong className="font-semibold text-foreground">{money(r.later)}</strong></span>}
    </span>
  );
}

/** Shared tones for the card edge and status callout. */
const CARD_TONE = {
  overdue: { edge: "bg-expense", callout: "bg-expense/[0.08] text-expense", Icon: TriangleAlert },
  postponed: { edge: "bg-primary-accent-text", callout: "bg-primary/10 text-primary-accent-text", Icon: CalendarClock },
  ok: { edge: "bg-success", callout: "bg-success/[0.08] text-success", Icon: Check },
  due: { edge: "bg-settle-emi-edge", callout: "bg-settle-emi-tint text-settle-emi-text", Icon: Clock },
} as const;

const PILL_GHOST =
  "inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

function LinkedEmiCard({ s, personName, source, saving, onToggle }: { s: PersonLinkedEmi; personName: string; source: LinkedEmiSource | undefined; saving: boolean; onToggle: () => void }) {
  const [open, setOpen] = useState(false);
  // Short schedules open in full. Longer schedules start with a preview of open shares.
  const [scheduleAll, setScheduleAll] = useState(false);
  const unpaidRows = s.installments.filter((i) => i.remaining > 0.005);
  const scheduleRows = scheduleAll || s.installments.length <= 6 ? s.installments : (unpaidRows.length > 0 ? unpaidRows : s.installments.slice(-3)).slice(0, 6);
  const hiddenCount = s.installments.length - scheduleRows.length;
  const first = personName.split(" ")[0];
  const { postponedOf, allPastDuePostponed } = usePostponedFacts(s);
  const r = useResponsibility(s);
  const T = CARD_TONE[r.owed < 0.005 ? r.postponed >= 0.005 ? "postponed" : "ok" : r.overdueCount > 0 ? "overdue" : "due"];
  const StatusIcon = T.Icon;
  const nextDue = s.installments.find((i) => i.remaining > 0.005 && postponedOf(i.key) == null);
  const amountLabel = s.shared ? "EMI share" : "EMI";
  const scheduleCell = cn(TD, "@max-[42rem]:block @max-[42rem]:border-0 @max-[42rem]:p-0");
  const scheduleNumber = cn(scheduleCell, "text-right text-[13px] font-semibold tabular-nums @max-[42rem]:row-start-2 @max-[42rem]:text-left");
  const mobileLabel = "block text-[11px] font-medium text-muted-foreground @min-[42rem]:hidden";
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
          <div className="space-y-2 rounded-lg bg-secondary/35 p-2.5 @min-[42rem]:bg-transparent @min-[42rem]:py-0 @min-[42rem]:pl-0">
            <ShareAmounts total={r.total} paid={r.repaid} remaining={s.remaining + s.upcoming} />
            <BalanceTiming responsibility={r} />
          </div>
          <div className="flex min-w-0 flex-col gap-2 rounded-[8px] border border-border bg-secondary/20 p-2.5 @min-[42rem]:gap-1 @min-[42rem]:rounded-none @min-[42rem]:border-0 @min-[42rem]:border-l @min-[42rem]:border-border-subtle @min-[42rem]:bg-transparent @min-[42rem]:p-0 @min-[42rem]:pl-3">
            <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs font-medium text-muted-foreground tabular-nums">
              <span className="inline-flex items-center gap-1.5"><Users className="size-3.5" aria-hidden /> {s.paidCount}/{s.installmentCount} shares repaid to you</span>
              <span className="inline-flex items-center gap-1.5"><Landmark className="size-3.5" aria-hidden /> Paid to lender {r.bankPaidCount}/{r.installmentCount}</span>
            </div>
            <ResponsibilityBar s={s} r={r} className="@min-[42rem]:h-1.5" />
            {nextDue && <p className="text-xs text-muted-foreground tabular-nums">Oldest open share due {shortDate(nextDue.dueDate)}</p>}
          </div>
        </div>
      </div>

      <div className="@min-[42rem]:flex @min-[42rem]:items-center @min-[42rem]:justify-between @min-[42rem]:gap-2 @min-[42rem]:border-t @min-[42rem]:border-border @min-[42rem]:bg-secondary/30 @min-[42rem]:px-3 @min-[42rem]:py-1">
        <p className={cn("mx-3.5 my-3 flex min-w-0 items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold wrap-anywhere tabular-nums @min-[42rem]:m-0 @min-[42rem]:rounded-none @min-[42rem]:bg-transparent @min-[42rem]:p-0", T.callout)}>
          <StatusIcon className="mt-0.5 size-3.5 shrink-0" strokeWidth={2.25} aria-hidden />
          <span>{r.owed >= 0.005 ? `${first} owes ${money(r.owed)} now` : r.postponed >= 0.005 ? "Postponed shares are still owed" : r.later >= 0.005 ? "Up to date" : "Fully settled"}</span>
        </p>
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border bg-secondary/30 px-3 py-2 @min-[42rem]:shrink-0 @min-[42rem]:flex-nowrap @min-[42rem]:border-0 @min-[42rem]:bg-transparent @min-[42rem]:p-0">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
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
        <div className="border-t border-border">
          <table role="table" aria-label={`${s.name} monthly schedule`} className="w-full border-separate border-spacing-0 @max-[42rem]:block">
            <thead role="rowgroup" className="@max-[42rem]:sr-only">
              <tr role="row">
                <th role="columnheader" scope="col" className={TH}>Due date</th>
                <th role="columnheader" scope="col" className={cn(TH, "w-[7rem] text-right")}>{amountLabel}</th>
                <th role="columnheader" scope="col" className={cn(TH, "w-[7rem] text-right")}>Paid</th>
                <th role="columnheader" scope="col" className={cn(TH, "w-[7rem] text-right")}>Pending</th>
                <th role="columnheader" scope="col" className={cn(TH, "w-[14rem]")}>Status</th>
              </tr>
            </thead>
            <tbody role="rowgroup" className="@max-[42rem]:block @max-[42rem]:space-y-1.5 @max-[42rem]:p-2.5">
              {scheduleRows.map((i) => {
                const moved = i.remaining > 0.005 ? postponedOf(i.key) : null;
                return (
                  <tr key={i.key} role="row" className="hover:bg-secondary/40 @max-[42rem]:grid @max-[42rem]:grid-cols-3 @max-[42rem]:items-center @max-[42rem]:gap-1.5 @max-[42rem]:rounded-lg @max-[42rem]:border @max-[42rem]:border-border @max-[42rem]:p-2">
                    <td role="cell" className={cn(scheduleCell, "font-medium whitespace-nowrap text-foreground tabular-nums @max-[42rem]:col-start-1 @max-[42rem]:row-start-1")}>{shortDate(i.dueDate)}</td>
                    <td role="cell" className={cn(scheduleNumber, "text-foreground @max-[42rem]:col-start-1")}>
                      <span aria-hidden className={mobileLabel}>{amountLabel}</span>
                      {money(i.amount)}
                    </td>
                    <td role="cell" className={cn(scheduleNumber, "@max-[42rem]:col-start-2", i.paid > 0.005 ? "text-success" : "text-muted-foreground")}>
                      <span aria-hidden className={mobileLabel}>Paid</span>
                      {money(i.paid)}
                    </td>
                    <td role="cell" className={cn(scheduleNumber, "@max-[42rem]:col-start-3", i.remaining <= 0.005 ? "text-muted-foreground" : i.status === "overdue" && !moved ? "text-expense" : "text-foreground")}>
                      <span aria-hidden className={mobileLabel}>Pending</span>
                      {i.remaining > 0.005 ? money(i.remaining) : "—"}
                    </td>
                    <td role="cell" className={cn(scheduleCell, "@max-[42rem]:col-span-2 @max-[42rem]:col-start-2 @max-[42rem]:row-start-1")} data-testid="linked-emi-schedule-status">
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 @max-[42rem]:justify-end">
                        {moved ? (
                          <>
                            <span className={POSTPONED_PILL}>Postponed</span>
                            <span className="text-[11px] text-primary-accent-text">{moved.date ? shortDate(moved.date) : `${moved.name} cycle`}</span>
                          </>
                        ) : <StatusPill status={i.status} />}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {hiddenCount > 0 || scheduleAll ? (
            <button type="button" onClick={() => setScheduleAll((all) => !all)} className="mx-2.5 my-1 min-h-7 rounded px-1 text-[11.5px] font-semibold text-primary-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
              {scheduleAll ? "Show fewer" : `Show all ${s.installments.length} EMIs`}
            </button>
          ) : null}
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
    } catch (e) {
      // A refusal explains itself (who has repayments recorded); anything else keeps the short title.
      toast.error("Couldn't update the EMI", e instanceof RepaymentLinkLockedError ? e.message : undefined);
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
                        {item.summary && <span className="shrink-0 text-right text-xs text-muted-foreground tabular-nums"><span className="block font-semibold text-foreground">{money(item.summary.remaining + item.summary.upcoming)}</span>Share balance</span>}
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

/** One agreement's balance and timing in the Overview. */
function AgreementRow({ s, onOpen }: { s: PersonLinkedEmi; onOpen: () => void }) {
  const { allPastDuePostponed } = usePostponedFacts(s);
  const r = useResponsibility(s);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={`Open ${s.name} on the Linked EMIs tab`}
        className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-[5px] px-1.5 py-2 text-left outline-none transition-colors hover:bg-secondary/55 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 text-sm font-semibold wrap-anywhere text-foreground">{s.name}</span>
          {allPastDuePostponed ? <span className={POSTPONED_PILL}>Postponed</span> : s.status === "overdue" && <StatusPill status="overdue" />}
        </span>
        <ArrowRight className="mt-0.5 size-3.5 text-muted-foreground" aria-hidden />
        <ShareAmounts className="col-span-2 max-w-md" total={r.total} paid={r.repaid} remaining={s.remaining + s.upcoming} />
        <span className="col-span-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <BalanceTiming responsibility={r} />
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums"><Landmark className="size-3.5 shrink-0" aria-hidden /> Paid to lender {r.bankPaidCount}/{r.installmentCount}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * The Overview's compact agreement list uses the same share amounts and deferrals as the Linked EMIs tab.
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

export function EmiHeaderColumn({ summaries, includedInReceivable, totalReceivable, fallbackLater }: { summaries: PersonLinkedEmi[]; includedInReceivable: number; totalReceivable: number; fallbackLater?: { label: string; amount: number } }) {
  const postponedOf = usePostponedLookup();
  const totals = summaries.reduce(
    (t, s) => {
      const r = emiResponsibility(s, (key) => postponedOf(key) != null);
      return { postponed: t.postponed + r.postponed, later: t.later + r.later, overdue: t.overdue + r.overdueCount };
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
        {row("Included in To receive", includedInReceivable, "text-settle-emi-text", "included")}
        {row("People Ledger · To receive", totalReceivable, "text-foreground", "total")}
        {totals.postponed >= 0.005 && row("Postponed shares", totals.postponed, "text-primary-accent-text", "pp")}
        {row(later.label, later.amount, "text-foreground", "later")}
      </dl>
    </>
  );
}
