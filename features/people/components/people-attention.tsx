"use client";

import { BellRing, ChevronDown } from "lucide-react";
import { useState } from "react";
import { followUpText } from "@/features/people/components/workspace/follow-up";
import { hasDueCandidate, useAllPersonFollowUps, usePeopleAttention } from "@/features/people/hooks/use-person-follow-ups";
import { money } from "@/lib/engines/person-cycle-statement-share";
import type { PersonFollowUp } from "@/lib/models/person-follow-up";
import { isActionable } from "@/lib/models/person-follow-up";
import { cn } from "@/lib/utils";

/**
 * People Ledger "Needs attention": the open obligations the user set a follow-up on. Renders nothing
 * until a reminder exists — never a dashboard of every unpaid debt.
 */
export function PeopleAttention({ onOpenPerson }: { onOpenPerson: (personId: string) => void }) {
  const { followUpsByPersonId } = useAllPersonFollowUps();
  const any = Object.values(followUpsByPersonId).some((l) => l.some((f) => f.state === "active"));
  return any ? <AttentionPanel followUpsByPersonId={followUpsByPersonId} onOpenPerson={onOpenPerson} /> : null;
}

function AttentionPanel({ followUpsByPersonId, onOpenPerson }: { followUpsByPersonId: Record<string, PersonFollowUp[]>; onOpenPerson: (personId: string) => void }) {
  const { items, actionable, isLoading } = usePeopleAttention(followUpsByPersonId);
  const [open, setOpen] = useState(false);
  if (isLoading || items.length === 0) return null;
  const urgent = actionable.length;
  return (
    <section aria-label="Follow-ups" className="rounded-[8px] border border-border-strong bg-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold text-foreground outline-none hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <BellRing className={cn("size-4", urgent > 0 ? "text-primary-accent-text" : "text-foreground/60")} aria-hidden />
        {urgent > 0 ? "Needs attention" : "Follow-ups"}
        <span className={cn("rounded-full px-1.5 text-[11px] leading-5 font-bold tabular-nums", urgent > 0 ? "bg-primary/20 text-foreground" : "bg-secondary text-foreground/70")}>
          {urgent > 0 ? urgent : items.length}
        </span>
        {urgent > 0 && items.length > urgent && <span className="text-xs font-medium text-foreground/60">· {items.length - urgent} upcoming</span>}
        <ChevronDown className={cn("ml-auto size-4 text-foreground/60 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <ul className="divide-y divide-border border-t border-border-strong">
          {items.map((i) => (
            <li key={`${i.personId}:${i.followUp.id}`}>
              <button
                type="button"
                onClick={() => onOpenPerson(i.personId)}
                className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 px-3 py-2 text-left outline-none hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-foreground">{i.personName}</span>
                  <span className="block truncate text-xs text-foreground/70">{i.followUp.obligationTitle}</span>
                </span>
                <span className="text-right">
                  <span className="block text-sm font-bold text-foreground tabular-nums">{money(i.remaining)}</span>
                  <span className={cn("block text-[11px] font-semibold", i.status === "overdue" ? "text-warning" : isActionable(i.status) ? "text-primary-accent-text" : "text-foreground/60")}>
                    {followUpText(i.followUp, i.status)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Drawer badge for People: reminders that reached their date on still-open obligations. Future reminders
 * and plain unpaid debts never count; zero → nothing rendered. The statement watches mount only once a
 * reminder is actually due.
 */
export function PeopleNavBadge({ collapsed = false }: { collapsed?: boolean }) {
  const { followUpsByPersonId } = useAllPersonFollowUps();
  return hasDueCandidate(followUpsByPersonId) ? <DueCount followUpsByPersonId={followUpsByPersonId} collapsed={collapsed} /> : null;
}

function DueCount({ followUpsByPersonId, collapsed }: { followUpsByPersonId: Record<string, PersonFollowUp[]>; collapsed: boolean }) {
  const { actionable, isLoading } = usePeopleAttention(followUpsByPersonId);
  const n = actionable.length;
  if (isLoading || n === 0) return null;
  const label = `${n} People ${n === 1 ? "follow-up" : "follow-ups"} due`;
  return collapsed ? (
    <span aria-label={label} className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary-accent-text" />
  ) : (
    <span aria-label={label} className="ml-auto rounded-full bg-primary/25 px-1.5 text-[11px] leading-5 font-bold text-foreground tabular-nums">
      {n}
    </span>
  );
}
