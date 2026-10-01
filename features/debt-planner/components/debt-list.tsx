"use client";

import { AlertTriangle, ArrowRight, ArrowUpRight, ChevronRight, Clock, CreditCard, Crosshair, Info, Landmark, ShoppingBag, User, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { dueLabel, formatDueDate } from "@/features/loans/components/loan-emi-ui";
import { interestLabel, type DebtInterest, type DebtPosition, type DebtSourceType } from "@/lib/engines/debt-position";
import type { PayoffPlan, PayoffStrategy } from "@/lib/engines/debt-payoff";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CATEGORY_SWATCH } from "./debt-overview";
import type { DebtView } from "./ownership-overview";
import { splitPaymentByOwnership } from "@/lib/engines/debt-ownership";
import { Breakdown, Chip, Label, Money, Section } from "./planner-ui";

const SOURCE_ICON: Record<DebtSourceType, LucideIcon> = {
  creditCard: CreditCard,
  loan: Landmark,
  emi: ShoppingBag,
  person: User,
};

/**
 * Where this debt's real payment flow lives. The planner never records a payment itself — a future
 * "Make payment" action routes here, to the existing Loan / EMI / card bill / People settlement flows.
 */
export function paymentHref(p: DebtPosition): { href: string; label: string } {
  switch (p.sourceType) {
    case "loan":
      return { href: `/loans?agreement=${encodeURIComponent(p.sourceId)}`, label: "Open loan" };
    case "emi":
      return { href: `/emi?agreement=${encodeURIComponent(p.sourceId)}`, label: "Open EMI" };
    case "creditCard":
      return { href: "/credit-cards", label: "Open card" };
    case "person":
      return { href: `/people?person=${encodeURIComponent(p.sourceId)}`, label: "Open ledger" };
  }
}

/**
 * The order the engine actually sent money above required payments in the simulated plan — the
 * selected strategy's order as the engine applied it. Nothing is re-ranked here.
 */
export function focusOrder(plan: PayoffPlan): string[] {
  const seen: string[] = [];
  for (const m of plan.months) for (const l of m.lines) if ((l.kind === "extra" || l.kind === "lumpSum") && !seen.includes(l.debtId)) seen.push(l.debtId);
  return seen;
}

/** Beginner wording for the rate cell; the engine's precise label stays in the row detail. */
function rateText(i: DebtInterest): { text: string; missing: boolean } {
  if (i.kind === "none") return { text: "No interest", missing: false };
  if (i.kind === "unknown") return i.statedRatePercent != null ? { text: `${i.statedRatePercent}% stated`, missing: true } : { text: "Rate not available", missing: true };
  return { text: interestLabel(i), missing: false };
}

function payoffText(p: DebtPosition, plan: PayoffPlan): { text: string; tone: "success" | "muted" | "expense" } {
  if (p.excludedFromPlan) return { text: "Not projected", tone: "muted" };
  const outcome = plan.outcomes[p.id];
  if (outcome?.finishLabel) return { text: outcome.finishLabel, tone: "success" };
  if (plan.status === "shortfall") return { text: "Budget needed", tone: "expense" };
  return { text: "No date yet", tone: "muted" };
}

function NextPayment({ p }: { p: DebtPosition }) {
  if (p.overdueAmount > 0 && p.oldestOverdueDate) {
    return (
      <div className="flex flex-col items-start gap-0.5">
        <span className="inline-flex items-center gap-1 text-[13px] font-bold text-expense tabular-nums">
          <AlertTriangle className="size-3.5" strokeWidth={2.25} />
          {formatCurrency(p.overdueAmount)} overdue
        </span>
        <span className="text-xs text-foreground/80">{dueLabel(p.oldestOverdueDate)}</span>
      </div>
    );
  }
  if (p.nextDueDate && p.nextDueAmount != null) {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] font-bold text-foreground tabular-nums">{formatCurrency(p.nextDueAmount)}</span>
        <span className="inline-flex items-center gap-1 text-xs text-foreground/80">
          <Clock className="size-3" />
          {dueLabel(p.nextDueDate)}
        </span>
      </div>
    );
  }
  return <span className="text-xs font-medium text-foreground/80">{p.excludedFromPlan ? "Not scheduled" : "No fixed schedule"}</span>;
}

