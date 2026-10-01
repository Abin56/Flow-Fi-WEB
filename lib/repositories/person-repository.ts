/**
 * Direct port of `lib/features/people/data/{person_repository,
 * ledger_repository}.dart` (`PersonRepository`, `LedgerRepository`).
 * Person/ledger-entry-specific persistence on top of the generic
 * CRUD/soft-delete repository, plus duplicate-person prevention and the
 * balance-sync hook every ledger write goes through.
 */

import { type CollectionReference, doc, type DocumentReference, getDocs, query, runTransaction, where } from "firebase/firestore";
import { FirestoreCrudRepository } from "@/lib/firestore/firestore-crud-repository";
import { recordEdit, updateField } from "@/lib/firestore/soft-deletable";
import { type LedgerEntry, type LedgerEntryType, type LedgerSourceKind, type Person, signedAmount } from "@/lib/models/person";
import type { ReceivedStatus } from "@/lib/models/expense";
import { PERSON_FUNDED_ACCOUNT_ID, type Transaction, type TransactionType } from "@/lib/models/transaction";
import type { EditTransactionParams, TransactionRepository } from "@/lib/repositories/transaction-repository";
import { generateId } from "@/lib/utils/id-generator";
import { planOrphanReconciliation } from "@/lib/engines/transaction-owned-ledger";

/** Entries per `softDeleteEntries` transaction — 1 person + N entries, far below Firestore's 500-write cap. */
const SOFT_DELETE_CHUNK = 200;

/** The "borrowed" obligation (I owe them the full amount) backing a person-funded expense. */
function personFundedEntry(
  id: string,
  personId: string,
  expense: Pick<Transaction, "id" | "amount" | "dateTime" | "description">,
): LedgerEntry {
  return {
    id,
    personId,
    type: "borrowed",
    amount: expense.amount,
    date: expense.dateTime,
    note: expense.description,
    transactionRef: expense.id,
    parentEntryId: null,
    sourceKind: "personFundedExpense",
    obligationRef: null,
    increasesBalance: true,
    receivedStatus: "yetToReceive",
    createdAt: new Date(),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
  };
}

export interface CreatePersonParams {
  name: string;
  avatarColorValue: number;
  openingBalance: number;
  phone?: string | null;
  email?: string | null;
  notes?: string;
}

export interface EditPersonParams {
  name?: string;
  phone?: string | null;
  email?: string | null;
  notes?: string;
  avatarColorValue?: number;
}

export class PersonRepository extends FirestoreCrudRepository<Person> {
  constructor(collection: CollectionReference<Person>) {
    super(collection);
  }

  async createPerson(params: CreatePersonParams): Promise<Person> {
    const existing = await this.getAll();
    const normalizedName = params.name.trim().toLowerCase();
    const isDuplicate = existing.some((p) => {
      if (p.name.trim().toLowerCase() !== normalizedName) return false;
      if (params.phone != null && p.phone != null && p.phone === params.phone) return true;
      if (params.email != null && p.email != null && p.email === params.email) return true;
      return false;
    });
    if (isDuplicate) {
      throw new Error("A person with this name and phone/email already exists");
    }

    const person: Person = {
      id: generateId(),
      name: params.name,
      phone: params.phone ?? null,
      email: params.email ?? null,
      notes: params.notes ?? "",
      avatarColorValue: params.avatarColorValue,
      openingBalance: params.openingBalance,
      currentBalance: params.openingBalance,
      createdAt: new Date(),
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
    await this.add(person.id, person);
    return person;
  }

  /** Opening balance is deliberately not editable here — see `Person`. */
  async editPerson(person: Person, params: EditPersonParams): Promise<void> {
    let updated = person;
    updated = updateField(updated, "name", updated.name, params.name, (e, v) => ({ ...e, name: v }));
    updated = updateField(updated, "phone", updated.phone, params.phone, (e, v) => ({ ...e, phone: v }));
    updated = updateField(updated, "email", updated.email, params.email, (e, v) => ({ ...e, email: v }));
    updated = updateField(updated, "notes", updated.notes, params.notes, (e, v) => ({ ...e, notes: v }));
    updated = updateField(
      updated,
      "avatarColor",
      updated.avatarColorValue,
      params.avatarColorValue,
      (e, v) => ({ ...e, avatarColorValue: v }),
    );
    await this.update(updated);
  }

  /** Public doc reference — lets `LedgerRepository` read/write a person within its own
   *  atomic `runTransaction`, without exposing the protected `collection` field itself.
   *  Mirrors `AccountRepository.docRef` exactly. */
  docRef(id: string): DocumentReference<Person> {
    return doc(this.collection, id);
  }

  /**
   * Pure — computes the person with a balance delta applied and its audit-trail entry
   * recorded, no Firestore I/O. `LedgerRepository` calls this inside its own
   * `runTransaction` after reading the person fresh, rather than trusting a possibly-stale
   * in-memory value — mirrors `AccountRepository.applyBalanceDelta` exactly.
   */
  applyBalanceDelta(person: Person, delta: number): Person {
    const newBalance = person.currentBalance + delta;
    let updated = recordEdit(person, "currentBalance", String(person.currentBalance), String(newBalance));
    updated = { ...updated, currentBalance: newBalance };
    return updated;
  }

  /**
   * Permanently deletes `person` and every `LedgerEntry` ever recorded
   * against them (active and trashed) — Firestore doesn't cascade-delete
   * subcollections on its own, and the Trash screen's confirmation dialog
   * explicitly promises "their history will be permanently removed", so
   * this is the one place that promise must actually be kept. `ledgerRepo`
   * is passed in rather than held as a field, since it's a per-person
   * repository the caller already has from the provider layer —
   * `PersonRepository` itself stays free of any structural dependency on
   * `LedgerRepository`.
   */
  async deletePersonAndLedger(person: Person, ledgerRepo: LedgerRepository): Promise<void> {
    const entries = [...(await ledgerRepo.getAll()), ...(await ledgerRepo.getTrash())];
    for (const entry of entries) {
      await ledgerRepo.permanentlyDeleteEntry(entry);
    }
    await this.permanentlyDelete(person);
  }
}

/**
 * Ledger-entry persistence for one person's
 * `users/{uid}/people/{personId}/ledger` subcollection. Constructed
 * per-person, with a `personRepository` reference so every write can keep
 * `Person.currentBalance` in sync — the same dependency shape
 * `TransactionRepository` uses for `AccountRepository`.
 */
export class LedgerRepository extends FirestoreCrudRepository<LedgerEntry> {
  constructor(
    collection: CollectionReference<LedgerEntry>,
    private readonly personRepository: PersonRepository,
  ) {
    super(collection);
  }

