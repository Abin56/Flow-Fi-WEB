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
import { type LedgerEntry, type LedgerEntryType, type Person, signedAmount } from "@/lib/models/person";
import { generateId } from "@/lib/utils/id-generator";

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
      increasesBalance?: boolean;
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
      increasesBalance: params.increasesBalance ?? true,
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

  /** `getByTransactionRef`, but over trashed entries — mirrors `getTrash` vs `getAll`. */
  async getTrashByTransactionRef(transactionId: string): Promise<LedgerEntry[]> {
    const snapshot = await getDocs(
      query(this.collection, where("deletedAt", "!=", null), where("transactionRef", "==", transactionId)),
    );
    return snapshot.docs.map((d) => d.data());
  }
}
