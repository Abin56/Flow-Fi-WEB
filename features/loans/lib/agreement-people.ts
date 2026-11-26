/**
 * The People side of one Loan / EMI, grouped per person for the detail page's People tab. Pure and derived — it reads the
 * participant shares `installmentBreakdown` already produces (the People Ledger's own `share` / `received` / `remaining`)
 * and the person's postponements, and only names each share's state. It never settles, moves or reschedules anything:
 * paying the bank does not mark anyone as having paid; only a recorded reimbursement lowers `remaining`.
 */
import type { InstallmentParticipant } from "@/lib/engines/installment-participants";
import { isPaidDirectlyEntry } from "@/lib/engines/historical-reimbursement";
import { PAYMENT_EPSILON, round2 } from "@/lib/engines/person-payment";
import { deferralView } from "@/lib/engines/person-payment-deferral";
import { isClosedCycle, isPostponedBeyond } from "@/lib/engines/person-due-now";
import type { StatementCycle, StatementRow } from "@/lib/engines/person-cycle-statement";
import { remainingAmount, type Installment } from "@/lib/models/payment-schedule";
import type { PersonPaymentDeferral } from "@/lib/models/person-payment-deferral";
import type { LedgerEntry } from "@/lib/models/person";
import { formatCurrencyExact } from "@/lib/format";

export type PersonShareStatus = "received" | "partial" | "pending" | "postponed";

export const PERSON_STATUS_LABEL: Record<PersonShareStatus, string> = {
  received: "Received",
  partial: "Partially received",
  pending: "Pending",
  postponed: "Postponed",
};

export interface AgreementPeopleLine {
  personId: string;
  personName: string;
  /** People statement row key — what People "Record received" / "Postpone" act on. */
  key: string;
  installmentId: string;
  sequenceNumber: number;
  dueDate: Date;
  share: number;
  received: number;
  remaining: number;
  fromAdvance?: number;
  paidDirectly?: boolean;
  status: PersonShareStatus;
  /** The postponed-to date (when one is set) — a postponed share is still owed. */
  postponedDate: Date | null;
  /** The People Ledger's expected cycle, including when a postponement comes due. */
  expectedCycle?: StatementCycle;
  /** The bank installment itself is fully paid — a separate fact from this person's repayment. */
  bankPaid: boolean;
}

export interface AgreementPerson {
  personId: string;
  personName: string;
  share: number;
  received: number;
  remaining: number;
  lines: AgreementPeopleLine[];
  /** The oldest share still open (what "Record received" / "Postpone" start from), or null when nothing is open. */
  firstOpen: AgreementPeopleLine | null;
  /** Paid toward their overall balance with no installment chosen — separate from `received`, never counted in it. */
  generalCredit: number;
}

/** The linked shares due through a cycle, including older unpaid shares and only their assigned settlements. */
export function agreementPeopleDueThrough(
  people: readonly AgreementPerson[],
  statements: Readonly<Record<string, { rows: readonly StatementRow[] }>>,
  cycle: StatementCycle,
  today: Date = new Date(),
): number {
  const end = new Date(cycle.end.getFullYear(), cycle.end.getMonth(), cycle.end.getDate(), 23, 59, 59, 999);
  const historical = isClosedCycle(cycle, today);
  let due = 0;
  for (const person of people) {
    const remainingByKey = new Map<string, number>();
    for (const row of statements[person.personId]?.rows ?? []) {
      if (row.date <= end && row.settlesKey && row.settles) {
        remainingByKey.set(row.settlesKey, row.settles.remainingAfter);
      }
    }
    for (const line of person.lines) {
      if (line.dueDate > end) continue;
      if (!historical && line.status === "postponed" && line.expectedCycle && isPostponedBeyond({
        status: line.status,
        date: line.postponedDate,
        cycle: line.expectedCycle,
      }, cycle)) continue;
      due += remainingByKey.get(line.key) ?? line.share;
    }
  }
  return round2(due);
}

/** Every person's line, grouped by installment — the schedule table's People column reads one installment at a time. */
export function peopleLinesByInstallment(people: readonly AgreementPerson[]): Map<string, AgreementPeopleLine[]> {
  const out = new Map<string, AgreementPeopleLine[]>();
  for (const p of people) for (const l of p.lines) out.set(l.installmentId, [...(out.get(l.installmentId) ?? []), l]);
  return out;
}

/**
 * One word for everyone's shares of ONE installment: Received (all in) · Postponed (nothing in, every open share moved) ·
 * Partially received (something in, something open — or one share part-paid) · Pending (nothing in yet).
 * Never derived from the bank installment: only recorded reimbursements count as received.
 */
export function summarizePeopleLines(lines: readonly Pick<AgreementPeopleLine, "status">[]): PersonShareStatus | null {
  if (lines.length === 0) return null;
  const open = lines.filter((l) => l.status !== "received");
  if (open.length === 0) return "received";
  const gotSome = open.length < lines.length || open.some((l) => l.status === "partial");
  if (gotSome) return "partial";
  return open.every((l) => l.status === "postponed") ? "postponed" : "pending";
}

/** Wording for a saved settlement, including non-cash coverage where the ledger identifies it. */
export function shareCoverageLabel(line: AgreementPeopleLine): string {
  return line.paidDirectly || (line.fromAdvance ?? 0) > PAYMENT_EPSILON ? "settled" : "received";
}

