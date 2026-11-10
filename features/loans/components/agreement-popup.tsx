"use client";

import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { CheckCircle2, ChevronRight } from "lucide-react";
import { ClayBadge } from "@/components/clay/clay-badge";
import { StackBase } from "@/components/finance/stack-layer";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { AmountDisplay, InstallmentProgress, LE_RADIUS, Money, dueLabel, type DebtCardBadge } from "@/features/loans/components/loan-emi-ui";
import { cn } from "@/lib/utils";

/**
 * The details window shared by a Loan and an EMI. One fixed-size window (so it never grows the page), two zones:
 *
 *   SUMMARY RAIL (left, 21rem)  what is owed, progress, the next payment, the key facts and links, and — pinned at the
 *                               bottom — the actions: Record Payment, Record past payments, then Edit / Close / Delete;
 *   SCHEDULE (right)            Upcoming · All installments · History, each a scrolling list with Pay on every
 *                               installment still owed.
 *
 * A narrow window (a phone) cannot hold both, so it stacks them: the summary strip on top, the sections as tabs with
 * "Overview" (what the rail shows) as the first one, the actions pinned underneath. The same elements are used in both
 * arrangements — nothing is rendered twice.
 *
 * Every action opens as a step deeper in the same window (see `stack-layer.tsx`); this component only lays things out
 * and owns which section is showing. Mount it only while there is a record to show — a fresh mount starts on Overview.
 */

type PopupTab = "overview" | "upcoming" | "all" | "history";

const TAB_LABEL: Record<PopupTab, string> = { overview: "Overview", upcoming: "Upcoming installments", all: "All installments", history: "Payment history" };

/** The window is "wide" (rail beside the schedule) from this width, measured on the window itself. */
const WIDE_AT = 720;

/** Where the footer's actions are drawn: stacked in the rail, or as one pinned bar. */
const FooterLayout = createContext<"rail" | "bar">("bar");

