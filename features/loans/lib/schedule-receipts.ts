import type { AgreementPeopleLine } from "@/features/loans/lib/agreement-people";
import { receivedHistory } from "@/features/loans/lib/received-history";
import { advanceSources } from "@/features/people/lib/person-payment-obligations";
import type { StatementCycle } from "@/lib/engines/person-cycle-statement";
import { advanceRemaining, PAYMENT_EPSILON, round2 } from "@/lib/engines/person-payment";
import type { AdvanceApplication, LedgerEntry } from "@/lib/models/person";

/** Display context for one person across this agreement. The saved settlement still comes from each share row. */
export function scheduleReceipts({
  entries,
  applications,
  lines,
  cycle,
}: {
  entries: readonly LedgerEntry[];
  applications?: readonly AdvanceApplication[];
  lines: readonly AgreementPeopleLine[];
  cycle: StatementCycle;
}) {
  const history = receivedHistory(entries, cycle);
  const receipts = history.recent.flatMap((receipt) => receipt.entries);
  const installmentByKey = new Map(lines.map((line) => [line.key, line.sequenceNumber]));
  const advances = applications && advanceRemaining(advanceSources(receipts), applications);
  const unusedByEntry = new Map(advances?.map((a) => [a.entryId, a.remaining]));
  const applicationsByEntry = new Map<string, AdvanceApplication[]>();
  for (const app of applications ?? []) {
    if (app.deletedAt != null || app.amount <= PAYMENT_EPSILON) continue;
    const group = applicationsByEntry.get(app.advanceEntryId) ?? [];
    group.push(app);
    applicationsByEntry.set(app.advanceEntryId, group);
  }
  const transactionsWithObligations = new Set(entries.flatMap((e) =>
    e.deletedAt == null && e.type === "gave" && e.transactionRef ? [e.transactionRef] : [],
  ));
  const availableAdvance = advances && round2(advances.reduce((sum, a) => sum + a.remaining, 0));
  const earlierAdvance = round2(receipts.reduce((sum, e) =>
    e.receivedDateKnown !== false && e.date < cycle.start ? sum + (unusedByEntry.get(e.id) ?? 0) : sum, 0));

  const recent = history.recent.flatMap((receipt) => {
    const parts = new Map<string, number>();
    const installmentKeys = new Set<string>();
    let relevant = false;
    const add = (label: string, amount: number) => {
      if (amount > PAYMENT_EPSILON) parts.set(label, round2((parts.get(label) ?? 0) + amount));
    };
    for (const entry of receipt.entries) {
      if (entry.sourceKind === "advance") {
        if (!applications) {
          add("Advance receipt", entry.amount);
          relevant = true;
          continue;
        }
        const unused = unusedByEntry.get(entry.id) ?? 0;
        for (const app of applicationsByEntry.get(entry.id) ?? []) {
          const sequence = installmentByKey.get(app.obligationKey);
          if (sequence != null) installmentKeys.add(app.obligationKey);
          add(sequence != null ? `Advance applied to #${sequence}` : "Advance applied elsewhere", app.amount);
        }
        add("Unallocated advance", unused);
        relevant ||= unused > PAYMENT_EPSILON;
      } else if (entry.obligationRef && installmentByKey.has(entry.obligationRef)) {
        installmentKeys.add(entry.obligationRef);
        add(`Applied to #${installmentByKey.get(entry.obligationRef)}`, entry.amount);
      } else if (entry.obligationRef || entry.parentEntryId || (entry.transactionRef && transactionsWithObligations.has(entry.transactionRef))) {
        add("Other obligation", entry.amount);
      } else if (entry.sourceKind === "emiInstallment" || entry.sourceKind === "loanInstallment") {
        add("Installment link unavailable", entry.amount);
      } else {
        relevant = true;
        add("General receipt · no installment selected", entry.amount);
      }
    }
    return relevant || installmentKeys.size > 0
      ? [{ key: receipt.key, date: receipt.date, amount: receipt.amount, parts, installmentKeys }]
      : [];
  });
  return { cycle, receivedThisCycle: history.receivedThisCycle, availableAdvance, earlierAdvance, recent };
}

export type ScheduleReceipts = ReturnType<typeof scheduleReceipts>;
