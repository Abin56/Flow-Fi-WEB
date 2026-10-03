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
  deletedAt: Date | null;
}): BreakdownLedgerEntry {
  return {
    id: e.id,
    type: e.type,
    amount: e.amount,
    parentEntryId: e.parentEntryId,
    transactionRef: e.transactionRef,
    obligationRef: e.obligationRef ?? null,
    isDeleted: e.deletedAt != null,
  };
}

/**
 * Why a person's balance is what it is — the two gross directions behind `PersonPosition.net`. Pure
 * explanation, never a second balance: `toReceive − toGive === position.net` always.
 *
 *  - Each active "borrowed" entry is its own obligation (two borrowings add up — they never offset each
 *    other); each "gave" entry likewise. Their open amount is the entry minus the "repaid"/"receivedBack"
 *    entries linked to it by `parentEntryId`.
 *  - Whatever the direct balance holds beyond those open amounts (a payment not linked to one entry, a
 *    split share settled by its expense, an adjustment, an opening balance) is `unlinked`: it first reduces
 *    the side it pays down, and only what is left over lands on the other side.
 *  - Loans are added from the position as-is (Loan principal).
 *  - The opted-in EMI receivable (installment shares due so far) is reduced by the settlements Record
 *    Payment allocated to those shares (`obligationRef` `emi-inst:`/`loan-inst:`) — ID-based, never by
 *    amount. Those settlements are NOT direct-ledger payments: counting them as an unlinked remainder
 *    turned a settled share into a phantom "to give" beside a stale "to receive" (audit finding F1).
 *    An unlinked negative remainder (e.g. an advance later applied to a share) pays down direct
 *    receivables first, then the open EMI receivable, and only then crosses over to "to give".
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
  /** The EMI receivable still open after share settlements and absorbed unlinked payments. */
  emiReceivableOpen: number;
  /** Gross: everything I need to give them. */
  toGive: number;
  /** Gross: everything I need to receive from them. */
  toReceive: number;
  /** toReceive − toGive (= `PersonPosition.net`). Positive: they owe me. */
  net: number;
}

export function personBalanceBreakdown(
  position: PersonPosition,
  entries: readonly BreakdownLedgerEntry[],
  loanIds: ReadonlySet<string>,
): PersonBalanceBreakdown {
  const active = entries.filter((e) => !e.isDeleted && !isLegacyLoanLedgerEntry(e, loanIds));
  const settledByParent = new Map<string, number>();
  for (const e of active) {
    if ((e.type === "repaid" || e.type === "receivedBack") && e.parentEntryId != null) {
      settledByParent.set(e.parentEntryId, (settledByParent.get(e.parentEntryId) ?? 0) + e.amount);
    }
  }
  let borrowedOpen = 0;
  let gaveOpen = 0;
  let shareSettled = 0;
  for (const e of active) {
    if (isInstallmentShareSettlement(e)) shareSettled += e.type === "receivedBack" ? e.amount : -e.amount;
    if (e.type !== "borrowed" && e.type !== "gave") continue;
    const open = Math.max(0, e.amount - (settledByParent.get(e.id) ?? 0));
    if (e.type === "borrowed") borrowedOpen += open;
    else gaveOpen += open;
  }
  borrowedOpen = round2(borrowedOpen);
  gaveOpen = round2(gaveOpen);
  shareSettled = round2(shareSettled);
  // Share settlements pay the EMI receivable, never the direct side; an over-settlement (nothing due
  // yet) stays an ordinary unlinked remainder, i.e. money held for them.
  const emiNet = round2(position.emiReceivable - shareSettled);
  let emiOpen = Math.max(emiNet, 0);
  const unlinked = round2(position.directBalance + shareSettled - (gaveOpen - borrowedOpen) + Math.min(emiNet, 0));

  // An unlinked remainder pays down its own side first; only the excess crosses over.
  let directGive = borrowedOpen;
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
    toGive,
    toReceive,
    net: round2(toReceive - toGive),
  };
}

/**
 * Σ what I owe people directly (per person, after that person's own netting) — the People part of Net
 * Worth's `peopleDirectBalance` that is a liability. Person Loans are excluded (already in `loans`).
 */
export function peopleDirectPayable(positions: readonly Pick<PersonPosition, "directBalance">[]): number {
  return round2(positions.reduce((s, p) => s + (p.directBalance < 0 ? -p.directBalance : 0), 0));
}

