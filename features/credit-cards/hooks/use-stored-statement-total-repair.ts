"use client";

import { useEffect } from "react";
import { useAllCreditCardStatements, useCreditCards } from "@/hooks/use-credit-cards";
import { useTransactions } from "@/hooks/use-transactions";
import { creditInflatedTotalRepair } from "@/lib/repositories/credit-card-repository";
import { createAccountRepository, createStatementRepository, createTransactionRepository } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";

/** `${statementId}:${storedTotal}` already handed to the repair this session — one attempt per stored value. */
const attempted = new Set<string>();

/**
 * One-time repair of stored statement documents whose `totalAmount` still carries the old
 * credit-as-charge figure (see `creditInflatedTotalRepair`). Runs while Credit Cards is open:
 *  - a pure check over already-loaded data first — no read, no write for a statement that isn't affected;
 *  - for a candidate, that card's transactions are fetched FRESH from Firestore and the statement document
 *    is re-read inside a transaction (`StatementRepository.repairCreditInflatedTotal`), which writes only
 *    `totalAmount` and only if it is still provably inflated — so a repeat (or second tab) writes nothing.
 * Never touches transactions, payments, balances, People, `amountPaid`, `minimumDue`, period or due date.
 */
export function useStoredStatementTotalRepair(): void {
  const uid = useAuthStore((s) => s.user?.uid);
  const { data: cards = [] } = useCreditCards();
  const { data: statements = [], isLoading: statementsLoading } = useAllCreditCardStatements();
  const { data: transactions = [], isLoading: transactionsLoading } = useTransactions();

  useEffect(() => {
    if (!uid || statementsLoading || transactionsLoading) return;
    const cardById = new Map(cards.map((c) => [c.id, c]));
    for (const statement of statements) {
      const card = cardById.get(statement.cardId);
      if (card == null) continue;
      if (creditInflatedTotalRepair(statement, transactions.filter((t) => t.accountId === card.accountId)) == null) continue;
      const key = `${statement.id}:${statement.totalAmount}`;
      if (attempted.has(key)) continue;
      attempted.add(key);
      void (async () => {
        const transactionRepository = createTransactionRepository(uid, createAccountRepository(uid));
        const fresh = await transactionRepository.getAllForAccountIncludingTrash(card.accountId);
        await createStatementRepository(uid, card.id).repairCreditInflatedTotal(statement.id, fresh);
      })().catch(() => attempted.delete(key)); // a failed repair changed nothing; it is retried next time
    }
  }, [uid, cards, statements, transactions, statementsLoading, transactionsLoading]);
}
