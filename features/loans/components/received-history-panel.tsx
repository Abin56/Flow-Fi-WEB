"use client";

import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { usePeopleLedgerEntries } from "@/features/people/hooks/use-people-data";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import { receivedHistory } from "@/features/loans/lib/received-history";
import type { InstallmentParticipant } from "@/lib/engines/installment-participants";
import { cycleRangeFor } from "@/lib/engines/month-cycle-range";
import { formatCycleLabel, formatStatementDate } from "@/lib/engines/person-cycle-statement";
import { PAYMENT_EPSILON, round2 } from "@/lib/engines/person-payment";
import { formatCurrencyExact } from "@/lib/format";
import type { Installment } from "@/lib/models/payment-schedule";
import { cn } from "@/lib/utils";

const RECENT_LIMIT = 3;

export function ReceivedHistoryPanel({ participants, installments, sourceKind }: {
  participants: readonly InstallmentParticipant[];
  installments: readonly Installment[];
  sourceKind: "loan" | "emi";
}) {
  const { entriesByPersonId, isLoading } = usePeopleLedgerEntries();
  const startDay = useMonthCycleStartDay();
  const [pickedPerson, setPickedPerson] = useState("");
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const person = participants.find((p) => p.personId === pickedPerson) ?? participants[0];
  if (!person) return null;

  const cycle = cycleRangeFor(startDay, new Date());
  const entries = entriesByPersonId[person.personId];
  const history = entries == null ? null : receivedHistory(entries, cycle);
  const lines = person.covered ?? (person.current ? [person.current] : []);
  const applied = round2(lines.reduce((sum, line) => sum + line.received, 0));
  const remaining = round2(lines.reduce((sum, line) => sum + line.remaining, 0));
  const prefix = sourceKind === "emi" ? "emi-inst" : "loan-inst";
  const sequenceByRef = new Map(installments.map((i) => [`${prefix}:${i.id}`, `#${i.sequenceNumber}`]));
  const cycleAmount = history == null ? "—" : formatCurrencyExact(history.receivedThisCycle);

  return (
    <aside aria-label="Received History" className="hidden min-w-0 rounded-lg border border-border bg-card lg:block" data-testid="received-history">
      <h3 className="hidden border-b border-border px-3 py-2 text-xs font-semibold text-foreground @min-[55rem]:block">Received History</h3>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((open) => !open)}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs font-semibold text-foreground outline-none hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring @min-[55rem]:hidden"
      >
        <span>Received History</span>
        <span className="ml-auto font-normal text-muted-foreground">{person.personName} · {cycleAmount} this cycle</span>
        <ChevronDown aria-hidden className={cn("size-3.5 shrink-0", expanded && "rotate-180")} />
      </button>
      <div id={contentId} className={cn("space-y-2 px-3 py-2", expanded ? "block border-t border-border @min-[55rem]:border-t-0" : "hidden @min-[55rem]:block")}>
        {participants.length > 1 ? (
          <select aria-label="Person for received history" value={person.personId} onChange={(event) => setPickedPerson(event.target.value)} className="h-8 w-full min-w-0 rounded-md border border-border-strong bg-card px-2 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {participants.map((p) => <option key={p.personId} value={p.personId}>{p.personName}</option>)}
          </select>
        ) : <p className="text-xs font-semibold text-foreground">{person.personName}</p>}
        <p className="text-[11px] text-muted-foreground">{formatCycleLabel(cycle)}</p>
        <dl className="space-y-1">
          <HistoryFigure label="Received this cycle" amount={cycleAmount} />
          {lines.length > 0 && <>
            <HistoryFigure label={lines.length === 1 ? `Applied to #${lines[0].sequenceNumber}` : "Applied to selected installments"} amount={formatCurrencyExact(applied)} />
            <HistoryFigure label="Remaining share" amount={formatCurrencyExact(remaining)} />
          </>}
          {(person.advanceHeld ?? 0) > PAYMENT_EPSILON && <HistoryFigure label="Unallocated advance" amount={formatCurrencyExact(person.advanceHeld ?? 0)} />}
          {(person.generalCredit ?? 0) > PAYMENT_EPSILON && <HistoryFigure label="Toward overall balance" amount={formatCurrencyExact(person.generalCredit ?? 0)} />}
        </dl>
        <div className="border-t border-border pt-1.5">
          <p className="text-xs font-semibold text-foreground">Recent receipts</p>
          {history == null ? (
            <p className="pt-1 text-[11px] text-muted-foreground">{isLoading ? "Loading receipts…" : "Receipt history unavailable."}</p>
          ) : history.recent.length > 0 ? (
            <ul aria-label="Recent People receipts" className="divide-y divide-border">
              {history.recent.slice(0, RECENT_LIMIT).map((item) => {
                const sequences = [...item.references].map((ref) => sequenceByRef.get(ref)).filter(Boolean);
                return (
                  <li key={item.key} className="flex flex-wrap justify-between gap-x-2 py-1 text-xs">
                    <span className="text-muted-foreground">
                      {item.date ? formatStatementDate(item.date, item.date.getFullYear() !== cycle.end.getFullYear()) : "Date unknown"}
                      {sequences.length > 0 && <span className="text-[11px]"> · {sequences.join(", ")}</span>}
                    </span>
                    <span className="font-semibold tabular-nums">{formatCurrencyExact(item.amount)}</span>
                  </li>
                );
              })}
            </ul>
          ) : <p className="pt-1 text-[11px] text-muted-foreground">No receipts recorded.</p>}
          {history && history.recent.length > RECENT_LIMIT && (
            <Link href={`/people?person=${encodeURIComponent(person.personId)}&view=ledger`} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block rounded text-xs font-semibold text-primary-accent-text underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring">
              View all in People
            </Link>
          )}
        </div>
      </div>
    </aside>
  );
}

function HistoryFigure({ label, amount }: { label: string; amount: string }) {
  return (
    <div className="flex justify-between gap-2 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="shrink-0 text-right font-semibold tabular-nums">{amount}</dd>
    </div>
  );
}
