"use client";

import { ArrowLeft, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useEmiRows } from "@/features/emi/hooks/use-emi-data";
import { loanDisplayName } from "@/features/loans/components/loan-card";
import { Money } from "@/features/loans/components/loan-emi-ui";
import { useLoanRows } from "@/features/loans/hooks/use-loans-data";
import { recordKindForEmi, recordKindForLoan } from "@/features/loans/lib/loan-emi-add";
import { cn } from "@/lib/utils";

type NavStatus = "active" | "overdue" | "closed";

interface NavEntry {
  key: string;
  id: string;
  name: string;
  tag: string;
  /** The regular installment. */
  installment: number;
  /** What is still owed (what is still to receive, for a loan I gave). */
  outstanding: number;
  lent: boolean;
  status: NavStatus;
  paid: number;
  total: number;
  nextDate: Date | null;
}

const STATUS_TEXT: Record<NavStatus, string> = { active: "Active", overdue: "Overdue", closed: "Closed" };
const STATUS_DOT: Record<NavStatus, string> = { active: "bg-success", overdue: "bg-expense", closed: "bg-muted-foreground/50" };

/**
 * The workspace's left panel: every Loan and EMI as one compact selectable row — name, the regular installment, what is
 * left, and its status. Picking a row swaps the right panel in place (the route follows, nothing else opens). Read from the
 * same rows the list page uses; ↑/↓ move through the list.
 */
