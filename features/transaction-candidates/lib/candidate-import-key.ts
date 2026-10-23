/**
 * Stable idempotency key for importing one SMS candidate — passed to
 * `TransactionRepository.createTransaction({ idempotencyKey })`, which derives the transaction's
 * document id from it (`txn_<key>`) and, INSIDE the same Firestore transaction that moves the account
 * balance, returns the already-saved transaction instead of writing a second one (or refuses if the
 * saved one's money differs). Same candidate => same key => at most one balance effect, however many
 * clicks, retries, tabs, or Android re-syncs ("resurrection") of the same document happen.
 *
 * The candidate id is Android's stable `SmsInboxItem.id` (the Firestore document id), so it identifies
 * the SMS itself, not a particular import attempt. Keys are scoped to the signed-in user by where they
 * live: the derived transaction id is a document under `users/{uid}/transactions`, so two users can
 * never collide.
 *
 * The repository only accepts `[A-Za-z0-9_-]{8,128}`. An id that already fits is used verbatim
 * (`sms_<id>`); anything else (other characters, too short/long) is hashed (`smsh_<sha256 hex>`).
 * The two forms can't collide: `sms_` + a valid id never starts `smsh_`.
 */

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function candidateImportKey(candidateId: string): Promise<string> {
  if (!candidateId) throw new Error("Cannot derive an import key for a candidate with no id.");
  const direct = `sms_${candidateId}`;
  if (KEY_PATTERN.test(direct)) return direct;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(candidateId));
  return `smsh_${toHex(digest)}`;
}

/** The transaction document id `createTransaction` derives from an idempotency key (mirrors `TransactionRepository`). */
export function importedTransactionId(key: string): string {
  return `txn_${key}`;
}

/**
 * `createTransaction` throws this when a keyed transaction already exists but with different money
 * (amount / account / date / type) — e.g. the user edited the imported transaction afterwards and the
 * candidate has since resurrected. Matched by message because the repository (out of scope here)
 * throws a plain `Error`; an emulator test pins this text against the real repository.
 */
export function isKeyedTransactionChangedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("already saved with different details");
}
