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
  type SplitType,
} from "@/lib/models/expense";
import type { Installment } from "@/lib/models/payment-schedule";
import { remainingAmount as installmentRemainingAmount } from "@/lib/models/payment-schedule";
import { isCreditor, type LedgerEntry, type Person } from "@/lib/models/person";
import { generateId } from "@/lib/utils/id-generator";
import { InstallmentPaymentRepository, InstallmentRepository, PaymentScheduleRepository } from "./payment-schedule-repository";
import { LedgerRepository, PersonRepository } from "./person-repository";
import { TransactionRepository } from "./transaction-repository";
import type { CollectionReference } from "firebase/firestore";

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

/**
 * Matches a participant across an edit — by `personId` when tracked as a
 * Person, otherwise by `name`. Mirrors `ExpenseRepository._participantKey`.
 */
function participantKey(p: ExpenseParticipant): string {
  return p.personId ?? `name:${p.name}`;
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
        }));
      }

      case "custom": {
        const participants: ExpenseParticipant[] = inputs.map((input) => ({
          personId: input.personId ?? null,
          name: input.name,
          share: requireValue(input, "a custom amount"),
          installmentId: null,
          isMe: input.isMe ?? false,
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
        }));
      }
    }
  }

  /**
   * Creates the PaymentSchedule + one Installment per non-"Me" participant
   * (nothing is ever "collected" from yourself, so Me never gets an
   * installment), posts a LedgerEntry for each person-linked participant,
   * and returns the full participants list with `installmentId`s filled in
   * for everyone except Me. Shared by `createExpense` and `convertToSplit`.
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
  }): Promise<{ scheduleId: string; participants: ExpenseParticipant[] }> {
    const { expenseId, participants, totalAmount, date, description, transactionId, dueDate } = params;
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
      await this.ledgerRepositoryFor(person.id).addEntry(person, {
        type: "gave",
        amount: participant.share,
        date,
        note: `Split: ${description}`,
        transactionRef: transactionId,
      });
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
      await this.transactionRepository.softDeleteTransaction(transaction).catch(() => {
        // Best-effort — the original error below is what actually surfaces.
      });
      throw error;
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
    if (participants.length === 0) {
      throw new Error("Choose at least one person to share with");
    }

    const expenseId = existingExpense?.id ?? generateId();

    const result = await this.generateScheduleAndLedger({
      expenseId,
      participants,
      totalAmount: params.totalAmount,
      date: params.date,
      description: params.description,
      transactionId: params.transactionId,
      dueDate: params.dueDate,
    });
    const scheduleId = result.scheduleId;
    participants = result.participants;

    if (existingExpense != null) {
      let updated = recordEdit(existingExpense, "splitType", existingExpense.splitType, params.splitType);
      updated = { ...updated, splitType: params.splitType, participants, scheduleId };
      await this.update(updated);
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
    await this.add(expense.id, expense);
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

    // Reverse + soft-delete the original per-person "gave" entries so their
    // pending balances don't double-count once the new ones are posted.
    for (const participant of expense.participants) {
      if (participant.personId == null) continue;
      const person = await this.personRepository.getByKey(participant.personId);
      if (person == null) continue;
      const ledgerRepository = this.ledgerRepositoryFor(person.id);
      const linked = (await ledgerRepository.getByTransactionRef(expense.transactionId)).filter(
        (e) => e.type === "gave",
      );
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
   * Edits an existing expense in place — simple fields always apply;
   * `totalAmount`/`splitType`/`participantInputs` only matter when `expense`
   * is split, and re-resolve every participant's share via `resolveShares`.
   * Never lets a participant's new share drop below what they've already
   * paid. Always keeps the linked Transaction in sync via
   * `TransactionRepository.editTransaction`. Mirrors
   * `ExpenseRepository.editExpense`.
   */
  async editExpense(params: EditExpenseParams): Promise<Expense> {
    let expense = params.expense;
    const { currentInstallments } = params;

    expense = updateField(expense, "description", expense.description, params.description, (e, v) => ({
      ...e,
      description: v,
    }));
    expense = updateField(expense, "date", expense.date, params.date, (e, v) => ({ ...e, date: v }));
    expense = updateField(expense, "categoryId", expense.categoryId, params.categoryId, (e, v) => ({
      ...e,
      categoryId: v,
    }));
    expense = updateField(expense, "accountId", expense.accountId, params.accountId, (e, v) => ({
      ...e,
      accountId: v,
    }));
    expense = updateField(expense, "notes", expense.notes, params.notes, (e, v) => ({ ...e, notes: v }));

    const resplitting =
      isSplit(expense) &&
      (params.totalAmount != null || params.splitType != null || params.participantInputs != null);
    let syncedTransactionAmount: number | undefined = params.totalAmount;

    if (resplitting) {
      if (params.participantInputs == null) {
        throw new Error("Choose who to share this expense with");
      }
      const newTotal = params.totalAmount ?? expense.totalAmount;
      const newSplitType = params.splitType ?? expense.splitType;
      const installmentById = new Map(currentInstallments.map((i) => [i.id, i]));

      const newParticipants = ExpenseRepository.resolveShares({
        type: newSplitType,
        total: newTotal,
        inputs: params.participantInputs,
      });
      if (newParticipants.length === 0) {
        throw new Error("Choose at least one person to share with");
      }

      const oldByKey = new Map(expense.participants.map((p) => [participantKey(p), p]));

      for (const participant of newParticipants) {
        if (participant.isMe) continue;
        const old = oldByKey.get(participantKey(participant));
        const installment = old?.installmentId == null ? undefined : installmentById.get(old.installmentId);
        if (installment == null) continue;
        if (participant.share < installment.amountPaid) {
          throw new Error(
            `${participant.name} has already been paid ${installment.amountPaid.toFixed(2)} — ` +
              "their share can't be reduced below that",
          );
        }
      }

      const scheduleId = expense.scheduleId;
      if (scheduleId == null) {
        throw new Error("This expense has no tracking schedule to update");
      }
      const installmentRepository = this.installmentRepositoryFor(scheduleId);

      const resolvedParticipants: ExpenseParticipant[] = [];
      for (const participant of newParticipants) {
        if (participant.isMe) {
          resolvedParticipants.push(participant);
          continue;
        }
        const old = oldByKey.get(participantKey(participant));
        const installment = old?.installmentId == null ? undefined : installmentById.get(old.installmentId);
        if (installment == null) {
          resolvedParticipants.push(participant);
          continue;
        }

        await installmentRepository.editInstallmentAmount(installment, participant.share);

        const delta = round2(participant.share - (old?.share ?? 0));
        if (delta !== 0 && participant.personId != null) {
          const person = await this.personRepository.getByKey(participant.personId);
          if (person != null) {
            const ledgerRepository = this.ledgerRepositoryFor(person.id);
            const entries = await ledgerRepository.getByTransactionRef(expense.transactionId);
            const originalEntry: LedgerEntry | undefined = entries.find((e) => e.type === "gave");
            if (originalEntry != null) {
              // Corrects the same "Split: ..."/"gave" entry the person's
              // statement already shows, so its displayed amount moves in
              // step with the just-synced Transaction/Installment instead
              // of staying stale next to a separate "Correct Balance" line.
              await ledgerRepository.editEntryAmount(person, originalEntry, participant.share);
            } else {
              // The original entry is gone (e.g. manually deleted from the
              // person's timeline) — fall back to a standalone correction
              // so the balance still stays in sync.
              await ledgerRepository.addEntry(person, {
                type: "adjustment",
                amount: Math.abs(delta),
                date: params.date ?? expense.date,
                note: `Edited: ${params.description ?? expense.description}`,
                increasesBalance: delta >= 0,
              });
            }
          }
        }

        resolvedParticipants.push(copyExpenseParticipant(participant, { installmentId: installment.id }));
      }

      expense = recordEdit(expense, "totalAmount", String(expense.totalAmount), String(newTotal));
      expense = { ...expense, totalAmount: newTotal };
      expense = recordEdit(expense, "splitType", expense.splitType, newSplitType);
      expense = { ...expense, splitType: newSplitType, participants: resolvedParticipants };
      syncedTransactionAmount = newTotal;
    } else {
      expense = updateField(expense, "totalAmount", expense.totalAmount, params.totalAmount, (e, v) => ({
        ...e,
        totalAmount: v,
      }));
    }

    const transaction = await this.transactionRepository.getByKey(expense.transactionId);
    if (transaction != null) {
      await this.transactionRepository.editTransaction(transaction, {
        amount: syncedTransactionAmount,
        dateTime: params.date,
        accountId: params.accountId,
        categoryId: params.categoryId,
        notes: params.notes,
      });
    }

    if (params.dueDate != null && expense.scheduleId != null) {
      const installmentRepository = this.installmentRepositoryFor(expense.scheduleId);
      for (const installment of currentInstallments) {
        await installmentRepository.editInstallmentDueDate(installment, params.dueDate);
      }
    }

    await this.update(expense);
    return expense;
  }

  /**
   * Marks one `participant` as settled: records an InstallmentPayment
   * against their tracking installment and posts a reversing LedgerEntry so
   * their pending balance drops by the settled amount. Mirrors
   * `ExpenseRepository.settleParticipant`.
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

    if (participant.personId == null) return;
    const person = await this.personRepository.getByKey(participant.personId);
    if (person == null) return;
    await this.ledgerRepositoryFor(person.id).addEntry(person, {
      type: "receivedBack",
      amount,
      date,
      note: `Split settlement: ${expense.description}`,
      transactionRef: expense.transactionId,
    });
  }

  /**
   * Settles a lump-sum `amount` against one person's outstanding
   * split/assigned-expense installments, oldest-due-first — the fan-out
   * counterpart to `settleParticipant`. If `amount` exceeds the total
   * outstanding across `pending`, the remainder is posted as one plain
   * LedgerEntry. `pending` must already be sorted oldest-due-first by the
   * caller. Mirrors `ExpenseRepository.settleAcrossPending`.
   */
  async settleAcrossPending(params: SettleAcrossPendingParams): Promise<void> {
    const { person, pending, amount, date, installmentPaymentRepositoryFor, note, settlementMethod } = params;
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
      await this.ledgerRepositoryFor(person.id).addEntry(person, {
        type: isCreditor(person) ? "receivedBack" : "repaid",
        amount: remaining,
        date,
        note: note === "" || note == null ? "Settled all" : note,
      });
    }
  }

  /**
   * Reverses this expense's ledger/schedule effect without touching the
   * underlying Transaction — the symmetric counterpart to
   * `assignToPerson`/`convertToAssigned` for "this person no longer owes me
   * this expense". Shares `deleteExpense`'s schedule/installment/ledger
   * cleanup exactly, but deliberately does NOT soft-delete the Transaction
   * or the Expense document itself. Mirrors
   * `ExpenseRepository.unassignFromPerson`.
   */
  async unassignFromPerson(expense: Expense): Promise<void> {
    const scheduleId = expense.scheduleId;
    if (scheduleId != null) {
      const installmentRepository = this.installmentRepositoryFor(scheduleId);
      for (const installment of await installmentRepository.getAll()) {
        await installmentRepository.softDelete(installment);
      }
      const schedule = await this.paymentScheduleRepository.getByKey(scheduleId);
      if (schedule != null) {
        await this.paymentScheduleRepository.softDelete(schedule);
      }
    }

    for (const participant of expense.participants) {
      if (participant.personId == null) continue;
      const person = await this.personRepository.getByKey(participant.personId);
      if (person == null) continue;
      const ledgerRepository = this.ledgerRepositoryFor(person.id);
      const linkedEntries = await ledgerRepository.getByTransactionRef(expense.transactionId);
      for (const entry of linkedEntries) {
        await ledgerRepository.softDeleteEntry(person, entry);
      }
    }

    await this.softDelete(expense);
  }

  /**
   * Cascading soft-delete for a split/assigned expense. Mirrors
   * `TransactionRepository.softDeleteTransaction` for the account balance,
   * then soft-deletes the Expense itself, its PaymentSchedule and every
   * Installment, and reverses + soft-deletes every person LedgerEntry this
   * expense posted. Mirrors `ExpenseRepository.deleteExpense`.
   */
  async deleteExpense(expense: Expense): Promise<void> {
    const transaction = await this.transactionRepository.getByKey(expense.transactionId);
    if (transaction != null) {
      await this.transactionRepository.softDeleteTransaction(transaction);
    }

    const scheduleId = expense.scheduleId;
    if (scheduleId != null) {
      const installmentRepository = this.installmentRepositoryFor(scheduleId);
      for (const installment of await installmentRepository.getAll()) {
        await installmentRepository.softDelete(installment);
      }
      const schedule = await this.paymentScheduleRepository.getByKey(scheduleId);
      if (schedule != null) {
        await this.paymentScheduleRepository.softDelete(schedule);
      }
    }

    for (const participant of expense.participants) {
      if (participant.personId == null) continue;
      const person = await this.personRepository.getByKey(participant.personId);
      if (person == null) continue;
      const ledgerRepository = this.ledgerRepositoryFor(person.id);
      const linkedEntries = await ledgerRepository.getByTransactionRef(expense.transactionId);
      for (const entry of linkedEntries) {
        await ledgerRepository.softDeleteEntry(person, entry);
      }
    }

    await this.softDelete(expense);
  }

  /**
   * Restores everything `deleteExpense` cascaded — the exact inverse. Only
   * restores a piece that is still actually in trash — each `isDeleted`
   * check guards against double-applying a balance effect if that piece
   * was already independently restored first. Mirrors
   * `ExpenseRepository.restoreExpense`.
   */
  async restoreExpense(expense: Expense): Promise<void> {
    const transaction = await this.transactionRepository.getByKey(expense.transactionId);
    if (transaction != null && transaction.deletedAt != null) {
      await this.transactionRepository.restoreTransaction(transaction);
    }

    const scheduleId = expense.scheduleId;
    if (scheduleId != null) {
      const installmentRepository = this.installmentRepositoryFor(scheduleId);
      for (const installment of await installmentRepository.getTrash()) {
        await installmentRepository.restore(installment);
      }
      const schedule = await this.paymentScheduleRepository.getByKey(scheduleId);
      if (schedule != null && schedule.deletedAt != null) {
        await this.paymentScheduleRepository.restore(schedule);
      }
    }

    for (const participant of expense.participants) {
      if (participant.personId == null) continue;
      const person = await this.personRepository.getByKey(participant.personId);
      if (person == null) continue;
      const ledgerRepository = this.ledgerRepositoryFor(person.id);
      const linkedEntries = await ledgerRepository.getTrashByTransactionRef(expense.transactionId);
      for (const entry of linkedEntries) {
        await ledgerRepository.restoreEntry(person, entry);
      }
    }

    await this.restore(expense);
  }
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