  /**
   * Creates the entry and applies its signed effect to the person's cached
   * balance atomically (one Firestore transaction, both writes land
   * together or neither does) — mirrors
   * `TransactionRepository.createTransaction`'s account-sync sequence
   * exactly, including reading the person fresh inside the transaction
   * rather than trusting the caller's possibly-stale in-memory copy (the
   * same "stale balance base" class of bug fixed for account/transaction
   * balances). Entries are otherwise append-only: besides
   * `editEntryAmount`'s narrow amount-correction case, the only ways an
   * entry's balance effect changes are `softDeleteEntry`/`restoreEntry`.
   *
   * `amount` is always positive, matching `LedgerEntry.amount`'s invariant
   * — direction comes from `type`, never from the sign of `amount`. For
   * type "adjustment", pass `increasesBalance` to choose which direction
   * the correction moves the balance.
   */
  async addEntry(
    person: Person,
    params: {
      type: LedgerEntryType;
      amount: number;
      date: Date;
      note?: string;
      transactionRef?: string | null;
      /** The "gave"/"borrowed" entry this "repaid"/"receivedBack" settlement applies against — see `LedgerEntry.parentEntryId`. */
      parentEntryId?: string | null;
      sourceKind?: LedgerSourceKind;
      obligationRef?: string | null;
      increasesBalance?: boolean;
      /** Defaults to "yetToReceive" — a new entry is never treated as already settled. */
      receivedStatus?: ReceivedStatus;
    },
  ): Promise<LedgerEntry> {
    if (params.amount <= 0) {
      throw new Error("Amount must be greater than 0");
    }

    const entry: LedgerEntry = {
      id: generateId(),
      personId: person.id,
      type: params.type,
      amount: params.amount,
      date: params.date,
      note: params.note ?? "",
      transactionRef: params.transactionRef ?? null,
      parentEntryId: params.parentEntryId ?? null,
      sourceKind: params.sourceKind ?? "manual",
      obligationRef: params.obligationRef ?? null,
      increasesBalance: params.increasesBalance ?? true,
      receivedStatus: params.receivedStatus ?? "yetToReceive",
      createdAt: new Date(),
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };

    const db = this.collection.firestore;
    const entryRef = doc(this.collection, entry.id);
    const personRef = this.personRepository.docRef(person.id);
    const delta = signedAmount(entry);

    await runTransaction(db, async (tx) => {
      const personSnap = await tx.get(personRef);
      if (!personSnap.exists()) throw new Error("Person not found");
      if (delta !== 0) {
        tx.set(personRef, this.personRepository.applyBalanceDelta(personSnap.data(), delta));
      }
      tx.set(entryRef, entry);
    });

    return entry;
  }

