"use client";

import { CalendarClock, HandCoins } from "lucide-react";
import Link from "next/link";
import { ClayBadge } from "@/components/clay/clay-badge";
import { Money } from "@/features/loans/components/loan-emi-ui";
import { PERSON_STATUS_LABEL, type AgreementPerson, type PersonShareStatus } from "@/features/loans/lib/agreement-people";
import { peoplePostponeHref, peopleSettleHref } from "@/lib/engines/linked-people-readiness";
import { cn } from "@/lib/utils";

const TONE: Record<PersonShareStatus, "success" | "warning" | "expense" | "primary"> = {
  received: "success",
  partial: "warning",
  pending: "expense",
  postponed: "primary",
};

const dateText = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

const ACTION =
  "inline-flex h-8 items-center gap-1.5 rounded-[6px] border px-2.5 text-xs font-semibold whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Who pays what on this agreement, one block per person: how much of their share has come in, and each installment's
 * state — Received · Partially received · Pending · Postponed — next to whether the BANK installment is paid (a separate
 * fact: paying the bank never marks anyone as having paid). "Record received" and "Postpone" open the People Ledger's own
 * flows, exactly as in Record Payment; nothing is written from here.
 */
export function AgreementPeopleTab({ people, returnTo, onTheyPaid }: { people: AgreementPerson[]; returnTo: string; onTheyPaid?: (installmentId: string) => void }) {
  return (
    <div className="flex flex-col gap-3" data-testid="agreement-people">
      {people.map((p) => {
        const percent = p.share > 0 ? Math.min(100, Math.round((p.received / p.share) * 100)) : 0;
        return (
          <section key={p.personId} aria-label={p.personName} className="overflow-hidden rounded-[10px] border border-border bg-card">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-secondary/40 px-4 py-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <Link href={`/people?person=${encodeURIComponent(p.personId)}`} className="truncate font-heading text-sm font-semibold text-foreground underline-offset-2 hover:underline">
                  {p.personName}
                </Link>
                {p.generalCredit > 0.005 && p.remaining > 0.005 && (
                  <span className="text-xs text-settle-receivable-text" data-testid={`general-${p.personId}`} title="Recorded in People toward the overall balance, not against an installment — so the shares below still show as open.">
                    <Money amount={p.generalCredit} className="text-xs" /> already received, not linked to an installment
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  {p.remaining > 0.005 ? (
                    <>
                      Still owes you <Money amount={p.remaining} className="text-xs text-foreground" /> of <Money amount={p.share} className="text-xs text-foreground" />
                    </>
                  ) : (
                    <>All <Money amount={p.share} className="text-xs text-foreground" /> received</>
                  )}
                </span>
              </div>
              <div className="flex min-w-[8rem] max-w-xs flex-1 flex-col gap-1">
                <div className="h-1.5 w-full overflow-hidden rounded-[2px] bg-border" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={`${p.personName} has repaid ${percent}%`}>
                  <div className="h-full rounded-[2px] bg-success transition-[width] duration-700 ease-out" style={{ width: `${percent}%` }} />
                </div>
                <span className="text-[11px] text-muted-foreground tabular-nums">{percent}% repaid to you</span>
              </div>
              {p.firstOpen && (
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {onTheyPaid && (
                    <button
                      type="button"
                      onClick={() => onTheyPaid(p.firstOpen!.installmentId)}
                      data-testid={`people-they-paid-${p.personId}`}
                      aria-label={`Record that ${p.personName} already paid installment ${p.firstOpen.sequenceNumber}`}
                      className={cn(ACTION, "border-border-strong bg-card text-foreground hover:bg-secondary")}
                    >
                      <HandCoins className="size-3.5" aria-hidden /> They paid
                    </button>
                  )}
                  <Link
                    href={peopleSettleHref(p.personId, p.firstOpen.key, returnTo)}
                    aria-label={`Record money received from ${p.personName} in People`}
                    className={cn(ACTION, "border-primary-accent-text bg-primary text-primary-foreground hover:bg-primary/85")}
                  >
                    <HandCoins className="size-3.5" aria-hidden /> Record received
                  </Link>
                  <Link
                    href={peoplePostponeHref(p.personId, p.firstOpen.key, returnTo)}
                    aria-label={`Postpone collecting ${p.personName}'s share in People`}
                    className={cn(ACTION, "border-border-strong bg-card text-foreground hover:bg-secondary")}
                  >
                    <CalendarClock className="size-3.5" aria-hidden /> Postpone
                  </Link>
                </div>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-left text-[13px]">
                <thead>
                  <tr className="border-b border-border text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                    <th className="px-4 py-2 font-semibold">Installment</th>
                    <th className="px-2 py-2 font-semibold">Due</th>
                    <th className="px-2 py-2 text-right font-semibold">Their share</th>
                    <th className="px-2 py-2 text-right font-semibold">Received</th>
                    <th className="px-2 py-2 font-semibold">Their payment</th>
                    <th className="px-4 py-2 font-semibold">Bank</th>
                  </tr>
                </thead>
                <tbody>
                  {p.lines.map((l) => (
                    <tr key={l.key} className="border-b border-border/60 last:border-b-0" data-testid={`people-line-${p.personId}-${l.sequenceNumber}`}>
                      <td className="px-4 py-2 font-medium text-foreground tabular-nums">#{l.sequenceNumber}</td>
                      <td className="px-2 py-2 whitespace-nowrap text-muted-foreground tabular-nums">{dateText(l.dueDate)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        <Money amount={l.share} className="text-[13px] text-foreground" />
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        <Money amount={Math.min(l.received, l.share)} className="text-[13px] text-foreground" />
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        <ClayBadge tone={TONE[l.status]} className="rounded-[5px] px-2 py-0.5 font-semibold">
                          {PERSON_STATUS_LABEL[l.status]}
                        </ClayBadge>
                        {l.status === "postponed" && l.postponedDate && <span className="ml-2 text-[11px] text-muted-foreground">until {dateText(l.postponedDate)}</span>}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        <ClayBadge tone="neutral" className={cn("rounded-[5px] px-2 py-0.5 font-medium", l.bankPaid ? "text-foreground" : "text-muted-foreground")}>
                          {l.bankPaid ? "Bank paid" : "Bank due"}
                        </ClayBadge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
