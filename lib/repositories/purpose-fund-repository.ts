/**
 * Purpose money — every change after the receipt, each one atomic (see `lib/models/purpose-fund.ts`).
 *
 *  - Record use: ONE real outgoing cash event, linked to the purpose — a new payment created here
 *    ("on their behalf" = a People movement, not my expense; or "my expense" = a normal expense; or a
 *    card bill payment = a transfer into the card account, the card's own payment rule), or an existing
 *    Transaction already recorded through its own flow (Loan / EMI / Person / anything). Never both.
 *  - Undo use: unlinks it; a payment created here is deleted with it (its account restored).
 *  - Edit: title / due / note / link always; amount down frees the difference as "unassigned"; amount up
 *    only from this receipt's unassigned money — the receipt's total never changes.
 *  - Cancel: the unused part becomes "unassigned" — never income, never deleted.
 *  - Unassigned money: assigned to a purpose again, or released to an advance (a normal advance ledger
 *    entry on the same payment) or to income (the cash leg shrinks by it and an Income Transaction of
 *    the same amount is written — the account total never changes).
 */

import { type CollectionReference, doc, getDocs, query, runTransaction } from "firebase/firestore";
import { PAYMENT_EPSILON, round2 } from "@/lib/engines/person-payment";
import { purposeUsed } from "@/lib/engines/purpose-funds";
import type { LedgerEntry, Person } from "@/lib/models/person";
import { signedAmount } from "@/lib/models/person";
import type { PurposeFund, PurposeLink, PurposeUse } from "@/lib/models/purpose-fund";
import type { Transaction } from "@/lib/models/transaction";
import { TxSession } from "@/lib/repositories/person-payment-repository";
import type { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import type { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { generateId } from "@/lib/utils/id-generator";

export type RecordUseInput =
  /** A new payment from my account. `behalf`: a People movement for this person (not my expense). */
  | { mode: "new"; accountId: string; amount: number; date: Date; description: string; classification: "behalf" | "expense"; categoryId?: string }
  /** A credit-card bill payment — a transfer from my account into the card account. */
  | { mode: "card"; accountId: string; cardAccountId: string; amount: number; date: Date; description: string; categoryId?: string }
  /** A payment already recorded through its own flow. */
  | { mode: "link"; transactionId: string; amount: number };

export interface PurposeEditPatch {
  title?: string;
  amount?: number;
  dueDate?: Date | null;
  note?: string;
  link?: PurposeLink | null;
}

export interface PurposeFundDeps {
  personRepository: PersonRepository;
  ledgerRepository: LedgerRepository;
  transactionRepository: TransactionRepository;
  purposeFunds: CollectionReference<PurposeFund>;
  /** The People cash-leg category — used for "on their behalf" payments. */
  cashLegCategoryId: string;
}

export class PurposeFundRepository {
  constructor(private readonly deps: PurposeFundDeps) {}

  private get db() {
    return this.deps.purposeFunds.firestore;
  }

  private ref(id: string) {
    return doc(this.deps.purposeFunds, id);
  }

  private async allFunds(): Promise<PurposeFund[]> {
    return (await getDocs(query(this.deps.purposeFunds))).docs.map((d) => d.data());
  }

  /** Fresh fund + its used amount (uses whose Transaction is still active), read inside the session. */
  private async readFund(session: TxSession, id: string): Promise<{ fund: PurposeFund; used: number }> {
    const snap = await session.get(this.ref(id));
    if (!snap.exists() || snap.data().deletedAt != null) throw new Error("This purpose no longer exists.");
    const fund = snap.data();
    const active = new Set<string>();
    for (const u of fund.uses) {
      const t = await this.deps.transactionRepository.getInTransaction(session.asTransaction(), u.transactionId);
      if (t && t.deletedAt == null) active.add(t.id);
    }
    return { fund, used: purposeUsed(fund, active) };
  }

  /** Records using purpose money — see the file comment. Returns the outgoing Transaction's id. */
  async recordUse(person: Person, fundId: string, input: RecordUseInput): Promise<string> {
    const amount = round2(input.amount);
    if (!(amount > 0)) throw new Error("Enter the amount used.");
    // Linking: how much of that payment other purposes already account for (never counted twice).
    let linkedElsewhere = 0;
    if (input.mode === "link") {
      for (const f of await this.allFunds()) {
        if (f.deletedAt != null) continue;
        for (const u of f.uses) if (u.transactionId === input.transactionId) linkedElsewhere = round2(linkedElsewhere + u.amount);
      }
    }
    let transactionId = "";
    await runTransaction(this.db, async (fsTx) => {
      const session = new TxSession(fsTx);
      const tx = session.asTransaction();
      const { fund, used } = await this.readFund(session, fundId);
      if (fund.state !== "active") throw new Error("This money isn't assigned to a purpose.");
      const remaining = round2(fund.amount - used);
      if (amount > remaining + PAYMENT_EPSILON) throw new Error(`Only ₹${remaining.toFixed(2)} is left on this purpose.`);

      let createdHere = true;
      if (input.mode === "link") {
        const t = await this.deps.transactionRepository.getInTransaction(tx, input.transactionId);
        if (!t || t.deletedAt != null) throw new Error("That payment no longer exists.");
        if (t.type !== "expense") throw new Error("Only money going out can be linked as a use.");
        if (t.id === fund.receiptTransactionRef) throw new Error("That is the receipt itself.");
        if (amount > round2(t.amount - linkedElsewhere) + PAYMENT_EPSILON) throw new Error("That is more than is left on the chosen payment.");
        transactionId = t.id;
        createdHere = false;
      } else if (input.mode === "card") {
        if (input.accountId === input.cardAccountId) throw new Error("Choose the account you paid the card from.");
        // The card's own payment rule: a transfer pair into the card account (one transferId), atomic here.
        // It settles the card's statements exactly like Pay bill, and purpose money never settles anyone's
        // share (it isn't an advance), so the same card People gate applies — checked before any write.
        await this.deps.transactionRepository.assertCardPaymentAllowedInTransaction(tx, input.cardAccountId, amount);
        const transferId = generateId();
        const common = { amount, dateTime: input.date, categoryId: input.categoryId || this.deps.cashLegCategoryId, description: input.description.trim() || fund.title, notes: `From ${person.name}'s money — ${fund.title}`, transferId };
        const out = await this.deps.transactionRepository.createTransactionInTransaction(tx, { ...common, type: "expense", accountId: input.accountId });
        await this.deps.transactionRepository.createTransactionInTransaction(tx, { ...common, type: "income", accountId: input.cardAccountId });
        transactionId = out.id;
      } else {
        const behalf = input.classification === "behalf";
        if (!behalf && !input.categoryId) throw new Error("Choose an expense category.");
        const out = await this.deps.transactionRepository.createTransactionInTransaction(tx, {
          type: "expense",
          amount,
          dateTime: input.date,
          accountId: input.accountId,
          categoryId: behalf ? this.deps.cashLegCategoryId : input.categoryId!,
          description: input.description.trim() || fund.title,
          notes: `From ${person.name}'s money — ${fund.title}`,
          // Paid on their behalf: their money passing through — moves the account, never my expense.
          ...(behalf ? { linkedPersonId: person.id, owesPersonToggle: false, isPersonLedgerMovement: true } : {}),
        });
        transactionId = out.id;
      }

      const use: PurposeUse = { id: generateId(), transactionId, amount, date: input.mode === "link" ? new Date() : input.date, createdHere, createdAt: new Date() };
      const done = round2(remaining - amount) <= PAYMENT_EPSILON;
      session.set(this.ref(fund.id), { ...fund, uses: [...fund.uses, use], completedAt: done ? new Date() : null, lastEditedAt: new Date() });
      session.flush();
    });
    return transactionId;
  }

  /** Unlinks one use; a payment created from the purpose is deleted with it (account restored). */
  async undoUse(fundId: string, useId: string): Promise<void> {
    const before = (await this.allFunds()).find((f) => f.id === fundId);
    const use = before?.uses.find((u) => u.id === useId);
    if (!before || !use) throw new Error("That use no longer exists.");
    // A card payment created here is a transfer pair — both legs go.
    const ids = [use.transactionId];
    if (use.createdHere) {
      const t = await this.deps.transactionRepository.getByKey(use.transactionId);
      if (t?.transferId) {
        const sibling = await this.deps.transactionRepository.findTransferSibling(t);
        if (sibling) ids.push(sibling.id);
      }
    }
    await runTransaction(this.db, async (fsTx) => {
      const session = new TxSession(fsTx);
      const tx = session.asTransaction();
      const snap = await session.get(this.ref(fundId));
      if (!snap.exists() || snap.data().deletedAt != null) throw new Error("This purpose no longer exists.");
      const fund = snap.data();
      const fresh = fund.uses.find((u) => u.id === useId);
      if (!fresh) throw new Error("That use no longer exists.");
      const prepared = fresh.createdHere ? await this.deps.transactionRepository.readSoftDeleteMany(tx, ids, () => true) : null;
      session.set(this.ref(fund.id), { ...fund, uses: fund.uses.filter((u) => u.id !== useId), completedAt: null, lastEditedAt: new Date() });
      if (prepared) this.deps.transactionRepository.writeSoftDeleteMany(tx, prepared);
      session.flush();
    });
  }

  /** Edits a purpose — see the file comment for the amount rule. */
  async editFund(fundId: string, patch: PurposeEditPatch): Promise<void> {
    const siblings = (await this.allFunds()).filter((f) => f.deletedAt == null);
    await runTransaction(this.db, async (fsTx) => {
      const session = new TxSession(fsTx);
      const { fund, used } = await this.readFund(session, fundId);
      if (fund.state !== "active") throw new Error("Only an active purpose can be edited.");
      const now = new Date();
      let next: PurposeFund = { ...fund, lastEditedAt: now };
      if (patch.title != null) {
        if (!patch.title.trim()) throw new Error("Say what this money is for.");
        next.title = patch.title.trim();
      }
      if (patch.note != null) next.note = patch.note.trim();
      if (patch.dueDate !== undefined) next.dueDate = patch.dueDate;
      if (patch.link !== undefined) next.link = patch.link;
      if (patch.amount != null) {
        const amount = round2(patch.amount);
        if (amount + PAYMENT_EPSILON < used) throw new Error(`₹${used.toFixed(2)} is already used — the amount can't be less than that.`);
        if (!(amount > 0)) throw new Error("Enter the amount.");
        const diff = round2(amount - fund.amount);
        if (diff < -PAYMENT_EPSILON) {
          // Lowered: the difference is freed from this receipt — waiting for a decision, never income.
          const id = generateId();
          session.set(this.ref(id), this.unassignedPiece(id, fund, -diff, now));
        } else if (diff > PAYMENT_EPSILON) {
          // Raised: only from this receipt's unassigned money, oldest first.
          let need = diff;
          for (const s of siblings.filter((f) => f.paymentId === fund.paymentId && f.state === "unassigned").sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
            if (need <= PAYMENT_EPSILON) break;
            const fresh = await session.get(this.ref(s.id));
            if (!fresh.exists() || fresh.data().deletedAt != null || fresh.data().state !== "unassigned") continue;
            const take = round2(Math.min(fresh.data().amount, need));
            const left = round2(fresh.data().amount - take);
            session.set(this.ref(s.id), left <= PAYMENT_EPSILON ? { ...fresh.data(), amount: 0, state: "cancelled", lastEditedAt: now } : { ...fresh.data(), amount: left, lastEditedAt: now });
            need = round2(need - take);
          }
          if (need > PAYMENT_EPSILON) throw new Error("This receipt has no unassigned money to add — the amount can only go up by what is unassigned.");
        }
        next = { ...next, amount, completedAt: round2(amount - used) <= PAYMENT_EPSILON ? (fund.completedAt ?? now) : null };
      }
      session.set(this.ref(fund.id), next);
      session.flush();
    });
  }

  /** Cancels a purpose: what is not used becomes unassigned money from the same receipt. */
  async cancelFund(fundId: string): Promise<void> {
    await runTransaction(this.db, async (fsTx) => {
      const session = new TxSession(fsTx);
      const { fund, used } = await this.readFund(session, fundId);
      if (fund.state !== "active") throw new Error("Only an active purpose can be cancelled.");
      const freed = round2(fund.amount - used);
      if (freed <= PAYMENT_EPSILON) throw new Error("This purpose is already fully used.");
      const now = new Date();
      // Anything used stays with the purpose (it is completed at what was used); untouched → cancelled.
      session.set(
        this.ref(fund.id),
        used > PAYMENT_EPSILON ? { ...fund, amount: used, completedAt: now, lastEditedAt: now } : { ...fund, amount: 0, state: "cancelled", lastEditedAt: now },
      );
      const pieceId = generateId();
      session.set(this.ref(pieceId), this.unassignedPiece(pieceId, fund, freed, now));
      session.flush();
    });
  }

  /** Gives unassigned money a purpose again (all of it, or part — the rest stays unassigned). */
  async assignUnassigned(unassignedId: string, draft: { title: string; amount: number; dueDate: Date | null; note: string; link: PurposeLink | null }): Promise<void> {
    await runTransaction(this.db, async (fsTx) => {
      const session = new TxSession(fsTx);
      const snap = await session.get(this.ref(unassignedId));
      if (!snap.exists() || snap.data().deletedAt != null || snap.data().state !== "unassigned") throw new Error("That money is no longer unassigned.");
      const piece = snap.data();
      const amount = round2(draft.amount);
      if (!draft.title.trim()) throw new Error("Say what this money is for.");
      if (!(amount > 0) || amount > piece.amount + PAYMENT_EPSILON) throw new Error(`Enter up to ₹${piece.amount.toFixed(2)}.`);
      const now = new Date();
      const left = round2(piece.amount - amount);
      session.set(this.ref(piece.id), left <= PAYMENT_EPSILON ? { ...piece, amount: 0, state: "cancelled", lastEditedAt: now } : { ...piece, amount: left, lastEditedAt: now });
      const id = generateId();
      session.set(this.ref(id), {
        ...piece,
        id,
        title: draft.title.trim(),
        amount,
        dueDate: draft.dueDate,
        note: draft.note.trim(),
        link: draft.link,
        uses: [],
        state: "active",
        release: null,
        completedAt: null,
        createdAt: now,
        lastEditedAt: null,
      });
      session.flush();
    });
  }

  /**
   * Releases unassigned money (all of that piece) to an advance against this person's future
   * obligations, or to income. Either way the account total is unchanged — the cash already arrived.
   */
  async releaseUnassigned(
    person: Person,
    unassignedId: string,
    to: { kind: "advance" } | { kind: "income"; categoryId: string; description: string },
  ): Promise<void> {
    await runTransaction(this.db, async (fsTx) => {
      const session = new TxSession(fsTx);
      const tx = session.asTransaction();
      const snap = await session.get(this.ref(unassignedId));
      if (!snap.exists() || snap.data().deletedAt != null || snap.data().state !== "unassigned") throw new Error("That money is no longer unassigned.");
      const piece = snap.data();
      const amount = round2(piece.amount);
      const cashLeg = await this.deps.transactionRepository.getInTransaction(tx, piece.receiptTransactionRef);
      if (!cashLeg || cashLeg.deletedAt != null) throw new Error("The payment this money came with no longer exists.");
      const now = new Date();

      if (to.kind === "advance") {
        // The same advance Record Payment writes ("Keep as advance"), on the same payment and cash leg.
        const personRef = this.deps.personRepository.docRef(person.id);
        const personSnap = await session.get(personRef);
        if (!personSnap.exists()) throw new Error("Person not found");
        const entry: LedgerEntry = {
          id: generateId(),
          personId: person.id,
          type: "receivedBack",
          amount,
          date: piece.receivedDate,
          note: "Advance — released from purpose money",
          increasesBalance: true,
          transactionRef: cashLeg.id,
          parentEntryId: null,
          obligationRef: null,
          sourceKind: "advance",
          paymentId: piece.paymentId,
          installmentPaymentRef: null,
          incomeTransactionRef: null,
          receivedStatus: "received",
          createdAt: now,
          deletedAt: null,
          lastEditedAt: null,
          editHistory: [],
        };
        session.set(personRef, this.deps.personRepository.applyBalanceDelta(personSnap.data(), signedAmount(entry)));
        session.set(this.deps.ledgerRepository.docRef(entry.id), entry);
        session.set(this.ref(piece.id), { ...piece, state: "released", release: { kind: "advance", ref: entry.id, date: now }, lastEditedAt: now });
      } else {
        if (!to.categoryId) throw new Error("Choose an income category.");
        // Move it out of the People cash leg into a normal Income transaction — same account, same day.
        const left = round2(cashLeg.amount - amount);
        if (left <= PAYMENT_EPSILON) throw new Error("This is the whole payment — revert it and record it again as income.");
        await this.deps.transactionRepository.editTransactionInTransaction(tx, cashLeg, { amount: left });
        const income: Transaction = await this.deps.transactionRepository.createTransactionInTransaction(tx, {
          type: "income",
          amount,
          dateTime: cashLeg.dateTime,
          accountId: cashLeg.accountId,
          categoryId: to.categoryId,
          description: to.description.trim() || `${person.name} — extra`,
        });
        session.set(this.ref(piece.id), { ...piece, state: "released", release: { kind: "income", ref: income.id, date: now }, lastEditedAt: now });
      }
      session.flush();
    });
  }

  private unassignedPiece(id: string, fund: PurposeFund, amount: number, now: Date): PurposeFund {
    return {
      ...fund,
      id,
      title: `Unassigned — was “${fund.title}”`,
      amount: round2(amount),
      dueDate: null,
      note: "",
      link: null,
      uses: [],
      state: "unassigned",
      release: null,
      completedAt: null,
      createdAt: now,
      lastEditedAt: null,
    };
  }
}