function Progress({ p }: { p: DebtPosition }) {
  if (p.originalPrincipal == null || p.originalPrincipal <= 0) return null;
  const paid = Math.max(p.originalPrincipal - p.outstanding, 0);
  const percent = Math.min(100, Math.round((paid / p.originalPrincipal) * 100));
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-[2px] bg-secondary ring-1 ring-border" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={`${percent}% of principal repaid`}>
        <div className="h-full bg-success" style={{ width: `${percent}%` }} />
      </div>
      <span className="text-xs font-medium text-foreground/80 tabular-nums">{percent}% paid</span>
    </div>
  );
}

/** Who the outstanding belongs to — shown only when some of it is someone else's. */
function OwnershipBreakdown({ p, required }: { p: DebtPosition; required: number }) {
  const o = p.ownership;
  if (o.othersTotal <= 0) return null;
  const reqOthers = splitPaymentByOwnership(required, o).others;
  return (
    <div className="flex flex-col gap-1.5 border-l-[3px] border-purple pl-3">
      <Label>Whose share</Label>
      <Breakdown
        rows={[
          { label: "My share", amount: o.mine },
          ...o.others.map((x) => ({ label: `${x.name}'s share`, amount: x.amount })),
        ]}
        total={{ label: "Total outstanding", amount: o.total }}
      />
      <p className="text-xs text-foreground/80">
        <strong className="tabular-nums text-foreground">{formatCurrency(o.othersTotal)}</strong> of this is allocated to others — their ownership of the
        debt, not necessarily what they still owe you (see People).
        {required > 0 && (
          <>
            {" "}This cycle the lender still expects {formatCurrency(required)} from you — about {formatCurrency(reqOthers)} of it is others&apos; share
            {p.sourceType === "creditCard" ? " (estimated from the card's overall split)" : ""}.
          </>
        )}
      </p>
    </div>
  );
}