export function AgreementNavList({ selectedId, onSelect }: { selectedId: string | null; onSelect: (id: string) => void }) {
  const { rows: loanRows } = useLoanRows();
  const { rows: emiRows } = useEmiRows();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"active" | "all">("active");
  const listRef = useRef<HTMLUListElement>(null);

  const entries = useMemo<NavEntry[]>(() => {
    const all: NavEntry[] = [
      ...loanRows.map((r) => ({
        key: `loan:${r.loan.id}`,
        id: r.loan.id,
        name: loanDisplayName(r),
        tag: recordKindForLoan(r.loan).label,
        installment: r.emiAmount,
        outstanding: r.outstandingPrincipal,
        lent: r.direction === "given",
        status: (r.status === "closed" ? "closed" : r.status === "overdue" ? "overdue" : "active") as NavStatus,
        paid: r.installmentsPaid,
        total: r.totalInstallments,
        nextDate: r.nextDueDate,
      })),
      ...emiRows.map((r) => ({
        key: `emi:${r.emi.id}`,
        id: r.emi.id,
        name: r.emi.name,
        tag: recordKindForEmi(r.emi).label,
        installment: r.nextInstallment ? r.nextInstallment.amountDue : (r.installments[0]?.amountDue ?? 0),
        outstanding: r.remainingBalance,
        lent: false,
        status: (r.status === "closed" || r.status === "completed" ? "closed" : r.status === "overdue" || r.status === "defaulted" ? "overdue" : "active") as NavStatus,
        paid: r.installmentsPaid,
        total: r.emi.installmentCount,
        nextDate: r.nextInstallment?.dueDate ?? null,
      })),
    ];
    // Active first, soonest payment first — the same order as the list page.
    return all.sort((a, b) => {
      if ((a.status === "closed") !== (b.status === "closed")) return a.status === "closed" ? 1 : -1;
      const at = a.nextDate?.getTime() ?? Number.POSITIVE_INFINITY;
      const bt = b.nextDate?.getTime() ?? Number.POSITIVE_INFINITY;
      return at !== bt ? at - bt : a.name.localeCompare(b.name);
    });
  }, [loanRows, emiRows]);

  const activeCount = entries.filter((e) => e.status !== "closed").length;
  const q = query.trim().toLowerCase();
  // The open record always stays listed, even when a filter would hide it.
  const shown = entries.filter((e) => e.id === selectedId || ((scope === "all" || e.status !== "closed") && (q === "" || e.name.toLowerCase().includes(q) || e.tag.toLowerCase().includes(q))));

  function onKeyDown(e: KeyboardEvent<HTMLUListElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = shown.findIndex((x) => x.id === selectedId);
    const next = shown[Math.min(shown.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    onSelect(next.id);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-nav="${next.id}"]`)?.focus());
  }

  return (
    <nav aria-label="Loans and EMIs" data-testid="agreement-nav" className="flex h-full min-h-0 w-[17.5rem] shrink-0 flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-e2">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-gradient-to-b from-secondary/70 to-card px-3 pt-2.5 pb-2">
        <Link href="/loans/" className="inline-flex h-6 w-fit items-center gap-1 rounded-[4px] text-[12px] font-semibold text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
          <ArrowLeft className="size-3.5" strokeWidth={2} aria-hidden />
          Loan &amp; EMI
        </Link>
        <div className="flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              aria-label="Search loans and EMIs"
              className="h-7 w-full rounded-[6px] border border-border-strong bg-card pr-2 pl-7 text-xs text-foreground outline-none placeholder:text-tertiary-foreground focus:border-primary-accent-text focus:ring-2 focus:ring-ring"
            />
          </div>
          <div role="radiogroup" aria-label="Show" className="flex shrink-0 rounded-[6px] border border-border bg-secondary/60 p-0.5">
            {(["active", "all"] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={scope === s}
                onClick={() => setScope(s)}
                className={cn("h-6 rounded-[4px] px-2 text-[11px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", scope === s ? "bg-card text-foreground shadow-e1" : "text-muted-foreground hover:text-foreground")}
              >
                {s === "active" ? `Active ${activeCount}` : "All"}
              </button>
            ))}
          </div>
        </div>
      </div>
      <ul ref={listRef} onKeyDown={onKeyDown} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {shown.length === 0 && <li className="px-3 py-6 text-center text-xs text-muted-foreground">Nothing matches.</li>}
        {shown.map((e) => {
          const on = e.id === selectedId;
          const pct = e.total > 0 ? Math.min(100, Math.round((e.paid / e.total) * 100)) : 0;
          return (
            <li key={e.key}>
              <button
                type="button"
                data-nav={e.id}
                data-testid={`nav-${e.id}`}
                aria-current={on ? "true" : undefined}
                tabIndex={on || (selectedId == null && e === shown[0]) ? 0 : -1}
                onClick={() => onSelect(e.id)}
                className={cn(
                  "group relative flex w-full flex-col gap-0.5 border-b border-border/70 px-3 py-2 text-left outline-none transition-colors duration-100 focus-visible:bg-secondary/70",
                  on ? "bg-primary/20 shadow-[inset_3px_0_0_var(--color-primary-accent-text)]" : "hover:bg-secondary/70",
                  e.status === "closed" && !on && "opacity-70",
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{e.name}</span>
                  <span className={cn("inline-flex shrink-0 items-center gap-1 text-[10.5px] font-semibold", e.status === "overdue" ? "text-expense" : "text-muted-foreground")}>
                    <span aria-hidden className={cn("size-1.5 rounded-full", STATUS_DOT[e.status])} />
                    {STATUS_TEXT[e.status]}
                  </span>
                </span>
                <span className="flex min-w-0 items-baseline justify-between gap-2 text-[11.5px] text-muted-foreground">
                  <span className="truncate">{e.tag}</span>
                  <span className="shrink-0 tabular-nums">
                    <Money amount={e.installment} className="text-[11.5px] font-semibold text-foreground/85" />
                    <span> / inst.</span>
                  </span>
                </span>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-[2px] bg-border" aria-hidden>
                    <span className="block h-full rounded-[2px] bg-primary-accent-text" style={{ width: `${pct}%` }} />
                  </span>
                  <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">
                    <Money amount={e.outstanding} className="text-[11.5px] font-semibold text-foreground" /> {e.lent ? "to receive" : "left"}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
