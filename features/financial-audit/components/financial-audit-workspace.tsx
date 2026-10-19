"use client";

/**
 * Temporary, READ-ONLY Financial Audit. Reads the signed-in owner's own records (existing Firebase Auth session,
 * existing security rules), runs `runFinancialAudit`, and shows what disagrees. No button on this page writes,
 * reverses or repairs anything; "Proposed correction" is text for the owner to review. The only action is an
 * optional, user-initiated JSON export of the report.
 */

import { useCallback, useMemo, useState } from "react";
import { Download, RefreshCw, ScanSearch, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/lib/firebase/client";
import { auditReportToJson, runFinancialAudit, type AuditReport, type Finding } from "@/lib/engines/financial-audit";
import { inspectLegacyCaseA, type LegacyCaseAReport } from "@/lib/engines/legacy-card-emi-inspection";
import { formatCurrencyPrecise } from "@/lib/format";
import { useAuthStore } from "@/store/auth-store";
import { loadAuditData } from "../lib/load-audit-data";

type Filter = "all" | "confirmed" | "suspected";

const CATEGORY_LABEL: Record<string, string> = {
  "account-drift": "Account balance drift",
  "person-drift": "People balance drift",
  "split-drift": "Split expense links",
  "emi-no-account-movement": "EMI paid, no account movement",
  "installment-paid-mismatch": "Installment vs payment records",
  "loan-payment-link": "Loan payment links",
  "loan-emi-orphan-transaction": "Orphan loan/EMI transactions",
  "half-reversed": "Half-reversed payments",
  "people-receipt-link": "People receipts",
  "transfer-integrity": "Transfers & card payments",
  "duplicate-movement": "Possible duplicates",
  "orphan-account-link": "Missing account",
};

const fmt = (d: Date | null) => (d ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—");

function FindingRow({ f }: { f: Finding }) {
  return (
    <li className="rounded-xl border border-border p-3 text-sm" data-testid="audit-finding">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={f.status === "confirmed" ? "destructive" : "secondary"}>{f.status === "confirmed" ? "Confirmed" : "Suspected"}</Badge>
        <Badge variant="outline">{f.confidence} confidence</Badge>
        <span className="font-medium text-foreground">{f.title}</span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
        <div><dt className="inline">Date: </dt><dd className="inline text-foreground">{fmt(f.date)}</dd></div>
        <div><dt className="inline">Amount: </dt><dd className="inline text-foreground">{f.amount == null ? "—" : formatCurrencyPrecise(f.amount)}</dd></div>
        <div><dt className="inline">Account: </dt><dd className="inline text-foreground">{f.accountName ?? "—"}</dd></div>
        <div className="truncate"><dt className="inline">Records: </dt><dd className="inline text-foreground">{f.refs.map((r) => `${r.kind}:${r.id.slice(0, 10)}`).join(", ")}</dd></div>
      </dl>
      <p className="mt-2 text-muted-foreground">{f.reason}</p>
      <p className="mt-2 rounded-lg bg-muted/50 p-2 text-xs">
        <span className="font-medium text-foreground">Proposed correction (preview only, not applied): </span>
        {f.proposal.summary}
        {f.proposal.balanceDelta != null ? ` Balance change if applied: ${f.proposal.balanceDelta > 0 ? "+" : ""}${formatCurrencyPrecise(f.proposal.balanceDelta)}.` : ""}
      </p>
    </li>
  );
}

/** Read-only: old card-EMI payments that billed the principal again on top of the recorded purchase. Nothing here writes. */
function LegacyCaseASection({ report }: { report: LegacyCaseAReport }) {
  return (
    <Card data-testid="legacy-case-a">
      <CardHeader>
        <CardTitle>Card EMI payments that may have billed principal twice</CardTitle>
        <CardDescription>
          Read-only. For an EMI whose purchase is already on the card, older payments charged the whole installment to the card — the principal again. Nothing is changed or reconciled here.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {report.rows.length === 0 && report.unknown.length === 0 ? (
          <p className="text-muted-foreground">None found.</p>
        ) : (
          <>
            {report.cards.map((c) => (
              <div key={c.cardId} className="rounded-xl border border-border p-3" data-testid="legacy-case-a-card">
                <p className="font-medium text-foreground">{c.cardName}: {formatCurrencyPrecise(c.excessPrincipal)} billed twice across {c.affectedPayments} payment(s)</p>
                <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
                  <div><dt className="inline">Liability now: </dt><dd className="inline text-foreground">{formatCurrencyPrecise(c.liabilityNow)}</dd></div>
                  <div><dt className="inline">After removing it: </dt><dd className="inline text-foreground">{formatCurrencyPrecise(c.liabilityAfterRemoval)}</dd></div>
                  <div><dt className="inline">Available now: </dt><dd className="inline text-foreground">{c.availableNow == null ? "shared limit" : formatCurrencyPrecise(c.availableNow)}</dd></div>
                  <div><dt className="inline">Available after: </dt><dd className="inline text-foreground">{c.availableAfter == null ? `+${formatCurrencyPrecise(c.excessPrincipal)} (pooled)` : formatCurrencyPrecise(c.availableAfter)}</dd></div>
                </dl>
                {c.complication && <p className="mt-2 text-xs text-destructive">{c.complication}</p>}
              </div>
            ))}
            <ul className="flex flex-col gap-2">
              {report.rows.map((r) => (
                <li key={r.paymentId} className="rounded-xl border border-border p-3" data-testid="legacy-case-a-row">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{r.confidence} confidence</Badge>
                    <span className="font-medium text-foreground">{r.emiName} · {r.cardName} · {fmt(r.paymentDate)}</span>
                  </div>
                  <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-3">
                    <div><dt className="inline">Purchase: </dt><dd className="inline text-foreground">{r.purchase.description || "purchase"} {formatCurrencyPrecise(r.purchase.amount)} ({fmt(r.purchase.date)})</dd></div>
                    <div><dt className="inline">Card charge: </dt><dd className="inline text-foreground">{formatCurrencyPrecise(r.originalCardCharge)}</dd></div>
                    <div><dt className="inline">Principal in it: </dt><dd className="inline text-foreground">{formatCurrencyPrecise(r.principalPaid)}</dd></div>
                    <div><dt className="inline">Interest &amp; fees: </dt><dd className="inline text-foreground">{formatCurrencyPrecise(r.interestAndFees)}</dd></div>
                    <div><dt className="inline">Current rule would charge: </dt><dd className="inline text-foreground">{formatCurrencyPrecise(r.expectedCardCharge)}</dd></div>
                    <div><dt className="inline">Excess: </dt><dd className="inline font-semibold text-destructive">{formatCurrencyPrecise(r.excessPrincipal)}</dd></div>
                  </dl>
                  {r.notes.map((n) => <p key={n} className="mt-1 text-xs text-muted-foreground">{n}</p>)}
                </li>
              ))}
            </ul>
            {report.unknown.length > 0 && (
              <div className="rounded-xl border border-border p-3" data-testid="legacy-case-a-unknown">
                <p className="font-medium text-foreground">Could not be assessed ({report.unknown.length})</p>
                <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                  {report.unknown.map((u) => <li key={u.paymentId}>{u.emiName}: {u.reason}</li>)}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function FinancialAuditWorkspace() {
  const uid = useAuthStore((s) => s.user?.uid);
  const [report, setReport] = useState<AuditReport | null>(null);
  const [legacyCaseA, setLegacyCaseA] = useState<LegacyCaseAReport | null>(null);
  const [meta, setMeta] = useState<{ skipped: Record<string, number>; counts: Record<string, number> } | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [category, setCategory] = useState<string>("all");

  const run = useCallback(async () => {
    if (!uid) return;
    setState("loading");
    setError(null);
    try {
      const loaded = await loadAuditData(db, uid);
      setReport(runFinancialAudit(loaded.input));
      setLegacyCaseA(
        inspectLegacyCaseA({
          emis: loaded.input.emis,
          cards: loaded.cardEmi.cards,
          accounts: loaded.input.accounts,
          transactions: loaded.input.transactions,
          payments: loaded.input.payments,
          breakdowns: loaded.cardEmi.breakdowns,
        }),
      );
      setMeta({ skipped: loaded.skipped, counts: loaded.counts });
      setState("idle");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The audit could not read your records.");
      setState("error");
    }
  }, [uid]);

  const shown = useMemo(
    () => (report?.findings ?? []).filter((f) => (filter === "all" || f.status === filter) && (category === "all" || f.category === category)),
    [report, filter, category],
  );

  const exportReport = () => {
    if (!report) return;
    const blob = new Blob([auditReportToJson(report)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flowfi-audit-${report.generatedAt.toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const drifting = report?.accounts.filter((a) => Math.abs(a.difference) >= 0.005) ?? [];

  return (
    <div className="flex flex-col gap-5 px-1">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-2xl bg-primary/10 text-primary-accent-text">
          <ScanSearch className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="font-heading text-xl font-semibold tracking-tight text-foreground">Financial Audit</h1>
          <p className="flex items-center gap-1 text-sm text-muted-foreground">
            <ShieldCheck className="size-4" /> Read-only. Nothing here changes a balance, payment or record.
          </p>
        </div>
        <Button onClick={run} disabled={!uid || state === "loading"} data-testid="run-audit">
          <RefreshCw className={state === "loading" ? "size-4 animate-spin" : "size-4"} />
          {report ? "Run again" : "Run audit"}
        </Button>
        <Button variant="outline" onClick={exportReport} disabled={!report} data-testid="export-audit">
          <Download className="size-4" /> Export report
        </Button>
      </div>

      {state === "error" && <p className="rounded-xl border border-destructive/40 p-3 text-sm text-destructive">{error}</p>}
      {!report && state !== "loading" && (
        <Card><CardContent className="p-4 text-sm text-muted-foreground">Press “Run audit” to read your accounts, transactions, People ledger, Loans and EMIs and compare them. It only reads.</CardContent></Card>
      )}

      {report && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card><CardHeader><CardDescription>Confirmed</CardDescription><CardTitle>{report.summary.confirmed}</CardTitle></CardHeader></Card>
            <Card><CardHeader><CardDescription>Suspected (historical)</CardDescription><CardTitle>{report.summary.suspected}</CardTitle></CardHeader></Card>
            <Card><CardHeader><CardDescription>Possibly unposted payments</CardDescription><CardTitle>{formatCurrencyPrecise(report.summary.possibleUnpostedPayments)}</CardTitle></CardHeader></Card>
            <Card><CardHeader><CardDescription>Historical, account-neutral</CardDescription><CardTitle>{formatCurrencyPrecise(report.summary.historicalNeutral.total)}</CardTitle></CardHeader></Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Account balances: stored vs calculated</CardTitle>
              <CardDescription>Calculated = opening balance + all active transactions. Difference = stored − calculated.</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="account-table">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr><th className="py-1">Account</th><th className="text-right">Stored</th><th className="text-right">Calculated</th><th className="text-right">Difference</th></tr>
                </thead>
                <tbody>
                  {report.accounts.map((a) => (
                    <tr key={a.id} className="border-t border-border">
                      <td className="py-1.5">{a.name} <span className="text-xs text-muted-foreground">({a.type}, {a.activeTransactions} txns)</span></td>
                      <td className="text-right tabular-nums">{formatCurrencyPrecise(a.stored)}</td>
                      <td className="text-right tabular-nums">{formatCurrencyPrecise(a.computed)}</td>
                      <td className={`text-right tabular-nums ${Math.abs(a.difference) >= 0.005 ? "font-semibold text-destructive" : "text-muted-foreground"}`}>
                        {Math.abs(a.difference) >= 0.005 ? formatCurrencyPrecise(a.difference) : "matches"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {drifting.some((a) => a.explanationCandidates.length > 0) && (
                <ul className="mt-3 list-disc pl-5 text-xs text-muted-foreground">
                  {drifting.flatMap((a) => a.explanationCandidates.map((c) => <li key={`${a.id}${c}`}>{a.name}: possibly explained by {c}</li>))}
                </ul>
              )}
              {report.people.some((p) => Math.abs(p.difference) >= 0.005) && (
                <p className="mt-3 text-xs text-destructive">
                  People balances out of step: {report.people.filter((p) => Math.abs(p.difference) >= 0.005).map((p) => `${p.name} ${formatCurrencyPrecise(p.difference)}`).join(", ")}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Findings</CardTitle>
              <CardDescription>
                Confirmed = the records contradict each other. Suspected = fits a historical gap; the money may already be in an opening balance, so do not assume it is missing.
              </CardDescription>
              <div className="flex flex-wrap gap-2 pt-2">
                {(["all", "confirmed", "suspected"] as const).map((f) => (
                  <Button key={f} size="sm" variant={filter === f ? "default" : "outline"} onClick={() => setFilter(f)}>{f}</Button>
                ))}
                <select
                  className="h-8 rounded-md border border-border bg-background px-2 text-sm"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  aria-label="Category"
                >
                  <option value="all">All categories</option>
                  {Object.keys(report.summary.byCategory).map((c) => (
                    <option key={c} value={c}>{CATEGORY_LABEL[c] ?? c} ({report.summary.byCategory[c].confirmed + report.summary.byCategory[c].suspected})</option>
                  ))}
                </select>
              </div>
            </CardHeader>
            <CardContent>
              {shown.length === 0 ? (
                <p className="text-sm text-muted-foreground">No findings for this filter.</p>
              ) : (
                <ul className="flex flex-col gap-2">{shown.map((f) => <FindingRow key={f.id} f={f} />)}</ul>
              )}
            </CardContent>
          </Card>

          {legacyCaseA && <LegacyCaseASection report={legacyCaseA} />}

          <p className="text-xs text-muted-foreground">
            Read {Object.entries(meta?.counts ?? {}).map(([k, v]) => `${v} ${k}`).join(", ")}.
            {Object.keys(meta?.skipped ?? {}).length > 0 && ` Could not read: ${Object.entries(meta!.skipped).map(([k, v]) => `${v} ${k}`).join(", ")}.`}{" "}
            Not covered: bill payments, card statements, savings (EMI breakdowns are read only for card-linked EMIs). Generated {report.generatedAt.toLocaleString()}.
          </p>
        </>
      )}
    </div>
  );
}
