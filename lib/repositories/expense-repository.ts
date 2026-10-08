/**
 * Direct port of `lib/features/expense/data/expense_repository.dart`
 * (`ExpenseRepository`). Bridges the feature-agnostic
 * `PaymentScheduleRepository`/`InstallmentRepository` (participant
 * settlement tracking via `OwnerType.splitExpense`), `TransactionRepository`
 * (account balance effect), and `LedgerRepository` (per-person pending
 * balance) — mirrors how `EmiRepository` composes the same schedule engine.
 * No new financial math is invented here beyond dividing
 * `Expense.totalAmount` into participant shares.
 */

import { FirestoreCrudRepository } from "@/lib/firestore/firestore-crud-repository";
import { recordEdit, updateField } from "@/lib/firestore/soft-deletable";
import {
  copyExpenseParticipant,
  type Expense,
  type ExpenseParticipant,
  isSplit,
  type ReceivedStatus,
  type SplitType,
} from "@/lib/models/expense";
import type { Installment } from "@/lib/models/payment-schedule";
import { remainingAmount as installmentRemainingAmount } from "@/lib/models/payment-schedule";
import { type LedgerEntry, type LedgerEntryType, type LedgerSourceKind, type Person, signedAmount } from "@/lib/models/person";
import { TxSession } from "@/lib/firestore/tx-session";
import { generateId } from "@/lib/utils/id-generator";
import { InstallmentPaymentRepository, InstallmentRepository, PaymentScheduleRepository } from "./payment-schedule-repository";
import { LedgerRepository, PersonRepository } from "./person-repository";
import { TransactionRepository } from "./transaction-repository";
import type { Transaction } from "@/lib/models/transaction";
import { type CollectionReference, runTransaction } from "firebase/firestore";

/**
 * A single participant's raw input before shares are resolved — the UI
 * layer supplies these; `ExpenseRepository` computes the actual `share`
 * each participant owes according to `SplitType`.
 */
export interface ExpenseParticipantInput {
  personId?: string | null;
  name: string;
  /** Meaningful only for "custom" (exact amount) and "percentage" (0-100). Ignored for "equal". */
  value?: number | null;
  /** Whether this input represents the permanent "Me" participant — see `ExpenseParticipant.isMe`. */
  isMe?: boolean;
  /** See `ReceivedStatus`. Defaults to "yetToReceive" for a non-"Me" participant, ignored (forced "notApplicable") for "Me". */
  receivedStatus?: ReceivedStatus;
}

/**
 * Every document a split write created, in order — so a failure part-way can be undone exactly
 * (`ExpenseRepository.rollbackSplitWrites`) instead of leaving shares, installments or people behind.
 */
export interface SplitWriteJournal {
  createdPeople: Person[];
  scheduleIds: string[];
  entries: { personId: string; entryId: string }[];
}