  /**
   * `addEntry`, but also creates a real account-affecting `Transaction`
   * alongside the ledger entry, both in the same atomic Firestore
   * transaction — used for "Borrowed"/"Repaid"/"Received Back" entries
   * added from the People page's Add Transaction / Settle Up dialogs, so
   * the cash movement they represent shows up in the main Transactions
   * list, account balances, Month Cycle, and Dashboard the same way an
   * "I Gave" expense-assignment already does (see `applyOwesPersonChange`).
   *
   * `type`/`accountId`/`categoryId` describe the real cash leg: "borrowed"
   * and "receivedBack" are cash IN (an income transaction), "gave" and
   * "repaid" are cash OUT (an expense transaction) — the caller picks the
   * right `type` to match `params.type`'s `cashFlowDirection`. The new
   * transaction's id is stored as the entry's `transactionRef`.
   */
  async addEntryWithTransaction(
    person: Person,
    params: {
      type: LedgerEntryType;
      amount: number;
      date: Date;
      note?: string;
      parentEntryId?: string | null;
      sourceKind?: LedgerSourceKind;
      obligationRef?: string | null;
      increasesBalance?: boolean;
      receivedStatus?: ReceivedStatus;
    },
    transactionParams: {
      type: TransactionType;
      accountId: string;
      categoryId: string;
      description?: string;
    },
    transactionRepository: TransactionRepository,
  ): Promise<{ entry: LedgerEntry; transaction: Transaction }> {
    if (params.amount <= 0) {
      throw new Error("Amount must be greater than 0");
    }

    const entryId = generateId();
    const db = this.collection.firestore;
    const entryRef = doc(this.collection, entryId);
    const personRef = this.personRepository.docRef(person.id);

    let entry!: LedgerEntry;
    let transaction!: Transaction;

    await runTransaction(db, async (tx) => {
      const personSnap = await tx.get(personRef);
      if (!personSnap.exists()) throw new Error("Person not found");

      transaction = await transactionRepository.createTransactionInTransaction(tx, {
        type: transactionParams.type,
        amount: params.amount,
        dateTime: params.date,
        accountId: transactionParams.accountId,
        categoryId: transactionParams.categoryId,
        description: transactionParams.description ?? params.note,
        notes: params.note,
        linkedPersonId: person.id,
        owesPersonToggle: false,
        isPersonLedgerMovement: true,
      });

      entry = {
        id: entryId,
        personId: person.id,
        type: params.type,
        amount: params.amount,
        date: params.date,
        note: params.note ?? "",
        transactionRef: transaction.id,
        parentEntryId: params.parentEntryId ?? null,
        sourceKind: params.sourceKind ?? "manual",
        obligationRef: params.obligationRef ?? null,
        increasesBalance: params.increasesBalance ?? true,
        receivedStatus: params.receivedStatus ?? "yetToReceive",
        createdAt: new Date(),
        deletedAt: null,
        lastEditedAt: null,
        editHistory: [],
      };

      const personDelta = signedAmount(entry);
      if (personDelta !== 0) {
        tx.set(personRef, this.personRepository.applyBalanceDelta(personSnap.data(), personDelta));
      }
      tx.set(entryRef, entry);
    });

    return { entry, transaction };
  }

  /**
   * An expense this person paid DIRECTLY for me ("Money I Borrowed → Person paid directly"), atomically:
   *  - the expense Transaction — a real expense of mine (My Spend, categories, Month Cycle), with
   *    `fundedByPersonId` = this person and NO account (`PERSON_FUNDED_ACCOUNT_ID`), so no account is read
   *    or moved;
   *  - one "borrowed" entry (I owe them the full amount), `sourceKind: "personFundedExpense"`,
   *    `transactionRef` = the expense — the two-way link (expense → `fundedByPersonId`/`linkedPersonId`,
   *    entry → `transactionRef`).
   * Never an `isPersonLedgerMovement` cash leg: no cash moved through my accounts. Repaying them later is
   * an ordinary People settlement against this entry (its own cash leg, never My Spend).
   */
  async createPersonFundedExpense(
    person: Person,
    params: {
      amount: number;
      date: Date;
      categoryId: string;
      description?: string;
      notes?: string;
      excludeFromCalculations?: boolean;
      accountingMonth?: Date | null;
    },
    transactionRepository: TransactionRepository,
  ): Promise<{ entry: LedgerEntry; transaction: Transaction }> {
    if (params.amount <= 0) {
      throw new Error("Amount must be greater than 0");
    }

    const entryId = generateId();
    const db = this.collection.firestore;
    const entryRef = doc(this.collection, entryId);
    const personRef = this.personRepository.docRef(person.id);

    let entry!: LedgerEntry;
    let transaction!: Transaction;

    await runTransaction(db, async (tx) => {
      const personSnap = await tx.get(personRef);
      if (!personSnap.exists()) throw new Error("Person not found");

      transaction = await transactionRepository.createTransactionInTransaction(tx, {
        type: "expense",
        amount: params.amount,
        dateTime: params.date,
        accountId: PERSON_FUNDED_ACCOUNT_ID,
        categoryId: params.categoryId,
        description: params.description,
        notes: params.notes,
        excludeFromCalculations: params.excludeFromCalculations,
        accountingMonth: params.accountingMonth,
        linkedPersonId: person.id,
        owesPersonToggle: false,
        fundedByPersonId: person.id,
      });

      entry = personFundedEntry(entryId, person.id, transaction);
      tx.set(personRef, this.personRepository.applyBalanceDelta(personSnap.data(), signedAmount(entry)));
      tx.set(entryRef, entry);
    });

    return { entry, transaction };
  }

