/**
 * Card bill People settlement gate at the WRITE layer — the authoritative enforcement of the rule the Pay
 * bill dialog shows: a card bill payment must not complete while a person's linked share of a charge THIS
 * payment reaches still has money to come in.
 *
 * Runs inside every card-payment write's Firestore transaction (`TransactionRepository`'s card payment
 * guard: `createTransferPairAtomic`, `createTransferPair` into a card, `restoreTransferPair` / `restoreTransaction`),
 * after the account reads and before any write, and decides from freshly read documents only — never
 * from what the dialog captured:
 *
 *  - the card's profile, statements and account transactions are re-read, and the card account itself is
 *    read in the transaction (every card purchase / payment rewrites its balance, so one committing while
 *    this payment is in flight conflicts and Firestore re-runs this check);
 *  - each person with a ledger entry on one of the card's charges is read in the transaction (a People
 *    payment / revert committing meanwhile conflicts the same way), with their ledger and advance
 *    applications read fresh.
 *
 * No second People calculation: the SAME chain the dialog uses — `cardBillsForCard` →
 * `cardStatementPaymentScope` → `payBillChargeScope` (the current statement's charges, by transaction id,
 * while the amount stays within that bill) → `linkedPeopleForCard` (oldest-first reach of THIS amount) →
 * `peopleSettlementGate`. A `ledger:` row's `remainingNow` depends only on settlements targeting that key
 * (ledger entries + advance applications), so EMI / Loan inputs are not needed for it — the same
 * approach as the Loan / EMI write gate (`people-settlement-gate.ts`).
 */

