"use client";

/**
 * Temporary, READ-ONLY Financial Audit. Reads the signed-in owner's own records (existing Firebase Auth session,
 * existing security rules), runs `runFinancialAudit`, and shows what disagrees. No button on this page writes,
 * reverses or repairs anything; "Proposed correction" is text for the owner to review. The only action is an
 * optional, user-initiated JSON export of the report.
 */

import { useCallback, useMemo, useState } from "react";
import { ArrowLeftRight, CircleAlert, CircleCheck, Download, Inbox, Landmark, ListChecks, Lock, RefreshCw, Repeat2, ScanSearch, ShieldCheck, TriangleAlert, Wallet } from "lucide-react";
import { ScrollNav } from "@/components/layout/scroll-nav";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { db } from "@/lib/firebase/client";
import { auditReportToJson, runFinancialAudit, type AuditReport, type Finding } from "@/lib/engines/financial-audit";
import { inspectLegacyCaseA, type LegacyCaseAReport } from "@/lib/engines/legacy-card-emi-inspection";
import { formatCurrencyPrecise } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/auth-store";
import { BalanceChecksSection } from "@/features/balance-control/components/balance-checks-section";
import { loadAuditData } from "../lib/load-audit-data";
import { AuditPanel, Fact, FilterChip, Pill, RailItem, StatTile } from "./audit-ui";

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
  const confirmed = f.status === "confirmed";
  return (
    <RailItem tone={confirmed ? "danger" : "warning"} testId="audit-finding">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={confirmed ? "danger" : "warning"}>
          {confirmed ? <TriangleAlert className="size-3" aria-hidden /> : <CircleAlert className="size-3" aria-hidden />}
          {confirmed ? "Confirmed" : "Suspected"}
        </Pill>
        <Pill>{f.confidence} confidence</Pill>
        <span className="font-medium text-foreground">{f.title}</span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Fact label="Date">{fmt(f.date)}</Fact>
        <Fact label="Amount">{f.amount == null ? "—" : formatCurrencyPrecise(f.amount)}</Fact>
        <Fact label="Account">{f.accountName ?? "—"}</Fact>
        <Fact label="Records">{f.refs.map((r) => `${r.kind}:${r.id.slice(0, 10)}`).join(", ")}</Fact>
      </dl>
      <p className="mt-3 leading-relaxed text-muted-foreground">{f.reason}</p>
      <p className="mt-3 flex items-start gap-2 rounded-lg border border-dashed border-border-strong bg-muted/40 p-3 text-xs leading-relaxed">
        <Lock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span>
          <span className="font-medium text-foreground">Proposed correction (preview only, not applied): </span>
          {f.proposal.summary}
          {f.proposal.balanceDelta != null ? ` Balance change if applied: ${f.proposal.balanceDelta > 0 ? "+" : ""}${formatCurrencyPrecise(f.proposal.balanceDelta)}.` : ""}
        </span>
      </p>
    </RailItem>
  );
}

