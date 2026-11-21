/**
 * One linked agreement's responsibility split into the five things a person page has to tell apart:
 *   Bank paid    — installments the lender has been paid (a fact about the bank, never the person's payment)
 *   Repaid       — what the person paid you against their installment shares
 *   Still owed   — open on shares already due, not postponed
 *   Postponed    — open shares moved to a later cycle (still owed)
 *   Later        — open shares not yet due
 * Display grouping only — every input is an existing `PersonLinkedEmi` installment figure plus the live deferral lookup;
 * nothing here feeds a balance, an allocation or a write. Repaid + Still owed + Postponed + Later = the total of the shares.
 */
import type { PersonLinkedEmi } from "@/lib/engines/person-linked-emis";

export interface EmiResponsibility {
  repaid: number;
  owed: number;
  postponed: number;
  later: number;
  /** Sum of the person's installment shares. */
  total: number;
  bankPaidCount: number;
  installmentCount: number;
  postponedCount: number;
  overdueCount: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function emiResponsibility(s: PersonLinkedEmi, isPostponed: (key: string) => boolean, now: Date = new Date()): EmiResponsibility {
  let repaid = 0;
  let owed = 0;
  let postponed = 0;
  let later = 0;
  let bankPaidCount = 0;
  let postponedCount = 0;
  let overdueCount = 0;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  for (const i of s.installments) {
    repaid += i.paid;
    if (i.lenderStatus === "paid") bankPaidCount += 1;
    if (i.remaining <= 0.005) continue;
    if (isPostponed(i.key)) {
      postponed += i.remaining;
      postponedCount += 1;
    } else if (new Date(i.dueDate.getFullYear(), i.dueDate.getMonth(), i.dueDate.getDate()).getTime() > today) {
      later += i.remaining;
    } else {
      owed += i.remaining;
      if (i.status === "overdue" || i.status === "partial") overdueCount += 1;
    }
  }
  return {
    repaid: r2(repaid),
    owed: r2(owed),
    postponed: r2(postponed),
    later: r2(later),
    total: r2(repaid + owed + postponed + later),
    bankPaidCount,
    installmentCount: s.installments.length,
    postponedCount,
    overdueCount,
  };
}

/** The five segments in reading order — shared by the bar, the legend and the board's columns. */
export const RESPONSIBILITY_SEGMENTS = [
  { key: "repaid", label: "Repaid to you", short: "Repaid", bar: "bg-success", dot: "bg-success", text: "text-success" },
  { key: "owed", label: "Still owed", short: "Owed", bar: "bg-expense", dot: "bg-expense", text: "text-expense" },
  { key: "postponed", label: "Postponed", short: "Postponed", bar: "bg-primary-accent-text", dot: "bg-primary-accent-text", text: "text-primary-accent-text" },
  { key: "later", label: "Later installments", short: "Later", bar: "bg-foreground/15", dot: "bg-foreground/25", text: "text-foreground/70" },
] as const;
