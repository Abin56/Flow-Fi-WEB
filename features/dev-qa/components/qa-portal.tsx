"use client";

/**
 * LOCAL MANUAL-QA ONLY — the developer testing dashboard at /dev/qa. Removable with `app/dev/qa`,
 * `features/dev-qa` and `lib/firebase/qa-emulator.ts`.
 *
 * Renders nothing but the guard failures unless every environment check passes. Also exposes `window.__qa`
 * (only after the guard passes) so a browser-automation run can record results, read timings and arm the
 * test-only refresh fault injection below.
 */

import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { ClayButton } from "@/components/clay/clay-button";
import { auth } from "@/lib/firebase/client";
import { cn } from "@/lib/utils";
import { isQaUser, runGuard, QA_USER_EMAIL, type GuardReport } from "../lib/guard";
import { ensureQaUser, resetEmulatorData, seedCardEmi, seedFixtures, seedSharedEmi, seedSharedHistoryEmi, seedStatementHistory, type SeedStep } from "../lib/seed";

type Verdict = "not-tested" | "pass" | "fail" | "not-executed";
interface Result {
  verdict: Verdict;
  note: string;
  ms?: Record<string, number>;
  at?: string;
}

const WORKFLOWS: { group: string; href: string; items: string[] }[] = [
  {
    group: "Loan & EMI (highest priority)",
    href: "/loans-installments",
    items: [
      "loan-record",
      "loan-partial",
      "loan-insufficient",
      "loan-duplicate-click",
      "loan-slow-write",
      "loan-slow-refresh",
      "loan-refresh-fail",
      "loan-refresh-8s",
      "loan-mark-unpaid",
      "loan-edit-payment",
      "emi-record",
    ],
  },
  { group: "Transactions", href: "/transactions", items: ["txn-expense", "txn-income", "txn-edit", "txn-delete", "txn-duplicate"] },
  { group: "People Ledger", href: "/people", items: ["people-receipt", "people-payment", "people-edit-reverse", "people-partial"] },
  { group: "Credit Cards", href: "/credit-cards", items: ["card-pay", "card-cancel"] },
  { group: "Regular Bills", href: "/bills", items: ["bill-pay", "bill-earlier", "bill-insufficient", "bill-cancel-edit"] },
  { group: "Accounts", href: "/accounts", items: ["acct-running", "acct-order", "acct-filter", "acct-mismatch"] },
  { group: "Dashboard / Month Cycle", href: "/dashboard", items: ["dash-totals", "dash-stale"] },
];

const RESULTS_KEY = "flowfi.qa.results";
const FAULT_PREFIXES = ["loan-financial-history", "loanPrincipalPrepaid", "loanScheduledPayments", "cardLinkedEmiPayments", "emi-payment-history"];

export type RefreshFault = { mode: "none" } | { mode: "slow"; delayMs: number } | { mode: "fail"; delayMs?: number };

declare global {
  interface Window {
    __qa?: {
      queryClient: QueryClient;
      setRefreshFault: (fault: RefreshFault) => void;
      refreshFault: () => RefreshFault;
      invalidations: () => { at: number; keys: string[]; outcome?: string }[];
      setResult: (id: string, verdict: Verdict, note: string, ms?: Record<string, number>) => void;
    };
  }
}

let currentFault: RefreshFault = { mode: "none" };
const faultLog: { at: number; keys: string[]; outcome?: string }[] = [];

