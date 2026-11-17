"use client";

/**
 * "Upcoming cycle" — a quiet in-app heads-up, a day before the next Month Cycle starts, of the collections that were
 * postponed INTO it. It is a reminder, never an overdue notice (those are the follow-up reminders and the "lapsed"
 * status), and it only reads: nothing here records a payment or changes a balance. Shown once per cycle (dismiss is
 * remembered per cycle on this device), so it never nags.
 *
 * Cheap until it matters: the per-person statements (needed for each item's live remaining) are mounted only when an
 * active deferral actually points at the next cycle inside the reminder window.
 */

import { CalendarClock, ChevronDown, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import { usePeopleCycleStatements } from "@/features/people/hooks/use-person-cycle-statement";
import { useAllPersonDeferrals } from "@/features/people/hooks/use-payment-deferrals";
import { openRemainingByKey } from "@/features/people/hooks/use-person-follow-ups";
import { usePeople } from "@/hooks/use-people";
import { cycleContaining, formatStatementDate } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { hasUpcomingCandidate, upcomingAlertKey, upcomingCycleAlert } from "@/lib/engines/upcoming-cycle-alert";
import type { Person } from "@/lib/models/person";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/auth-store";

const dismissKey = (uid: string | undefined) => `flowfi:upcoming-cycle-alert:${uid ?? "anon"}`;

function readDismissed(uid: string | undefined): string[] {
  try {
    const raw = window.localStorage.getItem(dismissKey(uid));
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeDismissed(uid: string | undefined, keys: string[]) {
  try {
    window.localStorage.setItem(dismissKey(uid), JSON.stringify(keys.slice(-12)));
  } catch {
    /* private mode / blocked storage — the alert simply shows again next visit */
  }
}

/** Today, refreshed when the calendar day changes while the page stays open. */
function useToday(): Date {
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => {
      const n = new Date();
      setToday((p) => (p.toDateString() === n.toDateString() ? p : n));
    }, 10 * 60 * 1000);
    return () => window.clearInterval(t);
  }, []);
  return today;
}

export function UpcomingCycleAlert({ onOpen, className }: { onOpen: (personId: string, obligationKey: string) => void; className?: string }) {
  const { deferralsByPerson } = useAllPersonDeferrals();
  const startDay = useMonthCycleStartDay();
  const today = useToday();
  if (!hasUpcomingCandidate(deferralsByPerson, today, startDay)) return null;
  return <AlertCard deferralsByPerson={deferralsByPerson} startDay={startDay} today={today} onOpen={onOpen} className={className} />;
}

function AlertCard({
  deferralsByPerson,
  startDay,
  today,
  onOpen,
  className,
}: {
  deferralsByPerson: Parameters<typeof upcomingCycleAlert>[0]["deferralsByPerson"];
  startDay: number;
  today: Date;
  onOpen: (personId: string, obligationKey: string) => void;
  className?: string;
}) {
  const uid = useAuthStore((s) => s.user?.uid);
  const { data: people = [] } = usePeople();
  // Whole history to today's cycle end: `remainingNow` is then what is still open today.
  const endMs = cycleContaining(today, startDay).end.getTime();
  const allTime = useMemo(() => ({ start: new Date(1970, 0, 1), end: new Date(endMs) }), [endMs]);
  const { statementsByPersonId, isLoading } = usePeopleCycleStatements(allTime);
  const alert = useMemo(
    () =>
      isLoading
        ? null
        : upcomingCycleAlert({
            today,
            startDay,
            people: (people as Person[]).map((p) => ({ id: p.id, name: p.name })),
            deferralsByPerson,
            remainingOf: (id) => openRemainingByKey(statementsByPersonId[id]),
          }),
    [isLoading, today, startDay, people, deferralsByPerson, statementsByPersonId],
  );
  const [dismissed, setDismissed] = useState<string[]>(() => (typeof window === "undefined" ? [] : readDismissed(uid)));
  const [open, setOpen] = useState(false);
  if (!alert) return null;
  const key = upcomingAlertKey(alert.cycle);
  if (dismissed.includes(key)) return null;

  const dismiss = () => {
    const next = [...dismissed, key];
    setDismissed(next);
    writeDismissed(uid, next);
  };
  const start = formatStatementDate(alert.cycle.start, alert.cycle.start.getFullYear() !== today.getFullYear());
  const when = alert.daysAway === 1 ? "starts tomorrow" : `starts in ${alert.daysAway} days`;
  const count = alert.items.length;
  const single = count === 1 ? alert.items[0] : null;

  return (
    <section
      aria-label="Upcoming cycle"
      data-testid="upcoming-cycle-alert"
      className={cn("rounded-[10px] border border-border-strong/60 border-l-4 border-l-settle-split-edge bg-card px-4 py-3 shadow-e1", className)}
    >
      <div className="flex items-start gap-2.5">
        <CalendarClock className="mt-0.5 size-4 shrink-0 text-settle-split-text" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
            <span className="font-bold text-foreground">Upcoming cycle · {start}</span>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[10.5px] font-bold text-foreground/70">Not due yet — {when}</span>
          </p>
          <p className="mt-0.5 text-[12.5px] text-foreground/80">
            {count} postponed {count === 1 ? "collection" : "collections"}
          </p>
          <ul className="mt-1.5 space-y-0.5" aria-label="Postponed to the upcoming cycle">
            {alert.people.map((p) => (
              <li key={p.personId} className="flex items-baseline justify-between gap-3 text-[13px]">
                <span className="min-w-0 truncate font-semibold text-foreground">
                  {p.personName}
                  {p.count > 1 && <span className="font-normal text-foreground/60"> · {p.count} items</span>}
                </span>
                <span className="shrink-0 font-bold text-foreground tabular-nums">{money(p.amount)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 flex items-baseline justify-between gap-3 border-t border-border pt-1 text-[12.5px]">
            <span className="text-foreground/70">Total expected</span>
            <span className="font-bold text-foreground tabular-nums">{money(alert.total)}</span>
          </p>

          {open && count > 1 && (
            <ul className="mt-2 divide-y divide-border overflow-hidden rounded-[8px] border border-border duration-200 animate-in fade-in slide-in-from-top-1" aria-label="Collections">
              {alert.items.map((i) => (
                <li key={`${i.personId}:${i.obligationKey}`}>
                  <button type="button" onClick={() => onOpen(i.personId, i.obligationKey)} className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[12.5px] outline-none hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring">
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-foreground">{i.personName}</span>
                      <span className="block truncate text-[11.5px] text-foreground/65">{i.title}</span>
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums">{money(i.amount)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-2 flex items-center gap-2">
            {single ? (
              <button type="button" onClick={() => onOpen(single.personId, single.obligationKey)} className="inline-flex h-8 items-center rounded-[6px] border border-primary-accent-text bg-primary px-3 text-[12px] font-semibold text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring">
                View collection
              </button>
            ) : (
              <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="inline-flex h-8 items-center gap-1 rounded-[6px] border border-primary-accent-text bg-primary px-3 text-[12px] font-semibold text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring">
                View collections
                <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
              </button>
            )}
            <span className="text-[11px] text-foreground/55">Reminder only — nothing is recorded.</span>
          </div>
        </div>
        <button type="button" onClick={dismiss} aria-label="Dismiss reminder" className="-mr-1 grid size-7 shrink-0 place-items-center rounded-[6px] text-foreground/60 outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring">
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </section>
  );
}
