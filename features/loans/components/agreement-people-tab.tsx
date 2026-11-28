"use client";

import { CalendarClock, HandCoins, ReceiptText } from "lucide-react";
import Link from "next/link";
import { Fragment, useRef, useState } from "react";
import { ClayBadge } from "@/components/clay/clay-badge";
import { DateInput, displayToIsoDate, formatDisplayDate } from "@/components/forms/date-input";
import { AgreementPeopleReceipt, PEOPLE_ROW_BUTTON, PEOPLE_ROW_FIELD } from "@/features/loans/components/agreement-people-receipt";
import { Money } from "@/features/loans/components/loan-emi-ui";
import { TheyPaidPanel } from "@/features/loans/components/they-paid-panel";
import { PERSON_STATUS_LABEL, type AgreementPeopleLine, type AgreementPerson, type PersonShareStatus } from "@/features/loans/lib/agreement-people";
import { usePaymentDeferralActions, usePersonPaymentDeferrals } from "@/features/people/hooks/use-payment-deferrals";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import type { OwnershipSource } from "@/lib/engines/debt-ownership";
import { peoplePostponeHref, peopleSettleHref } from "@/lib/engines/linked-people-readiness";
import { cycleContaining } from "@/lib/engines/person-cycle-statement";
import { cycleName } from "@/lib/engines/person-payment-deferral";
import { PAYMENT_EPSILON } from "@/lib/engines/person-payment";
import type { Installment } from "@/lib/models/payment-schedule";
import { cn } from "@/lib/utils";
import { generateId } from "@/lib/utils/id-generator";

const TONE: Record<PersonShareStatus, "success" | "warning" | "neutral"> = {
  received: "success",
  partial: "warning",
  pending: "neutral",
  postponed: "neutral",
};

const ROW_ACTION = cn(
  PEOPLE_ROW_BUTTON,
  "min-h-7 cursor-pointer gap-1 rounded-[8px] px-1.5 text-[11px] transition-colors disabled:cursor-default aria-expanded:disabled:opacity-100 @min-[43rem]/people-sheet:px-2 @min-[43rem]/people-sheet:text-xs",
);
const APPLY_ACTION = cn(ROW_ACTION, "border-settle-receivable-edge/45 bg-settle-receivable-tint text-settle-receivable-text hover:bg-settle-receivable-badge aria-expanded:bg-settle-receivable-badge");
const RECORD_ACTION = cn(ROW_ACTION, "border-primary-accent-text/35 bg-primary/18 text-primary-accent-text hover:bg-primary/32 aria-expanded:bg-primary/32");
const POSTPONE_ACTION = cn(ROW_ACTION, "border-warning/55 bg-warning/15 text-warning-foreground hover:bg-warning/30 aria-expanded:bg-warning/30 dark:text-warning");
const ACTION_ICON = "inline-grid size-4.5 shrink-0 place-items-center rounded-[4px] [&>svg]:size-3";
const STATUS_BADGE = "rounded-[6px] px-1.5 py-0.5 text-[11px] leading-tight font-semibold";
const CELL = "px-1 py-1.5 @min-[43rem]/people-sheet:px-2 @min-[65rem]/people-sheet:px-3";
const HEADING = cn(CELL, "font-semibold");

const dateText = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const toInputDate = (date: Date) => displayToIsoDate(formatDisplayDate(date));

type RowAction = "record" | "apply" | "postpone";

