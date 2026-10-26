/**
 * Phase 2 intake: pasted statement text → reconciliation rows, using Smart Capture's own parser and review-row
 * builder unchanged (same issues, same gates). The Smart Capture → Reconciliation handoff is a later phase; until
 * then this is how rows reach the workspace. The text itself is never stored (see reconciliation-draft.ts).
 */

import { sourceFingerprint } from "@/features/smart-capture/lib/capture-draft";
import { toReviewRows } from "@/features/smart-capture/lib/capture-review";
import { flagRepeatedRows } from "@/features/smart-capture/lib/ocr-review";
import { parsePastedStatement } from "@/features/smart-capture/lib/parse-pasted-statement";
import type { ReconRow } from "./types";

export interface IntakeResult {
  rows: ReconRow[];
  fingerprint: string;
  ignoredLines: number;
}

export function rowsFromPastedText(text: string): IntakeResult {
  const parsed = parsePastedStatement(text);
  const rows = toReviewRows(flagRepeatedRows(parsed.rows), "text").map((r) => ({ ...r, needsReconfirm: false }));
  return { rows, fingerprint: sourceFingerprint(text), ignoredLines: parsed.ignored.length };
}