function installFaultInjection(
  queryClient: QueryClient,
  setFault: (f: RefreshFault) => void,
  setResult: (id: string, verdict: Verdict, note: string, ms?: Record<string, number>) => void,
) {
  const marked = queryClient as QueryClient & { __qaPatched?: boolean };
  if (!marked.__qaPatched) {
    marked.__qaPatched = true;
    const original = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = (async (filters?: Parameters<QueryClient["invalidateQueries"]>[0], options?: Parameters<QueryClient["invalidateQueries"]>[1]) => {
      const key = String((filters as { queryKey?: unknown[] } | undefined)?.queryKey?.[0] ?? "");
      const f = currentFault;
      if (f.mode !== "none" && FAULT_PREFIXES.includes(key)) {
        const entry: { at: number; keys: string[]; outcome?: string } = { at: Date.now(), keys: [key] };
        faultLog.push(entry);
        if (f.mode === "slow") {
          const p = original(filters, options);
          await new Promise((r) => setTimeout(r, f.delayMs));
          entry.outcome = "slow-resolved";
          return p;
        }
        await new Promise((r) => setTimeout(r, f.delayMs ?? 0));
        entry.outcome = "injected-failure";
        throw new Error("QA fault injection: derived-data refresh failed");
      }
      return original(filters, options);
    }) as QueryClient["invalidateQueries"];
  }
  window.__qa = {
    queryClient,
    setRefreshFault: setFault,
    refreshFault: () => currentFault,
    invalidations: () => faultLog,
    setResult,
  };
}

function loadResults(): Record<string, Result> {
  try {
    return JSON.parse(localStorage.getItem(RESULTS_KEY) ?? "{}") as Record<string, Result>;
  } catch {
    return {};
  }
}

const VERDICT_STYLE: Record<Verdict, string> = {
  "not-tested": "border-border text-muted-foreground",
  pass: "border-success/50 bg-success/10 text-success",
  fail: "border-destructive/50 bg-destructive/10 text-destructive",
  "not-executed": "border-warning/50 bg-warning/10 text-foreground",
};

