"use client";

/**
 * Historical participant reimbursements for old Loan / EMI installments (`historical-reimbursement.ts`).
 * Lines come from the same whole-history People statements as the Pay dialog's breakdown; every write is the
 * normal People Record Payment (`recordPersonPayment`), one idempotent payment per person × installment.
 */

import { useCallback, useMemo } from "react";
import { usePeople } from "@/hooks/use-people";
import { usePeopleActions } from "@/features/people/hooks/use-people-data";
import { usePeopleCycleStatements } from "@/features/people/hooks/use-person-cycle-statement";
import type { OwnershipSource } from "@/lib/engines/debt-ownership";
import {
  reimbursementLines,
  runReimbursements,
  type ReimbursementItem,
  type ReimbursementLine,
  type ReimbursementResult,
} from "@/lib/engines/historical-reimbursement";
import type { StatementCycle } from "@/lib/engines/person-cycle-statement";
import { round2 } from "@/lib/engines/person-payment";
import type { Installment } from "@/lib/models/payment-schedule";
import type { Person } from "@/lib/models/person";

const ALL_TIME: StatementCycle = { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) };

export interface ReimbursementTarget {
  sourceKind: "emi" | "loan";
  source: OwnershipSource;
  installments: readonly Installment[];
  installmentIds: readonly string[];
}

export function useHistoricalReimbursement(target: ReimbursementTarget | null): {
  lines: ReimbursementLine[];
  isLoading: boolean;
  /** Records the planned items into `accountId` (for an "included" item, for the record only). */
  record: (items: readonly ReimbursementItem[], accountId: string, previous?: Record<string, ReimbursementResult>) => Promise<Record<string, ReimbursementResult>>;
} {
  const { statementsByPersonId, isLoading } = usePeopleCycleStatements(ALL_TIME);
  const { data: people = [] } = usePeople();
  const actions = usePeopleActions();
  const sourceKind = target?.sourceKind;
  const source = target?.source;
  const installments = target?.installments;
  const idsKey = target?.installmentIds.join(",") ?? "";

  const lines = useMemo(
    () =>
      sourceKind && source && installments && idsKey
        ? reimbursementLines({ statements: Object.values(statementsByPersonId), installments, installmentIds: idsKey.split(","), sourceKind, source })
        : [],
    [sourceKind, source, installments, idsKey, statementsByPersonId],
  );

  const record = useCallback(
    async (items: readonly ReimbursementItem[], accountId: string, previous: Record<string, ReimbursementResult> = {}) => {
      if (!actions) throw new Error("Sign in again to save.");
      // The person as this screen saw them; after each of our own writes, their balance as that write left it —
      // so the repository's stale-balance check still refuses a concurrent change made elsewhere.
      const expected = new Map<string, Person>();
      return runReimbursements(
        items,
        async (item) => {
          const person = expected.get(item.personId) ?? (people as Person[]).find((p) => p.id === item.personId);
          if (!person) throw new Error(`${item.personName} was not found.`);
          await actions.recordPersonPayment(person, {
            direction: "theyPaid",
            amount: item.amount,
            date: item.date,
            accountId,
            note: [item.recordedEarlier ? "Received earlier — already in my account" : null, item.dateKnown ? null : "date not known"].filter(Boolean).join(" · "),
            lines: [
              {
                key: item.obligationKey,
                amount: item.amount,
                route: { kind: "derived", obligationRef: item.obligationKey, sourceKind: item.obligationKey.startsWith("loan-inst:") ? "loanInstallment" : "emiInstallment" },
              },
            ],
            extra: null,
            recordedEarlier: item.recordedEarlier,
            dateKnown: item.dateKnown,
            idempotencyKey: item.key,
          });
          // A "receivedBack" lowers what they owe me by exactly the amount.
          expected.set(item.personId, { ...person, currentBalance: round2(person.currentBalance - item.amount) });
        },
        previous,
      );
    },
    [actions, people],
  );

  return { lines, isLoading: target != null && isLoading, record };
}
