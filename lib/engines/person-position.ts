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
  /** Outstanding principal they owe me through Loans I lent them. */
  loanReceivable: number;
  /** Outstanding principal I owe them through Loans I borrowed from them. */
  loanPayable: number;
  /** Signed sum of this person's active legacy Loan-generated ledger entries (removed from `directBalance`). */
  legacyLoanLedger: number;
  /** direct + receivable − payable. Positive: they owe me. */
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
}): PersonPosition {
  const { personId, currentBalance, loans, ledgerEntries, loanIds } = params;
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
  const net = round2(directBalance + loanReceivable - loanPayable);
  return {
    directBalance,
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