function DebtDetail({ p, plan, required, now }: { p: DebtPosition; plan: PayoffPlan; required: number; now: Date }) {
  const outcome = plan.outcomes[p.id];
  const next = p.schedule.slice(0, 4);
  const action = paymentHref(p);
  return (
    <div className="grid gap-5 border-t border-border bg-secondary/40 px-4 py-4 animate-in duration-200 fade-in-0 sm:px-5 lg:grid-cols-3">
      <div className="flex flex-col gap-1.5">
        <Label>Balance</Label>
        <Breakdown
          rows={[
            ...(p.originalPrincipal != null ? [{ label: "Original", amount: p.originalPrincipal }] : []),
            ...p.components.map((c) => ({ label: c.label, note: c.note, amount: c.amount })),
          ]}
        />
        <OwnershipBreakdown p={p} required={required} />
        {p.card && (
          <Breakdown
            rows={[
              { label: "Statement due", amount: p.card.statementDue },
              ...(p.card.minimumDue != null ? [{ label: "Minimum due", amount: p.card.minimumDue }] : []),
              { label: "Available credit", note: `${Math.round(p.card.utilizationPercent)}% used`, amount: p.card.available },
            ]}
          />
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Next payments</Label>
        {next.length === 0 ? (
          <p className="text-[13px] text-foreground/80">No scheduled payments. Paid only from extra budget.</p>
        ) : (
          <Breakdown rows={next.map((s) => ({ label: formatDueDate(s.dueDate), note: s.label, amount: s.amount, tone: s.dueDate.getTime() < now.getTime() ? ("expense" as const) : undefined }))} />
        )}
        {p.totalInstallments != null && p.installmentsPaid != null && (
          <p className="text-xs text-foreground/80">
            {p.installmentsPaid} of {p.totalInstallments} installments paid · {p.schedule.filter((s) => s.kind === "installment").length} remaining
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>In your plan</Label>
        <Breakdown
          rows={[
            { label: "Required this cycle", amount: required },
            ...(outcome ? [{ label: "Interest in plan", note: outcome.interestKnown ? "from schedule" : "card interest not modeled", amount: outcome.interestPaid }] : []),
          ]}
        />
        <p className="text-[13px] text-foreground">
          Rate: <span className="font-medium">{interestLabel(p.interest)}</span>
        </p>
        <p className="text-[13px] text-foreground">
          {p.excludedFromPlan
            ? `Not projected: ${p.excludedFromPlan}.`
            : outcome?.finishLabel
              ? `Projected to finish ${outcome.finishLabel}.`
              : "No finish date at this budget."}
          {outcome?.approximate && " (re-plan approximated)"}
        </p>
        {p.warnings.map((w, i) => (
          <p key={i} className="text-xs text-foreground/80">
            {w.message}
          </p>
        ))}
        <Link
          href={action.href}
          className="mt-1 inline-flex h-8 w-fit items-center gap-1.5 rounded-[6px] border border-border-strong bg-card px-3 text-[13px] font-semibold text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
        >
          {action.label}
          <ArrowUpRight className="size-3.5" />
        </Link>
      </div>
    </div>
  );
}

const COLS = "lg:grid-cols-[2.25rem_minmax(0,2fr)_minmax(0,1.15fr)_minmax(0,1.1fr)_minmax(0,1.15fr)_minmax(0,0.95fr)_1.25rem]";
const CELL = "lg:border-l lg:border-border lg:pl-3";

/** The debt register — one aligned row per debt, a structured table on desktop and stacked rows on mobile. */
export function DebtList({
  positions: allPositions,
  plan,
  requiredByDebt,
  now,
  focusId,
  view = "all",
}: {
  positions: DebtPosition[];
  plan: PayoffPlan;
  requiredByDebt: Record<string, number>;
  now: Date;
  focusId?: string | null;
  /** Ownership view: which amount leads each row. Rows are never hidden except in "Others' share". */
  view?: DebtView;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const positions = view === "others" ? allPositions.filter((p) => p.ownership.othersTotal > 0) : allPositions;
  const lead = (p: DebtPosition) => (view === "mine" ? p.ownership.mine : view === "others" ? p.ownership.othersTotal : p.outstanding);
  return (
    <Section id="dp-debts" title="Your debts" hint="Each debt once, from the record that owns it. Open a row for details." aside={<span className="text-xs font-semibold text-foreground/80">{positions.length} {positions.length === 1 ? "debt" : "debts"}</span>}>
      <div className="overflow-hidden rounded-b-[8px] border-x border-b border-border bg-card">
        <div className={cn("hidden gap-3 border-b border-border bg-secondary/60 px-4 py-2 lg:grid", COLS)}>
          {["#", "Debt", view === "mine" ? "My share" : view === "others" ? "Others' share" : "Still to pay", "Next payment", "Interest rate", "Payoff", ""].map((h, i) => (
            <Label key={i} className={i > 1 && h ? CELL : undefined}>
              {h}
            </Label>
          ))}
        </div>
        <ul>
          {positions.map((p, index) => {
            const Icon = SOURCE_ICON[p.sourceType];
            const isOpen = open === p.id;
            const rate = rateText(p.interest);
            const payoff = payoffText(p, plan);
            const isFocus = focusId === p.id;
            return (
              <li key={p.id} className="border-b border-border last:border-b-0">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : p.id)}
                  className={cn(
                    "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2.5 px-4 py-3 text-left outline-none transition-colors hover:bg-secondary/60 focus-visible:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset lg:py-2.5",
                    COLS,
                    isOpen && "bg-secondary/50",
                  )}
                >
                  <span className="hidden text-[13px] font-bold text-foreground/80 tabular-nums lg:block">{String(index + 1).padStart(2, "0")}</span>
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="relative flex size-8 shrink-0 items-center justify-center rounded-[6px] border border-border-strong bg-background">
                      <Icon className="size-4 text-foreground" strokeWidth={1.75} />
                      <span className={cn("absolute -bottom-px left-1 right-1 h-[3px] rounded-t-[2px]", CATEGORY_SWATCH[p.category])} aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 truncate text-[14px] font-bold text-foreground">
                        <span className="truncate">{p.name}</span>
                        {isFocus && (
                          <Chip tone="primary" icon={Crosshair} className="h-5 px-1.5 text-[10.5px]">
                            Focus
                          </Chip>
                        )}
                      </p>
                      <p className="truncate text-xs text-foreground/80">
                        {p.kindLabel}
                        {p.lenderName && p.lenderName !== p.name ? ` · ${p.lenderName}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className={cn("flex flex-col items-end gap-1 lg:items-start", CELL)}>
                    <Money amount={lead(p)} className="text-[16px] text-foreground" />
                    {p.ownership.othersTotal > 0 && (
                      <span className="border-l-2 border-purple pl-1.5 text-xs font-medium text-foreground/85 tabular-nums">
                        {view === "all" ? `Mine ${formatCurrency(p.ownership.mine)} · others ${formatCurrency(p.ownership.othersTotal)}` : `of ${formatCurrency(p.outstanding)} total`}
                      </span>
                    )}
                    <Progress p={p} />
                  </div>
                  <div className={cn("col-span-2 grid grid-cols-3 gap-3 border-t border-border/80 pt-2.5 lg:contents")}>
                    <div className={cn("min-w-0", CELL)}>
                      <Label className="mb-0.5 block lg:hidden">Next payment</Label>
                      <NextPayment p={p} />
                    </div>
                    <div className={cn("min-w-0 text-[13px]", CELL)}>
                      <Label className="mb-0.5 block lg:hidden">Rate</Label>
                      <span className={cn("inline-flex items-center gap-1 font-medium", rate.missing ? "text-foreground" : "text-foreground")}>
                        {rate.missing && <Info className="size-3.5 shrink-0 text-warning-foreground dark:text-warning" strokeWidth={2.25} />}
                        {rate.text}
                      </span>
                    </div>
                    <div className={cn("min-w-0 text-[13px] font-semibold", CELL)}>
                      <Label className="mb-0.5 block lg:hidden">Payoff</Label>
                      <span className={cn(payoff.tone === "success" ? "text-success" : payoff.tone === "expense" ? "text-expense" : "text-foreground/80")}>{payoff.text}</span>
                    </div>
                  </div>
                  <ChevronRight className={cn("hidden size-4 text-foreground/80 transition-transform duration-200 lg:block", isOpen && "rotate-90")} />
                </button>
                {isOpen && <DebtDetail p={p} plan={plan} required={requiredByDebt[p.id] ?? 0} now={now} />}
              </li>
            );
          })}
        </ul>
      </div>
    </Section>
  );
}

const STRATEGY_FIRST: Record<PayoffStrategy, string> = {
  avalanche: "First under Highest interest",
  snowball: "First under Lowest balance",
  duePriority: "First under Due date",
  custom: "First in your custom order",
};

/**
 * Next to focus — the first debt the engine sends extra money to under the selected strategy. Worded as
 * the strategy's result, never as advice. When no money reaches past required payments, say why.
 */
export function NextFocus({ plan, positions, strategy, requiredByDebt }: { plan: PayoffPlan; positions: DebtPosition[]; strategy: PayoffStrategy; requiredByDebt: Record<string, number> }) {
  const byId = new Map(positions.map((p) => [p.id, p]));
  const order = focusOrder(plan).filter((id) => byId.has(id));
  const first = order[0] ? byId.get(order[0])! : null;

  return (
    <section aria-labelledby="dp-focus" className="flex flex-col gap-2.5">
      <h2 id="dp-focus" className="text-[12px] font-bold tracking-[0.08em] text-foreground uppercase">
        Next to focus
      </h2>
      {first ? (
        <div className="flex flex-col gap-3 rounded-[8px] border border-primary-accent-text/70 bg-card px-4 py-3 shadow-[inset_3px_0_0_var(--primary)]">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-primary-accent-text">{STRATEGY_FIRST[strategy]}</p>
              <p className="truncate text-[17px] font-bold text-foreground">{first.name}</p>
              <p className="text-xs text-foreground/80">{first.kindLabel}</p>
            </div>
            <span className="text-[22px] leading-none font-bold text-foreground/30 tabular-nums" aria-hidden>
              01
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-3 border-t border-border pt-2.5 text-[13px]">
            <div>
              <dt className="text-xs text-foreground/80">Still to pay</dt>
              <dd className="font-bold text-foreground tabular-nums">{formatCurrency(first.outstanding)}</dd>
            </div>
            <div>
              <dt className="text-xs text-foreground/80">Required this cycle</dt>
              <dd className="font-bold text-foreground tabular-nums">{formatCurrency(requiredByDebt[first.id] ?? 0)}</dd>
            </div>
          </dl>
          <div className="flex flex-wrap items-center justify-between gap-2">
            {order.length > 1 ? (
              <p className="min-w-0 truncate text-xs text-foreground/80">
                Then: {order.slice(1, 4).map((id) => byId.get(id)!.name).join(" → ")}
              </p>
            ) : (
              <span />
            )}
            <Link
              href={paymentHref(first).href}
              className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-border-strong bg-card px-3 text-[13px] font-semibold text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
            >
              {paymentHref(first).label}
              <ArrowRight className="size-3.5" />
            </Link>
          </div>
        </div>
      ) : (
        <p className="rounded-[8px] border border-dashed border-border-strong px-4 py-3 text-[13px] text-foreground/85">
          {plan.status === "shortfall"
            ? "A focus debt appears once your budget covers required payments."
            : "Your whole budget goes to required payments. Add money above the required amount and the strategy will pick a debt to focus on."}
        </p>
      )}
    </section>
  );
}
