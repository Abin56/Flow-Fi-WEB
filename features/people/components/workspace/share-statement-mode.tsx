"use client";

import { ArrowDownLeft, ArrowUpRight, Check, ChevronDown, Copy, FileDown, MessageCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { usePersonCycleStatement } from "@/features/people/hooks/use-person-cycle-statement";
import { usePersonPendingSplitParticipants } from "@/features/people/hooks/use-person-pending-split-participants";
import { useSettlementLookups } from "@/features/people/hooks/use-settlement-lookups";
import { renderPersonStatementPdf } from "@/features/people/lib/person-statement-pdf";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import { STATEMENT_COPY, statementView, type StatementViewOptions, type StatementViewRow } from "@/features/people/lib/person-statement-pdf-model";
import type { SettlementStatusTone } from "@/features/people/lib/settlement-presentation";
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { sharedPositionLine, statementShareText, whatsAppShareUrl } from "@/lib/engines/person-cycle-statement-share";
import { SplitAllocationBreakdown } from "@/components/finance/split-allocation-breakdown";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/auth-store";
import { toast } from "@/store/toast-store";
import { StatementCalculation } from "../cycle-statement/statement-parts";
import { ModeFooter, ModeHeader, WS_PAD, WS_PRIMARY, WS_SECONDARY, WsLabel } from "./person-workspace-ui";
import { CyclePaymentHistory, CycleReconciliation } from "./settlement-summary";

/**
 * Share mode — a preview of exactly what the PDF contains (position, the cycle's reconciliation, every
 * item with original / paid / remaining and its status, and the payment history), plus WhatsApp / Copy /
 * PDF. The preview and the PDF read one `statementView`; the text message is the engine's summary.
 */
export function ShareStatementMode({
  statement,
  phone,
  onBack,
}: {
  statement: PersonCycleStatement;
  phone?: string | null;
  onBack: () => void;
}) {
  const [pdfBusy, setPdfBusy] = useState(false);
  const [messageOpen, setMessageOpen] = useState(false);
  // Read-only context that sharpens the wording (assigned vs split, later payments, accounts) — never a figure.
  const { allTimeStatement, ledgerEntries } = usePersonCycleStatement(statement.personId, statement.cycle);
  const { pending } = usePersonPendingSplitParticipants(statement.personId);
  const lookups = useSettlementLookups(ledgerEntries, pending);
  const cycleStartDay = useMonthCycleStartDay();
  // The statement is read by the person, so the owner is named from their profile — never "You".
  const ownerName = useAuthStore((s) => s.user?.displayName ?? null);
  const options = useMemo<StatementViewOptions>(
    () => ({ entries: ledgerEntries, history: allTimeStatement, lookups, accountForEntry: lookups.accountForEntry, cycleStartDay, ownerName }),
    [ledgerEntries, allTimeStatement, lookups, cycleStartDay, ownerName],
  );
  const view = useMemo(() => statementView(statement, options), [statement, options]);
  const text = statementShareText(statement);
  const first = statement.personName.split(" ")[0];
  const tone =
    statement.direction === "theyOwe" ? "text-settle-receivable-text" : statement.direction === "iOwe" ? "text-settle-payable-text" : "text-success";
  const edge =
    statement.direction === "theyOwe" ? "border-l-settle-receivable-edge" : statement.direction === "iOwe" ? "border-l-settle-payable-edge" : "border-l-success";
  const DirectionIcon = statement.direction === "theyOwe" ? ArrowDownLeft : statement.direction === "iOwe" ? ArrowUpRight : Check;

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Statement copied");
    } catch {
      toast.error("Couldn't copy — your browser blocked clipboard access");
    }
  };

  const downloadPdf = async () => {
    setPdfBusy(true);
    try {
      const bytes = await renderPersonStatementPdf(statement, options);
      const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `FlowFi-${statement.personName.replace(/[^\w]+/g, "-")}-${statement.cycleLabel.replace(/[^\w]+/g, "-")}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast.error("Couldn't create the PDF");
    } finally {
      setPdfBusy(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col">
      <ModeHeader backLabel="Close" onBack={onBack} onClose={onBack} title="Share Statement" subtitle={`${statement.personName} · ${statement.cycleLabel}`} />

      <div className={cn(WS_PAD, "mt-5 flex-1")}>
        <div className="grid gap-x-8 gap-y-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
          {/* The statement — the same content as the PDF, framed as a page so it never blends into the workspace */}
          <div className="min-w-0 rounded-[8px] border border-border-strong bg-card p-4 shadow-[0_1px_2px_rgba(0,0,0,0.06),0_10px_28px_-14px_rgba(0,0,0,0.22)] sm:p-6">
            <div className="grid gap-x-6 gap-y-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,19rem)]">
              <div className="min-w-0">
                <p className="text-[11.5px] font-semibold text-foreground/70">Settlement · {statement.cycleLabel}</p>
                <p className="text-[11px] text-foreground/60">Prepared by {view.ownerName}</p>
                <div className={cn("mt-1.5 border-l-[4px] pl-3", edge)}>
                  <p className={cn("inline-flex items-center gap-1.5 text-[13px] font-bold tracking-[0.08em] uppercase", tone)}>
                    <DirectionIcon className="size-4" strokeWidth={2.5} aria-hidden />
                    {view.headline}
                  </p>
                  <p className={cn("font-heading text-[32px] leading-tight font-bold tracking-tight tabular-nums", statement.direction === "settled" ? "text-foreground" : tone)}>
                    {view.amount}
                  </p>
                </div>
              </div>
              <CycleReconciliation statement={statement} personName={statement.personName} />
            </div>

            <div className="mt-5 flex items-baseline justify-between gap-3">
              <WsLabel>Transactions · {view.carried.length + view.rows.length}</WsLabel>
              <span className="text-[11px] font-medium text-foreground/60">Paid and remaining as of {view.asOf}</span>
            </div>
            {view.rows.length === 0 && view.carried.length === 0 ? (
              <p className="mt-1 border-y border-border-strong/70 py-3 text-sm font-medium text-foreground/75">{STATEMENT_COPY.empty}</p>
            ) : (
              <div className="mt-1.5 max-h-[26rem] space-y-1.5 overflow-y-auto">
                {view.carried.length > 0 && (
                  <>
                    <GroupCaption label={STATEMENT_COPY.carried.label} note={STATEMENT_COPY.carried.note} />
                    <ul className="space-y-1.5">{view.carried.map((r) => <StatementItem key={`c${r.no}`} row={r} focusCaption={`${first}'s share`} />)}</ul>
                    <GroupCaption label={STATEMENT_COPY.current} note={view.cycleLabel} />
                  </>
                )}
                {view.rows.length === 0 ? (
                  <p className="px-3 py-2.5 text-[13px] font-medium text-foreground/70">{STATEMENT_COPY.empty}</p>
                ) : (
                  <ul className="space-y-1.5">{view.rows.map((r) => <StatementItem key={r.no} row={r} focusCaption={`${first}'s share`} />)}</ul>
                )}
              </div>
            )}

            <CyclePaymentHistory statement={statement} personName={statement.personName} accountForEntry={lookups.accountForEntry} incomeForEntry={lookups.incomeForEntry} className="mt-4" />

            <details className="group mt-3">
              <summary className="flex cursor-pointer list-none items-center justify-between py-1 text-xs font-medium text-foreground/70 hover:text-foreground">
                Running calculation
                <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" strokeWidth={1.75} />
              </summary>
              <div className="mt-1.5 rounded-[6px] bg-secondary/60 p-3">
                <StatementCalculation statement={statement} />
              </div>
            </details>
          </div>

          {/* What gets sent */}
          <div className="min-w-0 lg:border-l lg:border-border lg:pl-6">
            <WsLabel>Sent as</WsLabel>
            <p className="mt-1.5 text-sm font-medium text-foreground">“{sharedPositionLine(statement)}”</p>
            <p className="mt-2 text-xs text-foreground/70">
              The PDF contains everything on the left. The WhatsApp / text message is a short summary.
            </p>
            <button
              type="button"
              aria-expanded={messageOpen}
              onClick={() => setMessageOpen((o) => !o)}
              className="mt-3 flex w-full items-center justify-between py-1 text-xs font-medium text-foreground/70 hover:text-foreground"
            >
              Message preview
              <ChevronDown className={cn("size-3.5 transition-transform", messageOpen && "rotate-180")} strokeWidth={1.75} />
            </button>
            <div
              className={cn(
                "grid transition-[grid-template-rows,opacity] duration-200 ease-out lg:grid-rows-[1fr] lg:opacity-100",
                messageOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
              )}
            >
              <div className="overflow-hidden">
                <pre className="mt-1.5 max-h-72 overflow-y-auto rounded-[6px] border border-border bg-secondary/80 p-3 font-sans text-xs whitespace-pre-wrap text-foreground">
                  {text}
                </pre>
              </div>
            </div>
          </div>
        </div>
      </div>

      <ModeFooter className="justify-stretch sm:justify-end">
        <button type="button" onClick={copyText} className={cn(WS_SECONDARY, "flex-1 sm:flex-none")}>
          <Copy className="size-4" strokeWidth={1.75} />
          Copy Text
        </button>
        <button type="button" onClick={downloadPdf} disabled={pdfBusy} className={cn(WS_SECONDARY, "flex-1 sm:flex-none")}>
          <FileDown className="size-4" strokeWidth={1.75} />
          {pdfBusy ? "Creating…" : "PDF"}
        </button>
        <button
          type="button"
          onClick={() => window.open(whatsAppShareUrl(text, phone), "_blank", "noopener,noreferrer")}
          className={cn(WS_PRIMARY, "flex-1 sm:flex-none")}
        >
          <MessageCircle className="size-4" strokeWidth={1.75} />
          WhatsApp
        </button>
      </ModeFooter>
    </div>
  );
}

