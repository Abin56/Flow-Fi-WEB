/**
 * Cache key of the fan-out payment reads (`useEmiInstallmentPayments`, `useLoanScheduledPayments`). Those reads are
 * cached forever and re-run only when this key changes.
 *
 * It used to be built from each installment's `amountPaid` only. Editing a payment's DATE (or re-allocating it at the
 * same total) soft-deletes the old payment records and writes new ones with an identical `amountPaid`, so the key did
 * not change and every consumer (Month Cycle, Dashboard Money Out, Reports, Analytics) kept the old payment date until
 * a full reload. Every payment that moved money also writes its linked Transaction (a new id or a new date / amount),
 * so those rows are part of the key now.
 */
export function paymentRowsKey(
  installments: readonly { scheduleId: string; id: string; amountPaid: number }[],
  linkedTransactions: readonly { id: string; dateTime: Date; amount: number }[],
  extra: (i: { scheduleId: string; id: string; amountPaid: number }) => string = () => "",
): string {
  const inst = installments.map((i) => `${i.scheduleId}:${i.id}:${i.amountPaid}${extra(i)}`).sort().join(",");
  const tx = linkedTransactions.map((t) => `${t.id}@${t.dateTime.getTime()}#${t.amount}`).sort().join(",");
  return `${inst}|${tx}`;
}
