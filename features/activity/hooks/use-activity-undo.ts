"use client";

/**
 * Wires Activity's Undo to the modules' OWN actions (the same ones their screens call) — nothing here
 * reverses money itself. `resolve` reads fresh facts; `execute` re-resolves immediately before writing (so
 * the decision is made on the latest documents), then hands the handler to `executeUndo`.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { DERIVED_QUERY_PREFIXES } from "@/features/loans/components/record-payment-dialog";
import { useBillActions } from "@/features/bills/hooks/use-bills-data";
import { useEmiActions } from "@/features/emi/hooks/use-emi-data";
import { useLoanActions } from "@/features/loans/hooks/use-loans-data";
import { usePeopleActions } from "@/features/people/hooks/use-people-data";
import { useTransactionActions } from "@/features/transactions/hooks/use-transactions-data";
import type { ActivityItem } from "@/features/activity/lib/activity-classify";
import { decideUndo, type EffectContext, type UndoDecision, type UndoFacts } from "@/features/activity/lib/undo-eligibility";
import { executeUndo, livePersonIds, resolveUndoFacts, type ExecuteDeps, type ExecuteResult } from "@/features/activity/lib/undo-resolve";
import { db } from "@/lib/firebase/client";
import { useAuthStore } from "@/store/auth-store";

export function useActivityUndo() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();
  const transactionActions = useTransactionActions();
  const peopleActions = usePeopleActions();
  const loanActions = useLoanActions();
  const emiActions = useEmiActions();
  const billActions = useBillActions();

  const deps: ExecuteDeps | null = useMemo(() => {
    if (!uid || !transactionActions || !peopleActions || !loanActions || !emiActions || !billActions) return null;
    return {
      uid,
      deleteTransactionWithLinkedEffects: (t) => transactionActions.deleteTransactionWithLinkedEffects(t),
      revertPersonPayment: (person, paymentId) => peopleActions.revertPersonPayment(person, paymentId),
      reverseLoanPayment: (params) => loanActions.reversePayment(params),
      reverseEmiPayment: (emi, params) => emiActions.reversePayment(emi, params),
      cancelBillPayment: (params) => billActions.cancelBillPayment(params),
    };
  }, [uid, transactionActions, peopleActions, loanActions, emiActions, billActions]);

  const resolve = useCallback(
    async (item: ActivityItem): Promise<UndoFacts> => {
      if (!uid) throw new Error("Not signed in");
      return resolveUndoFacts({ db, uid, personIds: await livePersonIds(uid) }, item);
    },
    [uid],
  );

  /**
   * Re-reads and re-decides, then runs the handler only if it is still eligible with the SAME handler kind.
   * `withCard` lets the caller add the Credit Cards preview to fresh transfer facts.
   */
  const execute = useCallback(
    async (item: ActivityItem, ctx: EffectContext, withCard: (facts: UndoFacts) => UndoFacts, expected: UndoDecision): Promise<ExecuteResult | { outcome: "blocked"; reason: string }> => {
      if (!deps || expected.kind !== "eligible") throw new Error("Not signed in");
      const decision = decideUndo(item, withCard(await resolve(item)), ctx);
      if (decision.kind === "alreadyUndone") return { outcome: "alreadyUndone", warning: null };
      if (decision.kind === "blocked") return { outcome: "blocked", reason: decision.reason };
      if (decision.handler.kind !== expected.handler.kind) return { outcome: "blocked", reason: "This record changed since you opened it — review it again." };
      const result = await executeUndo(decision.handler, deps, item.anchor.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["activity", uid] }),
        ...DERIVED_QUERY_PREFIXES.map((key) => queryClient.invalidateQueries({ queryKey: [key], exact: false })),
      ]);
      return result;
    },
    [deps, resolve, queryClient, uid],
  );

  return { ready: deps != null, resolve, execute };
}