/** The PDF's status colours: semantic only where the state means something (due / part-paid / paid / overdue), neutral otherwise. */
const STATUS_CLASS: Record<SettlementStatusTone, string> = {
  due: "bg-settle-emi-badge/55 text-settle-emi-text",
  payable: "bg-settle-carried-badge text-settle-carried-text",
  partial: "bg-settle-emi-badge text-settle-emi-text",
  settled: "bg-settle-receivable-badge text-settle-receivable-text",
  overdue: "bg-settle-payable-badge text-settle-payable-text",
  upcoming: "bg-settle-carried-badge text-settle-carried-text",
  received: "bg-settle-receivable-badge text-settle-receivable-text",
  paid: "bg-settle-carried-badge text-settle-carried-text",
  neutral: "bg-settle-carried-badge text-settle-carried-text",
};

function GroupCaption({ label, note }: { label: string; note: string }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 rounded-[4px] border-l-[3px] border-l-foreground/45 bg-secondary px-3 py-1 text-[11px]">
      <span className="font-semibold whitespace-nowrap text-foreground">{label}</span>
      <span className="text-foreground/70">{note}</span>
    </p>
  );
}

/**
 * One statement transaction — the same information architecture as a PDF row: description and metadata,
 * a neutral type badge, the row's amount named for what it is (`amountLabel`), paid / remaining, the status,
 * and for a split the full stored allocation as part of the same item.
 */