  /**
   * Changes who paid an expense — and/or edits a person-funded expense's amount/date — keeping the
   * expense and its People obligation in step, all in ONE atomic write. Every balance move goes through
   * `editTransactionInTransaction` (old account effect reversed once, new one applied once):
   *  - account → person P: the account's debit is reversed; a new "personFundedExpense" entry (I owe P).
   *  - person P → account: P's entry is soft-deleted (its balance effect reversed); the account is debited.
   *  - person P → person Q: P's entry removed, Q's created; no account moves.
   *  - person P → person P: the entry's amount/date/note edited in place (same entry, no duplicate).
   * `this` may be any LedgerRepository (it only provides the Firestore instance); each side's entries
   * are addressed through its own ledger. Refuses to move an obligation away from a person once
   * settlements were recorded against it — reverse those first (they'd otherwise be orphaned).
   */
  async changeExpenseFunding(params: {
    transaction: Transaction;
    /** The current person-funded obligation (null when the expense is account-funded). */
    from: { person: Person; ledger: LedgerRepository; entry: LedgerEntry; hasSettlements: boolean } | null;
    to: { kind: "account"; accountId: string } | { kind: "person"; person: Person; ledger: LedgerRepository };
    edits?: Omit<EditTransactionParams, "funding" | "accountId" | "linkedPersonId" | "clearLinkedPersonId" | "owesPersonToggle" | "type">;
    transactionRepository: TransactionRepository;
  }): Promise<void> {
    const { transaction, from, to, edits, transactionRepository } = params;
    const samePerson = from != null && to.kind === "person" && to.person.id === from.person.id;
    if (from != null && !samePerson && from.hasSettlements) {
      throw new Error(`Payments to ${from.person.name} are recorded against this expense — reverse them in People before changing who paid.`);
    }
    if (edits?.amount != null && edits.amount <= 0) throw new Error("Amount must be greater than 0");

    const db = this.collection.firestore;
    const fromEntryRef = from ? from.ledger.docRef(from.entry.id) : null;
    const fromPersonRef = from ? this.personRepository.docRef(from.person.id) : null;
    const toPersonRef = to.kind === "person" && !samePerson ? this.personRepository.docRef(to.person.id) : null;
    const newEntryId = generateId();

    await runTransaction(db, async (tx) => {
      // Every read before any write.
      const fresh = await transactionRepository.getInTransaction(tx, transaction.id);
      if (fresh == null || fresh.deletedAt != null) throw new Error("Transaction not found");
      if ((fresh.fundedByPersonId ?? null) !== (from?.person.id ?? null)) {
        throw new Error("This transaction changed since it was opened — reopen it and try again.");
      }
      const fromEntrySnap = fromEntryRef ? await tx.get(fromEntryRef) : null;
      const fromPersonSnap = fromPersonRef ? await tx.get(fromPersonRef) : null;
      const toPersonSnap = toPersonRef ? await tx.get(toPersonRef) : null;
      if (fromPersonSnap && !fromPersonSnap.exists()) throw new Error("Person not found");
      if (toPersonSnap && !toPersonSnap.exists()) throw new Error("Person not found");
      const fromEntry = fromEntrySnap?.exists() ? fromEntrySnap.data() : null;
      if (from && (fromEntry == null || fromEntry.deletedAt != null || fromEntry.transactionRef !== fresh.id)) {
        throw new Error("The People entry for this expense is missing — reopen it and try again.");
      }

      // Expense + account balances (its own reads happen here, before any write below).
      await transactionRepository.editTransactionInTransaction(tx, fresh, {
        ...edits,
        funding: to.kind === "person" ? { kind: "person", personId: to.person.id } : { kind: "account", accountId: to.accountId },
        linkedPersonId: to.kind === "person" ? to.person.id : undefined,
        owesPersonToggle: false,
      });
      const amount = edits?.amount ?? fresh.amount;
      const date = edits?.dateTime ?? fresh.dateTime;
      const note = edits?.description ?? fresh.description;

      if (samePerson) {
        let updated = updateField(fromEntry!, "amount", fromEntry!.amount, amount, (e, v) => ({ ...e, amount: v }));
        if (date.getTime() !== fromEntry!.date.getTime()) {
          updated = updateField(updated, "date", fromEntry!.date.toISOString(), date.toISOString(), (e) => ({ ...e, date }));
        }
        updated = updateField(updated, "note", fromEntry!.note, note, (e, v) => ({ ...e, note: v }));
        const delta = signedAmount(updated) - signedAmount(fromEntry!);
        if (delta !== 0) tx.set(fromPersonRef!, this.personRepository.applyBalanceDelta(fromPersonSnap!.data()!, delta));
        if (updated !== fromEntry) tx.set(fromEntryRef!, updated);
        return;
      }
      if (from) {
        tx.set(fromPersonRef!, this.personRepository.applyBalanceDelta(fromPersonSnap!.data()!, -signedAmount(fromEntry!)));
        tx.set(fromEntryRef!, { ...fromEntry!, deletedAt: new Date() });
      }
      if (to.kind === "person") {
        const entry = personFundedEntry(newEntryId, to.person.id, { id: fresh.id, amount, dateTime: date, description: note });
        tx.set(toPersonRef!, this.personRepository.applyBalanceDelta(toPersonSnap!.data()!, signedAmount(entry)));
        tx.set(to.ledger.docRef(newEntryId), entry);
      }
    });
  }

