"use client";

import { CalendarClock, Check, ChevronDown, Clock, ExternalLink, Info, Landmark, Layers, TriangleAlert, Users } from "lucide-react";
import Link from "next/link";
import { useContext, useState } from "react";
import { DeferralContext } from "@/features/people/components/workspace/payment-deferral";
import type { GeneralCredit } from "@/features/people/lib/settlement-presentation";
import { cycleName } from "@/lib/engines/person-payment-deferral";
import type { LinkedEmiSource } from "@/features/people/hooks/use-person-cycle-statement";
import { ColumnLabel, Leader } from "@/features/people/components/cycle-statement/header-parts";
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
      aria-label={`${s.paidCount} of ${s.installmentCount} installments paid`}
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
  "inline-flex h-6 items-center gap-1 rounded-full border border-border-strong px-2.5 text-[11.5px] font-semibold text-foreground transition-colors hover:border-primary-accent-text hover:bg-primary/15 disabled:opacity-50";

function Figure({ label, value, tone, strong, sub, className, dot }: { label: string; value: React.ReactNode; tone?: string; strong?: boolean; sub?: React.ReactNode; className?: string; dot?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="flex items-center gap-1 text-[10px] font-semibold tracking-[0.06em] text-foreground/55 uppercase">
        {dot && <span className={cn("size-1.5 rounded-full", dot)} aria-hidden />}
        {label}
      </dt>
      <dd className={cn("truncate font-semibold text-foreground tabular-nums", strong ? "font-heading text-[19px] leading-tight font-bold" : "text-[13.5px] leading-snug", tone)}>{value}</dd>
      {sub && <dd className="truncate text-[10.5px] font-medium text-foreground/55 tabular-nums">{sub}</dd>}
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
  "inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-[11.5px] font-semibold text-foreground/65 outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/** Every installment as one pip, in order — paid · partly paid · overdue · pending · not yet due · postponed. Display only. */
function InstallmentPips({ s, postponedOf }: { s: PersonLinkedEmi; postponedOf: ReturnType<typeof usePostponedLookup> }) {
  const count = (st: LinkedEmiInstallmentStatus) => s.installments.filter((i) => i.status === st).length;
  const label = `Installments: ${count("paid")} paid, ${count("overdue")} overdue, ${count("upcoming") + count("pending")} still to come`;
  return (
    <span role="img" aria-label={label} className="flex min-w-0 flex-wrap justify-end gap-[3px]">
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

function LinkedEmiCard({ s, personName, source, saving, onToggle, index = 0 }: { s: PersonLinkedEmi; personName: string; source: LinkedEmiSource | undefined; saving: boolean; onToggle: () => void; index?: number }) {
  const [open, setOpen] = useState(false);
  const first = personName.split(" ")[0];
  const { postponedOf, amount: postponedAmount, allPastDuePostponed, firstMove } = usePostponedFacts(s);
  const line = settlementLine(s, first, allPastDuePostponed);
  const r = useResponsibility(s);
  const T = CARD_TONE[allPastDuePostponed ? "postponed" : s.remaining < 0.005 ? "ok" : s.overdueCount > 0 ? "overdue" : "due"];
  const StatusIcon = T.Icon;
  const movedTo = firstMove ? (firstMove.date ? shortDate(firstMove.date) : `${firstMove.name} cycle`) : null;
  const movedLine = movedTo && postponedAmount > 0.005 && !allPastDuePostponed ? `${money(postponedAmount)} moved to ${movedTo} · still owed` : null;
  return (
    <li
      className="group/card relative flex animate-in flex-col overflow-hidden rounded-[14px] bg-card text-xs ring-1 ring-border transition-[box-shadow,transform] duration-200 fade-in-0 fill-mode-both slide-in-from-bottom-1 hover:-translate-y-px hover:shadow-e2 motion-reduce:hover:translate-y-0"
      style={{ animationDelay: `${index * 40}ms` }}
      data-testid="linked-emi-card"
    >
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", T.edge)} />
      <div className="px-3.5 pt-3 pl-[17px]">
        {/* Identity — what it is, status; then their monthly share and the bank's side */}
        <div className="flex min-w-0 items-center gap-2">
          <EmiBadge />
          <span className="truncate font-heading text-[14px] font-semibold text-foreground">{s.name}</span>
          <span className="ml-auto">{allPastDuePostponed ? <span className={POSTPONED_PILL} title="The overdue share was postponed — it is still owed">Postponed</span> : <StatusPill status={s.status} />}</span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-foreground/60 tabular-nums">
          <p
            className="flex min-w-0 items-center gap-1 truncate"
            title={s.shared ? `Shared · ${personName}'s share ${money(s.monthlyShare)} of ${money(s.installmentAmount)}` : `${personName} repays you ${money(s.monthlyShare)} a month`}
          >
            <Users className="size-3 shrink-0" strokeWidth={1.75} />
            <span className="truncate">{s.shared ? `${first}'s share ${money(s.monthlyShare)}/mo of ${money(s.installmentAmount)}` : `${first} repays ${money(s.monthlyShare)}/mo`}</span>
          </p>
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium" title="Installments the bank has been paid — your side with the lender, not a payment from them">
            <Landmark className="size-3" strokeWidth={1.75} aria-hidden />
            Bank paid {r.bankPaidCount}/{r.installmentCount}
          </span>
        </div>

        {/* The money — due now leads in its own tile; paid and later beside it */}
        <dl className="mt-2.5 grid grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1fr)] items-stretch gap-2">
          <Figure className={cn("rounded-[10px] px-2.5 py-1.5", T.tile)} dot={T.edge} label="Due now" value={money(s.remaining)} tone={T.value} strong />
          <Figure className="flex flex-col justify-center pl-1" dot="bg-success" label="Paid" value={money(s.paid)} tone={s.paid > 0 ? "text-success" : undefined} />
          <Figure className="flex flex-col justify-center border-l border-border-strong/50 pl-2.5" dot="bg-foreground/30" label="Later" value={money(s.upcoming)} />
        </dl>

        {/* Responsibility bar — repaid · still owed · postponed · later */}
        <ResponsibilityBar s={s} r={r} thin className="mt-2.5" />

        {/* The one sentence that matters, and where the installments stand */}
        <div className="mt-2 flex items-center gap-2">
          <p className={cn("flex min-w-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-semibold tabular-nums", T.callout)} title={[line.text, movedLine ?? (allPastDuePostponed && movedTo ? `moved to ${movedTo}` : null)].filter(Boolean).join(" · ")}>
            <StatusIcon className="size-3 shrink-0" strokeWidth={2.25} aria-hidden />
            <span className="truncate">
              {line.text}
              {movedLine ? ` · ${movedLine}` : allPastDuePostponed && movedTo ? ` · moved to ${movedTo}` : ""}
            </span>
          </p>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-foreground/55 tabular-nums" title={s.nextDue ? `Next due ${shortDate(s.nextDue.dueDate)}` : undefined}>
            <b className="font-semibold text-foreground/85">
              {s.paidCount}/{s.installmentCount} paid
            </b>
            <span className="max-w-[7.5rem]">
              <InstallmentPips s={s} postponedOf={postponedOf} />
            </span>
          </span>
        </div>
      </div>

      {/* Footer — schedule disclosure + actions */}
      <div className="mt-2.5 flex items-center gap-1.5 border-t border-border-strong/50 px-2.5 py-1 pl-3">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          title="Monthly schedule"
          className="inline-flex h-6 items-center gap-1 rounded-full px-2 text-[11.5px] font-semibold text-foreground/75 outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDown className={cn("size-3.5 transition-transform duration-200", open && "rotate-180")} strokeWidth={2} />
          Schedule
        </button>
        <span className="ml-auto flex items-center gap-1">
          {source && (
            <button type="button" disabled={saving} onClick={onToggle} className={PILL_GHOST}>
              Stop counting
            </button>
          )}
          <Link href={linkedEmiHref(s)} className={PILL_BTN}>
            <ExternalLink className="size-3" strokeWidth={1.75} />
            {s.sourceKind === "loan" ? "View loan" : "View EMI"}
          </Link>
        </span>
      </div>

      {open && (
        <ul className="max-h-60 divide-y divide-border-strong/40 overflow-y-auto border-t border-border-strong/50 px-4 py-1 pl-[19px] duration-200 animate-in fade-in-0 slide-in-from-top-1" aria-label={`${s.name} monthly schedule`}>
          {s.installments.map((i) => {
            const moved = i.remaining > 0.005 ? postponedOf(i.key) : null;
            return (
              <li key={i.key} className="flex items-center gap-2 py-1.5">
                <span className={cn("size-1.5 shrink-0 rounded-full", moved ? "bg-primary-accent-text" : DOT_CLASS[i.status])} aria-hidden />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium text-foreground">
                    {monthLabel(i.dueDate)} · Installment {i.number}
                  </span>
                  <span className="truncate text-foreground/60">
                    Due {shortDate(i.dueDate)}
                    {i.paid > 0 && i.remaining > 0 ? ` · ${money(i.paid)} paid, ${money(i.remaining)} left` : ""}
                    {moved ? ` · moved to ${moved.date ? shortDate(moved.date) : `${moved.name} cycle`}` : ""}
                    {i.lenderStatus === "paid" ? " · bank paid" : ""}
                  </span>
                </span>
                <span className="shrink-0 font-semibold text-foreground tabular-nums">{money(i.amount)}</span>
                {moved ? <span className={POSTPONED_PILL}>Postponed</span> : <StatusPill status={i.status} />}
              </li>
            );
          })}
        </ul>
      )}
    </li>
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
export function LinkedEmisPanel({
  personName,
  summaries,
  sources,
  savingId,
  onToggle,
  generalCredit,
}: {
  personName: string;
  summaries: PersonLinkedEmi[];
  sources: LinkedEmiSource[];
  savingId: string | null;
  onToggle: (source: LinkedEmiSource) => void;
  /** Payments toward the overall balance no item carries — the cards' "Paid" never includes them, so say so. */
  generalCredit?: GeneralCredit | null;
}) {
  const sourceOf = (kind: "emi" | "loan", id: string) => sources.find((x) => x.kind === kind && x.id === id);
  const counted = new Set(summaries.map((s) => s.key));
  const notCounted = sources.filter((x) => !counted.has(`${x.kind}:${x.id}`));
  if (summaries.length === 0 && notCounted.length === 0) return null;
  const untied = generalCredit && generalCredit.theyOwe.credit >= 0.005 ? generalCredit.theyOwe : null;
  return (
    <div data-testid="linked-emis">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <h3 className="flex items-center gap-2 font-heading text-[15px] font-semibold text-foreground">
          Linked EMIs
          <span className="rounded-full bg-secondary px-2 py-px text-[11px] font-semibold text-foreground/70 tabular-nums">{summaries.length + notCounted.length}</span>
        </h3>
        <span
          tabIndex={0}
          role="note"
          aria-label="Paying the bank doesn't settle these — record what they pay you with Record payment."
          title="Paying the bank doesn't settle these — record what they pay you with Record payment."
          className="grid size-5 cursor-help place-items-center rounded-full text-foreground/45 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Info className="size-3.5" aria-hidden />
        </span>
        {untied && summaries.length > 0 && (
          <p
            className="ml-auto inline-flex min-w-0 items-center gap-1.5 rounded-full bg-settle-receivable-tint/70 px-2.5 py-1 text-[11.5px] leading-snug text-foreground/75 ring-1 ring-settle-receivable-edge/25 ring-inset"
            data-testid="linked-emis-untied-note"
            title="Paid on each card counts only payments tied to an installment."
          >
            <Layers className="size-3 shrink-0 text-settle-receivable-text" aria-hidden />
            <span className="truncate">
              {personName} also paid <b className="font-semibold text-foreground tabular-nums">{money(untied.credit)}</b> toward the overall balance, not tied to an installment ·{" "}
              {untied.owed < 0.005 ? "nothing owed overall" : <><b className="font-semibold text-foreground tabular-nums">{money(untied.owed)}</b> still owed overall</>}
            </span>
          </p>
        )}
      </div>
      <ul className="mt-2.5 grid grid-cols-[repeat(auto-fill,minmax(21rem,1fr))] gap-2.5">
        {summaries.map((s, i) => {
          const src = sourceOf(s.sourceKind, s.sourceId);
          return <LinkedEmiCard key={s.key} index={i} s={s} personName={personName} source={src?.repays ? src : undefined} saving={src != null && savingId === src.id} onToggle={() => src && onToggle(src)} />;
        })}
        {notCounted.map((x) => (
          <li key={`${x.kind}:${x.id}`} className="flex items-center justify-between gap-3 rounded-[14px] border border-dashed border-border-strong bg-card px-3.5 py-3 text-xs">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <EmiBadge />
                <span className="truncate font-semibold text-foreground">{x.name}</span>
              </span>
              <span className="text-foreground/65">For them, not counted</span>
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
            <b className="font-semibold text-foreground tabular-nums">{money(untied.credit)}</b> received toward the overall balance — not assigned to any installment, so it isn&apos;t in
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
function AgreementRow({ s, personName, onOpen, index }: { s: PersonLinkedEmi; personName: string; onOpen: () => void; index: number }) {
  const { allPastDuePostponed } = usePostponedFacts(s);
  const r = useResponsibility(s);
  const line = settlementLine(s, personName.split(" ")[0], allPastDuePostponed);
  const parts = RESPONSIBILITY_SEGMENTS.filter((seg) => r[seg.key] >= 0.005);
  return (
    <li className="animate-in fade-in-0 fill-mode-both slide-in-from-bottom-1" style={{ animationDelay: `${index * 35}ms` }}>
      <button
        type="button"
        onClick={onOpen}
        title={`Open ${s.name} on the Linked EMIs tab`}
        className="flex w-full flex-col gap-1.5 rounded-[10px] px-2 py-2 text-left outline-none transition-colors hover:bg-secondary/70 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-foreground">{s.name}</span>
          {allPastDuePostponed ? <span className={POSTPONED_PILL}>Postponed</span> : s.status === "overdue" && <StatusPill status="overdue" />}
          <span className="ml-auto shrink-0 text-[11px] text-foreground/55 tabular-nums">
            {money(s.monthlyShare)}/mo · <span title="Installments the bank has been paid — your side with the lender">bank {r.bankPaidCount}/{r.installmentCount}</span>
          </span>
        </span>
        <ResponsibilityBar s={s} r={r} thin />
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] tabular-nums">
          {parts.map((seg) => (
            <span key={seg.key} className="inline-flex items-center gap-1 text-foreground/65">
              <span className={cn("size-1.5 rounded-full", seg.dot)} aria-hidden />
              {seg.short} <span className={cn("font-semibold", seg.text)}>{money(r[seg.key])}</span>
            </span>
          ))}
          <span className={cn("ml-auto text-[11px] font-semibold", line.tone)}>
            {s.paidCount}/{s.installmentCount} paid
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * The Overview's compact agreement list — one short block per linked agreement (name, status, bar, the non-zero
 * amounts). Same figures as the board (`personLinkedEmis` + live deferrals); the full board stays on the Linked EMIs tab.
 */
export function EmiAgreementList({ personName, summaries, onOpen }: { personName: string; summaries: PersonLinkedEmi[]; onOpen: () => void }) {
  if (summaries.length === 0) return null;
  const first = personName.split(" ")[0];
  return (
    <div data-testid="linked-emi-snapshot">
      <ul className="-mx-2 divide-y divide-border-strong/40">
        {summaries.map((s, i) => (
          <AgreementRow key={s.key} s={s} personName={personName} onOpen={onOpen} index={i} />
        ))}
      </ul>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10.5px] text-foreground/50">
        {RESPONSIBILITY_SEGMENTS.map((seg) => (
          <span key={seg.key} className="inline-flex items-center gap-1">
            <span className={cn("size-1.5 rounded-full", seg.dot)} aria-hidden />
            {seg.short}
          </span>
        ))}
        <span>· Bank = lender installments paid; it doesn&apos;t settle {first}&apos;s share. Payments toward the overall balance aren&apos;t in Repaid.</span>
      </p>
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
  const later = summaries.length > 0 ? { label: "Later (not yet due)", amount: totals.later } : fallbackLater ?? { label: "Upcoming", amount: 0 };
  const row = (label: React.ReactNode, value: number, tone: string, key: string) => (
    <div key={key} className="flex items-baseline gap-2">
      <dt className="truncate text-foreground/75">{label}</dt>
      <Leader />
      <dd className={cn("shrink-0 font-semibold", value >= 0.005 ? tone : "text-foreground/45")}>{money(value)}</dd>
    </div>
  );
  return (
    <>
      <ColumnLabel icon={<CalendarClock className="size-3" strokeWidth={2.25} aria-hidden />}>
        EMI shares
        {totals.overdue > 0 && <span className="rounded-full bg-expense/10 px-1.5 py-px text-[9.5px] tracking-normal text-expense normal-case">{totals.overdue} overdue</span>}
      </ColumnLabel>
      <dl className="mt-2 space-y-1.5 text-[12.5px] tabular-nums">
        {row("Owed to you now", owedNow, "text-settle-emi-text", "now")}
        {totals.postponed >= 0.005 && row(<span className="inline-flex items-center gap-1"><CalendarClock className="size-3 text-primary-accent-text" aria-hidden />Postponed · still owed</span>, totals.postponed, "text-primary-accent-text", "pp")}
        {row(later.label, later.amount, "text-foreground", "later")}
      </dl>
    </>
  );
}