/**
 * Σ People obligations by direction, GROSS — a person who owes me ₹1,000 while I owe them ₹500
 * is ₹1,000 receivable (asset) AND ₹500 payable (liability), never one netted ₹500. Person Loans are
 * excluded (already in `loans`). `receivable` is the direct ledger only; `emiReceivableOpen` is the open
 * Person-linked installment shares, kept apart so callers that add an EMI figure themselves never count
 * it twice. `receivable + emiReceivableOpen − payable === Σ (directBalance + emiReceivable)`.
 */
export function peopleDirectGross(
  positions: readonly { position: PersonPosition; entries: readonly BreakdownLedgerEntry[] }[],
  loanIds: ReadonlySet<string>,
): { receivable: number; payable: number; emiReceivableOpen: number } {
  let receivable = 0;
  let payable = 0;
  let emiReceivableOpen = 0;
  for (const { position, entries } of positions) {
    const direct = personDirectGross(position, entries, loanIds);
    receivable += direct.receivable;
    payable += direct.payable;
    emiReceivableOpen += direct.emiReceivableOpen;
  }
  return { receivable: round2(receivable), payable: round2(payable), emiReceivableOpen: round2(emiReceivableOpen) };
}

/** One person's direct (People ledger) obligations by direction, gross — Loans excluded, EMI shares apart. */
export function personDirectGross(
  position: PersonPosition,
  entries: readonly BreakdownLedgerEntry[],
  loanIds: ReadonlySet<string>,
): { receivable: number; payable: number; emiReceivableOpen: number } {
  // Loans are their own positions. EMI shares stay in, so their settlements land on them and not on the
  // direct side (F1/F2) — then they are reported apart.
  const b = personBalanceBreakdown({ ...position, loanPayable: 0, loanReceivable: 0 }, entries, loanIds);
  return { receivable: round2(b.toReceive - b.emiReceivableOpen), payable: b.toGive, emiReceivableOpen: b.emiReceivableOpen };
}

/**
 * The People part of Net Worth. A due Person-linked installment share is a real receivable (People shows
 * it) and its reimbursement is an asset swap (cash in, receivable out) — so the People balance is
 * `Σ (directBalance + emiReceivable)`. `Σ directBalance` alone booked every reimbursed share as a phantom
 * payable offset by the cash (F1): right total, wrong components. Components are gross.
 */
export function peopleNetWorthPosition(
  positions: readonly { position: PersonPosition; entries: readonly BreakdownLedgerEntry[] }[],
  loanIds: ReadonlySet<string>,
): { balance: number; receivable: number; payable: number } {
  const gross = peopleDirectGross(positions, loanIds);
  const balance = round2(positions.reduce((s, p) => s + p.position.directBalance + p.position.emiReceivable, 0));
  return { balance, receivable: round2(gross.receivable + gross.emiReceivableOpen), payable: gross.payable };
}

/**
 * Month Cycle's "You need to give" / "You need to receive" sides, from each person's GROSS breakdown —
 * never from the net alone. A person who both owes me and is owed by me appears on BOTH sides (with
 * their net beside it), so money I borrowed is never hidden because the same person also owes me
 * something (an EMI share, a Loan, a split). Σ toReceive − Σ toGive still equals Σ net.
 */
export function peopleDirectionSides<T extends { breakdown: Pick<PersonBalanceBreakdown, "toGive" | "toReceive" | "net"> }>(
  rows: readonly T[],
): {
  toGive: { row: T; amount: number }[];
  toReceive: { row: T; amount: number }[];
  totalToGive: number;
  totalToReceive: number;
} {
  const toGive = rows.filter((r) => r.breakdown.toGive > 0).map((row) => ({ row, amount: row.breakdown.toGive })).sort((a, b) => b.amount - a.amount);
  const toReceive = rows.filter((r) => r.breakdown.toReceive > 0).map((row) => ({ row, amount: row.breakdown.toReceive })).sort((a, b) => b.amount - a.amount);
  return {
    toGive,
    toReceive,
    totalToGive: round2(toGive.reduce((s, x) => s + x.amount, 0)),
    totalToReceive: round2(toReceive.reduce((s, x) => s + x.amount, 0)),
  };
}