export function AgreementPeopleTab({ people, target, agreementName, returnTo }: {
  people: AgreementPerson[];
  target?: { sourceKind: "loan" | "emi"; source: OwnershipSource; installments: readonly Installment[] };
  agreementName: string;
  returnTo?: string;
}) {
  const [editor, setEditor] = useState<{ personId: string; key: string; action: RowAction } | null>(null);
  const close = () => setEditor(null);
  return (
    <div className="@container/people-sheet flex min-w-0 flex-col gap-3" data-testid="agreement-people">
      {people.map((p) => {
        const percent = p.share > 0 ? Math.min(100, Math.round((p.received / p.share) * 100)) : 0;
        return (
          <section key={p.personId} aria-label={p.personName} className="overflow-hidden rounded-[14px] border border-border bg-card">
            <header className="grid items-start gap-x-6 gap-y-2.5 border-b border-border bg-secondary/35 px-3 py-2.5 @min-[37rem]/people-sheet:grid-cols-[minmax(0,1fr)_clamp(11.25rem,25cqi,18rem)] @min-[65rem]/people-sheet:px-4">
              <div className="grid min-w-0 gap-0.5">
                <h3 className="min-w-0 font-heading text-sm font-semibold text-foreground [overflow-wrap:anywhere]">
                  <Link href={`/people?person=${encodeURIComponent(p.personId)}`} className="rounded-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                    {p.personName}
                  </Link>
                </h3>
                <span className="text-xs text-muted-foreground">
                  {p.remaining > 0.005 ? (
                    <>
                      Unsettled installments <Money amount={p.remaining} exact className="text-xs text-foreground" /> of <Money amount={p.share} exact className="text-xs text-foreground" />
                    </>
                  ) : (
                    <>All <Money amount={p.share} exact className="text-xs text-foreground" /> received</>
                  )}
                </span>
                {p.generalCredit > 0.005 && p.remaining > 0.005 && (
                  <div className="mt-1 flex min-w-0 items-start gap-1.5 text-[11px] leading-snug text-settle-receivable-text" data-testid={`general-${p.personId}`} title="Recorded in People toward the overall balance, not against an installment — so the shares below still show as open.">
                    <HandCoins aria-hidden className="size-3.5 shrink-0" />
                    <p><Money amount={p.generalCredit} exact className="text-[11px]" /> received toward the overall People balance. Use a People receipt on an installment to assign it.</p>
                  </div>
                )}
              </div>
              <div className="grid min-w-0 gap-1.5 rounded-[8px] border border-border/80 bg-card/75 px-2.5 py-1.5">
                <span className="text-[11px] text-muted-foreground"><strong className="font-semibold text-foreground tabular-nums">{percent}%</strong> assigned to installments</span>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-border" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={`${p.personName}'s installments settled`}>
                  <div className="h-full rounded-full bg-success transition-[width] duration-700 ease-out motion-reduce:transition-none" style={{ width: `${percent}%` }} />
                </div>
              </div>
            </header>
            <div className="min-w-0 overflow-x-auto">
              <table className="w-full min-w-[34rem] text-left text-[13px]">
                <thead>
                  <tr className="border-b border-border bg-secondary/15 text-[10px] tracking-[0.045em] text-muted-foreground uppercase @min-[65rem]/people-sheet:text-[11px]">
                    <th scope="col" className={cn(HEADING, "pl-3 @min-[65rem]/people-sheet:pl-4")}>Installment</th>
                    <th scope="col" className={HEADING}>Due</th>
                    <th scope="col" className={cn(HEADING, "text-right")}>Their share</th>
                    <th scope="col" className={cn(HEADING, "text-right")}>Received</th>
                    <th scope="col" className={cn(HEADING, "text-right")}>Remaining</th>
                    <th scope="col" className={HEADING}>Their payment</th>
                    <th scope="col" className={HEADING}>Bank</th>
                    <th scope="col" className={cn(HEADING, "w-[31%] pr-3 @min-[43rem]/people-sheet:w-[34%] @min-[65rem]/people-sheet:w-[37%] @min-[65rem]/people-sheet:pr-4")}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {p.lines.map((l) => {
                    const active = editor?.personId === p.personId && editor.key === l.key ? editor.action : null;
                    const open = l.remaining > PAYMENT_EPSILON;
                    const show = (action: RowAction) => setEditor({ personId: p.personId, key: l.key, action });
                    return (
                      <Fragment key={l.key}>
                        <tr className={cn("border-b border-border/70 last:border-b-0", active ? "bg-settle-receivable-tint/70" : "hover:bg-secondary/25 focus-within:bg-secondary/25")} data-testid={`people-line-${p.personId}-${l.sequenceNumber}`}>
                          <th scope="row" className={cn(CELL, "pl-3 text-left font-semibold text-foreground tabular-nums @min-[65rem]/people-sheet:pl-4")}>#{l.sequenceNumber}</th>
                          <td className={cn(CELL, "text-xs whitespace-nowrap text-muted-foreground tabular-nums @min-[43rem]/people-sheet:text-[13px]")}>{dateText(l.dueDate)}</td>
                          <td className={cn(CELL, "text-right")}>
                            <Money amount={l.share} exact className="text-[13px] text-foreground" />
                          </td>
                          <td className={cn(CELL, "text-right")}>
                            <Money amount={Math.min(l.received, l.share)} exact className={cn("text-[13px]", l.received > PAYMENT_EPSILON ? "text-success" : "text-muted-foreground")} />
                          </td>
                          <td className={cn(CELL, "text-right")}>
                            <Money amount={l.remaining} exact className={cn("text-[13px]", open ? "text-foreground" : "text-muted-foreground")} />
                          </td>
                          <td className={CELL}>
                            <ClayBadge tone={TONE[l.status]} className={cn(STATUS_BADGE, l.status === "postponed" && "bg-settle-receivable-tint text-settle-receivable-text")}>
                              {PERSON_STATUS_LABEL[l.status]}
                            </ClayBadge>
                            {l.status === "postponed" && <span className="mt-0.5 block text-[11px] text-muted-foreground">{l.postponedDate ? `Until ${dateText(l.postponedDate)}` : l.expectedCycle ? cycleName(l.expectedCycle) : null}</span>}
                          </td>
                          <td className={cn(CELL, "whitespace-nowrap")}>
                            <ClayBadge tone="neutral" className={cn(STATUS_BADGE, "font-medium", l.bankPaid ? "text-foreground" : "bg-transparent px-0")}>
                              {l.bankPaid ? "Bank paid" : "Bank due"}
                            </ClayBadge>
                          </td>
                          <td className={cn(CELL, "pr-3 @min-[65rem]/people-sheet:pr-4")}>
                            {open && (target ? <div className="flex flex-wrap gap-1">
                              {p.generalCredit > PAYMENT_EPSILON && <button type="button" className={APPLY_ACTION} aria-label="Use People receipt" title="Use People receipt" aria-expanded={active === "apply"} disabled={editor != null} onClick={() => show("apply")}>
                                <span aria-hidden className={cn(ACTION_ICON, "bg-settle-receivable-badge")}><HandCoins /></span>
                                <span className="@min-[65rem]/people-sheet:hidden">People receipt</span>
                                <span className="hidden @min-[65rem]/people-sheet:inline">Use People receipt</span>
                              </button>}
                              <button type="button" className={RECORD_ACTION} aria-label={p.generalCredit > PAYMENT_EPSILON ? "Record another receipt" : undefined} title={p.generalCredit > PAYMENT_EPSILON ? "Record another receipt" : undefined} aria-expanded={active === "record"} disabled={editor != null} onClick={() => show("record")}>
                                <span aria-hidden className={cn(ACTION_ICON, "bg-primary/35")}><ReceiptText /></span>
                                {p.generalCredit > PAYMENT_EPSILON ? <><span className="@min-[65rem]/people-sheet:hidden">Another receipt</span><span className="hidden @min-[65rem]/people-sheet:inline">Record another receipt</span></> : "Record received"}
                              </button>
                              <button type="button" className={POSTPONE_ACTION} aria-expanded={active === "postpone"} disabled={editor != null} onClick={() => show("postpone")}>
                                <span aria-hidden className={cn(ACTION_ICON, "bg-warning/28")}><CalendarClock /></span>
                                {l.status === "postponed" ? "Change date" : "Postpone"}
                              </button>
                            </div> : <div className="flex flex-wrap gap-1">
                              <Link href={peopleSettleHref(p.personId, l.key, returnTo)} className={RECORD_ACTION}>
                                <span aria-hidden className={cn(ACTION_ICON, "bg-primary/35")}><ReceiptText /></span>
                                Record received
                              </Link>
                              <Link href={peoplePostponeHref(p.personId, l.key, returnTo)} className={POSTPONE_ACTION}>
                                <span aria-hidden className={cn(ACTION_ICON, "bg-warning/28")}><CalendarClock /></span>
                                Postpone
                              </Link>
                            </div>)}
                          </td>
                        </tr>
                        {active && target && <tr className="border-b border-border bg-settle-receivable-tint/35">
                          <td colSpan={8} className="px-3 py-2 @min-[65rem]/people-sheet:px-4">
                            <div className="max-w-[38rem] space-y-2 rounded-[10px] border border-settle-receivable-edge/35 bg-card px-3 py-2.5">
                              <p className="text-xs font-semibold text-foreground">{p.personName} <span className="font-normal text-muted-foreground">· Installment #{l.sequenceNumber}</span></p>
                              {active === "record" && <TheyPaidPanel {...target} installmentId={l.installmentId} personId={p.personId} onClose={close} />}
                              {active === "apply" && <AgreementPeopleReceipt line={l} onClose={close} />}
                              {active === "postpone" && <InstallmentPostpone line={l} agreementName={agreementName} onClose={close} />}
                              {!open && active !== "record" && <p className="text-xs text-success">This installment share is now fully received.</p>}
                            </div>
                          </td>
                        </tr>}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}

function InstallmentPostpone({ line, agreementName, onClose }: { line: AgreementPeopleLine; agreementName: string; onClose: () => void }) {
  const startDay = useMonthCycleStartDay();
  const { deferrals, isLoading } = usePersonPaymentDeferrals(line.personId);
  const actions = usePaymentDeferralActions();
  const [value, setValue] = useState(() => line.postponedDate ? toInputDate(line.postponedDate) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ value: string; revision: number; id: string } | null>(null);
  const inFlight = useRef(false);
  const now = new Date();
  const latest = line.dueDate > now ? line.dueDate : now;
  const min = new Date(latest.getFullYear(), latest.getMonth(), latest.getDate() + 1);
  const date = value ? new Date(`${value}T00:00:00`) : null;
  const valid = date != null && date >= min && line.remaining > PAYMENT_EPSILON;

  async function submit() {
    if (!date || !valid || isLoading || inFlight.current) return;
    const deferral = deferrals.find((d) => d.obligationKey === line.key);
    const revision = deferral?.revision ?? 0;
    if (!request.current || request.current.value !== value || request.current.revision !== revision) request.current = { value, revision, id: generateId() };
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      await actions.apply({ action: "postpone", requestId: request.current.id, expectedRevision: revision,
        personId: line.personId, obligationKey: line.key, obligationTitle: `${agreementName} · Installment #${line.sequenceNumber}`,
        obligationDate: line.dueDate, remaining: line.remaining, target: cycleContaining(date, startDay), targetDate: date,
        reason: deferral?.expected?.reason ?? null, note: deferral?.expected?.note ?? null, reminder: null, now, startDay,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't postpone this share. Please try again.");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2 text-xs">
      <label className="grid w-36 gap-1 font-medium text-foreground">Expected on
        <DateInput aria-label="Expected on" autoFocus className={PEOPLE_ROW_FIELD} value={value} min={toInputDate(min)} disabled={saving} onChange={(e) => setValue(e.target.value)} />
      </label>
      <button type="button" className={cn(PEOPLE_ROW_BUTTON, "border-primary-accent-text bg-primary text-primary-foreground hover:bg-primary/85")} disabled={!valid || isLoading || saving} onClick={() => void submit()}>{saving ? "Saving…" : "Save date"}</button>
      <button type="button" className={PEOPLE_ROW_BUTTON} disabled={saving} onClick={onClose}>Cancel</button>
      {error && <p role="alert" className="basis-full text-expense">{error}</p>}
      <p className="basis-full text-[11px] leading-snug text-muted-foreground">Collection can move to {dateText(min)} or later. The bank due date stays the same.</p>
    </div>
  );
}