  /**
   * Restores a trashed person-funded expense together with its "personFundedExpense" entry, atomically
   * — the obligation comes back exactly once and no account moves (the expense has none).
   */
  async restorePersonFundedExpense(person: Person, entry: LedgerEntry, transactionRepository: TransactionRepository): Promise<void> {
    if (entry.transactionRef == null) throw new Error("This entry has no linked expense");
    const db = this.collection.firestore;
    const entryRef = doc(this.collection, entry.id);
    const personRef = this.personRepository.docRef(person.id);
    await runTransaction(db, async (tx) => {
      const personSnap = await tx.get(personRef);
      const entrySnap = await tx.get(entryRef);
      const fresh = await transactionRepository.getInTransaction(tx, entry.transactionRef!);
      if (!personSnap.exists()) throw new Error("Person not found");
      if (!entrySnap.exists()) throw new Error("Ledger entry not found");
      if (fresh == null || fresh.fundedByPersonId !== person.id) throw new Error("This entry's expense wasn't paid by this person");
      const freshEntry = entrySnap.data();
      if (fresh.deletedAt != null) await transactionRepository.restoreTransactionInTransaction(tx, fresh);
      if (freshEntry.deletedAt != null) {
        tx.set(personRef, this.personRepository.applyBalanceDelta(personSnap.data(), signedAmount(freshEntry)));
        tx.set(entryRef, { ...freshEntry, deletedAt: null });
      }
    });
  }

  /**
   * Corrects an already-posted entry's `amount` in place and re-syncs the
   * person's cached balance by the delta — the one exception to
   * "append-only" (see `LedgerEntry`'s doc comment), used so editing a
   * split/assigned expense's amount updates the same history line the
   * user tapped instead of leaving it stale next to a separate "Correct
   * Balance" entry. Both the entry's own prior state and the person's
   * balance are read fresh inside one atomic transaction — the delta is
   * never computed from a stale caller-supplied copy of either document.
   */
  async editEntryAmount(person: Person, entry: LedgerEntry, newAmount: number): Promise<void> {
    if (newAmount <= 0) {
      throw new Error("Amount must be greater than 0");
    }

    const db = this.collection.firestore;
    const entryRef = doc(this.collection, entry.id);
    const personRef = this.personRepository.docRef(person.id);

    await runTransaction(db, async (tx) => {
      // Both reads before either write — Firestore transactions don't allow a read after a write.
      const personSnap = await tx.get(personRef);
      const entrySnap = await tx.get(entryRef);
      if (!personSnap.exists()) throw new Error("Person not found");
      if (!entrySnap.exists()) throw new Error("Ledger entry not found");

      const freshEntry = entrySnap.data();
      const oldSignedAmount = signedAmount(freshEntry);
      const updated = updateField(freshEntry, "amount", freshEntry.amount, newAmount, (e, v) => ({ ...e, amount: v }));
      const delta = signedAmount(updated) - oldSignedAmount;
      if (delta !== 0) {
        tx.set(personRef, this.personRepository.applyBalanceDelta(personSnap.data(), delta));
      }
      tx.set(entryRef, updated);
    });
  }