export function schedulePeopleRepayment(lines: readonly AgreementPeopleLine[], status: PersonShareStatus, future: boolean) {
  if (lines.length === 0 || lines.some(({ share, received, remaining }) =>
    ![share, received, remaining].every((n) => Number.isFinite(n) && n >= 0) || Math.abs(share - received - remaining) > PAYMENT_EPSILON
  )) return { text: PERSON_STATUS_LABEL[status], detail: undefined, amounts: null };

  const received = round2(lines.reduce((sum, line) => sum + line.received, 0));
  const remaining = round2(lines.reduce((sum, line) => sum + line.remaining, 0));
  const label = lines.some((line) => shareCoverageLabel(line) === "settled") ? "settled" : "received";
  const postponed = lines.some((line) => line.status === "postponed");
  const allOpenPostponed = postponed && lines.every((line) => line.status === "postponed" || line.status === "received");
  const timing = postponed ? (allOpenPostponed ? "Postponed" : "Partly postponed") : null;
  const detail = lines.map((line) => {
    const advance = (line.fromAdvance ?? 0) > PAYMENT_EPSILON ? ` · ${formatCurrencyExact(line.fromAdvance!)} from advance` : "";
    const direct = line.paidDirectly ? " · includes direct lender payment" : "";
    const timing = line.status === "postponed"
      ? ` · postponed${line.postponedDate ? ` until ${line.postponedDate.toLocaleDateString("en-IN")}` : ""}` : "";
    return `${line.personName}: ${formatCurrencyExact(line.received)} ${shareCoverageLabel(line)} · ${formatCurrencyExact(line.remaining)} left${advance}${direct}${timing}`;
  }).join("\n");
  return future && received <= PAYMENT_EPSILON && !postponed
    ? { text: PERSON_STATUS_LABEL.pending, detail, amounts: null }
    : { text: null, detail, amounts: { received, remaining, label, timing } };
}

export function agreementPeople(params: {
  participantsByInstallment: ReadonlyMap<string, readonly InstallmentParticipant[]>;
  installments: readonly Installment[];
  deferralsByPerson: Readonly<Record<string, readonly PersonPaymentDeferral[]>>;
  startDay: number;
  entriesByPersonId?: Readonly<Record<string, readonly LedgerEntry[]>>;
}): AgreementPerson[] {
  const installmentById = new Map(params.installments.map((i) => [i.id, i]));
  const directByPerson = new Map<string, Set<string>>();
  const people = new Map<string, AgreementPerson>();
  for (const [installmentId, participants] of params.participantsByInstallment) {
    const installment = installmentById.get(installmentId);
    if (!installment) continue;
    const bankPaid = installment.amountPaid > 0 && remainingAmount(installment) <= PAYMENT_EPSILON;
    for (const p of participants) {
      const l = p.current;
      if (l == null || l.share <= PAYMENT_EPSILON) continue;
      let direct = directByPerson.get(p.personId);
      if (!direct) {
        direct = new Set((params.entriesByPersonId?.[p.personId] ?? []).flatMap((entry) =>
          entry.deletedAt == null && entry.type === "receivedBack" && entry.obligationRef && isPaidDirectlyEntry(entry) ? [entry.obligationRef] : []
        ));
        directByPerson.set(p.personId, direct);
      }
      let status: PersonShareStatus;
      let postponedDate: Date | null = null;
      let expectedCycle: StatementCycle | undefined;
      if (l.remaining <= PAYMENT_EPSILON) status = "received";
      else {
        const deferral = params.deferralsByPerson[p.personId]?.find((d) => d.obligationKey === l.key);
        const view = deferral ? deferralView(deferral, l.remaining, params.startDay) : null;
        expectedCycle = view?.cycle;
        if (view?.status === "postponed") {
          status = "postponed";
          postponedDate = view.date ?? null;
        } else status = l.received > PAYMENT_EPSILON ? "partial" : "pending";
      }
      const line: AgreementPeopleLine = {
        personId: p.personId,
        personName: p.personName,
        key: l.key,
        installmentId,
        sequenceNumber: l.sequenceNumber,
        dueDate: l.dueDate,
        share: l.share,
        received: l.received,
        remaining: l.remaining,
        fromAdvance: l.fromAdvance,
        paidDirectly: l.received > PAYMENT_EPSILON && direct.has(l.key),
        status,
        postponedDate,
        expectedCycle,
        bankPaid,
      };
      const person = people.get(p.personId) ?? { personId: p.personId, personName: p.personName, share: 0, received: 0, remaining: 0, lines: [], firstOpen: null, generalCredit: p.generalCredit ?? 0 };
      person.lines.push(line);
      person.share = round2(person.share + l.share);
      person.received = round2(person.received + Math.min(l.received, l.share));
      person.remaining = round2(person.remaining + l.remaining);
      people.set(p.personId, person);
    }
  }
  for (const person of people.values()) {
    person.lines.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    person.firstOpen = person.lines.find((x) => x.remaining > PAYMENT_EPSILON) ?? null;
  }
  return [...people.values()].sort((a, b) => a.personName.localeCompare(b.personName));
}
