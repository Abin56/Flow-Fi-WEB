/**
 * App wiring for the final approval: the server re-read and the app's own repositories (the same factories every other
 * web write goes through, with the account-balance and card-payment guards). The expense repository is only reached by
 * a row assigned to a person or split between people. Nothing else is created.
 */

import { db } from "@/lib/firebase/client";
import { createAccountRepository, createExpenseRepository, createTransactionRepository } from "@/lib/repositories/repository-factory";
import { commitRepositoriesFor, type ApprovalDeps } from "./approval-commit";
import { readAuthoritativeData } from "./authoritative-reader";

export function createApprovalDeps(uid: string): ApprovalDeps {
  const accountRepository = createAccountRepository(uid);
  const transactionRepository = createTransactionRepository(uid, accountRepository);
  return { readData: () => readAuthoritativeData(db, uid), repositories: commitRepositoriesFor(transactionRepository, createExpenseRepository(uid, accountRepository)) };
}