import type { Transaction as FirestoreTransaction } from "firebase/firestore";
import { cardBillsForCard, cardStatementPaymentScope, payBillChargeScope, type CardStatementPaymentScope } from "@/lib/engines/card-cycle-bills";
import { linkedPeopleForCard, peopleSettlementGate, PeopleSettlementPendingError, type LinkedPeopleReadiness, type PeopleSettlementGate } from "@/lib/engines/linked-people-readiness";
import { buildPersonCycleStatement, type PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import type { Account } from "@/lib/models/account";
import type { CreditCardProfile, Statement } from "@/lib/models/credit-card";
import type { AdvanceApplication, LedgerEntry, Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";
import { CardStatementChangedError, type CardStatementIntent } from "./transaction-repository";

const ALL_TIME = { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) };

/** Fresh reads the gate needs — Firestore in the app (`firestoreCardBillGateReader`), in-memory in tests. */
export interface CardBillGateReader {
  /** The live card profile whose account is `accountId`, or null (a card account with no profile isn't gated, as in the dialog). */
  cardForAccount(accountId: string): Promise<CreditCardProfile | null>;
  statements(cardId: string): Promise<Statement[]>;
  cardTransactions(accountId: string): Promise<Transaction[]>;
  people(): Promise<Person[]>;
  ledger(personId: string): Promise<LedgerEntry[]>;
  advanceApplications(personId: string): Promise<AdvanceApplication[]>;
  /** In-transaction read of the person document, so a People write committing meanwhile re-runs the gate. */
  lockPerson(tx: FirestoreTransaction, personId: string): Promise<void>;
  /**
   * In-transaction reads of the card profile and its stored statements: their statement day / due day and
   * statement periods decide which bill is current and which charges it holds, so an edit committing
   * meanwhile re-runs the gate.
   *
   * INVARIANT for future statement creation: a statement CREATED mid-payment is not one of these locked
   * documents, so it would not re-run the gate. No app flow creates statements today (bills are derived
   * from the card's statement day). Whatever adds one must also write the card profile document (e.g. a
   * statements version / lastEditedAt) in the same transaction, so this lock catches it.
   */
  lockCard(tx: FirestoreTransaction, cardId: string, statementIds: readonly string[]): Promise<void>;
}

/** A card's bill as freshly read: the canonical Pay Now scope and the People gate for any amount. */
export interface CardBillState {
  card: CreditCardProfile;
  scope: CardStatementPaymentScope;
  /** People readiness for a payment of `amount` against this scope (what Pay bill shows). */
  readinessFor(amount: number): LinkedPeopleReadiness;
  /** The SAME People check the payment write runs: `peopleSettlementGate(readinessFor(amount))`. */
  peopleGateFor(amount: number): PeopleSettlementGate;
}

/**
 * Reads a card's bill FRESH through `reader` and runs the canonical chain once — `cardBillsForCard` →
 * `cardStatementPaymentScope`, and per amount `payBillChargeScope` → `linkedPeopleForCard` →
 * `peopleSettlementGate`. Used by the payment write (with `tx`: the card, its statements and each linked
 * person are also read in the transaction so a concurrent change re-runs it) and by Pay bill's Refresh
 * (no `tx`: an authoritative read, no locks). Null when the account isn't a card with a profile.
 */
export async function loadCardBillState(params: { reader: CardBillGateReader; cardAccount: Account; tx?: FirestoreTransaction | null; now?: Date }): Promise<CardBillState | null> {
  const { reader, cardAccount, tx } = params;
  const now = params.now ?? new Date();
  if (cardAccount.type !== "card") return null;
  const card = await reader.cardForAccount(cardAccount.id);
  if (card == null) return null;

  const [allStatements, rawTransactions, people] = await Promise.all([reader.statements(card.id), reader.cardTransactions(cardAccount.id), reader.people()]);
  const statements = allStatements.filter((s) => s.deletedAt == null);
  const transactions = rawTransactions.filter((t) => t.deletedAt == null && t.accountId === cardAccount.id);
  if (tx) await reader.lockCard(tx, card.id, statements.map((s) => s.id));
  const chargeIds = new Set(transactions.map((t) => t.id));
  const scope = cardStatementPaymentScope(cardBillsForCard(card, transactions, statements, now), now);

  // Only people with a share of one of this card's charges can gate it.
  const linked: { person: Person; entries: LedgerEntry[] }[] = [];
  for (const person of people) {
    if (person.deletedAt != null) continue;
    const entries = await reader.ledger(person.id);
    if (entries.some((e) => e.deletedAt == null && e.type === "gave" && e.transactionRef != null && chargeIds.has(e.transactionRef))) {
      linked.push({ person, entries });
    }
  }
  const personStatements: PersonCycleStatement[] = [];
  for (const { person, entries } of linked) {
    if (tx) await reader.lockPerson(tx, person.id);
    personStatements.push(
      buildPersonCycleStatement({
        person: { id: person.id, name: person.name, openingBalance: person.openingBalance, createdAt: person.createdAt },
        ledgerEntries: entries,
        loanIds: new Set(),
        emis: [],
        loans: [],
        installments: [],
        advanceApplications: await reader.advanceApplications(person.id),
        cycle: ALL_TIME,
      }),
    );
  }

  const readinessFor = (amount: number): LinkedPeopleReadiness =>
    linkedPeopleForCard({
      statements: personStatements,
      ledgerEntries: linked.flatMap((l) => l.entries),
      transactions,
      cardAccountId: cardAccount.id,
      cardOpeningBalance: cardAccount.openingBalance,
      lenderDue: amount,
      paymentAmount: amount,
      chargeScope: payBillChargeScope(scope, amount),
    });
  return { card, scope, readinessFor, peopleGateFor: (amount) => peopleSettlementGate(readinessFor(amount)) };
}

/**
 * Throws `PeopleSettlementPendingError` (subject "card-bill") when People shares beneath the charges a
 * payment of `amount` reaches on `cardAccount` are still open. Never writes anything.
 */
export async function assertCardBillPeopleSettled(params: {
  tx: FirestoreTransaction;
  reader: CardBillGateReader;
  /** The card account as read in the payment's transaction. */
  cardAccount: Account;
  amount: number;
  /** Normal Pay Now's statement — re-checked against current state (see `TransferPairParams.cardStatementIntent`). */
  statementIntent?: CardStatementIntent | null;
  now?: Date;
}): Promise<void> {
  const { tx, reader, cardAccount, amount, statementIntent } = params;
  const state = await loadCardBillState({ reader, cardAccount, tx, now: params.now });
  if (state == null) return;
  const { scope } = state;

  // Normal Pay Now pays ONE statement. If that statement is no longer the one a payment settles first,
  // or now owes less than this amount (another tab / device paid it), refuse rather than let the
  // oldest-first allocator spill this payment into the next statement.
  if (statementIntent != null && (scope.current?.id !== statementIntent.statementId || amount > scope.current.remaining + 0.005)) {
    throw new CardStatementChangedError();
  }

  const gate = state.peopleGateFor(amount);
  if (gate.blocked) throw new PeopleSettlementPendingError(gate, "card-bill");
}