export function QaPortal() {
  const queryClient = useQueryClient();
  const [guard, setGuard] = useState<GuardReport | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [steps, setSteps] = useState<SeedStep[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [fault, setFaultState] = useState<RefreshFault>(() => currentFault);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time localStorage hydration after mount
    setResults(loadResults());
    void runGuard().then(setGuard);
    return onAuthStateChanged(auth, (u) => setUserEmail(u?.email ?? null));
  }, []);

  const setResult = useCallback((id: string, verdict: Verdict, note: string, ms?: Record<string, number>) => {
    setResults((prev) => {
      const next = { ...prev, [id]: { verdict, note, ms, at: new Date().toISOString() } };
      try {
        localStorage.setItem(RESULTS_KEY, JSON.stringify(next));
      } catch {
        // Storage unavailable — results stay in memory for this page load.
      }
      return next;
    });
  }, []);

  const setFault = useCallback((f: RefreshFault) => {
    currentFault = f;
    setFaultState(f);
  }, []);

  // Test-only fault injection: wraps THIS tab's query client so invalidations of the Loan/EMI payment-derived
  // queries are delayed or rejected. It stays installed while the tab lives (client-side navigation to the app
  // pages must keep it armed); a full page reload removes it. No application code path is changed.
  useEffect(() => {
    if (!guard?.allowed) return;
    installFaultInjection(queryClient, setFault, setResult);
  }, [guard?.allowed, queryClient, setFault, setResult]);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const counts = useMemo(() => {
    const all = WORKFLOWS.flatMap((w) => w.items);
    const c = { pass: 0, fail: 0, "not-executed": 0, "not-tested": 0 };
    for (const id of all) c[results[id]?.verdict ?? "not-tested"] += 1;
    return { ...c, total: all.length };
  }, [results]);

  if (!guard) return <main className="p-6 text-sm text-muted-foreground">Checking environment…</main>;

  if (!guard.allowed) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-xl flex-col gap-3 bg-background px-4 py-8" data-testid="qa-blocked">
        <h1 className="text-lg font-semibold text-destructive">QA portal blocked</h1>
        <p className="text-sm text-muted-foreground">The portal only runs against the local emulator with synthetic data. These checks failed:</p>
        <GuardList report={guard} />
      </main>
    );
  }

  const signedIn = isQaUser(auth.currentUser);

  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-4 bg-background px-4 py-6 text-sm" data-testid="qa-portal">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="font-heading text-xl font-semibold">FlowFi Manual QA</h1>
          <p className="text-xs text-muted-foreground">Local emulator only · synthetic data · developer tool</p>
        </div>
        <span className="rounded-full border border-success/50 bg-success/10 px-3 py-1 text-xs font-semibold text-success" data-testid="qa-env-ok">
          Emulator verified
        </span>
      </header>

      <section className="rounded-xl border border-border bg-card p-4" aria-label="Environment">
        <h2 className="mb-2 text-sm font-semibold">Environment & emulator status</h2>
        <GuardList report={guard} />
      </section>

      <section className="rounded-xl border border-border bg-card p-4" aria-label="Test user and data">
        <h2 className="mb-2 text-sm font-semibold">Synthetic test user & fixtures</h2>
        <p className="mb-3 text-xs text-muted-foreground" data-testid="qa-user">
          {userEmail ? `Signed in as ${userEmail}${signedIn ? " (synthetic QA user ✓)" : " — NOT the QA user"}` : `Signed out · QA user: ${QA_USER_EMAIL}`}
        </p>
        <div className="flex flex-wrap gap-2">
          <ClayButton size="sm" disabled={busy != null} onClick={() => run("signin", async () => void (await ensureQaUser()))} data-testid="qa-signin">
            {busy === "signin" ? "Signing in…" : "Sign in as QA user"}
          </ClayButton>
          <ClayButton
            size="sm"
            variant="secondary"
            disabled={busy != null || !signedIn}
            onClick={() =>
              run("seed", async () => {
                const user = auth.currentUser;
                if (!user) throw new Error("Sign in first");
                const r = await seedFixtures(user);
                setSteps(r.steps);
              })
            }
            data-testid="qa-seed"
          >
            {busy === "seed" ? "Seeding…" : "Initialize fixtures"}
          </ClayButton>
          <ClayButton
            size="sm"
            variant="secondary"
            disabled={busy != null || !signedIn}
            onClick={() =>
              run("reset", async () => {
                const user = auth.currentUser;
                if (!user) throw new Error("Sign in first");
                await resetEmulatorData();
                const r = await seedFixtures(user);
                setSteps(r.steps);
              })
            }
            data-testid="qa-reset"
          >
            {busy === "reset" ? "Resetting…" : "Reset test fixtures"}
          </ClayButton>
          <ClayButton
            size="sm"
            variant="secondary"
            disabled={busy != null || !signedIn}
            onClick={() =>
              run("sharedEmi", async () => {
                const user = auth.currentUser;
                if (!user) throw new Error("Sign in first");
                setSteps((await seedSharedEmi(user)).steps);
              })
            }
            data-testid="qa-seed-shared-emi"
          >
            {busy === "sharedEmi" ? "Adding…" : "Add shared EMI"}
          </ClayButton>
          <ClayButton
            size="sm"
            variant="secondary"
            disabled={busy != null || !signedIn}
            onClick={() =>
              run("cardEmi", async () => {
                const user = auth.currentUser;
                if (!user) throw new Error("Sign in first");
                setSteps((await seedCardEmi(user)).steps);
              })
            }
            data-testid="qa-seed-card-emi"
          >
            {busy === "cardEmi" ? "Adding…" : "Add card EMI"}
          </ClayButton>
          <ClayButton
            size="sm"
            variant="secondary"
            disabled={busy != null || !signedIn}
            onClick={() =>
              run("historyEmi", async () => {
                const user = auth.currentUser;
                if (!user) throw new Error("Sign in first");
                setSteps((await seedSharedHistoryEmi(user)).steps);
              })
            }
            data-testid="qa-seed-history-emi"
          >
            {busy === "historyEmi" ? "Adding…" : "Add 24-month shared EMI"}
          </ClayButton>
          <ClayButton
            size="sm"
            variant="secondary"
            disabled={busy != null || !signedIn}
            onClick={() =>
              run("history", async () => {
                const user = auth.currentUser;
                if (!user) throw new Error("Sign in first");
                setSteps((await seedStatementHistory(user)).steps);
              })
            }
            data-testid="qa-seed-history"
          >
            {busy === "history" ? "Adding…" : "Add statement history"}
          </ClayButton>
          <ClayButton size="sm" variant="ghost" disabled={busy != null || userEmail == null} onClick={() => run("signout", () => signOut(auth))}>
            Sign out
          </ClayButton>
        </div>
        {error && (
          <p role="alert" className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive" data-testid="qa-error">
            {error}
          </p>
        )}
        {steps.length > 0 && (
          <ul className="mt-3 grid gap-1 text-xs sm:grid-cols-2" data-testid="qa-seed-steps">
            {steps.map((s) => (
              <li key={s.name} className={cn("flex justify-between gap-2 rounded border px-2 py-1", s.ok ? "border-border" : "border-destructive/50 text-destructive")}>
                <span>
                  {s.ok ? "✓" : "✗"} {s.name}
                  {s.detail ? ` — ${s.detail}` : ""}
                </span>
                <span className="tabular-nums text-muted-foreground">{s.ms} ms</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-4" aria-label="Fault injection">
        <h2 className="mb-1 text-sm font-semibold">Derived-data refresh fault injection (test-only)</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Wraps this tab&apos;s query client so the Loan/EMI payment-derived refresh is delayed or rejected. The Firestore payment write is untouched. Navigate with the links
          below (client-side) so it stays armed; a reload clears it.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              ["none", { mode: "none" }],
              ["slow 3 s", { mode: "slow", delayMs: 3000 }],
              ["slow 12 s", { mode: "slow", delayMs: 12000 }],
              ["fail", { mode: "fail", delayMs: 500 }],
            ] as [string, RefreshFault][]
          ).map(([label, f]) => (
            <ClayButton key={label} size="sm" variant={JSON.stringify(f) === JSON.stringify(fault) ? "primary" : "secondary"} onClick={() => setFault(f)}>
              {label}
            </ClayButton>
          ))}
          <span className="text-xs text-muted-foreground" data-testid="qa-fault">
            armed: {fault.mode}
          </span>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4" aria-label="Checklist">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Manual test checklist</h2>
          <span className="text-xs text-muted-foreground" data-testid="qa-counts">
            {counts.pass} pass · {counts.fail} fail · {counts["not-executed"]} not executed · {counts["not-tested"]} not tested / {counts.total}
          </span>
        </div>
        <div className="flex flex-col gap-4">
          {WORKFLOWS.map((w) => (
            <div key={w.group}>
              <div className="mb-1 flex items-center justify-between">
                <h3 className="text-xs font-semibold tracking-wide uppercase">{w.group}</h3>
                <Link href={w.href} className="text-xs font-medium text-primary-accent-text underline underline-offset-2">
                  Open {w.href} →
                </Link>
              </div>
              <ul className="flex flex-col gap-1">
                {w.items.map((id) => {
                  const r = results[id];
                  const v = r?.verdict ?? "not-tested";
                  return (
                    <li key={id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-2 py-1.5" data-testid={`qa-item-${id}`}>
                      <span className="min-w-40 font-mono text-xs">{id}</span>
                      <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-semibold", VERDICT_STYLE[v])}>{v}</span>
                      {r?.ms && (
                        <span className="text-[11px] tabular-nums text-muted-foreground">
                          {Object.entries(r.ms)
                            .map(([k, ms]) => `${k} ${ms} ms`)
                            .join(" · ")}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={r?.note}>
                        {r?.note}
                      </span>
                      <span className="flex gap-1">
                        {(["pass", "fail", "not-executed"] as Verdict[]).map((opt) => (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => setResult(id, opt, r?.note ?? "", r?.ms)}
                            className="rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-secondary"
                          >
                            {opt === "not-executed" ? "n/e" : opt}
                          </button>
                        ))}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function GuardList({ report }: { report: GuardReport }) {
  return (
    <ul className="grid gap-1 text-xs sm:grid-cols-2" data-testid="qa-guard">
      {report.checks.map((c) => (
        <li key={c.id} className={cn("flex items-start gap-2 rounded border px-2 py-1", c.ok ? "border-border" : "border-destructive/50 text-destructive")}>
          <span aria-hidden>{c.ok ? "✓" : "✗"}</span>
          <span>
            <span className="font-medium">{c.label}</span>
            <span className="block text-muted-foreground">{c.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
