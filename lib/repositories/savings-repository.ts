/**
 * Savings-goal persistence on top of the generic CRUD/soft-delete repository (originally a direct port of
 * `lib/features/savings/data/savings_repository.dart`, now extended with real-money entries).
 *
 * Money rules (see `lib/models/savings-contribution.ts` + `lib/engines/savings-goals.ts`):
 *  - An "earmark" entry writes ONLY the contribution document (+ the goal's completion/cache fields). No
 *    transaction, no account balance change.
 *  - A "transfer" entry first writes the real own-account transfer pair through
 *    `TransactionRepository.createTransferPairAtomic` (one Firestore transaction for both legs and both
 *    balances, idempotent on the entry id), THEN the contribution + goal in a second transaction. A retry with
 *    the same entry id after a lost response finds the stored pair and the stored entry and writes nothing twice.
 *  - `goal.currentAmount` is kept up to date incrementally only as a cache for the mobile app.
 */

import { type CollectionReference, doc, runTransaction } from "firebase/firestore";
import { FirestoreCrudRepository } from "@/lib/firestore/firestore-crud-repository";
import { recordEdit, updateField } from "@/lib/firestore/soft-deletable";
import type { SavingsContribution, SavingsEntryDirection, SavingsEntryMode } from "@/lib/models/savings-contribution";
import type { SavingsGoal } from "@/lib/models/savings-goal";
import type { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { generateId } from "@/lib/utils/id-generator";

export interface CreateGoalParams {
  name: string;
  targetAmount: number;
  dueDate?: Date | null;
  notes?: string;
  icon?: string | null;
  accent?: string | null;
}

export interface EditGoalParams {
  name?: string;
  targetAmount?: number;
  dueDate?: Date | null;
  clearDueDate?: boolean;
  notes?: string;
  icon?: string | null;
  accent?: string | null;
  /** What the goal holds right now (derived) — lets a target change re-evaluate completion. */
  savedNow?: number;
}

export interface RecordEntryParams {
  /** One user action's identity — keep it across retries. 8–128 letters/digits/-/_ (becomes the transfer key). */
  id: string;
  direction: SavingsEntryDirection;
  mode: SavingsEntryMode;
  amount: number;
  date: Date;
  /** The account holding the goal's money for this entry. Required for transfer; the reserved account for earmark. */
  accountId: string | null;
  /** Transfer: the other account (funding source for "in", destination for "out"). */
  counterAccountId?: string | null;
  note?: string;
  /** Transfer only — the transfer's category (the "Transfer" category). */
  categoryId?: string;
  /** What the goal holds after this entry — drives auto-complete / re-open. */
  savedAfter: number;
}

export interface SavingsRepositoryDeps {
  contributions: (goalId: string) => CollectionReference<SavingsContribution>;
  transactions: TransactionRepository;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Re-evaluates a goal's completion after its saved amount changed — auto-complete on reaching, re-open on slipping. */
function applyCompletion(goal: SavingsGoal, savedAfter: number, now: Date): SavingsGoal {
  const reached = savedAfter >= goal.targetAmount - 0.005;
  if (!goal.isCompleted && reached) {
    return { ...recordEdit(goal, "isCompleted", "false", "true"), isCompleted: true, closedEarly: false, completedAt: now };
  }
  if (goal.isCompleted && !goal.closedEarly && !reached) {
    return { ...recordEdit(goal, "isCompleted", "true", "false"), isCompleted: false, completedAt: null };
  }
  return goal;
}

export class SavingsRepository extends FirestoreCrudRepository<SavingsGoal> {
  constructor(
    collection: CollectionReference<SavingsGoal>,
    private readonly deps?: SavingsRepositoryDeps,
  ) {
    super(collection);
  }

  private requireDeps(): SavingsRepositoryDeps {
    if (!this.deps) throw new Error("Savings entries need the contributions collection and the transaction repository");
    return this.deps;
  }

  async createGoal(params: CreateGoalParams): Promise<SavingsGoal> {
    if (!(params.targetAmount > 0)) {
      throw new Error("Target amount must be greater than 0");
    }
    if (!params.name.trim()) throw new Error("Give the goal a name");
    const goal: SavingsGoal = {
      id: generateId(),
      name: params.name.trim(),
      targetAmount: params.targetAmount,
      currentAmount: 0,
      dueDate: params.dueDate ?? null,
      notes: params.notes ?? "",
      isCompleted: false,
      isArchived: false,
      createdAt: new Date(),
      openingAmount: 0,
      icon: params.icon ?? null,
      accent: params.accent ?? null,
      closedEarly: false,
      completedAt: null,
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
    await this.add(goal.id, goal);
    return goal;
  }

  /** Applied to the FRESH document so a cached field another write changed meanwhile is never overwritten. */
  async editGoal(goal: SavingsGoal, params: EditGoalParams): Promise<void> {
    if (params.targetAmount != null && !(params.targetAmount > 0)) {
      throw new Error("Target amount must be greater than 0");
    }
    if (params.name != null && !params.name.trim()) throw new Error("Give the goal a name");
    await this.updateFresh(goal.id, (fresh) => {
      let updated = fresh;
      updated = updateField(updated, "name", updated.name, params.name?.trim(), (e, v) => ({ ...e, name: v }));
      updated = updateField(updated, "targetAmount", updated.targetAmount, params.targetAmount, (e, v) => ({ ...e, targetAmount: v }));
      if (params.clearDueDate && updated.dueDate != null) {
        updated = recordEdit(updated, "dueDate", String(updated.dueDate), "none");
        updated = { ...updated, dueDate: null };
      } else {
        updated = updateField(updated, "dueDate", updated.dueDate, params.dueDate, (e, v) => ({ ...e, dueDate: v }));
      }
      updated = updateField(updated, "notes", updated.notes, params.notes, (e, v) => ({ ...e, notes: v }));
      if (params.icon !== undefined && params.icon !== updated.icon) updated = { ...updated, icon: params.icon };
      if (params.accent !== undefined && params.accent !== updated.accent) updated = { ...updated, accent: params.accent };
      // A new target can reach (or fall short of) what is already saved.
      if (params.targetAmount != null && params.savedNow != null) updated = applyCompletion(updated, params.savedNow, new Date());
      return updated;
    });
  }

  /**
   * Records one money entry. See the file header for the earmark / transfer split. Returns the stored entry —
   * the already-stored one when the same `id` was recorded before (an idempotent retry).
   */
  async recordEntry(goal: SavingsGoal, params: RecordEntryParams): Promise<SavingsContribution> {
    const { contributions, transactions } = this.requireDeps();
    if (!ID_PATTERN.test(params.id)) throw new Error("Invalid entry id");
    if (!(params.amount > 0) || round2(params.amount) !== params.amount) throw new Error("Enter an amount greater than 0 with at most 2 decimal places");
    if (goal.deletedAt != null) throw new Error("This goal was deleted");
    if (params.mode === "earmark" && params.accountId == null) throw new Error("Choose the account this money is in");

    let transactionIds: string[] = [];
    if (params.mode === "transfer") {
      if (!params.accountId || !params.counterAccountId) throw new Error("Choose both accounts");
      if (!params.categoryId) throw new Error('A transfer needs a category — create a "Transfer" category first');
      const sourceAccountId = params.direction === "in" ? params.counterAccountId : params.accountId;
      const destinationAccountId = params.direction === "in" ? params.accountId : params.counterAccountId;
      const [outLeg, inLeg] = await transactions.createTransferPairAtomic({
        amount: params.amount,
        dateTime: params.date,
        sourceAccountId,
        destinationAccountId,
        categoryId: params.categoryId,
        description: params.direction === "in" ? `Savings · ${goal.name}` : `Savings withdrawal · ${goal.name}`,
        notes: params.note ?? "",
        idempotencyKey: params.id,
        enforceFunds: true,
      });
      transactionIds = [outLeg.id, inLeg.id];
    }

    const entryRef = doc(contributions(goal.id), params.id);
    const goalRef = doc(this.collection, goal.id);
    const now = new Date();
    return runTransaction(this.collection.firestore, async (tx) => {
      const entrySnap = await tx.get(entryRef);
      const goalSnap = await tx.get(goalRef);
      if (entrySnap.exists()) return entrySnap.data();
      if (!goalSnap.exists() || goalSnap.data().deletedAt != null) throw new Error("This goal no longer exists");
      const fresh = goalSnap.data();
      const entry: SavingsContribution = {
        id: params.id,
        goalId: goal.id,
        direction: params.direction,
        mode: params.mode,
        amount: params.amount,
        date: params.date,
        accountId: params.accountId,
        counterAccountId: params.mode === "transfer" ? (params.counterAccountId ?? null) : null,
        transactionIds,
        note: params.note ?? "",
        createdAt: now,
        deletedAt: null,
        lastEditedAt: null,
        editHistory: [],
      };
      const signed = params.direction === "in" ? params.amount : -params.amount;
      const cache = Math.max(0, round2(fresh.currentAmount + signed));
      let updated = recordEdit(fresh, "currentAmount", String(fresh.currentAmount), String(cache));
      updated = { ...updated, currentAmount: cache };
      updated = applyCompletion(updated, params.savedAfter, now);
      tx.set(entryRef, entry);
      tx.set(goalRef, updated);
      return entry;
    });
  }

  /**
   * Removes an entry. A transfer's legs are deleted TOGETHER (the transfer is undone — both balances restored);
   * an earmark is just released. An entry whose transfer was already reversed in Transactions is only hidden.
   * `savedAfter` is what the goal holds once this entry no longer counts.
   */
  async removeEntry(goal: SavingsGoal, entry: SavingsContribution, opts: { wasActive: boolean; savedAfter: number }): Promise<void> {
    const { contributions, transactions } = this.requireDeps();
    if (entry.mode === "transfer" && opts.wasActive) {
      const leg = await transactions.getByKey(entry.transactionIds[0]);
      // Legs already deleted elsewhere → nothing to undo; the entry is just hidden below.
      if (leg && leg.deletedAt == null) await transactions.deleteTransferPair(leg);
    }
    const entryRef = doc(contributions(goal.id), entry.id);
    const goalRef = doc(this.collection, goal.id);
    const now = new Date();
    await runTransaction(this.collection.firestore, async (tx) => {
      const entrySnap = await tx.get(entryRef);
      const goalSnap = await tx.get(goalRef);
      if (!entrySnap.exists() || entrySnap.data().deletedAt != null) return; // already removed
      tx.set(entryRef, recordEdit({ ...entrySnap.data(), deletedAt: now }, "removed", "false", "true"));
      if (goalSnap.exists() && opts.wasActive) {
        const fresh = goalSnap.data();
        const signed = entry.direction === "in" ? -entry.amount : entry.amount;
        const cache = Math.max(0, round2(fresh.currentAmount + signed));
        let updated = recordEdit(fresh, "currentAmount", String(fresh.currentAmount), String(cache));
        updated = { ...updated, currentAmount: cache };
        tx.set(goalRef, applyCompletion(updated, opts.savedAfter, now));
      }
    });
  }

  /**
   * Edits an entry. A transfer entry is backed by locked transaction legs, so only its note changes; an earmark
   * can also change amount, account and date (cache + completion follow).
   */
  async editEntry(
    goal: SavingsGoal,
    entry: SavingsContribution,
    patch: { note?: string; amount?: number; accountId?: string | null; date?: Date },
    savedAfter: number,
  ): Promise<void> {
    const { contributions } = this.requireDeps();
    const entryRef = doc(contributions(goal.id), entry.id);
    const goalRef = doc(this.collection, goal.id);
    const now = new Date();
    await runTransaction(this.collection.firestore, async (tx) => {
      const entrySnap = await tx.get(entryRef);
      const goalSnap = await tx.get(goalRef);
      if (!entrySnap.exists() || entrySnap.data().deletedAt != null) throw new Error("This entry no longer exists");
      const fresh = entrySnap.data();
      let next = fresh;
      let delta = 0;
      if (patch.note != null && patch.note !== fresh.note) next = recordEdit({ ...next, note: patch.note }, "note", fresh.note, patch.note);
      if (fresh.mode === "earmark") {
        if (patch.amount != null && patch.amount !== fresh.amount) {
          if (!(patch.amount > 0) || round2(patch.amount) !== patch.amount) throw new Error("Enter an amount greater than 0 with at most 2 decimal places");
          delta = (fresh.direction === "in" ? 1 : -1) * (patch.amount - fresh.amount);
          next = recordEdit({ ...next, amount: patch.amount }, "amount", String(fresh.amount), String(patch.amount));
        }
        if (patch.accountId != null && patch.accountId !== fresh.accountId) {
          next = recordEdit({ ...next, accountId: patch.accountId }, "accountId", String(fresh.accountId), patch.accountId);
        }
        if (patch.date != null && patch.date.getTime() !== fresh.date.getTime()) {
          next = recordEdit({ ...next, date: patch.date }, "date", fresh.date.toISOString(), patch.date.toISOString());
        }
      }
      if (next === fresh) return;
      tx.set(entryRef, next);
      if (delta !== 0 && goalSnap.exists()) {
        const g = goalSnap.data();
        const cache = Math.max(0, round2(g.currentAmount + delta));
        let updated = recordEdit(g, "currentAmount", String(g.currentAmount), String(cache));
        updated = { ...updated, currentAmount: cache };
        tx.set(goalRef, applyCompletion(updated, savedAfter, now));
      }
    });
  }

  /** "Mark completed" — below the target it is an explicit early close (never flagged as slipped later). */
  async markCompleted(goal: SavingsGoal, opts?: { saved?: number }): Promise<void> {
    await this.updateFresh(goal.id, (fresh) => {
      if (fresh.isCompleted) return fresh;
      const closedEarly = opts?.saved != null ? opts.saved < fresh.targetAmount - 0.005 : false;
      return { ...recordEdit(fresh, "isCompleted", "false", "true"), isCompleted: true, closedEarly, completedAt: new Date() };
    });
  }

  async markIncomplete(goal: SavingsGoal): Promise<void> {
    await this.updateFresh(goal.id, (fresh) => {
      if (!fresh.isCompleted) return fresh;
      return { ...recordEdit(fresh, "isCompleted", "true", "false"), isCompleted: false, closedEarly: false, completedAt: null };
    });
  }

  /**
   * Hides a goal from the primary active list without soft-deleting it — archiving is a user-visible
   * organizational action, not a delete, so it's kept separate from the trash/soft-delete mechanism.
   */
  async archive(goal: SavingsGoal): Promise<void> {
    await this.updateFresh(goal.id, (fresh) => (fresh.isArchived ? fresh : { ...recordEdit(fresh, "isArchived", "false", "true"), isArchived: true }));
  }

  async unarchive(goal: SavingsGoal): Promise<void> {
    await this.updateFresh(goal.id, (fresh) => (!fresh.isArchived ? fresh : { ...recordEdit(fresh, "isArchived", "true", "false"), isArchived: false }));
  }
}