/** Read-only: old card-EMI payments that billed the principal again on top of the recorded purchase. Nothing here writes. */
function LegacyCaseASection({ report }: { report: LegacyCaseAReport }) {
  return (
    <AuditPanel
      testId="legacy-case-a"
      icon={Repeat2}
      title="Card EMI payments that may have billed principal twice"
      description="Read-only. For an EMI whose purchase is already on the card, older payments charged the whole installment to the card — the principal again. Nothing is changed or reconciled here."
    >
      <div className="flex flex-col gap-3 text-sm">
        {report.rows.length === 0 && report.unknown.length === 0 ? (
          <p className="flex items-center gap-2 text-muted-foreground"><CircleCheck className="size-4 text-success" aria-hidden /> None found.</p>
        ) : (
          <>
            {report.cards.map((c) => (
              <div key={c.cardId} className="rounded-xl border border-warning/50 bg-warning/10 p-4" data-testid="legacy-case-a-card">
                <p className="font-medium text-foreground">{c.cardName}: {formatCurrencyPrecise(c.excessPrincipal)} billed twice across {c.affectedPayments} payment(s)</p>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                  <Fact label="Liability now">{formatCurrencyPrecise(c.liabilityNow)}</Fact>
                  <Fact label="After removing it">{formatCurrencyPrecise(c.liabilityAfterRemoval)}</Fact>
                  <Fact label="Available now">{c.availableNow == null ? "shared limit" : formatCurrencyPrecise(c.availableNow)}</Fact>
                  <Fact label="Available after">{c.availableAfter == null ? `+${formatCurrencyPrecise(c.excessPrincipal)} (pooled)` : formatCurrencyPrecise(c.availableAfter)}</Fact>
                </dl>
                {c.complication && <p className="mt-3 text-xs text-destructive">{c.complication}</p>}
              </div>
            ))}
            <ul className="flex flex-col gap-3">
              {report.rows.map((r) => (
                <RailItem key={r.paymentId} tone="warning" testId="legacy-case-a-row">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill>{r.confidence} confidence</Pill>
                    <span className="font-medium text-foreground">{r.emiName} · {r.cardName} · {fmt(r.paymentDate)}</span>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
                    <Fact label="Purchase">{r.purchase.description || "purchase"} {formatCurrencyPrecise(r.purchase.amount)} ({fmt(r.purchase.date)})</Fact>
                    <Fact label="Card charge">{formatCurrencyPrecise(r.originalCardCharge)}</Fact>
                    <Fact label="Principal in it">{formatCurrencyPrecise(r.principalPaid)}</Fact>
                    <Fact label="Interest &amp; fees">{formatCurrencyPrecise(r.interestAndFees)}</Fact>
                    <Fact label="Current rule would charge">{formatCurrencyPrecise(r.expectedCardCharge)}</Fact>
                    <Fact label="Excess" tone="danger">{formatCurrencyPrecise(r.excessPrincipal)}</Fact>
                  </dl>
                  {r.notes.map((n) => <p key={n} className="mt-2 text-xs text-muted-foreground">{n}</p>)}
                </RailItem>
              ))}
            </ul>
            {report.unknown.length > 0 && (
              <div className="rounded-xl border border-dashed border-border-strong p-4" data-testid="legacy-case-a-unknown">
                <p className="font-medium text-foreground">Could not be assessed ({report.unknown.length})</p>
                <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                  {report.unknown.map((u) => <li key={u.paymentId}>{u.emiName}: {u.reason}</li>)}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </AuditPanel>
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
    <div className="flex flex-col gap-5 px-1 pb-6">
      <header className="flex flex-wrap items-start gap-3 sm:gap-4">
        <span className="hidden size-11 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-e2 sm:flex">
          <ScanSearch className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-heading text-xl font-semibold tracking-tight text-foreground sm:text-2xl">Financial Audit</h1>
            <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-card px-2 text-[11px] font-medium text-muted-foreground">
              <Lock className="size-3" aria-hidden /> Read-only
            </span>
          </div>
          <p className="mt-1 flex items-start gap-1.5 text-sm text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            <span className="min-w-0">Read-only. Nothing here changes a balance, payment or record.</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={run} disabled={!uid || state === "loading"} data-testid="run-audit" className="shadow-e1">
            <RefreshCw className={state === "loading" ? "size-4 animate-spin" : "size-4"} />
            {report ? "Run again" : "Run audit"}
          </Button>
          <Button variant="outline" onClick={exportReport} disabled={!report} data-testid="export-audit" className="bg-card shadow-e1">
            <Download className="size-4" /> Export report
          </Button>
        </div>
      </header>

      <BalanceChecksSection />

      {state === "error" && (
        <div role="alert" className="flex items-start gap-3 rounded-2xl border border-destructive/35 bg-destructive/5 p-4 text-sm text-destructive">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-destructive/10"><CircleAlert className="size-4" aria-hidden /></span>
          <p className="min-w-0 self-center leading-relaxed">{error}</p>
        </div>
      )}
      {state === "loading" && !report && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-busy>
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
        </div>
      )}
      {!report && state !== "loading" && (
        <div className="surface-primary flex flex-col items-center gap-3 rounded-2xl border-dashed px-6 py-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-accent text-primary-accent-text"><ListChecks className="size-6" aria-hidden /></span>
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">Press “Run audit” to read your accounts, transactions, People ledger, Loans and EMIs and compare them. It only reads.</p>
        </div>
      )}

      {report && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile icon={TriangleAlert} label="Confirmed" value={report.summary.confirmed} tone={report.summary.confirmed > 0 ? "danger" : "success"} hint={report.summary.confirmed > 0 ? "Records contradict each other" : "Nothing contradicts"} />
            <StatTile icon={CircleAlert} label="Suspected (historical)" value={report.summary.suspected} tone={report.summary.suspected > 0 ? "warning" : "success"} />
            <StatTile icon={Wallet} label="Possibly unposted payments" value={formatCurrencyPrecise(report.summary.possibleUnpostedPayments)} tone={report.summary.possibleUnpostedPayments > 0 ? "warning" : "neutral"} />
            <StatTile icon={ArrowLeftRight} label="Historical, account-neutral" value={formatCurrencyPrecise(report.summary.historicalNeutral.total)} />
          </div>

          <AuditPanel
            icon={Landmark}
            title="Account balances: stored vs calculated"
            description="Calculated = opening balance + all active transactions. Difference = stored − calculated."
            headerExtra={
              <div className="flex flex-wrap gap-1.5">
                <Pill tone={drifting.length > 0 ? "danger" : "success"}>
                  {drifting.length > 0 ? <TriangleAlert className="size-3" aria-hidden /> : <CircleCheck className="size-3" aria-hidden />}
                  {drifting.length > 0 ? `${drifting.length} out of step` : "All accounts match"}
                </Pill>
              </div>
            }
          >
            <div className="-mx-4 overflow-x-auto sm:-mx-5">
              <table className="w-full min-w-[34rem] text-sm" data-testid="account-table">
                <thead className="text-left text-[11px] tracking-wide text-muted-foreground uppercase">
                  <tr>
                    <th className="px-4 pb-2 font-medium sm:px-5">Account</th>
                    <th className="px-2 pb-2 text-right font-medium">Stored</th>
                    <th className="px-2 pb-2 text-right font-medium">Calculated</th>
                    <th className="px-4 pb-2 text-right font-medium sm:px-5">Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {report.accounts.map((a) => {
                    const drift = Math.abs(a.difference) >= 0.005;
                    return (
                      <tr key={a.id} className={cn("border-t border-border transition-colors hover:bg-muted/40", drift && "bg-destructive/[0.04]")}>
                        <td className="px-4 py-2.5 sm:px-5">
                          <span className="font-medium text-foreground">{a.name}</span>{" "}
                          <span className="text-xs text-muted-foreground">({a.type}, {a.activeTransactions} txns)</span>
                        </td>
                        <td className="px-2 py-2.5 text-right tabular-nums">{formatCurrencyPrecise(a.stored)}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums">{formatCurrencyPrecise(a.computed)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums sm:px-5">
                          {drift ? (
                            <span className="inline-flex rounded-full bg-destructive/10 px-2 py-0.5 font-semibold text-destructive">{formatCurrencyPrecise(a.difference)}</span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-success"><CircleCheck className="size-3.5" aria-hidden /> matches</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {drifting.some((a) => a.explanationCandidates.length > 0) && (
              <ul className="mt-3 list-disc pl-5 text-xs text-muted-foreground">
                {drifting.flatMap((a) => a.explanationCandidates.map((c) => <li key={`${a.id}${c}`}>{a.name}: possibly explained by {c}</li>))}
              </ul>
            )}
            {report.people.some((p) => Math.abs(p.difference) >= 0.005) && (
              <p className="mt-3 rounded-lg bg-destructive/5 p-3 text-xs text-destructive">
                People balances out of step: {report.people.filter((p) => Math.abs(p.difference) >= 0.005).map((p) => `${p.name} ${formatCurrencyPrecise(p.difference)}`).join(", ")}
              </p>
            )}
          </AuditPanel>

          <AuditPanel
            icon={ListChecks}
            title="Findings"
            description="Confirmed = the records contradict each other. Suspected = fits a historical gap; the money may already be in an opening balance, so do not assume it is missing."
            headerExtra={
              <div className="flex flex-wrap items-center gap-2">
                {(["all", "confirmed", "suspected"] as const).map((f) => (
                  <FilterChip key={f} active={filter === f} onClick={() => setFilter(f)}>{f[0].toUpperCase() + f.slice(1)}</FilterChip>
                ))}
                <select
                  className="h-8 max-w-full cursor-pointer rounded-full border border-border bg-card px-3 text-sm font-medium text-foreground transition-[border-color] duration-150 outline-none hover:border-border-strong focus-visible:ring-3 focus-visible:ring-ring/40"
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
            }
          >
            {shown.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground"><Inbox className="size-4" aria-hidden /> No findings for this filter.</p>
            ) : (
              <ul className="flex flex-col gap-3">{shown.map((f) => <FindingRow key={f.id} f={f} />)}</ul>
            )}
          </AuditPanel>

          {legacyCaseA && <LegacyCaseASection report={legacyCaseA} />}

          <p className="text-xs text-muted-foreground">
            Read {Object.entries(meta?.counts ?? {}).map(([k, v]) => `${v} ${k}`).join(", ")}.
            {Object.keys(meta?.skipped ?? {}).length > 0 && ` Could not read: ${Object.entries(meta!.skipped).map(([k, v]) => `${v} ${k}`).join(", ")}.`}{" "}
            Not covered: bill payments, card statements, savings (EMI breakdowns are read only for card-linked EMIs). Generated {report.generatedAt.toLocaleString()}.
          </p>
        </>
      )}
      <ScrollNav />
    </div>
  );
}