function StatementItem({ row: r, focusCaption }: { row: StatementViewRow; focusCaption: string }) {
  return (
    <li data-carried={r.carried || undefined} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 rounded-[6px] border border-border-strong bg-card px-3 py-2.5">
      <div className="min-w-0">
        <p className="flex min-w-0 items-baseline gap-1.5">
          <span className="text-[11px] text-foreground/55 tabular-nums">{r.no}</span>
          <span className="min-w-0 text-[13.5px] font-semibold break-words text-foreground">{r.title}</span>
        </p>
        <p className="text-[11.5px] break-words text-foreground/65">
          {r.date} · {r.carried && r.fromCycle ? `From ${r.fromCycle} · ` : ""}{r.relation}
        </p>
        {/* One-line split context — only when the full allocation below isn't available (legacy data). */}
        {r.splitNote && !r.allocation && <p className="text-[11px] leading-snug text-foreground/60 tabular-nums">{r.splitNote}</p>}
      </div>
      <div className="flex items-start justify-end">
        <span className="inline-flex h-5 items-center rounded-[4px] border border-border-strong bg-card px-1.5 text-[10.5px] font-semibold whitespace-nowrap text-foreground/75">{r.typeLabel}</span>
      </div>
      {r.allocation && (
        <SplitAllocationBreakdown allocation={r.allocation} variant="compact" focusCaption={focusCaption} className="col-span-2 max-w-3xl border-border-strong/70" />
      )}
      <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11.5px]">
        {r.original && (
          <div className="flex gap-1"><dt className="text-foreground/60">{r.amountLabel}</dt><dd className="font-semibold text-foreground tabular-nums">{r.original}</dd></div>
        )}
        {r.paid && (
          <div className="flex gap-1"><dt className="text-foreground/60">Paid</dt><dd className="font-semibold text-foreground tabular-nums">{r.paid}</dd></div>
        )}
        {r.remaining && (
          <div className="flex gap-1"><dt className="text-foreground/60">Remaining</dt><dd className="font-bold text-foreground tabular-nums">{r.remaining}</dd></div>
        )}
      </dl>
      <div className="flex min-w-0 flex-col items-end">
        <span className={cn("inline-flex h-5 items-center rounded-[4px] border border-current/30 px-1.5 text-[10.5px] font-semibold whitespace-nowrap", STATUS_CLASS[r.statusTone])}>{r.status}</span>
        {r.statusDetail && <span className="max-w-[14rem] truncate text-[10.5px] text-foreground/60">{r.statusDetail}</span>}
      </div>
    </li>
  );
}