/** The "next installment" / "fully paid" card under the progress bar. */
export function NextStrip({ next, total, overdue }: { next: { dueDate: Date; amount: number; sequenceNumber: number } | null; total: number; overdue: boolean }) {
  if (!next) {
    return (
      <div className={cn(LE_RADIUS.card, "flex items-center gap-2 bg-success/10 px-3 py-2.5")}>
        <CheckCircle2 className="size-4 shrink-0 text-success" strokeWidth={1.75} />
        <span className="text-sm font-semibold text-foreground">Fully paid</span>
        <span className="truncate text-xs text-muted-foreground">Every installment is settled.</span>
      </div>
    );
  }
  return (
    <div className={cn(LE_RADIUS.card, "flex flex-col gap-1 border px-3 py-2.5", overdue ? "border-expense/30 bg-expense/8" : "border-border bg-card")}>
      <div className="flex items-center justify-between gap-2 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
        <span>Next payment</span>
        <span className="tabular-nums">
          #{next.sequenceNumber} of {total}
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span className={cn("min-w-0 truncate text-sm font-semibold", overdue ? "text-expense" : "text-foreground")}>{dueLabel(next.dueDate)}</span>
        <Money amount={next.amount} className="shrink-0 text-lg text-foreground" />
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{children}</h3>;
}

export function AgreementPopup({
  open,
  onOpenChange,
  eyebrow,
  title,
  subtitle,
  badges,
  outstandingLabel,
  outstanding,
  paid,
  total,
  partial,
  strip,
  comingUp,
  details,
  detailsTitle,
  upcoming,
  all,
  allLabel = "All",
  history,
  upcomingCount,
  allCount,
  historyCount,
  footer,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "Loan" / "EMI". */
  eyebrow: string;
  title: string;
  subtitle: string;
  badges: DebtCardBadge[];
  outstandingLabel: string;
  outstanding: number;
  paid: number;
  total: number;
  partial: number;
  /** Usually a `NextStrip`. Omitted for a closed record. */
  strip?: ReactNode;
  /** The first few installments still owed (the narrow window's Overview). Omitted when nothing is left to pay. */
  comingUp?: ReactNode;
  details: ReactNode;
  /** "Loan details" / "EMI details". */
  detailsTitle: string;
  upcoming: ReactNode;
  all: ReactNode;
  /** The complete schedule's tab name — "All EMIs", "Schedule". */
  allLabel?: string;
  history: ReactNode;
  upcomingCount: number;
  allCount: number;
  historyCount: number;
  footer: ReactNode;
  testId?: string;
}) {
  const [tab, setTab] = useState<PopupTab>("overview");
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    if (!box) return;
    const measure = () => setWide(box.clientWidth >= WIDE_AT);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [box]);

  // With the rail beside it the summary is always in view, so "Overview" is not a tab there: show the first section.
  const shown: PopupTab = wide && tab === "overview" ? (upcomingCount > 0 ? "upcoming" : "all") : tab;
  const tabs: { value: PopupTab; label: string; count?: number }[] = [
    ...(wide ? [] : [{ value: "overview" as const, label: "Overview" }]),
    { value: "upcoming", label: "Upcoming", count: upcomingCount },
    { value: "all", label: allLabel, count: allCount },
    { value: "history", label: "History", count: historyCount },
  ];

  return (
    <StackBase
      open={open}
      onOpenChange={onOpenChange}
      testId={testId}
      header={
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[10.5px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">{eyebrow}</span>
          <DialogTitle className="truncate font-heading text-lg leading-tight font-semibold">{title}</DialogTitle>
          <DialogDescription className="truncate text-xs text-muted-foreground">{subtitle}</DialogDescription>
        </div>
      }
    >
      <FooterLayout.Provider value={wide ? "rail" : "bar"}>
        <div ref={setBox} className={cn("min-h-0 flex-1 overflow-hidden", wide ? "grid grid-cols-[21rem_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]" : "flex flex-col")}>
          {/* Summary rail — `contents` in the narrow window, so its pieces join the single column in the order set below. */}
          <aside aria-label="Summary" className={wide ? "flex min-h-0 flex-col border-r border-border bg-secondary/35" : "contents"}>
            <div className={cn("flex shrink-0 flex-col gap-3 border-b border-border px-4 py-3.5", !wide && "order-1")}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">{outstandingLabel}</span>
                  <AmountDisplay amount={outstanding} size={wide ? "lg" : "md"} />
                </div>
                {badges.length > 0 && (
                  <div className="flex flex-wrap justify-end gap-1">
                    {badges.map((b) => (
                      <ClayBadge key={b.label} tone={b.tone} className="rounded-[5px] font-semibold">
                        {b.label}
                      </ClayBadge>
                    ))}
                  </div>
                )}
              </div>
              {total > 0 && <InstallmentProgress paid={paid} total={total} partial={partial} />}
              {strip}
            </div>

            <div
              role={wide ? undefined : "tabpanel"}
              aria-label={wide ? undefined : TAB_LABEL.overview}
              className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4", !wide && "order-3", !wide && shown !== "overview" && "hidden")}
            >
              <div className="flex flex-col gap-5">
                {!wide && comingUp && (
                  <section aria-label="Coming up" className="@container flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <SectionLabel>Coming up</SectionLabel>
                      {upcomingCount > 0 && (
                        <button
                          type="button"
                          onClick={() => setTab("upcoming")}
                          className="inline-flex items-center gap-0.5 rounded-[6px] px-1 text-xs font-semibold text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          See all {upcomingCount}
                          <ChevronRight className="size-3.5" strokeWidth={2} />
                        </button>
                      )}
                    </div>
                    {comingUp}
                  </section>
                )}
                <section aria-label={detailsTitle} className="flex flex-col gap-4">
                  <SectionLabel>{detailsTitle}</SectionLabel>
                  {details}
                </section>
              </div>
            </div>

            <div className={cn("shrink-0 border-t border-border bg-secondary/40", !wide && "order-4")}>{footer}</div>
          </aside>

          {/* The schedule — sections as tabs. */}
          <section aria-label="Schedule" className={wide ? "flex min-h-0 flex-col" : "contents"}>
            <div role="tablist" aria-label="Sections" className={cn("flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-card px-3", !wide && "order-2 pt-1")}>
              {tabs.map(({ value, label, count }) => {
                const active = value === shown;
                return (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setTab(value)}
                    className={cn(
                      "relative inline-flex h-11 shrink-0 items-center gap-1.5 px-2.5 text-[13px] whitespace-nowrap outline-none transition-colors duration-150 focus-visible:rounded-[6px] focus-visible:ring-2 focus-visible:ring-ring",
                      active ? "font-semibold text-foreground" : "font-medium text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {label}
                    {count != null && (
                      <span className={cn("grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px] tabular-nums", active ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground")}>{count}</span>
                    )}
                    <span aria-hidden className={cn("absolute inset-x-2 bottom-0 h-0.5 rounded-full transition-opacity duration-150", active ? "bg-foreground opacity-100" : "opacity-0")} />
                  </button>
                );
              })}
            </div>
            <div
              role="tabpanel"
              aria-label={shown === "all" ? `${allLabel} installments` : TAB_LABEL[shown]}
              className={cn("@container min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4", !wide && "order-3", !wide && shown === "overview" && "hidden")}
            >
              {shown === "upcoming" ? upcoming : shown === "all" ? all : shown === "history" ? history : null}
            </div>
          </section>
        </div>
      </FooterLayout.Provider>
    </StackBase>
  );
}

/**
 * The window's actions. In the rail: Record Payment on top, the quieter money action under it (each full width), then
 * the record management under a rule. In the narrow window: one pinned bar. `money` lists the quieter action first and
 * the primary one last; the layout decides the order and widths, so the buttons carry no width classes of their own.
 */
export function AgreementFooter({ note, money, manage }: { note?: string; money: ReactNode; manage: ReactNode }) {
  const rail = useContext(FooterLayout) === "rail";
  return (
    <div className="flex flex-col">
      {note && <p className="px-4 pt-3 text-xs text-muted-foreground">{note}</p>}
      <div className={cn("px-4 py-3", rail ? "flex flex-col-reverse gap-2 [&>*]:w-full" : "flex flex-wrap gap-2 [&>*]:min-w-[9rem] [&>*]:flex-1 [&>*:last-child]:flex-[1.5]")}>{money}</div>
      <div className="flex flex-wrap items-center gap-0.5 border-t border-border px-2.5 py-1 [&_button]:h-8">{manage}</div>
    </div>
  );
}
