/** Client wrapper for `deleteStatementDocumentCallable` (functions/src/index.ts) — permanently removes the PDF from Storage, its staged rows and the document record. */

import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase/client";

export type DeleteStatementDocumentResponse = {
  outcome: "deleted" | "not_found" | "has_imported_transactions" | "still_processing";
};

export async function deleteStatementDocument(documentId: string): Promise<DeleteStatementDocumentResponse> {
  const callable = httpsCallable<{ documentId: string }, DeleteStatementDocumentResponse>(
    functions,
    "deleteStatementDocumentCallable",
  );
  return (await callable({ documentId })).data;
}
