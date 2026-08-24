/**
 * Mirrors the `FinancialDocumentStatus` union in
 * lib/models/financial-document.ts (the web package) — see
 * docs/state-machine.md, the authoritative reference for every legal
 * transition between these values. Duplicated rather than shared because
 * this repo has two independent npm packages (flowfi-web and functions/)
 * with no workspace/shared-types setup yet; noted explicitly here rather
 * than silently diverging; if the two ever drift, docs/state-machine.md
 * is the tiebreaker.
 */
export type FinancialDocumentStatus =
  | "uploaded"
  | "decrypting"
  | "parsing"
  | "awaiting_password"
  | "parsed"
  | "needs_review"
  | "imported"
  | "failed";

/** docs/state-machine.md §3 — sub-classification of status:"failed". */
export type FailureReason = "parsing_failed" | "password_required" | "unsupported_document" | "cancelled";
