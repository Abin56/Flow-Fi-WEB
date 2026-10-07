/**
 * One Person's financial position — the single People rule shared by Web and Flutter
 * (`lib/features/people/domain/person_position.dart`), held to identical answers by
 * `tests/cross-platform-fixtures/person-position-fixture.json`. Pure.
 *
 * Canonical sources:
 *  - Direct obligations (split expenses, settlements, manual gave/borrowed/adjustments, "someone paid
 *    my EMI" attributions) → the Person ledger (`Person.currentBalance`).
 *  - Loan obligations → the Loan itself: outstanding principal (never future interest — the same
 *    `outstandingPrincipal` Net Worth uses), attributed to the Loan's counterparty `personId`.
 *    `payerPersonId` (someone who pays a bank Loan's EMIs for me) is not a counterparty — what I owe
 *    them for those EMIs is already a direct ledger entry.
 *
 * Legacy de-duplication: the old Web Loan form also posted Loan-generated ledger entries ("gave"/
 * "borrowed" at creation, "receivedBack"/"repaid" per payment), each stamped `transactionRef = loan.id`
 * (`loan-ledger-sync.ts`). Those entries are recognised ONLY by that persisted link — never by amount,
 * date or text — and their signed amount is taken back out of the direct balance, so the Loan counts once.
 * A Transaction id never equals a Loan id (both are generated UUIDs / `orig_…` ids).
 *
 * Trashed Loans are excluded (Trash leaves Net Worth), closed Loans are included (a closed Loan with
 * principal left is not repaid principal) — both exactly as the Loan balance sheet.
 */

export interface PositionLoan {
  id: string;
  personId: string | null;
  direction: "given" | "taken";
  outstandingPrincipal: number;
  isDeleted: boolean;
}

export interface PositionLedgerEntry {
  transactionRef: string | null;
  /** `signedAmount(entry)` — positive = they owe me more. */
  signedAmount: number;
  isDeleted: boolean;
}