  /**
   * Edits a posted entry's amount, date and/or note in place (each change recorded in `editHistory`),
   * re-syncing the person's cached balance by any amount delta — same atomic read-then-write as
   * `editEntryAmount`. Omitted fields are left as they are.
   */
  async editEntry(
    person: Person,
    entry: LedgerEntry,
    patch: { amount?: number; date?: Date; note?: string },
    /**
     * When given, the entry's OWN cash leg (the 1:1 `isPersonLedgerMovement` Transaction
     * `addEntryWithTransaction` posted for a "gave"/"borrowed" entry) is edited in the same atomic write —
     * so the account balance moves with the obligation and the two never drift apart. A payment cash leg
     * shared by several settlement entries is never touched here.
     */
    transactionRepository?: TransactionRepository,
    /** Extra cash-leg fields to save alongside (e.g. description/category from the Transactions page). */
    cashLegExtra?: Omit<EditTransactionParams, "amount" | "dateTime">,
  ): Promise<void> {
    if (patch.amount != null && patch.amount <= 0) {
      throw new Error("Amount must be greater than 0");
    }

    const db = this.collection.firestore;
    const entryRef = doc(this.collection, entry.id);
    const personRef = this.personRepository.docRef(person.id);

    await runTransaction(db, async (tx) => {
      const personSnap = await tx.get(personRef);
      const entrySnap = await tx.get(entryRef);
      if (!personSnap.exists()) throw new Error("Person not found");
      if (!entrySnap.exists()) throw new Error("Ledger entry not found");

      const fresh = entrySnap.data();
      const cashLeg =
        transactionRepository != null && fresh.transactionRef != null && (fresh.type === "borrowed" || fresh.type === "gave")
          ? await transactionRepository.getInTransaction(tx, fresh.transactionRef)
          : null;
      const ownCashLeg =
        cashLeg != null && cashLeg.deletedAt == null && cashLeg.isPersonLedgerMovement && cashLeg.linkedPersonId === person.id && cashLeg.amount === fresh.amount
          ? cashLeg
          : null;

      let updated = updateField(fresh, "amount", fresh.amount, patch.amount, (e, v) => ({ ...e, amount: v }));
      if (patch.date && patch.date.getTime() !== fresh.date.getTime()) {
        updated = updateField(updated, "date", fresh.date.toISOString(), patch.date.toISOString(), (e) => ({ ...e, date: patch.date! }));
      }
      updated = updateField(updated, "note", fresh.note, patch.note, (e, v) => ({ ...e, note: v }));
      if (updated === fresh && cashLegExtra == null) return;

      // The cash leg's reads happen inside `editTransactionInTransaction` before its writes, and before
      // the person/entry writes below — Firestore allows no read after a write.
      if (ownCashLeg != null) {
        await transactionRepository!.editTransactionInTransaction(tx, ownCashLeg, {
          ...cashLegExtra,
          amount: updated.amount !== ownCashLeg.amount ? updated.amount : undefined,
          dateTime: updated.date.getTime() !== fresh.date.getTime() ? updated.date : undefined,
        });
      }
      if (updated === fresh) return;

      const delta = signedAmount(updated) - signedAmount(fresh);
      if (delta !== 0) {
        tx.set(personRef, this.personRepository.applyBalanceDelta(personSnap.data(), delta));
      }
      tx.set(entryRef, updated);
    });
  }

  /**
   * Flips an entry's settlement status in place. Unlike `editEntryAmount`,
   * this never touches the person's cached balance — `receivedStatus` is
   * purely a settlement marker, independent of the signed amount already
   * applied when the entry was created.
   */
  async updateReceivedStatus(entry: LedgerEntry, receivedStatus: ReceivedStatus): Promise<void> {
    const updated = updateField(entry, "receivedStatus", entry.receivedStatus, receivedStatus, (e, v) => ({ ...e, receivedStatus: v }));
    await this.update(updated);
  }

  /**
   * Reverses the entry's balance effect, then soft-deletes it, atomically —
   * mirrors `TransactionRepository.softDeleteTransaction`.
   */
  async softDeleteEntry(person: Person, entry: LedgerEntry): Promise<void> {
    const db = this.collection.firestore;
    const entryRef = doc(this.collection, entry.id);
    const personRef = this.personRepository.docRef(person.id);

    await runTransaction(db, async (tx) => {
      const personSnap = await tx.get(personRef);
      const entrySnap = await tx.get(entryRef);
      if (!personSnap.exists()) throw new Error("Person not found");
      if (!entrySnap.exists()) throw new Error("Ledger entry not found");

      const freshEntry = entrySnap.data();
      const delta = -signedAmount(freshEntry);
      if (delta !== 0) {
        tx.set(personRef, this.personRepository.applyBalanceDelta(personSnap.data(), delta));
      }
      tx.set(entryRef, { ...freshEntry, deletedAt: new Date() });
    });
  }

