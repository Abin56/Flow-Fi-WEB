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
import { cardBillsForCard, cardStatementPaymentScope, payBillChargeScope } from "@/lib/engines/card-cycle-bills";
import { linkedPeopleForCard, peopleSettlementGate, PeopleSettlementPendingError } from "@/lib/engines/linked-people-readiness";
import { buildPersonCycleStatement, type PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import type { Account } from "@/lib/models/account";
import type { CreditCardProfile, Statement } from "@/lib/models/credit-card";
import type { AdvanceApplication, LedgerEntry, Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";

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
   */
  lockCard(tx: FirestoreTransaction, cardId: string, statementIds: readonly string[]): Promise<void>;
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
  now?: Date;
}): Promise<void> {
  const { tx, reader, cardAccount, amount } = params;
  const now = params.now ?? new Date();
  if (cardAccount.type !== "card") return;
  const card = await reader.cardForAccount(cardAccount.id);
  if (card == null) return;

  const [allStatements, rawTransactions, people] = await Promise.all([reader.statements(card.id), reader.cardTransactions(cardAccount.id), reader.people()]);
  const statements = allStatements.filter((s) => s.deletedAt == null);
  const transactions = rawTransactions.filter((t) => t.deletedAt == null && t.accountId === cardAccount.id);
  await reader.lockCard(tx, card.id, statements.map((s) => s.id));
  const chargeIds = new Set(transactions.map((t) => t.id));

  // Only people with a share of one of this card's charges can gate it.
  const linked: { person: Person; entries: LedgerEntry[] }[] = [];
  for (const person of people) {
    if (person.deletedAt != null) continue;
    const entries = await reader.ledger(person.id);
    if (entries.some((e) => e.deletedAt == null && e.type === "gave" && e.transactionRef != null && chargeIds.has(e.transactionRef))) {
      linked.push({ person, entries });
    }
  }
  if (linked.length === 0) return;

  const personStatements: PersonCycleStatement[] = [];
  for (const { person, entries } of linked) {
    await reader.lockPerson(tx, person.id);
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

  const scope = cardStatementPaymentScope(cardBillsForCard(card, transactions, statements, now), now);
  const gate = peopleSettlementGate(
    linkedPeopleForCard({
      statements: personStatements,
      ledgerEntries: linked.flatMap((l) => l.entries),
      transactions,
      cardAccountId: cardAccount.id,
      cardOpeningBalance: cardAccount.openingBalance,
      lenderDue: amount,
      paymentAmount: amount,
      chargeScope: payBillChargeScope(scope, amount),
    }),
  );
  if (gate.blocked) throw new PeopleSettlementPendingError(gate, "card-bill");
}