export interface PersonPosition {
  /** Direct Person ledger balance with Loan-generated legacy entries taken out. */
  directBalance: number;
  /**
   * What they owe me for explicitly opted-in Person-linked EMI installments due so far
   * (`emiReceivableThrough` in `person-emi-obligations.ts`). Their repayments are already in the direct
   * ledger balance; lender payments never reduce it. 0 on Flutter, which has no such opt-in yet.
   */
  emiReceivable: number;
  /** Outstanding principal they owe me through Loans I lent them. */
  loanReceivable: number;
  /** Outstanding principal I owe them through Loans I borrowed from them. */
  loanPayable: number;
  /** Signed sum of this person's active legacy Loan-generated ledger entries (removed from `directBalance`). */
  legacyLoanLedger: number;
  /** direct + EMI receivable + Loan receivable − Loan payable. Positive: they owe me. */
  net: number;
  owesMe: number;
  iOwe: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** True for a ledger entry the old Web Loan form generated for one of `loanIds`. */
export function isLegacyLoanLedgerEntry(entry: Pick<PositionLedgerEntry, "transactionRef">, loanIds: ReadonlySet<string>): boolean {
  return entry.transactionRef != null && loanIds.has(entry.transactionRef);
}

/**
 * @param loanIds every known Loan id (active AND trashed) — so a legacy entry of a trashed Loan is
 *   still recognised as Loan-generated.
 */
export function personPosition(params: {
  personId: string;
  currentBalance: number;
  loans: readonly PositionLoan[];
  ledgerEntries: readonly PositionLedgerEntry[];
  loanIds: ReadonlySet<string>;
  /** Person-linked EMI receivable (defaults to 0 — see `PersonPosition.emiReceivable`). */
  emiReceivable?: number;
}): PersonPosition {
  const { personId, currentBalance, loans, ledgerEntries, loanIds, emiReceivable = 0 } = params;
  const legacyLoanLedger = ledgerEntries
    .filter((e) => !e.isDeleted && isLegacyLoanLedgerEntry(e, loanIds))
    .reduce((sum, e) => sum + e.signedAmount, 0);
  let loanReceivable = 0;
  let loanPayable = 0;
  for (const loan of loans) {
    if (loan.personId !== personId || loan.isDeleted) continue;
    if (loan.direction === "given") loanReceivable += loan.outstandingPrincipal;
    else loanPayable += loan.outstandingPrincipal;
  }
  const directBalance = round2(currentBalance - legacyLoanLedger);
  const net = round2(directBalance + emiReceivable + loanReceivable - loanPayable);
  return {
    directBalance,
    emiReceivable: round2(emiReceivable),
    loanReceivable: round2(loanReceivable),
    loanPayable: round2(loanPayable),
    legacyLoanLedger: round2(legacyLoanLedger),
    net,
    owesMe: net > 0 ? net : 0,
    iOwe: net < 0 ? -net : 0,
  };
}

/** People-list totals over every person's position. */
export function peopleTotals(positions: readonly PersonPosition[]): {
  totalOwedToMe: number;
  owedByCount: number;
  totalIOwe: number;
  owingCount: number;
  net: number;
} {
  const totalOwedToMe = round2(positions.reduce((s, p) => s + p.owesMe, 0));
  const totalIOwe = round2(positions.reduce((s, p) => s + p.iOwe, 0));
  return {
    totalOwedToMe,
    owedByCount: positions.filter((p) => p.owesMe > 0).length,
    totalIOwe,
    owingCount: positions.filter((p) => p.iOwe > 0).length,
    net: round2(totalOwedToMe - totalIOwe),
  };
}

/** A ledger entry as the balance breakdown reads it — direction comes from `type`, never from a sign. */
export interface BreakdownLedgerEntry {
  id: string;
  type: "gave" | "borrowed" | "receivedBack" | "repaid" | "adjustment";
  /** Always positive (`LedgerEntry.amount`). */
  amount: number;
  parentEntryId: string | null;
  transactionRef: string | null;
  isDeleted: boolean;
  /**
   * `LedgerEntry.obligationRef` — an `emi-inst:` / `loan-inst:` key means this settlement pays a
   * Person-linked installment share (`emiReceivable`), never a direct ledger obligation.
   */
  obligationRef?: string | null;
  /** `LedgerEntry.sourceKind` — `"advance"` marks money paid ahead of any obligation (see `isAdvanceEntry`). */
  sourceKind?: string | null;
}

/**
 * An `AdvanceApplication` as the breakdown reads it: part of an advance entry explicitly applied to one
 * obligation (`ledger:{id}`, `emi-inst:{id}`, `loan-inst:{id}`). Moves neither cash nor the balance.
 */
export interface BreakdownAdvanceApplication {
  advanceEntryId: string;
  obligationKey: string;
  amount: number;
  deletedAt: Date | null;
}

/**
 * True for an advance — money received from / paid to the person ahead of any obligation (Record Payment
 * "keep as advance"). It settles nothing until explicitly applied; the People statement keeps it apart
 * from pending (`ledger balance = pending + advance`), and so does the breakdown.
 */
export function isAdvanceEntry(entry: Pick<BreakdownLedgerEntry, "type" | "sourceKind" | "parentEntryId" | "obligationRef">): boolean {
  return (
    (entry.type === "receivedBack" || entry.type === "repaid") &&
    entry.sourceKind === "advance" &&
    entry.parentEntryId == null &&
    entry.obligationRef == null
  );
}

/** True for a settlement entry Record Payment allocated to a Person-linked EMI / Loan installment share. */
export function isInstallmentShareSettlement(entry: Pick<BreakdownLedgerEntry, "type" | "obligationRef">): boolean {
  return (
    (entry.type === "receivedBack" || entry.type === "repaid") &&
    entry.obligationRef != null &&
    (entry.obligationRef.startsWith("emi-inst:") || entry.obligationRef.startsWith("loan-inst:"))
  );
}

/** A `LedgerEntry`-shaped document as the breakdown reads it — the one mapping every caller uses. */
export function breakdownEntryOf(e: {
  id: string;
  type: BreakdownLedgerEntry["type"];
  amount: number;
  parentEntryId: string | null;
  transactionRef: string | null;
  obligationRef?: string | null;
  sourceKind?: string | null;
  deletedAt: Date | null;
}): BreakdownLedgerEntry {
  return {
    id: e.id,
    type: e.type,
    amount: e.amount,
    parentEntryId: e.parentEntryId,
    transactionRef: e.transactionRef,
    obligationRef: e.obligationRef ?? null,
    sourceKind: e.sourceKind ?? null,
    isDeleted: e.deletedAt != null,
  };
}

/**
 * Why a person's balance is what it is — the gross directions behind `PersonPosition.net`. Pure
 * explanation, never a second balance: `toReceive − toGive + advance === position.net` always.
 *
 *  - Each active "borrowed" entry is its own obligation (two borrowings add up — they never offset each
 *    other); each "gave" entry likewise. Their open amount is the entry minus the "repaid"/"receivedBack"
 *    entries linked to it by `parentEntryId`, and minus the advance explicitly applied to it.
 *  - Loans are added from the position as-is (Loan principal).
 *  - The opted-in EMI receivable (installment shares due so far) is reduced by the settlements Record
 *    Payment allocated to those shares (`obligationRef` `emi-inst:`/`loan-inst:`) and by advance explicitly
 *    applied to them — ID-based, never by amount. Those settlements are NOT direct-ledger payments:
 *    counting them as an unlinked remainder turned a settled share into a phantom "to give" beside a stale
 *    "to receive" and shrank the person's unrelated card attribution (audit findings F1 / F2). A share
 *    settlement beyond what is due (e.g. the Loan was cancelled after they reimbursed) is money to refund
 *    them: it lands on "to give" and never pays down an unrelated receivable.
 *  - An advance (`isAdvanceEntry`) settles nothing until it is explicitly applied (`AdvanceApplication`).
 *    What is not applied is `advance` — the People statement's advance balance — never "to give", never
 *    "to receive", never netted against any obligation. An application beyond what is open on its
 *    obligation (applied early to a share not yet due) stays held until that share falls due.
 *  - Whatever the direct balance holds beyond all of that (a legacy payment not linked to one entry, a
 *    split share settled by its expense, an adjustment, an opening balance) is `unlinked`: it first reduces
 *    the side it pays down, and only what is left over lands on the other side.
 */
export interface PersonBalanceBreakdown {
  /** Open "borrowed" obligations — what I still owe them from money I borrowed, gross. */
  borrowedOpen: number;
  /** Open "gave" obligations — what they still owe me from money I gave / their split shares, gross. */
  gaveOpen: number;
  /** Signed direct-balance remainder not tied to one open entry (+ = toward "they owe me"). */
  unlinked: number;
  loanPayable: number;
  loanReceivable: number;
  emiReceivable: number;
  /** The EMI receivable still open after share settlements, applied advance and absorbed unlinked payments. */
  emiReceivableOpen: number;
  /**
   * Unapplied advance, FlowFi sign: − = they paid me ahead (money I hold for them), + = I paid them ahead.
   * Never part of `toGive` / `toReceive`.
   */
  advance: number;
  /** Gross: everything I need to give them. */
  toGive: number;
  /** Gross: everything I need to receive from them. */
  toReceive: number;
  /** toReceive − toGive + advance (= `PersonPosition.net`). Positive: they owe me. */
  net: number;
}

const toPaise = (v: number) => Math.round(v * 100);
const fromPaise = (p: number) => p / 100;

export function personBalanceBreakdown(
  position: PersonPosition,
  entries: readonly BreakdownLedgerEntry[],
  loanIds: ReadonlySet<string>,
  advanceApplications: readonly BreakdownAdvanceApplication[] = [],
): PersonBalanceBreakdown {
  const active = entries.filter((e) => !e.isDeleted && !isLegacyLoanLedgerEntry(e, loanIds));
  const byId = new Map(active.map((e) => [e.id, e]));
  const settledByParent = new Map<string, number>();
  for (const e of active) {
    if ((e.type === "repaid" || e.type === "receivedBack") && e.parentEntryId != null) {
      settledByParent.set(e.parentEntryId, (settledByParent.get(e.parentEntryId) ?? 0) + e.amount);
    }
  }
  let shareSettled = 0;
  let advance = 0;
  for (const e of active) {
    if (isInstallmentShareSettlement(e)) shareSettled += e.type === "receivedBack" ? e.amount : -e.amount;
    if (isAdvanceEntry(e)) advance += e.type === "receivedBack" ? -e.amount : e.amount;
  }
  shareSettled = round2(shareSettled);
  const shareDue = round2(position.emiReceivable - shareSettled);

  // Explicit advance applications, in paise: only from an active advance, never beyond it, only in the
  // direction it can cover (their advance settles a "gave" entry or an installment share; mine settles a
  // "borrowed" entry), and never beyond what is open on the obligation.
  const usedByAdvance = new Map<string, number>();
  const appliedByEntry = new Map<string, number>();
  let appliedToShares = 0;
  for (const a of advanceApplications) {
    if (a.deletedAt != null || !(a.amount > 0)) continue;
    const source = byId.get(a.advanceEntryId);
    if (source == null || !isAdvanceEntry(source)) continue;
    let target: BreakdownLedgerEntry | undefined;
    let room = 0;
    if (a.obligationKey.startsWith("ledger:")) {
      target = byId.get(a.obligationKey.slice("ledger:".length));
      if (target == null || target.type !== (source.type === "receivedBack" ? "gave" : "borrowed")) continue;
      room = toPaise(Math.max(0, target.amount - (settledByParent.get(target.id) ?? 0))) - (appliedByEntry.get(target.id) ?? 0);
    } else if (source.type === "receivedBack" && (a.obligationKey.startsWith("emi-inst:") || a.obligationKey.startsWith("loan-inst:"))) {
      room = toPaise(Math.max(shareDue, 0)) - appliedToShares;
    }
    const take = Math.min(toPaise(a.amount), toPaise(source.amount) - (usedByAdvance.get(source.id) ?? 0), room);
    if (take <= 0) continue;
    usedByAdvance.set(source.id, (usedByAdvance.get(source.id) ?? 0) + take);
    if (target != null) appliedByEntry.set(target.id, (appliedByEntry.get(target.id) ?? 0) + take);
    else appliedToShares += take;
    advance += source.type === "receivedBack" ? fromPaise(take) : -fromPaise(take);
  }
  advance = round2(advance);

  let borrowedOpen = 0;
  let gaveOpen = 0;
  for (const e of active) {
    if (e.type !== "borrowed" && e.type !== "gave") continue;
    const open = Math.max(0, e.amount - (settledByParent.get(e.id) ?? 0) - fromPaise(appliedByEntry.get(e.id) ?? 0));
    if (e.type === "borrowed") borrowedOpen += open;
    else gaveOpen += open;
  }
  borrowedOpen = round2(borrowedOpen);
  gaveOpen = round2(gaveOpen);

  // Share settlements pay the EMI receivable, never the direct side; beyond what is due they are a refund
  // owed to the person ("to give"), never netted against an unrelated receivable.
  const emiNet = round2(shareDue - fromPaise(appliedToShares));
  let emiOpen = Math.max(emiNet, 0);
  const shareRefund = Math.max(-emiNet, 0);
  // directBalance + emiReceivable = (gaveOpen − borrowedOpen) + emiNet + advance + unlinked —
  // applications move neither cash nor the balance, only which side holds the money.
  const unlinked = round2(position.directBalance + position.emiReceivable - (gaveOpen - borrowedOpen) - emiNet - advance);

  // An unlinked remainder pays down its own side first; only the excess crosses over.
  let directGive = borrowedOpen + shareRefund;
  let directReceive = gaveOpen;
  if (unlinked > 0) {
    const used = Math.min(unlinked, directGive);
    directGive -= used;
    directReceive += unlinked - used;
  } else if (unlinked < 0) {
    let rest = -unlinked;
    const usedDirect = Math.min(rest, directReceive);
    directReceive -= usedDirect;
    rest -= usedDirect;
    const usedEmi = Math.min(rest, emiOpen);
    emiOpen -= usedEmi;
    rest -= usedEmi;
    directGive += rest;
  }
  emiOpen = round2(emiOpen);

  const toGive = round2(directGive + position.loanPayable);
  const toReceive = round2(directReceive + position.loanReceivable + emiOpen);
  return {
    borrowedOpen,
    gaveOpen,
    unlinked,
    loanPayable: position.loanPayable,
    loanReceivable: position.loanReceivable,
    emiReceivable: position.emiReceivable,
    emiReceivableOpen: emiOpen,
    advance,
    toGive,
    toReceive,
    net: round2(toReceive - toGive + advance),
  };
}

/**
 * Σ what I owe people directly (per person, after that person's own netting) — the People part of Net
 * Worth's `peopleDirectBalance` that is a liability. Person Loans are excluded (already in `loans`).
 */
export function peopleDirectPayable(positions: readonly Pick<PersonPosition, "directBalance">[]): number {
  return round2(positions.reduce((s, p) => s + (p.directBalance < 0 ? -p.directBalance : 0), 0));
}

/** One person's position, ledger entries and advance applications — what the gross views read. */
export interface PersonGrossInput {
  position: PersonPosition;
  entries: readonly BreakdownLedgerEntry[];
  advanceApplications?: readonly BreakdownAdvanceApplication[];
}

/** One person's People-ledger obligations by direction, gross (`personDirectGross`). */
export interface PersonDirectGross {
  /** What they owe me on the direct ledger (Loans and installment shares excluded). */
  receivable: number;
  /** What I owe them on the direct ledger — never an unapplied advance, never a reimbursed share. */
  payable: number;
  /** Their Person-linked installment shares still open. */
  emiReceivableOpen: number;
  /** Unapplied advance they paid me ahead (money I hold for them), ≥ 0. */
  advanceHeld: number;
  /** Unapplied advance I paid them ahead, ≥ 0. */
  advancePaid: number;
}

/**
 * Σ People obligations by direction, GROSS — a person who owes me ₹1,000 while I owe them ₹500
 * is ₹1,000 receivable (asset) AND ₹500 payable (liability), never one netted ₹500. Person Loans are
 * excluded (already in `loans`). `receivable` is the direct ledger only; `emiReceivableOpen` is the open
 * Person-linked installment shares, kept apart so callers that add an EMI figure themselves never count
 * it twice; unapplied advances are apart too.
 * `receivable + emiReceivableOpen − payable − advanceHeld + advancePaid === Σ (directBalance + emiReceivable)`.
 */
export function peopleDirectGross(people: readonly PersonGrossInput[], loanIds: ReadonlySet<string>): PersonDirectGross {
  const sum: PersonDirectGross = { receivable: 0, payable: 0, emiReceivableOpen: 0, advanceHeld: 0, advancePaid: 0 };
  for (const p of people) {
    const direct = personDirectGross(p.position, p.entries, loanIds, p.advanceApplications);
    for (const k of Object.keys(sum) as (keyof PersonDirectGross)[]) sum[k] += direct[k];
  }
  for (const k of Object.keys(sum) as (keyof PersonDirectGross)[]) sum[k] = round2(sum[k]);
  return sum;
}

/** One person's direct (People ledger) obligations by direction, gross — Loans excluded, EMI shares and advances apart. */
export function personDirectGross(
  position: PersonPosition,
  entries: readonly BreakdownLedgerEntry[],
  loanIds: ReadonlySet<string>,
  advanceApplications: readonly BreakdownAdvanceApplication[] = [],
): PersonDirectGross {
  // Loans are their own positions. EMI shares stay in, so their settlements land on them and not on the
  // direct side (F1/F2) — then they are reported apart, as is the unapplied advance.
  const b = personBalanceBreakdown({ ...position, loanPayable: 0, loanReceivable: 0 }, entries, loanIds, advanceApplications);
  return {
    receivable: round2(b.toReceive - b.emiReceivableOpen),
    payable: b.toGive,
    emiReceivableOpen: b.emiReceivableOpen,
    advanceHeld: b.advance < 0 ? -b.advance : 0,
    advancePaid: b.advance > 0 ? b.advance : 0,
  };
}

/**
 * The People part of Net Worth. A due Person-linked installment share is a real receivable (People shows
 * it) and its reimbursement is an asset swap (cash in, receivable out) — so the People balance is
 * `Σ (directBalance + emiReceivable)`. `Σ directBalance` alone booked every reimbursed share as a phantom
 * payable offset by the cash (F1): right total, wrong components. Components are gross:
 * `receivable − payable − advanceHeld + advancePaid === balance`. An unapplied advance is in the balance
 * (the cash came in and it is not income) but is neither a payable nor a receivable.
 */
export function peopleNetWorthPosition(
  people: readonly PersonGrossInput[],
  loanIds: ReadonlySet<string>,
): { balance: number; receivable: number; payable: number; advanceHeld: number; advancePaid: number } {
  const gross = peopleDirectGross(people, loanIds);
  const balance = round2(people.reduce((s, p) => s + p.position.directBalance + p.position.emiReceivable, 0));
  return {
    balance,
    receivable: round2(gross.receivable + gross.emiReceivableOpen),
    payable: gross.payable,
    advanceHeld: gross.advanceHeld,
    advancePaid: gross.advancePaid,
  };
}

/**
 * Month Cycle's "You need to give" / "You need to receive" sides, from each person's GROSS breakdown —
 * never from the net alone. A person who both owes me and is owed by me appears on BOTH sides (with
 * their net beside it), so money I borrowed is never hidden because the same person also owes me
 * something (an EMI share, a Loan, a split). Unapplied advances are their own totals (held money — never
 * "to give", never subtracted from "to receive"): Σ toReceive − Σ toGive − advanceHeld + advancePaid = Σ net.
 */
export function peopleDirectionSides<T extends { breakdown: Pick<PersonBalanceBreakdown, "toGive" | "toReceive" | "net"> & { advance?: number } }>(
  rows: readonly T[],
): {
  toGive: { row: T; amount: number }[];
  toReceive: { row: T; amount: number }[];
  totalToGive: number;
  totalToReceive: number;
  /** Σ unapplied advances people paid me — money I hold for them. */
  advanceHeld: number;
  /** Σ unapplied advances I paid people ahead. */
  advancePaid: number;
} {
  const toGive = rows.filter((r) => r.breakdown.toGive > 0).map((row) => ({ row, amount: row.breakdown.toGive })).sort((a, b) => b.amount - a.amount);
  const toReceive = rows.filter((r) => r.breakdown.toReceive > 0).map((row) => ({ row, amount: row.breakdown.toReceive })).sort((a, b) => b.amount - a.amount);
  return {
    toGive,
    toReceive,
    totalToGive: round2(toGive.reduce((s, x) => s + x.amount, 0)),
    totalToReceive: round2(toReceive.reduce((s, x) => s + x.amount, 0)),
    advanceHeld: round2(rows.reduce((s, r) => s + Math.max(-(r.breakdown.advance ?? 0), 0), 0)),
    advancePaid: round2(rows.reduce((s, r) => s + Math.max(r.breakdown.advance ?? 0, 0), 0)),
  };
}
