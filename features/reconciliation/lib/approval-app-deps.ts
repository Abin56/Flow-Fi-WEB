/**
 * App wiring for the final approval: the server re-read and the app's own transaction repository (the same factory
 * every other web write goes through, with its account-balance and card-payment guards). Nothing else is created.
 */

import { db } from "@/lib/firebase/client";
import { createAccountRepository, createTransactionRepository } from "@/lib/repositories/repository-factory";
import { commitRepositoriesFor, type ApprovalDeps } from "./approval-commit";
import { readAuthoritativeData } from "./authoritative-reader";

export function createApprovalDeps(uid: string): ApprovalDeps {
  const transactionRepository = createTransactionRepository(uid, createAccountRepository(uid));
  return { readData: () => readAuthoritativeData(db, uid), repositories: commitRepositoriesFor(transactionRepository) };
}