function newSplitWriteJournal(): SplitWriteJournal {
  return { createdPeople: [], scheduleIds: [], entries: [] };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function requireValue(input: ExpenseParticipantInput, what: string): number {
  const value = input.value;
  if (value == null || value < 0) {
    throw new Error(`${input.name} needs ${what} of 0 or more`);
  }
  return value;
}

/** "Me" is never a receivable — forced to "notApplicable" regardless of what the input requested. */
function receivedStatusFor(input: ExpenseParticipantInput): ReceivedStatus {
  if (input.isMe) return "notApplicable";
  return input.receivedStatus ?? "yetToReceive";
}

/**
 * Matches a participant across an edit — by `personId` when tracked as a
 * Person, otherwise by `name`. Mirrors `ExpenseRepository._participantKey`.
 */
export function participantKey(p: ExpenseParticipant): string {
  return p.personId ?? `name:${p.name}`;
}

/**
 * Note prefix for the one "receivedBack" entry that exists purely because
 * the participant is flagged `receivedStatus: "received"` — as opposed to
 * the "receivedBack" entries `settleParticipant`/`settleAcrossPending` post
 * for real, user-recorded (possibly partial) settlements, which carry
 * "Split settlement: "/a custom note instead.
 *
 * Both kinds share `type === "receivedBack"` and the same `transactionRef`,
 * so matching on type alone (as the reconciliation used to) picks up a
 * partial-settlement entry and then either skips posting the status entry
 * entirely, soft-deletes the user's real settlement record, or rewrites a
 * partial payment's amount up to the full share — all silent corruption of
 * the person's balance. This prefix is the discriminator.
 */
export const RECEIVED_STATUS_NOTE_PREFIX = "Received: ";

/**
 * The status-driven "receivedBack" entry among `entries`, if one was posted
 * — see `RECEIVED_STATUS_NOTE_PREFIX`. Never a settlement entry.
 */
function findReceivedStatusEntry(entries: LedgerEntry[]): LedgerEntry | undefined {
  return entries.find((e) => e.type === "receivedBack" && e.note.startsWith(RECEIVED_STATUS_NOTE_PREFIX));
}

export interface CreateExpenseParams {
  description: string;
  totalAmount: number;
  date: Date;
  categoryId: string;
  accountId: string;
  splitType: SplitType;
  participantInputs?: ExpenseParticipantInput[];
  notes?: string;
  dueDate?: Date | null;
  excludeFromCalculations?: boolean;
  accountingMonth?: Date | null;
  isBusiness?: boolean;
  /** Internal authoritative origin of the generated Person ledger entries. */
  sourceKind?: Extract<LedgerSourceKind, "splitExpense" | "assignedExpense">;
}

export interface AssignToPersonParams {
  description: string;
  totalAmount: number;
  date: Date;
  categoryId: string;
  accountId: string;
  personId: string;
  personName: string;
  notes?: string;
  dueDate?: Date | null;
  excludeFromCalculations?: boolean;
  accountingMonth?: Date | null;
  isBusiness?: boolean;
}

export interface ConvertToSplitParams {
  existingExpense?: Expense | null;
  transactionId: string;
  description: string;
  totalAmount: number;
  date: Date;
  categoryId: string;
  accountId: string;
  notes: string;
  splitType: SplitType;
  participantInputs: ExpenseParticipantInput[];
  dueDate?: Date | null;
  /** Internal authoritative origin of the generated Person ledger entries. */
  sourceKind?: Extract<LedgerSourceKind, "splitExpense" | "assignedExpense">;
}

export interface ConvertToAssignedParams {
  existingExpense?: Expense | null;
  transactionId: string;
  description: string;
  totalAmount: number;
  date: Date;
  categoryId: string;
  accountId: string;
  notes: string;
  personId: string;
  personName: string;
  partialAmount?: number | null;
  dueDate?: Date | null;
}

export interface ResplitExpenseParams {
  expense: Expense;
  splitType: SplitType;
  participantInputs: ExpenseParticipantInput[];
  dueDate?: Date | null;
}

export interface EditExpenseParams {
  expense: Expense;
  currentInstallments: Installment[];
  description?: string;
  totalAmount?: number;
  date?: Date;
  categoryId?: string;
  accountId?: string;
  notes?: string;
  splitType?: SplitType;
  participantInputs?: ExpenseParticipantInput[];
  dueDate?: Date | null;
}

export interface SettleParticipantParams {
  expense: Expense;
  participant: ExpenseParticipant;
  installment: Installment;
  installmentPaymentRepository: InstallmentPaymentRepository;
  amount: number;
  date: Date;
  note?: string;
  settlementMethod?: string | null;
}

export interface PendingSettlement {
  expense: Expense;
  participant: ExpenseParticipant;
  installment: Installment;
}

export interface SettleAcrossPendingParams {
  person: Person;
  pending: PendingSettlement[];
  amount: number;
  date: Date;
  installmentPaymentRepositoryFor: (scheduleId: string, installmentId: string) => InstallmentPaymentRepository;
  note?: string;
  settlementMethod?: string | null;
  /**
   * Signed total of this person's active legacy Loan-generated ledger entries
   * (`PersonPosition.legacyLoanLedger`). Settle Up settles the DIRECT balance only, so the
   * remainder's direction is decided from `currentBalance - legacyLoanLedger` — never from Loan
   * principal an old Web Loan once mirrored into the ledger. Defaults to 0.
   */
  legacyLoanLedger?: number;
  /**
   * What they owe me for opted-in Person-linked EMI installments (`PersonPosition.emiReceivable`) — not
   * in `currentBalance`, but part of what Settle Up settles, so it counts toward the remainder's
   * direction: a lump sum against an EMI obligation is money received, not money I repay. Defaults to 0.
   */
  emiReceivable?: number;
}

/**
 * "Received" means real money was received (People invariant, audit P1-01 follow-up). A split share can only
 * become received through People → Record payment, which posts the cash into a chosen account in the same
 * atomic write. Marking a share received WITHOUT that cash (an "Already paid" flag, the quick ✓ toggle) cleared
 * the receivable while no account moved — Net Worth silently dropped by the share — so it is refused here.
 * Undoing a legacy ledger-only "received" (back to "yet to receive") stays allowed.
 */
export class ReceivedWithoutCashError extends Error {
  constructor(name?: string) {
    super(
      `${name ? `${name}'s share` : "This share"} can't be marked as received here — no money would be recorded. Save it as "owes me", then use Record payment in People to record the money and the account it went into.`,
    );
    this.name = "ReceivedWithoutCashError";
  }
}

/** Throws `ReceivedWithoutCashError` for a participant that would BECOME "received" without a cash receipt. */
function assertNoCashlessReceipt(participants: readonly ExpenseParticipant[], previous: readonly ExpenseParticipant[] = []): void {
  const before = new Map(previous.map((p) => [participantKey(p), p.receivedStatus]));
  const offender = participants.find((p) => !p.isMe && p.receivedStatus === "received" && before.get(participantKey(p)) !== "received");
  if (offender) throw new ReceivedWithoutCashError(offender.name);
}

export class ExpenseRepository extends FirestoreCrudRepository<Expense> {
  constructor(
    collection: CollectionReference<Expense>,
    private readonly transactionRepository: TransactionRepository,
    private readonly paymentScheduleRepository: PaymentScheduleRepository,
    private readonly personRepository: PersonRepository,
    /** Resolves an InstallmentRepository scoped to a given schedule id. */
    private readonly installmentRepositoryFor: (scheduleId: string) => InstallmentRepository,
    /** Resolves a LedgerRepository scoped to a given person id. */
    private readonly ledgerRepositoryFor: (personId: string) => LedgerRepository,
  ) {
    super(collection);
  }

  /**
   * Resolves `inputs` into each participant's positive `share` of `total`
   * according to `type`, validating that the shares add up. Unlimited
   * participants are supported — no cap on `inputs.length`.
   */
  static resolveShares(params: {
    type: SplitType;
    total: number;
    inputs: ExpenseParticipantInput[];
  }): ExpenseParticipant[] {
    const { type, total, inputs } = params;
    if (inputs.length === 0) {
      throw new Error("A shared expense needs at least one person");
    }

    // Reject the same person appearing twice (by tracked id, or by name for
    // free-text participants) so shares can't be silently double-counted.
    const seenPersonIds = new Set<string>();
    const seenNames = new Set<string>();
    for (const input of inputs) {
      if (input.personId != null) {
        if (seenPersonIds.has(input.personId)) {
          throw new Error(`${input.name} is already in this split`);
        }
        seenPersonIds.add(input.personId);
      }
      const nameKey = input.name.trim().toLowerCase();
      if (nameKey !== "" && input.personId == null) {
        if (seenNames.has(nameKey)) {
          throw new Error(`${input.name} is already in this split`);
        }
        seenNames.add(nameKey);
      }
    }

    switch (type) {
      case "none":
        return [];

      case "equal": {
        // Every share must be at least ₹0.01 — a ₹0.00 share is rejected later by `addEntry` (WFI-P3-02).
        if (Math.round(total * 100) < inputs.length) throw new Error(`This amount is too small to split between ${inputs.length} people`);
        const share = round2(total / inputs.length);
        const shares = new Array(inputs.length).fill(share);
        const remainder = round2(total - share * inputs.length);
        shares[shares.length - 1] = round2(shares[shares.length - 1] + remainder);
        return inputs.map((input, i) => ({
          personId: input.personId ?? null,
          name: input.name,
          share: shares[i],
          installmentId: null,
          isMe: input.isMe ?? false,
          receivedStatus: receivedStatusFor(input),
        }));
      }

      case "custom": {
        const participants: ExpenseParticipant[] = inputs.map((input) => ({
          personId: input.personId ?? null,
          name: input.name,
          share: requireValue(input, "a custom amount"),
          installmentId: null,
          isMe: input.isMe ?? false,
          receivedStatus: receivedStatusFor(input),
        }));
        const sum = round2(participants.reduce((s, p) => s + p.share, 0));
        if (sum !== round2(total)) {
          throw new Error(
            `Custom amounts add up to ${sum}, but the expense total is ${round2(total)}. ` +
              `Amount left to assign: ${round2(total - sum)}`,
          );
        }
        return participants;
      }

      case "percentage": {
        const totalPercent = round2(inputs.reduce((s, i) => s + requireValue(i, "a percentage"), 0));
        if (totalPercent !== 100) {
          throw new Error(
            `Percentages add up to ${totalPercent}%, but must total 100%. ` +
              `Percentage left to assign: ${round2(100 - totalPercent)}%`,
          );
        }
        const shares = inputs.map((i) => round2(total * ((i.value as number) / 100)));
        const roundingRemainder = round2(total - shares.reduce((s, v) => s + v, 0));
        shares[shares.length - 1] = round2(shares[shares.length - 1] + roundingRemainder);
        return inputs.map((input, i) => ({
          personId: input.personId ?? null,
          name: input.name,
          share: shares[i],
          installmentId: null,
          isMe: input.isMe ?? false,
          receivedStatus: receivedStatusFor(input),
        }));
      }
    }
  }

  /**
   * Promotes every "custom name" participant (`personId == null`, `!isMe`)
   * to a real `Person` record so their share of the split appears in the
   * People Ledger — Task 1's "custom name saved as a ledger participant".
   * Reused, never re-created: matches an existing Person by exact
   * case-insensitive name first (same normalization `PersonRepository.createPerson`
   * already uses for its own dedup check), so re-submitting an edited split
   * with the same typed name links back to the same Person and ledger
   * instead of spawning a duplicate contact every save. Mirrors nothing in
   * the Flutter app (web-only convenience) — the Flutter split flow requires
   * picking an existing Person up front, so a `personId` is never null there
   * for a real ledger-bound participant.
   */
  private async promoteCustomNameParticipants(participants: ExpenseParticipant[], journal?: SplitWriteJournal): Promise<ExpenseParticipant[]> {
    const needsPromotion = participants.some((p) => !p.isMe && p.personId == null && p.name.trim() !== "");
    if (!needsPromotion) return participants;

    const existingPeople = await this.personRepository.getAll();
    const byNormalizedName = new Map(existingPeople.map((p) => [p.name.trim().toLowerCase(), p]));
    // Also de-dupes within this same split — two custom-name rows with the
    // same typed name resolve to the one Person created for the first.
    const createdThisCall = new Map<string, Person>();

    const resolved: ExpenseParticipant[] = [];
    for (const participant of participants) {
      if (participant.isMe || participant.personId != null || participant.name.trim() === "") {
        resolved.push(participant);
        continue;
      }
      const key = participant.name.trim().toLowerCase();
      let person = byNormalizedName.get(key) ?? createdThisCall.get(key);
      if (person == null) {
        person = await this.personRepository.createPerson({
          name: participant.name.trim(),
          avatarColorValue: 0xff9e9e9e,
          openingBalance: 0,
        });
        createdThisCall.set(key, person);
        journal?.createdPeople.push(person);
      }
      resolved.push({ ...participant, personId: person.id });
    }
    return resolved;
  }

  /**
   * Creates the PaymentSchedule + one Installment per non-"Me" participant
   * (nothing is ever "collected" from yourself, so Me never gets an
   * installment), posts a LedgerEntry for each person-linked participant
   * (after promoting any custom-name participant to a real Person — see
   * `promoteCustomNameParticipants`), and returns the full participants list
   * with `installmentId`s (and, for custom names, `personId`s) filled in for
   * everyone except Me. Shared by `createExpense` and `convertToSplit`.
   * Mirrors `ExpenseRepository._generateScheduleAndLedger`.
   */
  private async generateScheduleAndLedger(params: {
    expenseId: string;
    participants: ExpenseParticipant[];
    totalAmount: number;
    date: Date;
    description: string;
    transactionId: string;
    dueDate?: Date | null;
    sourceKind: Extract<LedgerSourceKind, "splitExpense" | "assignedExpense">;
    /** Records every write, so a caller can undo a partial split exactly (`rollbackSplitWrites`). */
    journal?: SplitWriteJournal;
  }): Promise<{ scheduleId: string; participants: ExpenseParticipant[] }> {
    const { expenseId, totalAmount, date, description, transactionId, dueDate, sourceKind } = params;
    const { journal } = params;
    const participants = await this.promoteCustomNameParticipants(params.participants, journal);
    const collectible = participants.filter((p) => !p.isMe);
    if (collectible.length === 0) {
      throw new Error("Add at least one other person to share with");
    }

    const schedule = await this.paymentScheduleRepository.createSchedule({
      ownerType: "splitExpense",
      ownerId: expenseId,
      totalAmount,
      scheduleType: "oneTime",
      // Defaults to a week out rather than the expense's own date, so an
      // unpaid expense doesn't read Overdue the very next day.
      firstDueDate: dueDate ?? addDays(date, 7),
      installmentCount: collectible.length,
    });
    journal?.scheduleIds.push(schedule.id);

    const installments = await this.installmentRepositoryFor(schedule.id).generateInstallments(schedule, {
      precomputedAmounts: collectible.map((p) => ({ amountDue: p.share })),
    });

    let collectibleIndex = 0;
    const resolvedParticipants = participants.map((participant) =>
      participant.isMe ? participant : copyExpenseParticipant(participant, { installmentId: installments[collectibleIndex++].id }),
    );

    for (const participant of resolvedParticipants) {
      if (participant.personId == null) continue;
      const person = await this.personRepository.getByKey(participant.personId);
      if (person == null) continue;
      const ledgerRepository = this.ledgerRepositoryFor(person.id);
      const shareEntry = await ledgerRepository.addEntry(person, {
        type: "gave",
        amount: participant.share,
        date,
        note: `Split: ${description}`,
        transactionRef: transactionId,
        sourceKind,
        receivedStatus: "yetToReceive",
      });
      journal?.entries.push({ personId: person.id, entryId: shareEntry.id });
      // "Received" is decided up front (e.g. the payer already collected cash
      // at the table) — post the settlement immediately rather than waiting
      // for a separate Settle Up action, so the ledger's received total is
      // correct from the moment the split is saved. "yetToReceive"/"excluded"
      // both leave the "gave" entry outstanding; they differ only in label/
      // intent, not in ledger effect, per Task 2.
      if (participant.receivedStatus === "received") {
        const refreshedPerson = (await this.personRepository.getByKey(person.id)) ?? person;
        const receivedEntry = await ledgerRepository.addEntry(refreshedPerson, {
          type: "receivedBack",
          amount: participant.share,
          date,
          note: `${RECEIVED_STATUS_NOTE_PREFIX}${description}`,
          transactionRef: transactionId,
          sourceKind,
          receivedStatus: "received",
        });
        journal?.entries.push({ personId: person.id, entryId: receivedEntry.id });
      }
    }

    return { scheduleId: schedule.id, participants: resolvedParticipants };
  }

  /**
   * Creates an expense, its account-balance-effecting Transaction, and —
   * when `splitType` isn't "none" — a PaymentSchedule + per-participant
   * Installments tracking settlement, plus a LedgerEntry per person-linked
   * participant. Mirrors `ExpenseRepository.createExpense`.
   */
  async createExpense(params: CreateExpenseParams): Promise<Expense> {
    if (params.description.trim() === "") {
      throw new Error("Expense description is required");
    }
    if (params.totalAmount <= 0) {
      throw new Error("Total amount must be greater than 0");
    }

    let participants = ExpenseRepository.resolveShares({
      type: params.splitType,
      total: params.totalAmount,
      inputs: params.participantInputs ?? [],
    });
    assertNoCashlessReceipt(participants);

    const transaction = await this.transactionRepository.createTransaction({
      type: "expense",
      amount: params.totalAmount,
      dateTime: params.date,
      accountId: params.accountId,
      categoryId: params.categoryId,
      // `description` (merchant name) and `isBusiness` used to be silently dropped here — every
      // other `createTransaction` call site in the app passes them, but this one didn't, so a Shared
      // Expense / Someone Else's Expense commit left the real `Transaction` with a blank merchant
      // name (only the separate `Expense` doc below got it) and lost the Business modifier entirely.
      // `/transactions`' own list/detail views read `Transaction.description`, not the linked
      // `Expense`'s, so the blank name showed up everywhere outside this expense's own card.
      description: params.description,
      isBusiness: params.isBusiness ?? false,
      notes: params.notes ?? "",
      excludeFromCalculations: params.excludeFromCalculations ?? false,
      accountingMonth: params.accountingMonth ?? null,
    });

    const expenseId = generateId();
    let scheduleId: string | null = null;
    const journal = newSplitWriteJournal();

    try {
      if (participants.length > 0) {
        const result = await this.generateScheduleAndLedger({
          expenseId,
          participants,
          totalAmount: params.totalAmount,
          date: params.date,
          description: params.description,
          transactionId: transaction.id,
          dueDate: params.dueDate,
          sourceKind: params.sourceKind ?? "splitExpense",
          journal,
        });
        scheduleId = result.scheduleId;
        participants = result.participants;
      }

      const expense: Expense = {
        id: expenseId,
        description: params.description,
        totalAmount: params.totalAmount,
        date: params.date,
        categoryId: params.categoryId,
        accountId: params.accountId,
        transactionId: transaction.id,
        splitType: params.splitType,
        participants,
        scheduleId,
        notes: params.notes ?? "",
        createdAt: new Date(),
        deletedAt: null,
        lastEditedAt: null,
        editHistory: [],
      };
      await this.add(expense.id, expense);
      return expense;
    } catch (error) {
      // The Transaction (and its account-balance effect) already committed above —
      // undo it rather than leave an orphaned Transaction with no Expense/schedule/
      // ledger behind it, which would otherwise double-count on a caller's retry
      // (retry sees no committed Expense, so it creates a second Transaction).
      // Every share, installment, schedule and auto-created person written so far is
      // undone too, so a failed split leaves zero partial financial state.
      await this.rollbackSplitWrites(journal, { expenseId, transaction }, error);
      throw error;
    }
  }

  /**
   * Undoes a partially written split, newest write first, through the same balance-safe primitives
   * every other delete uses: each People share via `softDeleteEntries` (balance reversed once, an
   * already-trashed entry skipped), the schedule's installments and the schedule, the Expense if it
   * landed, people auto-created for this split, and — for `createExpense` only — its new Transaction
   * (re-read fresh, so an already-trashed one is never reversed twice). Every step is attempted even
   * if an earlier one fails; if any fails the error says so, never a silent half-rollback. Idempotent.
   */
  private async rollbackSplitWrites(
    journal: SplitWriteJournal,
    owned: { expenseId: string | null; transaction?: Transaction },
    /** The failure being rolled back — its message is kept, so the real cause always surfaces. */
    original?: unknown,
  ): Promise<void> {
    const failures: unknown[] = [];
    const attempt = async (step: () => Promise<unknown>) => {
      try {
        await step();
      } catch (e) {
        failures.push(e);
      }
    };

    const byPerson = new Map<string, string[]>();
    for (const { personId, entryId } of journal.entries) byPerson.set(personId, [...(byPerson.get(personId) ?? []), entryId]);
    for (const [personId, entryIds] of byPerson) {
      await attempt(async () => {
        const person = await this.personRepository.getByKey(personId);
        if (person == null) return;
        const ledger = this.ledgerRepositoryFor(personId);
        const entries = (await Promise.all(entryIds.map((id) => ledger.getByKey(id)))).filter((e): e is LedgerEntry => e != null);
        await ledger.softDeleteEntries(person, entries.reverse());
      });
    }
    for (const scheduleId of journal.scheduleIds) {
      await attempt(async () => {
        const installmentRepository = this.installmentRepositoryFor(scheduleId);
        for (const installment of await installmentRepository.getAll()) await installmentRepository.softDelete(installment);
        const schedule = await this.paymentScheduleRepository.getByKey(scheduleId);
        if (schedule != null && schedule.deletedAt == null) await this.paymentScheduleRepository.softDelete(schedule);
      });
    }
    if (owned.expenseId != null) await attempt(async () => {
      const expense = await this.getByKey(owned.expenseId!);
      if (expense != null && expense.deletedAt == null) await this.softDelete(expense);
    });
    for (const person of journal.createdPeople) {
      await attempt(async () => {
        const fresh = await this.personRepository.getByKey(person.id);
        if (fresh != null && fresh.deletedAt == null) await this.personRepository.softDelete(fresh);
      });
    }
    if (owned.transaction) {
      const transaction = owned.transaction;
      // Read fresh inside the same atomic write: an already-trashed Transaction is never reversed twice.
      await attempt(() =>
        runTransaction(this.collection.firestore, async (tx) => {
          const fresh = await this.transactionRepository.getInTransaction(tx, transaction.id);
          if (fresh != null && fresh.deletedAt == null) await this.transactionRepository.softDeleteTransactionInTransaction(tx, fresh);
        }),
      );
    }
    if (failures.length > 0) {
      const reason = original instanceof Error ? original.message : "This split failed";
      throw new Error(`${reason} — and it couldn't be fully undone; please check this expense and the people in it.`, { cause: failures[0] });
    }
  }

  /**
   * Task 2's "assign expense to person" — the degenerate single-participant
   * case of `createExpense` (one participant owing 100% of the total).
   * Mirrors `ExpenseRepository.assignToPerson`.
   */
  assignToPerson(params: AssignToPersonParams): Promise<Expense> {
    return this.createExpense({
      description: params.description,
      totalAmount: params.totalAmount,
      date: params.date,
      categoryId: params.categoryId,
      accountId: params.accountId,
      splitType: "custom",
      participantInputs: [{ personId: params.personId, name: params.personName, value: params.totalAmount }],
      notes: params.notes,
      dueDate: params.dueDate,
      sourceKind: "assignedExpense",
      excludeFromCalculations: params.excludeFromCalculations,
      accountingMonth: params.accountingMonth,
      isBusiness: params.isBusiness,
    });
  }

  /**
   * Converts an existing plain expense into a split expense — Task 1's
   * "convert an old expense" flow. Reuses exactly the split-branch logic
   * `createExpense` runs for a brand-new expense against an
   * already-recorded `transactionId` — no second Transaction is ever
   * created. Mirrors `ExpenseRepository.convertToSplit`.
   */
  async convertToSplit(params: ConvertToSplitParams): Promise<Expense> {
    const { existingExpense } = params;
    if (existingExpense != null && isSplit(existingExpense)) {
      throw new Error("This expense has already been shared");
    }

    let participants = ExpenseRepository.resolveShares({
      type: params.splitType,
      total: params.totalAmount,
      inputs: params.participantInputs,
    });
    assertNoCashlessReceipt(participants, existingExpense?.participants ?? []);
    if (participants.length === 0) {
      throw new Error("Choose at least one person to share with");
    }

    const expenseId = existingExpense?.id ?? generateId();
    // The Transaction already existed and stays; only what this conversion writes is undone on failure
    // (never an Expense that existed before it).
    const journal = newSplitWriteJournal();
    const rollback = (error: unknown) => this.rollbackSplitWrites(journal, { expenseId: existingExpense == null ? expenseId : null }, error);

    let result: { scheduleId: string; participants: ExpenseParticipant[] };
    try {
      result = await this.generateScheduleAndLedger({
        expenseId,
        participants,
        totalAmount: params.totalAmount,
        date: params.date,
        description: params.description,
        transactionId: params.transactionId,
        dueDate: params.dueDate,
        sourceKind: params.sourceKind ?? "splitExpense",
        journal,
      });
    } catch (error) {
      await rollback(error);
      throw error;
    }
    const scheduleId = result.scheduleId;
    participants = result.participants;

    if (existingExpense != null) {
      let updated = recordEdit(existingExpense, "splitType", existingExpense.splitType, params.splitType);
      updated = { ...updated, splitType: params.splitType, participants, scheduleId };
      try {
        await this.update(updated);
      } catch (error) {
        await rollback(error);
        throw error;
      }
      return updated;
    }

    const expense: Expense = {
      id: expenseId,
      description: params.description,
      totalAmount: params.totalAmount,
      date: params.date,
      categoryId: params.categoryId,
      accountId: params.accountId,
      transactionId: params.transactionId,
      splitType: params.splitType,
      participants,
      scheduleId,
      notes: params.notes,
      createdAt: new Date(),
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
    try {
      await this.add(expense.id, expense);
    } catch (error) {
      await rollback(error);
      throw error;
    }
    return expense;
  }

  /**
   * Part 1's "assign an existing transaction to a person" — the degenerate
   * single-participant case of `convertToSplit`. `partialAmount`, when
   * supplied, is the person's share; the rest is implicitly the payer's own
   * ("Me") share. Mirrors `ExpenseRepository.convertToAssigned`.
   */
  convertToAssigned(params: ConvertToAssignedParams): Promise<Expense> {
    const personShare = params.partialAmount ?? params.totalAmount;
    const meShare = round2(params.totalAmount - personShare);
    return this.convertToSplit({
      existingExpense: params.existingExpense,
      transactionId: params.transactionId,
      description: params.description,
      totalAmount: params.totalAmount,
      date: params.date,
      categoryId: params.categoryId,
      accountId: params.accountId,
      notes: params.notes,
      splitType: "custom",
      participantInputs: [
        { name: "Me", isMe: true, value: meShare },
        { personId: params.personId, name: params.personName, value: personShare },
      ],
      dueDate: params.dueDate,
      sourceKind: "assignedExpense",
    });
  }

  /**
   * Re-splits an already split/assigned expense across a new participant
   * set. Discards the old schedule/installments/ledger entries and
   * regenerates them from scratch — only safe before any money has been
   * collected; throws if any current installment already has a payment.
   * Mirrors `ExpenseRepository.resplitExpense`.
   */
  async resplitExpense(params: ResplitExpenseParams): Promise<Expense> {
    const { expense } = params;
    const newParticipants = ExpenseRepository.resolveShares({
      type: params.splitType,
      total: expense.totalAmount,
      inputs: params.participantInputs,
    });
    assertNoCashlessReceipt(newParticipants, expense.participants);
    if (newParticipants.filter((p) => !p.isMe).length === 0) {
      throw new Error("Choose at least one person to share with");
    }

    const oldScheduleId = expense.scheduleId;
    if (oldScheduleId != null) {
      const installmentRepository = this.installmentRepositoryFor(oldScheduleId);
      const oldInstallments = await installmentRepository.getAll();
      if (oldInstallments.some((i) => i.amountPaid > 0)) {
        throw new Error("This expense already has payments recorded — remove them before re-splitting.");
      }
      for (const installment of oldInstallments) {
        await installmentRepository.softDelete(installment);
      }
      const schedule = await this.paymentScheduleRepository.getByKey(oldScheduleId);
      if (schedule != null) await this.paymentScheduleRepository.softDelete(schedule);
    }

    // Reverse + soft-delete every original per-person entry this transaction
    // posted — both the "gave" entry and, if the participant had already
    // been marked "received", its matching "receivedBack" entry — so
    // pending balances and received totals don't double-count once the new
    // split's entries are posted.
    for (const participant of expense.participants) {
      if (participant.personId == null) continue;
      const person = await this.personRepository.getByKey(participant.personId);
      if (person == null) continue;
      const ledgerRepository = this.ledgerRepositoryFor(person.id);
      const linked = await ledgerRepository.getByTransactionRef(expense.transactionId);
      for (const entry of linked) {
        await ledgerRepository.softDeleteEntry(person, entry);
      }
    }

    const result = await this.generateScheduleAndLedger({
      expenseId: expense.id,
      participants: newParticipants,
      totalAmount: expense.totalAmount,
      date: expense.date,
      description: expense.description,
      transactionId: expense.transactionId,
      dueDate: params.dueDate,
      sourceKind: "splitExpense",
    });

    let updated = recordEdit(expense, "splitType", expense.splitType, params.splitType);
    updated = {
      ...updated,
      splitType: params.splitType,
      participants: result.participants,
      scheduleId: result.scheduleId,
    };
    await this.update(updated);
    return updated;
  }

  /**
   * Description-only follow-up for a split/assigned Expense whose Transaction was just renamed: the
   * Expense's own `description` and each participant's "Split: …" share entry (the People row title)
   * take the new text. No amount, share, installment, settlement or balance is touched — `editEntry`
   * with only a note has zero balance delta. Idempotent: anything already in step is left alone, so
   * running it after `editExpense` (which syncs notes for tracked shares) changes nothing further.
   * Settlement entries ("Split settlement: …", "Received: …") are payment-history snapshots and are
   * deliberately not rewritten.
   */
  async syncDescription(expense: Expense, description: string): Promise<void> {
    const next = description.trim();
    if (next === "") return;
    if (expense.description !== next) await this.update({ ...expense, description: next });
    const newNote = `Split: ${next}`;
    const personIds = new Set(expense.participants.flatMap((p) => (p.isMe || p.personId == null ? [] : [p.personId])));
    for (const personId of personIds) {
      const person = await this.personRepository.getByKey(personId);
      if (person == null) continue;
      const ledgerRepository = this.ledgerRepositoryFor(person.id);
      const entries = await ledgerRepository.getByTransactionRef(expense.transactionId);
      for (const entry of entries) {
        if (entry.type !== "gave" || entry.paymentId != null || !entry.note.startsWith("Split: ") || entry.note === newNote) continue;
        await ledgerRepository.editEntry(person, entry, { note: newNote });
      }
    }
  }

  /**
   * Edits an existing expense in place — simple fields always apply; `totalAmount`/`splitType`/
   * `participantInputs` only matter when the expense is split, and re-resolve every participant's share via
   * `resolveShares`. Never lets a participant's new share drop below what they've already paid.
   *
   * ATOMIC (web-financial-integrity-audit P1-09): every financial change — the linked Transaction and its
   * account balance, each share's installment, each person's ledger entries and cached balance, added and
   * removed participants, and the Expense itself — is written in ONE Firestore transaction, computed from
   * documents re-read inside it. All of it lands, or none of it does. Only non-financial preparation runs
   * first (resolving shares, promoting a typed name to a Person); a person created for an attempt that then
   * fails is trashed again.
   */
  async editExpense(params: EditExpenseParams): Promise<Expense> {
    const caller = params.expense;
    const resplitRequested = params.totalAmount != null || params.splitType != null || params.participantInputs != null;
    const journal = newSplitWriteJournal();
    let newParticipants: ExpenseParticipant[] | null = null;
    if (isSplit(caller) && resplitRequested) {
      if (params.participantInputs == null) throw new Error("Choose who to share this expense with");
      const resolved = ExpenseRepository.resolveShares({
        type: params.splitType ?? caller.splitType,
        total: params.totalAmount ?? caller.totalAmount,
        inputs: params.participantInputs,
      });
      if (resolved.length === 0) throw new Error("Choose at least one person to share with");
      assertNoCashlessReceipt(resolved, caller.participants);
      // Idempotent by name: an already-promoted custom name resolves back to the same Person.
      newParticipants = await this.promoteCustomNameParticipants(resolved, journal);
    }

    // Ids the transaction re-reads — queries can't run inside a client transaction.
    const scheduleId = caller.scheduleId;
    const installmentIds = new Set<string>(caller.participants.flatMap((p) => (p.installmentId ? [p.installmentId] : [])));
    if (scheduleId != null) for (const i of await this.installmentRepositoryFor(scheduleId).getAll()) installmentIds.add(i.id);
    const personIds = [...new Set([...caller.participants, ...(newParticipants ?? [])].flatMap((p) => (p.personId ? [p.personId] : [])))];
    const entryIdsByPerson = await this.liveEntryIdsByPerson(personIds, caller.transactionId);

    try {
      return await runTransaction(this.collection.firestore, async (tx) => {
        const session = new TxSession(tx);
        const result = await this.editInSession(session, params, newParticipants, [...installmentIds], entryIdsByPerson);
        session.flush();
        return result;
      });
    } catch (error) {
      // Nothing financial was written. Undo only the people this attempt promoted from typed names.
      for (const person of journal.createdPeople) {
        await this.personRepository
          .getByKey(person.id)
          .then((fresh) => (fresh != null && fresh.deletedAt == null ? this.personRepository.softDelete(fresh) : undefined))
          .catch(() => undefined);
      }
      throw error;
    }
  }

  /** Active ledger entry ids per person whose `transactionRef` is this expense's transaction (pre-read for a tx). */
  private async liveEntryIdsByPerson(personIds: readonly string[], transactionId: string): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    for (const personId of personIds) map.set(personId, (await this.ledgerRepositoryFor(personId).getByTransactionRef(transactionId)).map((e) => e.id));
    return map;
  }

  private async editInSession(
    session: TxSession,
    params: EditExpenseParams,
    newParticipants: ExpenseParticipant[] | null,
    installmentIds: readonly string[],
    entryIdsByPerson: ReadonlyMap<string, string[]>,
  ): Promise<Expense> {
    const tx = session.asTransaction();
    const freshSnap = await session.get(this.docRef(params.expense.id));
    if (!freshSnap.exists() || freshSnap.data().deletedAt != null) throw new Error("This expense was deleted in another tab or device — nothing was changed.");
    let expense = freshSnap.data();

    expense = updateField(expense, "description", expense.description, params.description, (e, v) => ({ ...e, description: v }));
    expense = updateField(expense, "date", expense.date, params.date, (e, v) => ({ ...e, date: v }));
    expense = updateField(expense, "categoryId", expense.categoryId, params.categoryId, (e, v) => ({ ...e, categoryId: v }));
    expense = updateField(expense, "accountId", expense.accountId, params.accountId, (e, v) => ({ ...e, accountId: v }));
    expense = updateField(expense, "notes", expense.notes, params.notes, (e, v) => ({ ...e, notes: v }));

    const scheduleId = expense.scheduleId;
    const now = new Date();
    const personDelta = new Map<string, number>();
    const addDelta = (personId: string, delta: number) => personDelta.set(personId, round2((personDelta.get(personId) ?? 0) + delta));
    const ledgerRef = (personId: string, entryId: string) => this.ledgerRepositoryFor(personId).docRef(entryId);
    const installmentRef = (id: string) => this.installmentRepositoryFor(scheduleId!).docRef(id);
    /** Fresh, live entries of this person on this expense's transaction. */
    const liveEntries = async (personId: string): Promise<LedgerEntry[]> => {
      const out: LedgerEntry[] = [];
      for (const id of entryIdsByPerson.get(personId) ?? []) {
        const snap = await session.get(ledgerRef(personId, id));
        if (snap.exists() && snap.data().deletedAt == null && snap.data().transactionRef === expense.transactionId) out.push(snap.data());
      }
      return out;
    };
    const putEntry = (entry: LedgerEntry) => session.set(ledgerRef(entry.personId, entry.id), entry);

    const installmentById = new Map<string, Installment>();
    if (scheduleId != null) {
      for (const id of installmentIds) {
        const snap = await session.get(installmentRef(id));
        if (snap.exists() && snap.data().deletedAt == null) installmentById.set(id, snap.data());
      }
    }
    const touchedInstallments = new Map<string, Installment>();
    let syncedTransactionAmount: number | undefined = params.totalAmount;

    if (newParticipants != null && isSplit(expense)) {
      const newTotal = params.totalAmount ?? expense.totalAmount;
      const newSplitType = params.splitType ?? expense.splitType;
      const description = params.description ?? expense.description;
      const newDate = params.date ?? expense.date;
      const newNote = `Split: ${description}`;
      const oldByKey = new Map(expense.participants.map((p) => [participantKey(p), p]));
      const newKeys = new Set(newParticipants.map(participantKey));
      if (scheduleId == null) throw new Error("This expense has no tracking schedule to update");

      // Validate everything before computing any write.
      for (const p of newParticipants) {
        if (p.isMe) continue;
        const old = oldByKey.get(participantKey(p));
        const inst = old?.installmentId == null ? undefined : installmentById.get(old.installmentId);
        if (inst != null && p.share < inst.amountPaid) {
          throw new Error(`${p.name} has already been paid ${inst.amountPaid.toFixed(2)} — their share can't be reduced below that`);
        }
      }
      for (const removed of expense.participants) {
        if (removed.isMe || newKeys.has(participantKey(removed)) || removed.installmentId == null) continue;
        const inst = installmentById.get(removed.installmentId);
        if (inst != null && inst.amountPaid > 0) {
          throw new Error(`${removed.name} has already paid ${inst.amountPaid.toFixed(2)} — remove that payment before taking them off this expense`);
        }
      }

      const existing = [...installmentById.values()];
      let nextSequence = existing.reduce((m, i) => Math.max(m, i.sequenceNumber), 0);
      const firstDue = params.dueDate ?? existing.map((i) => i.dueDate).sort((a, b) => a.getTime() - b.getTime())[0] ?? addDays(newDate, 7);

      const resolved: ExpenseParticipant[] = [];
      for (const p of newParticipants) {
        if (p.isMe) {
          resolved.push(p);
          continue;
        }
        const old = oldByKey.get(participantKey(p));
        const inst = old?.installmentId == null ? undefined : installmentById.get(old.installmentId);

        if (inst == null) {
          // A participant added by this edit: their tracking installment and their share, like a new split.
          nextSequence += 1;
          const installment: Installment = {
            id: generateId(),
            scheduleId,
            ownerType: "splitExpense",
            ownerId: expense.id,
            sequenceNumber: nextSequence,
            dueDate: firstDue,
            amountDue: p.share,
            amountPaid: 0,
            isSkipped: false,
            principalPortion: null,
            interestPortion: null,
            createdAt: now,
            deletedAt: null,
            lastEditedAt: null,
            editHistory: [],
          };
          touchedInstallments.set(installment.id, installment);
          if (p.personId != null) {
            const gave = newLedgerEntry({ personId: p.personId, type: "gave", amount: p.share, date: newDate, note: newNote, transactionRef: expense.transactionId, sourceKind: "splitExpense", receivedStatus: "yetToReceive" });
            putEntry(gave);
            addDelta(p.personId, signedAmount(gave));
            if (p.receivedStatus === "received") {
              const back = newLedgerEntry({ personId: p.personId, type: "receivedBack", amount: p.share, date: newDate, note: `${RECEIVED_STATUS_NOTE_PREFIX}${description}`, transactionRef: expense.transactionId, sourceKind: "splitExpense", receivedStatus: "received" });
              putEntry(back);
              addDelta(p.personId, signedAmount(back));
            }
          }
          resolved.push(copyExpenseParticipant(p, { installmentId: installment.id }));
          continue;
        }

        if (inst.amountDue !== p.share) {
          touchedInstallments.set(inst.id, { ...recordEdit(inst, "amountDue", String(inst.amountDue), String(p.share)), amountDue: p.share });
        }
        if (p.personId != null) {
          const entries = await liveEntries(p.personId);
          const delta = round2(p.share - (old?.share ?? 0));
          const gave = entries.find((e) => e.type === "gave");
          if (gave != null) {
            let updated = updateField(gave, "amount", gave.amount, delta !== 0 ? p.share : undefined, (e, v) => ({ ...e, amount: v }));
            if (gave.date.getTime() !== newDate.getTime()) updated = updateField(updated, "date", gave.date.toISOString(), newDate.toISOString(), (e) => ({ ...e, date: newDate }));
            if (gave.note.startsWith("Split: ") && gave.note !== newNote) updated = updateField(updated, "note", gave.note, newNote, (e, v) => ({ ...e, note: v }));
            if (updated !== gave) {
              putEntry(updated);
              addDelta(p.personId, signedAmount(updated) - signedAmount(gave));
            }
          } else if (delta !== 0) {
            // The original share entry is gone (removed from the person's timeline) — a standalone correction.
            const adjustment = newLedgerEntry({ personId: p.personId, type: "adjustment", amount: Math.abs(delta), date: newDate, note: `Edited: ${description}`, transactionRef: null, sourceKind: "manual", receivedStatus: "yetToReceive", increasesBalance: delta >= 0 });
            putEntry(adjustment);
            addDelta(p.personId, signedAmount(adjustment));
          }

          // Status-driven "received" entry: credits only what real settlements haven't already credited.
          const oldStatus = old?.receivedStatus ?? "yetToReceive";
          const receivedEntry = findReceivedStatusEntry(entries);
          const statusCredit = round2(p.share - inst.amountPaid);
          const retire = (entry: LedgerEntry) => {
            putEntry({ ...entry, deletedAt: now });
            addDelta(entry.personId, -signedAmount(entry));
          };
          if (p.receivedStatus === "received" && oldStatus !== "received") {
            if (receivedEntry == null && statusCredit > 0) {
              const back = newLedgerEntry({ personId: p.personId, type: "receivedBack", amount: statusCredit, date: newDate, note: `${RECEIVED_STATUS_NOTE_PREFIX}${description}`, transactionRef: expense.transactionId, sourceKind: gave?.sourceKind ?? "splitExpense", receivedStatus: "received" });
              putEntry(back);
              addDelta(p.personId, signedAmount(back));
            }
          } else if (p.receivedStatus !== "received" && oldStatus === "received") {
            if (receivedEntry != null) retire(receivedEntry);
          } else if (p.receivedStatus === "received" && receivedEntry != null && delta !== 0) {
            if (statusCredit > 0) {
              const updated = updateField(receivedEntry, "amount", receivedEntry.amount, statusCredit, (e, v) => ({ ...e, amount: v }));
              putEntry(updated);
              addDelta(p.personId, signedAmount(updated) - signedAmount(receivedEntry));
            } else {
              retire(receivedEntry);
            }
          }
        }
        resolved.push(copyExpenseParticipant(p, { installmentId: inst.id }));
      }

      // Participants dropped by this edit: their installment closes and every share entry they hold on this
      // expense is reversed — otherwise a debt would remain with nobody owing it.
      for (const removed of expense.participants) {
        if (removed.isMe || newKeys.has(participantKey(removed))) continue;
        const inst = removed.installmentId == null ? undefined : installmentById.get(removed.installmentId);
        if (inst != null) touchedInstallments.set(inst.id, { ...inst, deletedAt: now });
        if (removed.personId == null) continue;
        for (const entry of await liveEntries(removed.personId)) {
          putEntry({ ...entry, deletedAt: now });
          addDelta(removed.personId, -signedAmount(entry));
        }
      }

      expense = recordEdit(expense, "totalAmount", String(expense.totalAmount), String(newTotal));
      expense = { ...expense, totalAmount: newTotal };
      expense = recordEdit(expense, "splitType", expense.splitType, newSplitType);
      expense = { ...expense, splitType: newSplitType, participants: resolved };
      syncedTransactionAmount = newTotal;
    } else {
      expense = updateField(expense, "totalAmount", expense.totalAmount, params.totalAmount, (e, v) => ({ ...e, totalAmount: v }));
    }

    // The linked Transaction and its account — as the split's owner (P0-02's generic refusal does not apply).
    const transaction = await this.transactionRepository.getInTransaction(tx, expense.transactionId);
    if (transaction != null && transaction.deletedAt == null) {
      await this.transactionRepository.editTransactionInTransaction(
        tx,
        transaction,
        { amount: syncedTransactionAmount, dateTime: params.date, accountId: params.accountId, categoryId: params.categoryId, notes: params.notes },
        { owner: "split" },
      );
    }

    if (params.dueDate != null && scheduleId != null) {
      for (const inst of [...installmentById.values(), ...touchedInstallments.values()]) {
        const current = touchedInstallments.get(inst.id) ?? inst;
        if (current.deletedAt != null || current.dueDate.getTime() === params.dueDate.getTime()) continue;
        touchedInstallments.set(inst.id, { ...recordEdit(current, "dueDate", current.dueDate.toISOString(), params.dueDate.toISOString()), dueDate: params.dueDate });
      }
    }
    for (const inst of touchedInstallments.values()) session.set(installmentRef(inst.id), inst);

    for (const [personId, delta] of personDelta) {
      if (delta === 0) continue;
      const personRef = this.personRepository.docRef(personId);
      const personSnap = await session.get(personRef);
      if (!personSnap.exists()) throw new Error("Person not found");
      session.set(personRef, this.personRepository.applyBalanceDelta(personSnap.data(), delta));
    }
    session.set(this.docRef(expense.id), expense);
    return expense;
  }

  /**
   * Flips one split participant's `receivedStatus` between "received" and
   * "yetToReceive" without touching shares, amounts, or any other
   * participant — the People Ledger's ✓/✕ quick-toggle. Reuses exactly the
   * same status-reconciliation branches `editExpense` runs during a resplit
   * (same `RECEIVED_STATUS_NOTE_PREFIX`-tagged entry, same idempotency
   * guarantees), just without requiring a full share re-resolve. Never posts
   * more than the one status-driven "receivedBack" entry, and never touches
   * a real (possibly partial) settlement entry from `settleParticipant`.
   */
  async setParticipantReceivedStatus(
    expense: Expense,
    participant: ExpenseParticipant,
    receivedStatus: ReceivedStatus,
  ): Promise<Expense> {
    if (participant.isMe || participant.personId == null) {
      throw new Error("Only a person-linked participant can have a received status");
    }
    if (receivedStatus !== "received" && receivedStatus !== "yetToReceive") {
      throw new Error("Only 'received' and 'yetToReceive' can be toggled here");
    }
    const oldStatus = participant.receivedStatus;
    if (oldStatus === receivedStatus) return expense;
    if (receivedStatus === "received") throw new ReceivedWithoutCashError(participant.name);

    const person = await this.personRepository.getByKey(participant.personId);
    if (person == null) throw new Error("Person not found");
    const ledgerRepository = this.ledgerRepositoryFor(person.id);
    const entries = await ledgerRepository.getByTransactionRef(expense.transactionId);
    const receivedEntry = findReceivedStatusEntry(entries);

    // Only the undo direction remains: a legacy ledger-only "received" status entry is retired.
    if (receivedEntry != null) {
      const refreshedPerson = (await this.personRepository.getByKey(person.id)) ?? person;
      await ledgerRepository.softDeleteEntry(refreshedPerson, receivedEntry);
    }

    const updatedParticipants = expense.participants.map((p) =>
      participantKey(p) === participantKey(participant) ? { ...p, receivedStatus } : p,
    );
    const updatedExpense = recordEdit(expense, "participants", JSON.stringify(expense.participants), JSON.stringify(updatedParticipants));
    const finalExpense = { ...updatedExpense, participants: updatedParticipants };
    await this.update(finalExpense);
    return finalExpense;
  }

  /**
   * Marks one `participant` as settled: records an InstallmentPayment
   * against their tracking installment and posts a reversing LedgerEntry so
   * their pending balance drops by the settled amount. Mirrors
   * `ExpenseRepository.settleParticipant`.
   *
   * When this payment brings the installment's remaining balance to zero,
   * also flips `participant.receivedStatus` to "received" on the Expense
   * doc — otherwise a fully-settled participant still reads as "yet to
   * receive" in the Transaction section, out of sync with the ledger entry
   * this same call just posted with `receivedStatus: "received"`.
   *
   * @deprecated LEDGER-ONLY — records a settlement with NO cash leg (no account receives the money). Not wired to
   * any app action or UI since the "Received = real money" contract; kept only for legacy tests/tooling. A
   * share being paid back is recorded with `PersonPaymentRepository.recordPayment` (`split` route) instead.
   */
  async settleParticipant(params: SettleParticipantParams): Promise<void> {
    const { expense, participant, installment, installmentPaymentRepository, amount, date, note, settlementMethod } =
      params;
    if (participant.installmentId !== installment.id) {
      throw new Error("This payment does not belong to this person");
    }

    await installmentPaymentRepository.recordPayment(installment, {
      amount,
      date,
      note: note ?? "",
      settlementMethod,
    });

    const fullySettled = round2(installmentRemainingAmount(installment) - amount) <= 0;
    if (fullySettled && participant.receivedStatus !== "received") {
      const updatedParticipants = expense.participants.map((p) =>
        participantKey(p) === participantKey(participant) ? { ...p, receivedStatus: "received" as ReceivedStatus } : p,
      );
      const updatedExpense = recordEdit(expense, "participants", JSON.stringify(expense.participants), JSON.stringify(updatedParticipants));
      await this.update({ ...updatedExpense, participants: updatedParticipants });
    }

    if (participant.personId == null) return;
    const person = await this.personRepository.getByKey(participant.personId);
    if (person == null) return;
    await this.ledgerRepositoryFor(person.id).addEntry(person, {
      type: "receivedBack",
      amount,
      date,
      note: `Split settlement: ${expense.description}`,
      transactionRef: expense.transactionId,
      receivedStatus: "received",
    });
  }

  /**
   * Settles a lump-sum `amount` against one person's outstanding
   * split/assigned-expense installments, oldest-due-first — the fan-out
   * counterpart to `settleParticipant`. If `amount` exceeds the total
   * outstanding across `pending`, the remainder is posted as one plain
   * LedgerEntry. `pending` must already be sorted oldest-due-first by the
   * caller. Mirrors `ExpenseRepository.settleAcrossPending`.
   *
   * @deprecated LEDGER-ONLY — records a settlement with NO cash leg (no account receives the money). Not wired to
   * any app action or UI since the "Received = real money" contract; kept only for legacy tests/tooling. A
   * person paying back is recorded with `PersonPaymentRepository.recordPayment` (Record payment) instead.
   */
  async settleAcrossPending(params: SettleAcrossPendingParams): Promise<void> {
    const { person, pending, amount, date, installmentPaymentRepositoryFor, note, settlementMethod, legacyLoanLedger = 0, emiReceivable = 0 } = params;
    if (amount <= 0) {
      throw new Error("Settlement amount must be greater than 0");
    }

    let remaining = amount;
    for (const item of pending) {
      if (remaining <= 0) break;
      const owed = installmentRemainingAmount(item.installment);
      if (owed <= 0) continue;
      const portion = owed < remaining ? owed : remaining;
      await this.settleParticipant({
        expense: item.expense,
        participant: item.participant,
        installment: item.installment,
        installmentPaymentRepository: installmentPaymentRepositoryFor(
          item.installment.scheduleId,
          item.installment.id,
        ),
        amount: portion,
        date,
        note,
        settlementMethod,
      });
      remaining -= portion;
    }

    if (remaining > 0) {
      // Re-read rather than reuse the caller's `person`: the loop above just
      // posted a receivedBack entry per settled installment, each of which
      // moved the balance. The remainder's direction ("receivedBack" when
      // they still owe, "repaid" when the lump sum has overshot into you
      // owing them) must be decided from the balance as it stands *now* —
      // deciding it from the pre-loop copy picks the opposite sign whenever
      // the settlements flipped who owes whom, posting the remainder in the
      // wrong direction and doubling the error.
      const refreshedPerson = (await this.personRepository.getByKey(person.id)) ?? person;
      await this.ledgerRepositoryFor(person.id).addEntry(refreshedPerson, {
        type: refreshedPerson.currentBalance - legacyLoanLedger + emiReceivable > 0 ? "receivedBack" : "repaid",
        amount: remaining,
        date,
        note: note === "" || note == null ? "Settled all" : note,
        receivedStatus: "received",
      });
    }
  }

  /**
   * Reverses this expense's ledger/schedule effect without touching the underlying Transaction — "this person
   * no longer owes me this expense". Same atomic retirement as `deleteExpense` (one Firestore transaction,
   * idempotent), except the Transaction and its account stay, and the retired entries carry no restore
   * provenance (an unassign is never undone by `restoreExpense`).
   */
  async unassignFromPerson(expense: Expense): Promise<void> {
    await this.retireSplit(expense, { deleteTransaction: false });
  }

  /**
   * Cascading soft delete of a split/assigned expense — ATOMIC and IDEMPOTENT (audit P1-09): in ONE Firestore
   * transaction the Transaction is soft-deleted with its account reversed once, the schedule and every
   * installment are retired, every share entry on this expense is reversed out of its person's balance and
   * stamped `retiredBy: "expense:<id>"` (P1-10 provenance), and the Expense is trashed. Re-reads everything
   * inside the transaction: an expense that is already deleted (double click, retry after a lost response,
   * another tab — including concurrently) writes nothing. Settlement entries recorded by Record Payment point at
   * their own cash leg, not this transaction, so they stay (money that really changed hands).
   */
  async deleteExpense(expense: Expense): Promise<void> {
    await this.retireSplit(expense, { deleteTransaction: true });
  }

  private async retireSplit(expense: Expense, opts: { deleteTransaction: boolean }): Promise<void> {
    const marker = opts.deleteTransaction ? splitRetirementMarker(expense.id) : null;
    const scheduleId = expense.scheduleId;
    // Ids to re-read inside the transaction (queries can't run in one).
    const installmentIds = new Set<string>(expense.participants.flatMap((p) => (p.installmentId ? [p.installmentId] : [])));
    if (scheduleId != null) for (const i of await this.installmentRepositoryFor(scheduleId).getAll()) installmentIds.add(i.id);
    const personIds = [...new Set(expense.participants.flatMap((p) => (p.personId ? [p.personId] : [])))];
    const entryIdsByPerson = await this.liveEntryIdsByPerson(personIds, expense.transactionId);

    await runTransaction(this.collection.firestore, async (tx) => {
      const session = new TxSession(tx);
      const t = session.asTransaction();
      const snap = await session.get(this.docRef(expense.id));
      if (!snap.exists() || snap.data().deletedAt != null) return; // already retired — never reversed twice
      const fresh = snap.data();
      const now = new Date();

      if (opts.deleteTransaction) {
        const transaction = await this.transactionRepository.getInTransaction(t, fresh.transactionId);
        // An already-trashed Transaction had its balance reversed already (e.g. a ghost from an older path).
        if (transaction != null && transaction.deletedAt == null) await this.transactionRepository.softDeleteTransactionInTransaction(t, transaction);
      }

      if (scheduleId != null) {
        for (const id of installmentIds) {
          const ref = this.installmentRepositoryFor(scheduleId).docRef(id);
          const inst = await session.get(ref);
          if (inst.exists() && inst.data().deletedAt == null) session.set(ref, { ...inst.data(), deletedAt: now });
        }
        const scheduleRef = this.paymentScheduleRepository.docRef(scheduleId);
        const schedule = await session.get(scheduleRef);
        if (schedule.exists() && schedule.data().deletedAt == null) session.set(scheduleRef, { ...schedule.data(), deletedAt: now });
      }

      for (const personId of personIds) {
        const ledger = this.ledgerRepositoryFor(personId);
        let delta = 0;
        for (const id of entryIdsByPerson.get(personId) ?? []) {
          const entrySnap = await session.get(ledger.docRef(id));
          if (!entrySnap.exists()) continue;
          const entry = entrySnap.data();
          if (entry.deletedAt != null || entry.transactionRef !== fresh.transactionId) continue;
          delta -= signedAmount(entry);
          session.set(ledger.docRef(id), { ...entry, deletedAt: now, retiredBy: marker });
        }
        delta = round2(delta);
        if (delta !== 0) {
          const personRef = this.personRepository.docRef(personId);
          const personSnap = await session.get(personRef);
          if (!personSnap.exists()) throw new Error("Person not found");
          session.set(personRef, this.personRepository.applyBalanceDelta(personSnap.data(), delta));
        }
      }

      session.set(this.docRef(fresh.id), { ...fresh, deletedAt: now });
      session.flush();
    });
  }

  /**
   * Restores what `deleteExpense` retired — ATOMIC and IDEMPOTENT, from documents re-read in ONE transaction:
   * the Transaction (its account re-applied once), the installments the expense's participants still point
   * at, the schedule, and ONLY the share entries stamped `retiredBy: "expense:<id>"` by that delete (P1-10).
   * An entry retired before the delete (e.g. a ✓ received status that was undone) has no such stamp and stays
   * retired; so does every entry of a legacy delete that predates the stamp — what can't be proven to have
   * been retired by the delete is never resurrected. A repeat / concurrent restore finds the expense live and
   * writes nothing.
   */
  async restoreExpense(expense: Expense): Promise<void> {
    const marker = splitRetirementMarker(expense.id);
    const scheduleId = expense.scheduleId;
    const personIds = [...new Set(expense.participants.flatMap((p) => (p.personId ? [p.personId] : [])))];
    const trashedEntryIds = new Map<string, string[]>();
    for (const personId of personIds) {
      trashedEntryIds.set(personId, (await this.ledgerRepositoryFor(personId).getTrashByTransactionRef(expense.transactionId)).map((e) => e.id));
    }

    await runTransaction(this.collection.firestore, async (tx) => {
      const session = new TxSession(tx);
      const t = session.asTransaction();
      const snap = await session.get(this.docRef(expense.id));
      if (!snap.exists() || snap.data().deletedAt == null) return; // already live — nothing re-applied
      const fresh = snap.data();

      const transaction = await this.transactionRepository.getInTransaction(t, fresh.transactionId);
      if (transaction != null && transaction.deletedAt != null) await this.transactionRepository.restoreTransactionInTransaction(t, transaction);

      if (scheduleId != null) {
        for (const p of fresh.participants) {
          if (p.installmentId == null) continue;
          const ref = this.installmentRepositoryFor(scheduleId).docRef(p.installmentId);
          const inst = await session.get(ref);
          if (inst.exists() && inst.data().deletedAt != null) session.set(ref, { ...inst.data(), deletedAt: null });
        }
        const scheduleRef = this.paymentScheduleRepository.docRef(scheduleId);
        const schedule = await session.get(scheduleRef);
        if (schedule.exists() && schedule.data().deletedAt != null) session.set(scheduleRef, { ...schedule.data(), deletedAt: null });
      }

      for (const personId of personIds) {
        const ledger = this.ledgerRepositoryFor(personId);
        let delta = 0;
        for (const id of trashedEntryIds.get(personId) ?? []) {
          const entrySnap = await session.get(ledger.docRef(id));
          if (!entrySnap.exists()) continue;
          const entry = entrySnap.data();
          if (entry.deletedAt == null || entry.retiredBy !== marker || entry.transactionRef !== fresh.transactionId) continue;
          delta += signedAmount(entry);
          session.set(ledger.docRef(id), { ...entry, deletedAt: null, retiredBy: null });
        }
        delta = round2(delta);
        if (delta !== 0) {
          const personRef = this.personRepository.docRef(personId);
          const personSnap = await session.get(personRef);
          if (!personSnap.exists()) throw new Error("Person not found");
          session.set(personRef, this.personRepository.applyBalanceDelta(personSnap.data(), delta));
        }
      }

      session.set(this.docRef(fresh.id), { ...fresh, deletedAt: null });
      session.flush();
    });
  }
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** `LedgerEntry.retiredBy` stamped by `deleteExpense` — the provenance `restoreExpense` restores by. */
export function splitRetirementMarker(expenseId: string): string {
  return `expense:${expenseId}`;
}

/** A new ledger entry written inside a split transaction (same shape `LedgerRepository.addEntry` writes). */
function newLedgerEntry(params: {
  personId: string;
  type: LedgerEntryType;
  amount: number;
  date: Date;
  note: string;
  transactionRef: string | null;
  sourceKind: LedgerSourceKind;
  receivedStatus: ReceivedStatus;
  increasesBalance?: boolean;
}): LedgerEntry {
  if (!(params.amount > 0)) throw new Error("Amount must be greater than 0");
  return {
    id: generateId(),
    personId: params.personId,
    type: params.type,
    amount: params.amount,
    date: params.date,
    note: params.note,
    transactionRef: params.transactionRef,
    parentEntryId: null,
    sourceKind: params.sourceKind,
    obligationRef: null,
    increasesBalance: params.increasesBalance ?? true,
    receivedStatus: params.receivedStatus,
    createdAt: new Date(),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
  };
}
