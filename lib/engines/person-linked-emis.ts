/**
 * Per-person "Linked EMIs" summary — one compact row per Loan / EMI a Person carries a share of, plus its
 * monthly schedule. Pure and derived: nothing here is stored, so it can never drift from the People
 * Ledger or the Loan & EMI screens.
 *
 * Sources of truth (never recomputed here):
 *  - Which installments the Person owes me, and how much of each (their share on a shared agreement):
 *    `personEmiObligations` — the same primitive the People list and the cycle statement read.
 *  - How much of each share is still open: the People statement's `remainingNow` for that obligation row
 *    (a Person's receipt, a settled advance, a postponed share all flow through there). A row the
 *    statement does not list yet (a future cycle) has nothing received against it.
 *  - The lender's installment state is context only (`lenderStatus`). Me paying the bank never settles the
 *    Person, and the Person paying me never settles the bank — the two sides stay separate.
 *
 * "Due" means the installment's due date is on or before today. Installments not yet due are `upcoming`
 * and never counted as overdue or as money owed now.
 */

import type { PersonEmiObligation } from "@/lib/engines/person-emi-obligations";

export type LinkedEmiInstallmentStatus = "paid" | "partial" | "overdue" | "pending" | "upcoming";
export type LinkedEmiStatus = "paid" | "partial" | "overdue" | "pending";

const EPSILON = 0.005;
const round2 = (v: number) => Math.round(v * 100) / 100;
const dayIndex = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export interface LinkedEmiInstallment {
  key: string;
  installmentId: string;
  number: number;
  dueDate: Date;
  /** The Person's share of this installment. */
  amount: number;
  /** Received against that share (share − still open). */
  paid: number;
  remaining: number;
  status: LinkedEmiInstallmentStatus;
  /** What the bank side of this installment looks like — context only. */
  lenderStatus: PersonEmiObligation["lenderStatus"];
}

export interface PersonLinkedEmi {
  /** `loan:{id}` / `emi:{id}` */
  key: string;
  sourceKind: "emi" | "loan";
  sourceId: string;
  name: string;
  /** More than one person (or me plus someone) divides this agreement's installments. */
  shared: boolean;
  /** The Person's share of the next open installment (else of the last one) — their monthly responsibility. */
  monthlyShare: number;
  /** The whole installment the lender expects, when it differs from the share. */
  installmentAmount: number;
  nextDue: { dueDate: Date; remaining: number; number: number } | null;
  /** Shares of installments due on or before today. */
  dueToDate: number;
  /** Received against every installment share (all of them, including paid ahead). */
  paid: number;
  /** Still open on installments already due. */
  remaining: number;
  /** Still open on installments not yet due. */
  upcoming: number;
  installmentCount: number;
  paidCount: number;
  overdueCount: number;
  status: LinkedEmiStatus;
  installments: LinkedEmiInstallment[];
}

export function installmentStatusOf(amount: number, remaining: number, dueDate: Date, now: Date): LinkedEmiInstallmentStatus {
  if (remaining <= EPSILON) return "paid";
  if (dayIndex(dueDate) > dayIndex(now)) return remaining < amount - EPSILON ? "partial" : "upcoming";
  if (dayIndex(dueDate) < dayIndex(now)) return remaining < amount - EPSILON ? "partial" : "overdue";
  return remaining < amount - EPSILON ? "partial" : "pending";
}

/**
 * `obligations` are one Person's (`personEmiObligations`). `remainingByKey` maps an obligation key
 * (`emi-inst:{id}` / `loan-inst:{id}`) to its statement `remainingNow`; absent keys are fully open.
 * `sharedSourceIds` lists agreements (`loan:{id}` / `emi:{id}`) divided between several parties.
 */
export function personLinkedEmis(params: {
  obligations: readonly PersonEmiObligation[];
  remainingByKey: ReadonlyMap<string, number>;
  sharedSourceIds?: ReadonlySet<string>;
  now?: Date;
}): PersonLinkedEmi[] {
  const now = params.now ?? new Date();
  const groups = new Map<string, PersonEmiObligation[]>();
  for (const o of params.obligations) {
    const key = `${o.sourceKind}:${o.sourceId}`;
    const list = groups.get(key) ?? [];
    list.push(o);
    groups.set(key, list);
  }

  const result: PersonLinkedEmi[] = [];
  for (const [key, list] of groups) {
    const sorted = [...list].sort((a, b) => a.installmentNumber - b.installmentNumber);
    const installments: LinkedEmiInstallment[] = sorted.map((o) => {
      const remaining = round2(Math.min(o.amount, Math.max(0, params.remainingByKey.get(o.key) ?? o.amount)));
      return {
        key: o.key,
        installmentId: o.installmentId,
        number: o.installmentNumber,
        dueDate: o.dueDate,
        amount: o.amount,
        paid: round2(o.amount - remaining),
        remaining,
        status: installmentStatusOf(o.amount, remaining, o.dueDate, now),
        lenderStatus: o.lenderStatus,
      };
    });
    const isDue = (i: LinkedEmiInstallment) => dayIndex(i.dueDate) <= dayIndex(now);
    const open = installments.filter((i) => i.remaining > EPSILON);
    const next = open[0] ?? null;
    const dueRows = installments.filter(isDue);
    const overdue = installments.filter((i) => i.status === "overdue" || (i.status === "partial" && dayIndex(i.dueDate) < dayIndex(now)));
    const first = sorted[0];
    const status: LinkedEmiStatus = overdue.length > 0
      ? "overdue"
      : installments.some((i) => i.status === "partial")
        ? "partial"
        : dueRows.some((i) => i.remaining > EPSILON)
          ? "pending"
          : open.length === 0 || dueRows.length > 0
            ? "paid"
            : "pending";
    result.push({
      key,
      sourceKind: first.sourceKind,
      sourceId: first.sourceId,
      name: first.sourceName,
      shared: params.sharedSourceIds?.has(key) ?? first.amount < first.installmentAmount - EPSILON,
      monthlyShare: round2((next ? sorted.find((o) => o.key === next.key) : sorted[sorted.length - 1])?.amount ?? first.amount),
      installmentAmount: first.installmentAmount,
      nextDue: next ? { dueDate: next.dueDate, remaining: next.remaining, number: next.number } : null,
      dueToDate: round2(dueRows.reduce((s, i) => s + i.amount, 0)),
      paid: round2(installments.reduce((s, i) => s + i.paid, 0)),
      remaining: round2(dueRows.reduce((s, i) => s + i.remaining, 0)),
      upcoming: round2(installments.filter((i) => !isDue(i)).reduce((s, i) => s + i.remaining, 0)),
      installmentCount: installments.length,
      paidCount: installments.filter((i) => i.status === "paid").length,
      overdueCount: overdue.length,
      status,
      installments,
    });
  }
  // Needs attention first (overdue, then soonest next due), settled agreements last.
  const rank: Record<LinkedEmiStatus, number> = { overdue: 0, partial: 1, pending: 2, paid: 3 };
  return result.sort((a, b) => rank[a.status] - rank[b.status] || (a.nextDue?.dueDate.getTime() ?? Infinity) - (b.nextDue?.dueDate.getTime() ?? Infinity));
}