  /**
   * `softDeleteEntry` for several entries at once — each entry's balance effect is reversed and the
   * entry soft-deleted, with the person's balance written once per chunk inside the same atomic
   * `runTransaction`. Every entry and the person are read fresh; an entry already in trash is skipped
   * (its effect was reversed when it was deleted), so a retry never reverses anything twice. Chunked
   * to stay well inside Firestore's per-transaction write limit; each chunk is self-consistent (its
   * balance change matches exactly the entries it deletes).
   */
  async softDeleteEntries(person: Person, entries: LedgerEntry[]): Promise<void> {
    const unique = Array.from(new Map(entries.map((e) => [e.id, e])).values());
    const db = this.collection.firestore;
    const personRef = this.personRepository.docRef(person.id);

    for (let i = 0; i < unique.length; i += SOFT_DELETE_CHUNK) {
      const chunk = unique.slice(i, i + SOFT_DELETE_CHUNK);
      await runTransaction(db, async (tx) => {
        // Every read before any write — Firestore transactions don't allow a read after a write.
        const personSnap = await tx.get(personRef);
        const refs = chunk.map((e) => doc(this.collection, e.id));
        const snaps = [];
        for (const ref of refs) snaps.push(await tx.get(ref));
        if (!personSnap.exists()) throw new Error("Person not found");

        const now = new Date();
        let delta = 0;
        const writes: [DocumentReference<LedgerEntry>, LedgerEntry][] = [];
        snaps.forEach((snap, idx) => {
          if (!snap.exists()) throw new Error("Ledger entry not found");
          const freshEntry = snap.data();
          if (freshEntry.deletedAt != null) return;
          delta -= signedAmount(freshEntry);
          writes.push([refs[idx], { ...freshEntry, deletedAt: now }]);
        });
        if (delta !== 0) {
          tx.set(personRef, this.personRepository.applyBalanceDelta(personSnap.data(), delta));
        }
        for (const [ref, value] of writes) tx.set(ref, value);
      });
    }
  }

  /**
   * THE delete for People-ledger entries (People page and Transactions page alike): `softDeleteEntries`,
   * plus each entry's own cash leg — the `isPersonLedgerMovement` Transaction `addEntryWithTransaction`
   * posted for it (the entry's `transactionRef`) — soft-deleted with its account balance reversed, all in
   * the same atomic `runTransaction` per chunk. A `transactionRef` that isn't this person's cash-leg
   * Transaction (a split/assigned expense, a legacy Loan) is never touched here — `planEntryDeletion`
   * refuses those entries up front, and this re-checks the fresh document regardless. A cash leg that
   * is already trashed is skipped, so an entry orphaned by an earlier transaction-only delete is still
   * cleaned up correctly (only its ledger effect is reversed).
   */
  async softDeleteEntriesWithCashLegs(person: Person, entries: LedgerEntry[], transactionRepository: TransactionRepository): Promise<void> {
    const unique = Array.from(new Map(entries.map((e) => [e.id, e])).values());
    const db = this.collection.firestore;
    const personRef = this.personRepository.docRef(person.id);

    for (let i = 0; i < unique.length; i += SOFT_DELETE_CHUNK) {
      const chunk = unique.slice(i, i + SOFT_DELETE_CHUNK);
      await runTransaction(db, async (tx) => {
        // Every read before any write — Firestore transactions don't allow a read after a write.
        const personSnap = await tx.get(personRef);
        const refs = chunk.map((e) => doc(this.collection, e.id));
        const snaps = [];
        for (const ref of refs) snaps.push(await tx.get(ref));
        if (!personSnap.exists()) throw new Error("Person not found");
        const fresh = snaps.map((snap) => {
          if (!snap.exists()) throw new Error("Ledger entry not found");
          return snap.data();
        });
        const active = fresh.filter((e) => e.deletedAt == null);
        const cashLegs = await transactionRepository.readSoftDeleteMany(
          tx,
          active.flatMap((e) => (e.transactionRef == null ? [] : [e.transactionRef])),
          // A person-funded expense is deleted together with its own obligation (it moves no account).
          (t) => (t.isPersonLedgerMovement && t.linkedPersonId === person.id) || t.fundedByPersonId === person.id,
        );

        const now = new Date();
        let delta = 0;
        for (const e of active) delta -= signedAmount(e);
        if (delta !== 0) {
          tx.set(personRef, this.personRepository.applyBalanceDelta(personSnap.data(), delta));
        }
        active.forEach((e) => tx.set(doc(this.collection, e.id), { ...e, deletedAt: now }));
        transactionRepository.writeSoftDeleteMany(tx, cashLegs);
      });
    }
  }

