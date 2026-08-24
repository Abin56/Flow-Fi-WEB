"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatCurrencyPrecise } from "@/lib/format";
import { useTransactions } from "@/hooks/use-transactions";
import type { TransactionStudioMutations } from "@/hooks/use-transaction-studio-mutations";
import type { GridRow } from "../lib/grid-types";

const DATE_FORMAT = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });

/**
 * Rows this statement's Duplicate Detection (Architecture §13) flagged as a possible match
 * against an already-existing transaction (`duplicateCandidateOf` — set server-side, points at a
 * real `transactions/{id}` doc, distinct from `duplicateOfTransactionId`'s *confirmed* state per
 * `StatusCell`'s own doc comment).
 */
export function duplicateCandidateRows(rows: GridRow[]): GridRow[] {
  return rows.filter((r) => r.duplicateCandidateOf != null && r.duplicateOfTransactionId == null);
}

/**
 * Pure content, no wrapper/trigger of its own — mounted inside `ValidationBar`'s single
 * expandable "N rows need attention" strip alongside the preflight and transfer-match sections,
 * so a reviewer only ever sees one collapsible warning area instead of three stacked cards.
 */
export function DuplicateCandidateList({
  rows,
  mutations,
  onOpenRow,
}: {
  rows: GridRow[];
  mutations: TransactionStudioMutations;
  onOpenRow: (recordId: string) => void;
}) {
  const { data: transactions = [] } = useTransactions();
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const candidates = duplicateCandidateRows(rows);
  if (candidates.length === 0) return null;

  const transactionById = new Map(transactions.map((t) => [t.id, t]));

  async function resolve(row: GridRow, action: "confirm" | "dismiss") {
    setResolvingId(row.id);
    try {
      if (action === "confirm") {
        await mutations.updateFields(row.id, { duplicateOfTransactionId: row.duplicateCandidateOf, include: false });
      } else {
        await mutations.updateFields(row.id, { duplicateCandidateOf: null });
      }
    } finally {
      setResolvingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        Possible duplicates · {candidates.length}
      </p>
      {candidates.map((row) => {
        const existing = row.duplicateCandidateOf ? transactionById.get(row.duplicateCandidateOf) : undefined;
        return (
          <div key={row.id} className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-xs">
            <div className="flex items-center justify-between gap-3">
              <button type="button" onClick={() => onOpenRow(row.id)} className="min-w-0 flex-1 text-left">
                <p className="truncate font-medium text-foreground">{row.counterpartyNormalized ?? row.counterpartyRaw}</p>
                <p className="text-muted-foreground">
                  {formatCurrencyPrecise(row.amount)} · {DATE_FORMAT.format(row.date)} · this statement
                </p>
              </button>
              <div className="min-w-0 flex-1 text-right">
                {existing ? (
                  <>
                    <p className="truncate font-medium text-foreground">{existing.description || "Existing transaction"}</p>
                    <p className="text-muted-foreground">
                      {formatCurrencyPrecise(existing.amount)} · {DATE_FORMAT.format(existing.dateTime)} · already imported
                    </p>
                  </>
                ) : (
                  <p className="text-muted-foreground">Matched transaction unavailable</p>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-1.5">
              <Button variant="ghost" size="xs" onClick={() => void resolve(row, "dismiss")} disabled={resolvingId === row.id}>
                Not a Duplicate
              </Button>
              <Button variant="outline" size="xs" onClick={() => void resolve(row, "confirm")} disabled={resolvingId === row.id}>
                Mark as Duplicate
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
