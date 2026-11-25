/**
 * Which description a People view shows for a record linked to a transaction. DISPLAY ONLY — nothing here writes,
 * and a projected ledger entry must never be handed to a repository (it would persist the projected note).
 *
 * `Transaction.description` is the approved wording. `Transaction.notes` is not a description: an import keeps the
 * bank's narration there ("Bank narration: UPI/…") for verification and matching, next to its own marker.
 */

import type { LedgerEntry } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";

const SHARE_PREFIX = "Split: ";

/** Segments an importer adds to `Transaction.notes` (joined with " · ") — never the user's own words. */
const IMPORT_SEGMENT = /^(Bank narration:|Imported via (Reconciliation|Smart Capture))/;

/** The user's own words in a transaction's notes — without the import's narration and marker. Null when nothing is left. */
export function userNote(notes: string | null | undefined): string | null {
  const own = (notes ?? "")
    .split(" · ")
    .filter((part) => !IMPORT_SEGMENT.test(part.trim()))
    .join(" · ")
    .trim();
  return own || null;
}

type ShareEntry = Pick<LedgerEntry, "type" | "sourceKind" | "paymentId" | "note" | "transactionRef"> & Partial<Pick<LedgerEntry, "personId" | "editHistory">>;
type LinkedTransaction = Pick<Transaction, "id" | "description" | "deletedAt" | "type" | "isPersonLedgerMovement"> & Partial<Pick<Transaction, "fundedByPersonId">>;

/**
 * An expense a person paid for me: its entry is created with the note copied from the description, and a later note
 * change is recorded in `editHistory`. So only a note with NO recorded change is provably that untouched copy. A
 * changed one may be wording typed in People (or an earlier sync — they can't be told apart) and stays as stored.
 */
function personFundedNote(entry: ShareEntry, t: LinkedTransaction | undefined): string | null {
  if (entry.type !== "borrowed" || entry.sourceKind !== "personFundedExpense" || entry.paymentId != null) return null;
  if (!entry.editHistory || entry.editHistory.some((e) => e.field === "note")) return null;
  if (!t || t.deletedAt != null || t.type !== "expense" || t.fundedByPersonId == null || t.fundedByPersonId !== entry.personId) return null;
  return t.description.trim() || null;
}

/**
 * A split / assigned share's stored "Split: …" note is a copy of its expense's description. A rename that did not
 * reach the copy leaves it stale, so statements read the linked transaction's description instead. Same ownership rule
 * as `transaction-description-sync.ts`: only a note still in the generated "Split: …" form follows; a note typed on the
 * People side, a payment snapshot, a cash leg and anything without a live expense transaction are left as stored.
 * An untouched person-funded note follows too (`personFundedNote`).
 * Returns the SAME array when nothing differs.
 */
export function withLinkedDescriptions<E extends ShareEntry>(entries: E[], transactionsById: ReadonlyMap<string, LinkedTransaction>): E[] {
  let changed = false;
  const out = entries.map((entry) => {
    const funded = personFundedNote(entry, entry.transactionRef ? transactionsById.get(entry.transactionRef) : undefined);
    if (funded != null && funded !== entry.note) {
      changed = true;
      return { ...entry, note: funded };
    }
    if (entry.type !== "gave" || entry.paymentId != null || !entry.note.startsWith(SHARE_PREFIX)) return entry;
    if (entry.sourceKind !== "splitExpense" && entry.sourceKind !== "assignedExpense") return entry;
    const t = entry.transactionRef ? transactionsById.get(entry.transactionRef) : undefined;
    if (!t || t.deletedAt != null || t.type !== "expense" || t.isPersonLedgerMovement) return entry;
    const description = t.description.trim();
    const note = `${SHARE_PREFIX}${description}`;
    if (!description || note === entry.note) return entry;
    changed = true;
    return { ...entry, note };
  });
  return changed ? out : entries;
}
