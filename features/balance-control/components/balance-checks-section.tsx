"use client";

/**
 * Read-only "definition checks" for the Financial Audit page: card balance vs derived outstanding, Dashboard vs
 * Reports debt, limits / shared limits, card-EMI locking, Loan / EMI outstanding. Reads the figures the app already
 * computes (live hooks) and re-derives them; nothing here writes, repairs or recalculates anything.
 */

import { useMemo, useState } from "react";
import { BookCheck, CircleCheck, CircleHelp, TriangleAlert } from "lucide-react";
import { CHECK_AREA_LABEL, type CheckArea, type CheckFinding, type CheckStatus } from "@/lib/engines/balance-control-checks";
import { formatCurrencyPrecise } from "@/lib/format";
import { AuditPanel, Fact, FilterChip, Pill, RailItem, type Tone } from "@/features/financial-audit/components/audit-ui";
import { useBalanceControlData } from "../hooks/use-balance-control-data";

const STATUS_LABEL: Record<CheckStatus, string> = { confirmed: "Confirmed", suspected: "Suspected", legitimate: "Explained" };
const STATUS_TONE: Record<CheckStatus, Tone> = { confirmed: "danger", suspected: "warning", legitimate: "success" };
const STATUS_ICON = { confirmed: TriangleAlert, suspected: CircleHelp, legitimate: CircleCheck } as const;
const AREAS = Object.keys(CHECK_AREA_LABEL) as CheckArea[];

function Row({ f }: { f: CheckFinding }) {
  const Icon = STATUS_ICON[f.status];
  return (
    <RailItem tone={STATUS_TONE[f.status]} testId="balance-check-finding">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={STATUS_TONE[f.status]}>
          <Icon className="size-3" aria-hidden /> {STATUS_LABEL[f.status]}
        </Pill>
        <span className="font-medium text-foreground">{f.title}</span>
        <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">{f.subject}</span>
      </div>
      <p className="mt-2 leading-relaxed text-muted-foreground">{f.detail}</p>
      {f.figures && (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg bg-muted/50 p-3 sm:grid-cols-3 lg:grid-cols-5">
          {f.figures.map((x) => (
            <Fact key={x.label} label={x.label} tone={f.status === "confirmed" && /unexplained/i.test(x.label) ? "danger" : undefined}>
              {formatCurrencyPrecise(x.value)}
            </Fact>
          ))}
        </dl>
      )}
    </RailItem>
  );
}

export function BalanceChecksSection() {
  const { report, isLoading } = useBalanceControlData();
  const [area, setArea] = useState<CheckArea | "all">("all");
  const shown = useMemo(() => report.findings.filter((f) => area === "all" || f.area === area), [report, area]);

  return (
    <AuditPanel
      testId="balance-checks"
      icon={BookCheck}
      title="Card, limit and debt definitions"
      description="Read-only. Explained = a difference that comes from how a figure is defined (overpayment, net credit, a shared limit), not a mistake."
      headerExtra={
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-1.5">
            <Pill tone={report.summary.confirmed > 0 ? "danger" : "neutral"}>{report.summary.confirmed} confirmed</Pill>
            <Pill tone={report.summary.suspected > 0 ? "warning" : "neutral"}>{report.summary.suspected} suspected</Pill>
            <Pill tone={report.summary.legitimate > 0 ? "success" : "neutral"}>{report.summary.legitimate} explained</Pill>
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by area">
            <FilterChip active={area === "all"} onClick={() => setArea("all")}>All</FilterChip>
            {AREAS.map((a) => (
              <FilterChip key={a} active={area === a} onClick={() => setArea(a)} count={report.checked[a]}>{CHECK_AREA_LABEL[a]}</FilterChip>
            ))}
          </div>
        </div>
      }
    >
      {isLoading && report.findings.length === 0 ? (
        <p className="text-sm text-muted-foreground">Reading your cards, loans and EMIs…</p>
      ) : shown.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><CircleCheck className="size-4 text-success" aria-hidden /> No findings for this selection.</p>
      ) : (
        <ul className="flex flex-col gap-3">{shown.map((f) => <Row key={f.id} f={f} />)}</ul>
      )}
    </AuditPanel>
  );
}
