"use client";

/**
 * Read-only "definition checks" for the Financial Audit page: card balance vs derived outstanding, Dashboard vs
 * Reports debt, limits / shared limits, card-EMI locking, Loan / EMI outstanding. Reads the figures the app already
 * computes (live hooks) and re-derives them; nothing here writes, repairs or recalculates anything.
 */

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CHECK_AREA_LABEL, type CheckArea, type CheckFinding, type CheckStatus } from "@/lib/engines/balance-control-checks";
import { formatCurrencyPrecise } from "@/lib/format";
import { useBalanceControlData } from "../hooks/use-balance-control-data";

const STATUS_LABEL: Record<CheckStatus, string> = { confirmed: "Confirmed", suspected: "Suspected", legitimate: "Explained" };
const AREAS = Object.keys(CHECK_AREA_LABEL) as CheckArea[];

function Row({ f }: { f: CheckFinding }) {
  return (
    <li className="rounded-xl border border-border p-3 text-sm" data-testid="balance-check-finding">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={f.status === "confirmed" ? "destructive" : f.status === "suspected" ? "secondary" : "outline"}>{STATUS_LABEL[f.status]}</Badge>
        <span className="font-medium text-foreground">{f.title}</span>
        <span className="text-xs text-muted-foreground">{f.subject}</span>
      </div>
      <p className="mt-1 text-muted-foreground">{f.detail}</p>
      {f.figures && (
        <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {f.figures.map((x) => (
            <div key={x.label}><dt className="inline">{x.label}: </dt><dd className="inline tabular-nums text-foreground">{formatCurrencyPrecise(x.value)}</dd></div>
          ))}
        </dl>
      )}
    </li>
  );
}

export function BalanceChecksSection() {
  const { report, isLoading } = useBalanceControlData();
  const [area, setArea] = useState<CheckArea | "all">("all");
  const shown = useMemo(() => report.findings.filter((f) => area === "all" || f.area === area), [report, area]);

  return (
    <Card data-testid="balance-checks">
      <CardHeader>
        <CardTitle>Card, limit and debt definitions</CardTitle>
        <CardDescription>
          Read-only. Explained = a difference that comes from how a figure is defined (overpayment, net credit, a shared limit), not a mistake.
          {" "}{report.summary.confirmed} confirmed · {report.summary.suspected} suspected · {report.summary.legitimate} explained.
        </CardDescription>
        <div className="flex flex-wrap gap-2 pt-2">
          <button type="button" onClick={() => setArea("all")} className={`h-8 rounded-md border px-2.5 text-sm ${area === "all" ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>All</button>
          {AREAS.map((a) => (
            <button key={a} type="button" onClick={() => setArea(a)} className={`h-8 rounded-md border px-2.5 text-sm ${area === a ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>
              {CHECK_AREA_LABEL[a]} <span className="text-xs opacity-70">({report.checked[a]})</span>
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && report.findings.length === 0 ? (
          <p className="text-sm text-muted-foreground">Reading your cards, loans and EMIs…</p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">No findings for this selection.</p>
        ) : (
          <ul className="flex flex-col gap-2">{shown.map((f) => <Row key={f.id} f={f} />)}</ul>
        )}
      </CardContent>
    </Card>
  );
}
