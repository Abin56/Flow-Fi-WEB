/**
 * Honest UI labels for every real `FinancialDocumentStatus` /
 * `FailureReason` value defined in `lib/models/financial-document.ts` and
 * authoritatively described in `docs/state-machine.md`. Every value in
 * both real unions is mapped — nothing invented, nothing added.
 */

import type { ClayBadgeProps } from "@/components/clay/clay-badge";
import type { FailureReason, FinancialDocumentStatus } from "@/lib/models/financial-document";

export const STATUS_LABEL: Record<FinancialDocumentStatus, string> = {
  uploaded: "Uploaded",
  decrypting: "Unlocking",
  parsing: "Processing",
  awaiting_password: "Password Required",
  parsed: "Parsed",
  needs_review: "Needs Review",
  imported: "Imported",
  failed: "Failed",
};

/** docs/state-machine.md §1 — non-terminal statuses are still actively moving through the pipeline. */
export const STATUS_TONE: Record<FinancialDocumentStatus, NonNullable<ClayBadgeProps["tone"]>> = {
  uploaded: "neutral",
  decrypting: "warning",
  parsing: "primary",
  awaiting_password: "warning",
  parsed: "success",
  needs_review: "warning",
  imported: "success",
  failed: "expense",
};

/** docs/state-machine.md §3 — every real `failureReason` value, nothing invented. */
export const FAILURE_REASON_LABEL: Record<FailureReason, string> = {
  parsing_failed: "The file couldn't be processed (it may be corrupted).",
  password_required: "This statement is password-protected.",
  unsupported_document: "This document type isn't supported yet.",
  cancelled: "Upload was cancelled.",
};
