/**
 * Deleting a People cash leg from Transactions. When it is a receipt recorded together with a Loan / EMI payment
 * ("already paid → add to my account"), the delete is the same both-sides undo as Activity's — never one side only.
 * Any other transaction is not touched here (`handled: false`) and takes the ordinary delete. Refusals throw their
 * plain-language reason and write nothing.
 */

import { decidePairedReceiptDelete } from "@/features/activity/lib/undo-eligibility";
import { executeUndo, livePersonIds, resolvePairedReceiptFacts, type ExecuteDeps } from "@/features/activity/lib/undo-resolve";
import { db } from "@/lib/firebase/client";
import { formatCurrencyExact } from "@/lib/format";

export async function deletePairedReceiptIfAny(deps: ExecuteDeps, transactionId: string): Promise<{ handled: boolean; warning: string | null }> {
  const facts = await resolvePairedReceiptFacts({ db, uid: deps.uid, personIds: await livePersonIds(deps.uid) }, transactionId);
  if (facts == null) return { handled: false, warning: null };
  const decision = decidePairedReceiptDelete(facts, { money: formatCurrencyExact, accountName: () => null, accountBalance: () => null, personName: () => null });
  if (decision == null || decision.kind === "alreadyUndone") return { handled: false, warning: null };
  if (decision.kind === "blocked") throw new Error(decision.reason);
  const result = await executeUndo(decision.handler, deps, transactionId);
  return { handled: true, warning: result.warning };
}