  /**
   * Repairs ghost entries — transaction-owned entries (`transactionOwnership`) whose transaction was
   * deleted by a path that left the People effect behind. Each candidate and its owning transaction are
   * re-read FRESH inside one atomic `runTransaction` and re-classified; only an entry that is still
   * provably owned by a deleted/missing transaction, with no live payment recorded against it, is
   * soft-deleted with its balance effect reversed (it stays in trash — audit history and
   * `restorePersonFundedExpense` keep working). Nothing else is ever written; returns the removed ids.
   */
  async reconcileOrphanedTransactionEntries(person: Person, candidateIds: readonly string[], transactionRepository: TransactionRepository): Promise<string[]> {
    if (candidateIds.length === 0) return [];
    const all = await this.getAll();
    const db = this.collection.firestore;
    const personRef = this.personRepository.docRef(person.id);
    const removed: string[] = [];

    await runTransaction(db, async (tx) => {
      removed.length = 0;
      const personSnap = await tx.get(personRef);
      if (!personSnap.exists()) throw new Error("Person not found");
      const fresh = new Map<string, LedgerEntry>();
      for (const id of new Set(candidateIds)) {
        const snap = await tx.get(doc(this.collection, id));
        if (snap.exists()) fresh.set(id, snap.data());
      }
      const owners = new Map<string, Transaction | null>();
      for (const e of fresh.values()) {
        if (e.transactionRef != null && !owners.has(e.transactionRef)) {
          owners.set(e.transactionRef, await transactionRepository.getInTransaction(tx, e.transactionRef));
        }
      }
      // Fresh candidates replace their listed copies; the rest of the ledger only answers "is a live payment recorded against it".
      const entries = [...all.filter((e) => !fresh.has(e.id)), ...fresh.values()];
      const plan = planOrphanReconciliation(entries, (ref) => (owners.has(ref) ? owners.get(ref) : undefined));
      const toRemove = plan.reconcile.filter((e) => fresh.has(e.id));

      let delta = 0;
      for (const e of toRemove) delta -= signedAmount(e);
      if (delta !== 0) tx.set(personRef, this.personRepository.applyBalanceDelta(personSnap.data(), delta));
      const now = new Date();
      for (const e of toRemove) {
        tx.set(doc(this.collection, e.id), { ...e, deletedAt: now });
        removed.push(e.id);
      }
    });
    return [...removed];
  }

  /**
   * Re-applies the entry's balance effect, then restores it, atomically —
   * mirrors `TransactionRepository.restoreTransaction`.
   */
  async restoreEntry(person: Person, entry: LedgerEntry): Promise<void> {
    const db = this.collection.firestore;
    const entryRef = doc(this.collection, entry.id);
    const personRef = this.personRepository.docRef(person.id);

    await runTransaction(db, async (tx) => {
      const personSnap = await tx.get(personRef);
      const entrySnap = await tx.get(entryRef);
      if (!personSnap.exists()) throw new Error("Person not found");
      if (!entrySnap.exists()) throw new Error("Ledger entry not found");

      const freshEntry = entrySnap.data();
      const delta = signedAmount(freshEntry);
      if (delta !== 0) {
        tx.set(personRef, this.personRepository.applyBalanceDelta(personSnap.data(), delta));
      }
      tx.set(entryRef, { ...freshEntry, deletedAt: null });
    });
  }

  /**
   * No balance change — already reversed at soft-delete time. Mirrors
   * `TransactionRepository.permanentlyDeleteTransaction`.
   */
  async permanentlyDeleteEntry(entry: LedgerEntry): Promise<void> {
    await this.permanentlyDelete(entry);
  }

  /**
   * Active entries whose `transactionRef` matches `transactionId` — a
   * targeted query for callers that only need "this expense's" ledger
   * entries, instead of fetching the whole subcollection via `getAll` and
   * filtering client-side.
   */
  async getByTransactionRef(transactionId: string): Promise<LedgerEntry[]> {
    const snapshot = await getDocs(
      query(this.collection, where("deletedAt", "==", null), where("transactionRef", "==", transactionId)),
    );
    return snapshot.docs.map((d) => d.data());
  }

  /** Every entry (active and trashed) written by one Record Payment — see `LedgerEntry.paymentId`. */
  async getByPaymentId(paymentId: string): Promise<LedgerEntry[]> {
    const snapshot = await getDocs(query(this.collection, where("paymentId", "==", paymentId)));
    return snapshot.docs.map((d) => d.data());
  }

  /** `getByTransactionRef`, but over trashed entries — mirrors `getTrash` vs `getAll`. */
  async getTrashByTransactionRef(transactionId: string): Promise<LedgerEntry[]> {
    const snapshot = await getDocs(
      query(this.collection, where("deletedAt", "!=", null), where("transactionRef", "==", transactionId)),
    );
    return snapshot.docs.map((d) => d.data());
  }
}
