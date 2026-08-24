/**
 * Write layer for `users/{uid}/documentImports/{importId}/records` — the
 * Transaction Studio review grid's editable rows (architecture §4a). Not a
 * `FirestoreCrudRepository` subclass: `StagedRecord` isn't a
 * `SoftDeletableEntity` (no `deletedAt`/`editHistory` — it tracks edits via
 * its own simpler `userEdited`/`lastEditedAt`/`lastEditedBy` fields, and
 * "Delete Row" is a real hard delete of the staged record, never a
 * committed one — see the model's own module doc).
 *
 * Every write is a partial `updateDoc` (via `stagedRecordPatchToFirestore`),
 * not a full-document `setDoc` overwrite — a spreadsheet cell edit must not
 * clobber fields another edit (or the parser, or another tab) touched
 * concurrently.
 */

import { type CollectionReference, deleteDoc, doc, setDoc, updateDoc, writeBatch } from "firebase/firestore";
import { stagedRecordPatchToFirestore, type StagedRecord } from "@/lib/models/document-import";
import { generateId } from "@/lib/utils/id-generator";

/** Firestore's write-batch limit is 500 operations; chunk any bulk op above that. */
const BATCH_CHUNK_SIZE = 450;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export class DocumentImportRecordRepository {
  constructor(private readonly collection: CollectionReference<StagedRecord>) {}

  /**
   * Applies one row's edit — stamps `userEdited`/`lastEditedAt`/`lastEditedBy`
   * alongside whatever fields the caller changed, so every edit (including
   * an undo/redo replay) is a real, attributed write.
   */
  async updateFields(recordId: string, patch: Partial<Omit<StagedRecord, "id">>, editedBy: string): Promise<void> {
    const data = stagedRecordPatchToFirestore({ ...patch, userEdited: true, lastEditedAt: new Date(), lastEditedBy: editedBy });
    await updateDoc(doc(this.collection, recordId), data);
  }

  /** Same field patch applied to many rows at once (bulk category/owner/action/include changes) — chunked into Firestore's 500-op batch limit. */
  async bulkUpdateFields(recordIds: string[], patch: Partial<Omit<StagedRecord, "id">>, editedBy: string): Promise<void> {
    const data = stagedRecordPatchToFirestore({ ...patch, userEdited: true, lastEditedAt: new Date(), lastEditedBy: editedBy });
    for (const group of chunk(recordIds, BATCH_CHUNK_SIZE)) {
      const batch = writeBatch(this.collection.firestore);
      for (const recordId of group) batch.update(doc(this.collection, recordId), data);
      await batch.commit();
    }
  }

  /** Deletes only the staged review record — never touches a committed transaction/expense/etc. */
  async deleteRecord(recordId: string): Promise<void> {
    await deleteDoc(doc(this.collection, recordId));
  }

  async bulkDeleteRecords(recordIds: string[]): Promise<void> {
    for (const group of chunk(recordIds, BATCH_CHUNK_SIZE)) {
      const batch = writeBatch(this.collection.firestore);
      for (const recordId of group) batch.delete(doc(this.collection, recordId));
      await batch.commit();
    }
  }

  /**
   * Row menu / bulk bar "Duplicate" — a new staged record with a fresh id,
   * copying every field except provenance (`sourcePage`/`sourceLineIndex`/
   * `splitParentId`/`mergedInto`/`duplicateOfTransactionId`/
   * `committedTransactionId` reset, since a duplicate is a new user-created
   * row, not a second copy of the same statement line). Never touches the
   * original.
   */
  async duplicateRecord(record: StagedRecord, editedBy: string): Promise<StagedRecord> {
    const duplicate: StagedRecord = {
      ...record,
      id: generateId(),
      splitParentId: null,
      mergedInto: null,
      duplicateOfTransactionId: null,
      duplicateCandidateOf: null,
      committedTransactionId: null,
      userEdited: true,
      lastEditedAt: new Date(),
      lastEditedBy: editedBy,
    };
    await setDoc(doc(this.collection, duplicate.id), duplicate);
    return duplicate;
  }
}
