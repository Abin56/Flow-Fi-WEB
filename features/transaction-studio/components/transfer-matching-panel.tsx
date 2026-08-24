"use client";

import { useMemo, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatCurrencyPrecise } from "@/lib/format";
import { reconcileTransfers, type MatchedTransferPair } from "@/lib/engines/transfer-reconciliation-engine";
import { useAccounts } from "@/hooks/use-accounts";
import { useTransactions } from "@/hooks/use-transactions";
import { createAccountRepository, createTransactionRepository } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";

const DATE_FORMAT = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });

/**
 * B11's Transfer Reconciliation Engine. Runs read-only over the user's real, already-committed
 * transactions (not this statement's staged rows — the whole point of B11 is pairing legs that
 * came from *different* statements, so the other leg may not even belong to the document
 * currently open in Transaction Studio). Confident matches (`result.matches` — the engine's
 * unique-mutual-best pairs, never a guess under ambiguity) are offered for one-pair-at-a-time
 * confirmation; nothing is linked until the reviewer clicks "Match & Link".
 *
 * A hook (not a self-contained panel) so `ValidationBar` can read `visibleMatches.length` for its
 * one-line "N issues" summary without a second reconciliation pass — the count and the list below
 * it come from the exact same computation.
 */
export function useTransferMatches() {
  const uid = useAuthStore((s) => s.user?.uid);
  const { data: transactions = [] } = useTransactions();
  const { data: accounts = [] } = useAccounts();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [linkingKey, setLinkingKey] = useState<string | null>(null);

  const result = useMemo(() => {
    const outflows = transactions
      .filter((t) => t.type === "expense" && t.transferId == null)
      .map((t) => ({ id: t.id, accountId: t.accountId, amount: t.amount, dateTime: t.dateTime }));
    const inflows = transactions
      .filter((t) => t.type === "income" && t.transferId == null)
      .map((t) => ({ id: t.id, accountId: t.accountId, amount: t.amount, dateTime: t.dateTime }));
    return reconcileTransfers(outflows, inflows);
  }, [transactions]);

  const pairKey = (m: MatchedTransferPair) => `${m.outflowId}:${m.inflowId}`;
  const visibleMatches = result.matches.filter((m) => !dismissed.has(pairKey(m)));
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? "Account";
  const transactionById = new Map(transactions.map((t) => [t.id, t]));

  async function matchAndLink(match: MatchedTransferPair) {
    if (!uid) return;
    const outflow = transactionById.get(match.outflowId);
    const inflow = transactionById.get(match.inflowId);
    if (!outflow || !inflow) return;

    setLinkingKey(pairKey(match));
    try {
      const accountRepository = createAccountRepository(uid);
      const transactionRepository = createTransactionRepository(uid, accountRepository);
      await transactionRepository.linkTransferPair(outflow, inflow);
      // No manual list update needed — the live `useTransactions()` listener picks up the new
      // `transferId` and this pair naturally drops out of `visibleMatches` on the next render.
    } finally {
      setLinkingKey(null);
    }
  }

  function dismiss(match: MatchedTransferPair) {
    setDismissed((prev) => new Set(prev).add(pairKey(match)));
  }

  return { visibleMatches, accountName, transactionById, linkingKey, matchAndLink, dismiss, pairKey };
}

/**
 * Pure content, no wrapper/trigger of its own — mounted inside `ValidationBar`'s single
 * expandable "N rows need attention" strip alongside the preflight and duplicate sections.
 */
export function TransferMatchList({ matches }: { matches: ReturnType<typeof useTransferMatches> }) {
  const { visibleMatches, accountName, transactionById, linkingKey, matchAndLink, dismiss, pairKey } = matches;
  if (visibleMatches.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        Transfer matches across your accounts · {visibleMatches.length}
      </p>
      {visibleMatches.map((match) => {
        const outflow = transactionById.get(match.outflowId);
        const inflow = transactionById.get(match.inflowId);
        if (!outflow || !inflow) return null;
        const key = pairKey(match);
        return (
          <div key={key} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-xs">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">{accountName(outflow.accountId)}</p>
                <p className="text-muted-foreground">
                  {formatCurrencyPrecise(outflow.amount)} · {DATE_FORMAT.format(outflow.dateTime)}
                </p>
              </div>
              <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">{accountName(inflow.accountId)}</p>
                <p className="text-muted-foreground">
                  {formatCurrencyPrecise(inflow.amount)} · {DATE_FORMAT.format(inflow.dateTime)}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button variant="ghost" size="xs" onClick={() => dismiss(match)} disabled={linkingKey === key}>
                Not a Match
              </Button>
              <Button size="xs" onClick={() => void matchAndLink(match)} disabled={linkingKey === key}>
                {linkingKey === key ? <Loader2 className="size-3 animate-spin" /> : null}
                Match &amp; Link
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
