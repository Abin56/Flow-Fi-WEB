/**
 * "Not received yet — postpone their share" (shared Loan / EMI Record payment): one People deferral request per
 * open share, all to the same expected cycle. Pure — the dialog panel (`share-postpone.tsx`) and the tests share it.
 * The requests go through `PaymentDeferralRepository.apply`, the ONE postponement People already has: timing
 * metadata only, never a payment, never the lender installment.
 */

import type { PostponeRequest } from "@/lib/engines/person-payment-deferral";
import { quickPostpone } from "@/lib/engines/person-due-now";
import type { StatementCycle } from "@/lib/engines/person-cycle-statement";
import { PAYMENT_EPSILON } from "@/lib/engines/person-payment";
import type { FollowUpKind } from "@/lib/models/person-follow-up";
import type { PersonPaymentDeferral } from "@/lib/models/person-payment-deferral";

export interface PostponeShare {
  personId: string;
  personName: string;
  /** The person's open shares of what this payment covers (`emi-inst:` / `loan-inst:` keys). */
  obligations: readonly { key: string; title: string; remaining: number }[];
}

/**
 * "Remind me about the rest" moves a share only when the one-click Postpone could (`quickPostpone`). A share already
 * expected in a later cycle is left exactly where it is — never pushed again, never pulled earlier — and only gets
 * the reminder.
 */
export function splitReminderShares(params: {
  people: readonly PostponeShare[];
  dateOf: (obligationKey: string) => Date;
  deferralsByPerson: Readonly<Record<string, readonly PersonPaymentDeferral[]>>;
  startDay: number;
  now: Date;
}): { toPostpone: PostponeShare[]; remindOnly: { personId: string; key: string; title: string }[] } {
  const toPostpone: PostponeShare[] = [];
  const remindOnly: { personId: string; key: string; title: string }[] = [];
  for (const p of params.people) {
    const movable: PostponeShare["obligations"][number][] = [];
    for (const o of p.obligations) {
      if (o.remaining <= PAYMENT_EPSILON) continue;
      const deferral = (params.deferralsByPerson[p.personId] ?? []).find((d) => d.obligationKey === o.key);
      if (quickPostpone({ deferral, obligationDate: params.dateOf(o.key), startDay: params.startDay, today: params.now }).allowed) movable.push(o);
      else remindOnly.push({ personId: p.personId, key: o.key, title: o.title });
    }
    if (movable.length > 0) toPostpone.push({ ...p, obligations: movable });
  }
  return { toPostpone, remindOnly };
}

export function planSharePostpone(params: {
  people: readonly PostponeShare[];
  dateOf: (obligationKey: string) => Date;
  deferralsByPerson: Readonly<Record<string, readonly PersonPaymentDeferral[]>>;
  target: StatementCycle;
  reminder: { kind: FollowUpKind; remindOn: Date } | null;
  startDay: number;
  now: Date;
  /** Per person AND share: several people share one installment key, each with their own deferral. */
  requestIdFor: (personId: string, obligationKey: string) => string;
}): PostponeRequest[] {
  const { people, dateOf, deferralsByPerson, target, reminder, startDay, now, requestIdFor } = params;
  return people.flatMap((p) =>
    p.obligations
      .filter((o) => o.remaining > PAYMENT_EPSILON)
      .map((o) => ({
        action: "postpone" as const,
        requestId: requestIdFor(p.personId, o.key),
        expectedRevision: (deferralsByPerson[p.personId] ?? []).find((d) => d.obligationKey === o.key)?.revision ?? 0,
        personId: p.personId,
        obligationKey: o.key,
        obligationTitle: o.title,
        now,
        startDay,
        obligationDate: dateOf(o.key),
        remaining: o.remaining,
        target,
        reason: "unableNow" as const,
        note: null,
        reminder,
      })),
  );
}
