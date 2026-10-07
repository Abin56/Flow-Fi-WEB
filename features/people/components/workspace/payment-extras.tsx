"use client";

import { PiggyBank } from "lucide-react";
import { useState } from "react";
import type { RecordPaymentInitial } from "@/features/people/components/workspace/record-payment-panel";
import { obligationSourceLabel, timingOf, type PayableObligation } from "@/features/people/lib/person-payment-obligations";
import { formatStatementDate } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import type { PaymentImpact } from "@/lib/engines/person-payment-impact";
import { planAdvanceApplication, round2, type AdvanceSource, type AdvanceUse } from "@/lib/engines/person-payment";
import { cn } from "@/lib/utils";
import { WS_FIELD, WS_GHOST, WS_PRIMARY } from "./person-workspace-ui";

/**
 * Inside the revert confirmation: what this ONE payment did and what reverting it changes — every figure
 * from `paymentImpact` (its ledger entries, cash leg / income transactions and advance applications).
 * When a later settlement already used this payment's advance, the revert is blocked and that use is
 * listed so the user can undo it first. "Edit instead" is offered where the payment can be edited.
 */
export function PaymentRevertDetails({
  impact,
  firstName,
  initial,
  onEdit,
  accountNameOf,
  obligationTitleOf,
  onUndoDependency,
}: {
  impact: PaymentImpact;
  firstName: string;
  /** The edit pre-fill — null when this payment is changed by revert + record. */
  initial: RecordPaymentInitial | null;
  onEdit?: (initial: RecordPaymentInitial) => void;
  accountNameOf: (accountId: string) => string;
  obligationTitleOf: (obligationKey: string) => string;
  /** Undoes one later use of this payment's advance. */
  onUndoDependency?: (applicationId: string) => Promise<void>;
}) {
  const received = impact.direction === "theyPaid";
  const [undoing, setUndoing] = useState<string | null>(null);
  if (!impact.canRevert) {
    return (
      <>
        <p className="font-semibold text-foreground">Can&apos;t revert this payment yet</p>
        <p>
          {money(impact.advanceUsed)} of the advance from this payment was already used in {impact.dependencies.length === 1 ? "a later settlement" : "later settlements"}:
        </p>
        <ul className="divide-y divide-border-strong/45 rounded-[6px] border border-border-strong/70">
          {impact.dependencies.map((d) => (
            <li key={d.applicationId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2.5 py-1.5 text-[12.5px]">
              <span className="min-w-0 flex-1 font-medium text-foreground">
                {obligationTitleOf(d.obligationKey)} · {formatStatementDate(d.date, true)}
              </span>
              <span className="font-semibold tabular-nums text-foreground">{money(d.amount)}</span>
              {onUndoDependency && (
                <button
                  type="button"
                  disabled={undoing != null}
                  onClick={async () => {
                    setUndoing(d.applicationId);
                    try {
                      await onUndoDependency(d.applicationId);
                    } finally {
                      setUndoing(null);
                    }
                  }}
                  className="h-6 rounded-[5px] px-1.5 text-[11.5px] font-semibold text-primary-accent-text outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                >
                  {undoing === d.applicationId ? "Undoing…" : "Undo that use"}
                </button>
              )}
            </li>
          ))}
        </ul>
        <p>Undo {impact.dependencies.length === 1 ? "that use" : "those uses"} first — then this payment can be reverted. Nothing has been changed.</p>
      </>
    );
  }
  return (
    <>
      <p className="flex items-baseline justify-between gap-3 font-medium text-foreground">
        <span>
          {firstName} payment · {received ? "received" : "paid"}
        </span>
        <span className="font-heading font-bold tabular-nums">{money(impact.received)}</span>
      </p>
      <p>This will:</p>
      <ul className="list-disc space-y-0.5 pl-5">
        {impact.accounts.map((a) => (
          <li key={a.accountId}>
            {received ? "remove" : "return"} {money(a.amount)} {received ? "from" : "to"} {accountNameOf(a.accountId)}
          </li>
        ))}
        {impact.settled > 0 && <li>reopen {money(impact.settled)} of settled obligations</li>}
        {impact.advance > 0 && <li>remove {money(impact.advanceUnused)} of unused advance</li>}
        {impact.income > 0 && <li>remove {money(impact.income)} recorded as income</li>}
        {impact.purposes > 0 && <li>remove {money(impact.purposes)} kept for purposes (any use of it must be undone first)</li>}
      </ul>
      <p className="text-foreground/75">The People Ledger, statements and reports update as though this payment had never been recorded.</p>
      {onEdit && initial && (
        <p>
          Only the amount, account or allocation was wrong?{" "}
          <button type="button" onClick={() => onEdit(initial)} className="font-semibold text-foreground underline underline-offset-2">
            Edit the payment instead
          </button>
          .
        </p>
      )}
    </>
  );
}

function Figure({ label, value, tone, strong }: { label: string; value: string; tone?: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold tracking-[0.05em] text-foreground/70 uppercase">{label}</dt>
      <dd className={cn("tabular-nums", strong ? "font-heading text-[16px] font-bold" : "text-[14px] font-semibold", tone ?? "text-foreground")}>{value}</dd>
    </div>
  );
}

/**
 * Advance held for this person — what is available, what is open on the same side, and what would be
 * left after applying it. Nothing is consumed until the user opens it, picks the obligations and
 * confirms: a new cycle never uses advance on its own. Applying moves no money (the advance already did).
 */
export function ApplyAdvancePanel({
  personName,
  side,
  available,
  obligations,
  open,
  onOpenChange,
  onConfirm,
  cycle,
}: {
  personName: string;
  side: "theyOwe" | "iOwe";
  available: readonly (AdvanceSource & { remaining: number })[];
  /** Every open obligation (either side) — only this side's are offered. */
  obligations: readonly PayableObligation[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (targets: { obligationKey: string; uses: AdvanceUse[] }[]) => Promise<void>;
  /**
   * The selected People cycle. Items dated after it are "Upcoming": still offered (applying advance early
   * is allowed) but never pre-selected — advance only reaches a future item when the user ticks it.
   */
  cycle?: { start: Date; end: Date };
}) {
  const first = personName.split(" ")[0];
  const options = obligations.filter((o) => o.side === side);
  const isLater = (o: PayableObligation) => cycle != null && timingOf(o.date, cycle) === "later";
  const [selected, setSelected] = useState<Set<string>>(() => new Set(options.filter((o) => !isLater(o)).map((o) => o.key)));
  const upcomingTotal = round2(options.filter(isLater).reduce((s, o) => s + o.outstanding, 0));
  const [manual, setManual] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const plan = planAdvanceApplication({
    available,
    obligations: options,
    side,
    selectedKeys: [...selected],
    manual: manual ? Object.fromEntries(Object.entries(manual).map(([k, v]) => [k, Number(v) || 0])) : null,
  });
  // Due through the selected cycle — upcoming items are shown separately, never counted as "need to receive" now.
  const openTotal = round2(options.filter((o) => !isLater(o)).reduce((s, o) => s + o.outstanding, 0));
  const lineByKey = new Map(plan.allocation.lines.map((l) => [l.key, l]));
  // Received vs applied, straight from `advanceRemaining` (each advance: amount, remaining) — no second balance.
  const sideAdvances = available.filter((a) => a.side === side);
  const received = round2(sideAdvances.reduce((s, a) => s + a.amount, 0));
  const applied = round2(sideAdvances.reduce((s, a) => s + (a.amount - a.remaining), 0));
  const applying = plan.allocation.allocated;
  const toggle = (key: string) => {
    setManual(null);
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="mt-4 overflow-hidden rounded-[8px] border border-settle-advance-edge/70 bg-card">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-l-[4px] border-settle-advance-edge bg-settle-advance-tint px-4 py-2.5">
        <p className="flex items-center gap-1.5 text-[12px] font-bold tracking-[0.07em] text-settle-advance-text uppercase">
          <PiggyBank className="size-4" strokeWidth={2.25} aria-hidden />
          {side === "theyOwe" ? `Advance from ${first}` : `Advance you paid ${first}`}
        </p>
        <dl className="flex flex-1 flex-wrap gap-x-6 gap-y-1">
          <Figure label={side === "theyOwe" ? "Advance received" : "Advance paid"} value={money(received)} />
          <Figure label="Applied" value={money(applied)} />
          <Figure label="Available to apply" value={money(plan.availableTotal)} tone="text-settle-advance-text" strong />
          <Figure label={side === "theyOwe" ? `You need to receive from ${first}` : `You need to give to ${first}`} value={money(openTotal)} />
          <Figure label="Remaining after advance" value={money(Math.max(0, round2(openTotal - plan.availableTotal)))} strong />
          {upcomingTotal > 0 && <Figure label="Upcoming (later cycles)" value={money(upcomingTotal)} />}
        </dl>
        {!open && options.length > 0 && (
          <button type="button" onClick={() => onOpenChange(true)} className={cn(WS_PRIMARY, "h-8 px-3")}>
            Apply advance
          </button>
        )}
      </div>
      {options.length === 0 && (
        <p className="px-4 py-2 text-xs font-medium text-foreground/75">
          Nothing is open on this side right now — the advance stays available until you apply it or revert the payment it came from.
        </p>
      )}
      {open && options.length > 0 && (
        <div className="px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold text-foreground/80">Choose what the advance pays — oldest first unless you change an amount.</p>
            {manual && (
              <button
                type="button"
                onClick={() => setManual(null)}
                className="h-7 rounded-[6px] px-2 text-xs font-semibold text-foreground/80 hover:bg-secondary"
              >
                Allocate automatically
              </button>
            )}
          </div>
          <div className="mt-2 overflow-x-auto rounded-[6px] border border-border-strong">
            <table className="w-full min-w-[34rem] border-collapse text-sm">
              <thead>
                <tr className="bg-secondary text-left text-[11px] font-semibold tracking-[0.05em] text-foreground/75 uppercase">
                  <th className="w-9 border-b border-border-strong px-2 py-1.5" />
                  <th className="border-b border-border-strong px-2 py-1.5">Obligation</th>
                  <th className="border-b border-border-strong px-2 py-1.5 text-right">Due</th>
                  <th className="border-b border-border-strong px-2 py-1.5 text-right">From advance</th>
                  <th className="border-b border-border-strong px-2 py-1.5 text-right">Remaining</th>
                </tr>
              </thead>
              <tbody>
                {options.map((o) => {
                  const on = selected.has(o.key);
                  const line = lineByKey.get(o.key);
                  const after = on ? (line?.remainingAfter ?? o.outstanding) : o.outstanding;
                  return (
                    <tr key={o.key} className={cn(on ? "bg-settle-advance-tint/60" : "hover:bg-secondary/60")}>
                      <td className="border-b border-border px-2 py-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggle(o.key)}
                          aria-label={`Apply advance to ${o.title}`}
                          className="size-4 accent-[var(--color-settle-advance-edge)]"
                        />
                      </td>
                      <td className="border-b border-border px-2 py-1.5">
                        <span className="flex items-center gap-1.5 font-semibold text-foreground">
                          {o.title}
                          {isLater(o) && (
                            <span className="rounded-[4px] bg-secondary px-1.5 text-[10px] leading-4 font-bold text-foreground/75 uppercase">Upcoming</span>
                          )}
                        </span>
                        <span className="text-xs text-foreground/70">
                          {formatStatementDate(o.date, true)} · {obligationSourceLabel(o, first)}
                        </span>
                      </td>
                      <td className="border-b border-border px-2 py-1.5 text-right font-semibold tabular-nums">{money(o.outstanding)}</td>
                      <td className="border-b border-border px-2 py-1.5 text-right tabular-nums">
                        {on ? (
                          <input
                            type="number"
                            inputMode="decimal"
                            aria-label={`Advance for ${o.title}`}
                            value={manual ? (manual[o.key] ?? "") : String(line?.amount ?? 0)}
                            onChange={(e) =>
                              setManual((m) => ({
                                ...(m ?? Object.fromEntries(plan.allocation.lines.map((l) => [l.key, String(l.amount)]))),
                                [o.key]: e.target.value,
                              }))
                            }
                            className={cn(WS_FIELD, "h-8 w-28 text-right tabular-nums")}
                          />
                        ) : (
                          <span className="text-foreground/55">—</span>
                        )}
                      </td>
                      <td className="border-b border-border px-2 py-1.5 text-right font-semibold tabular-nums">
                        {on && after <= 0.005 ? (
                          <span className="text-success">Paid in full</span>
                        ) : (
                          <span className={on && line ? "text-warning" : "text-foreground"}>{money(after)}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
              <Figure label="Applying now" value={money(applying)} tone="text-settle-advance-text" strong />
              <Figure label="Advance left" value={money(round2(plan.availableTotal - applying))} />
              <Figure
                label="Still due after"
                value={money(Math.max(0, round2(options.filter((o) => !isLater(o)).reduce((s, o) => s + (selected.has(o.key) ? (lineByKey.get(o.key)?.remainingAfter ?? o.outstanding) : o.outstanding), 0))))}
                strong
              />
            </dl>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => onOpenChange(false)} disabled={busy} className={WS_GHOST}>
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || !!plan.error || plan.targets.length === 0}
                onClick={async () => {
                  setBusy(true);
                  setErr(null);
                  try {
                    await onConfirm(plan.targets);
                    onOpenChange(false);
                  } catch (e) {
                    setErr(e instanceof Error ? e.message : "Couldn't apply the advance.");
                  } finally {
                    setBusy(false);
                  }
                }}
                className={WS_PRIMARY}
              >
                {busy ? "Applying…" : `Apply ${money(applying)} of advance`}
              </button>
            </div>
            {(err || plan.error) && <p className="text-xs font-medium text-expense sm:col-span-2">{err ?? plan.error}</p>}
            <p className="text-[11.5px] text-foreground/70 sm:col-span-2">
              No money moves and nothing becomes income — the advance was already received. Each application stays linked to the payment it came from and can be
              undone.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
