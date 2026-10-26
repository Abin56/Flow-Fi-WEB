/**
 * Phase 4 — the final approval: live revalidation, then the existing commit engine. This is the ONLY file in
 * Reconciliation that writes, and it writes through exactly one call: `commitReviewImport` (Transaction Studio's
 * engine, also used by Smart Capture's old direct import), after `getPreflightBlockers` and
 * `detectFreshDuplicatesForCommit`. There is no second transaction-writing path, and no financial repository is
 * touched here or changed.
 *
 * Order, and why:
 *  1. Re-read FlowFi's records from the SERVER (`readData`) — never the live hooks, never the cache. A failed read
 *     stops here; nothing has been written.
 *  2. Recompute the review exactly as the screen does (`analyzeSession`) against those fresh records, and compare the
 *     evidence of every included row with what the user reviewed. Anything that moved — a new possible match, a linked
 *     transaction that vanished, a row now imported, a card bill that closed, a card or account that changed —
 *     STOPS the approval and returns the user to the review. A "No match" shown earlier never authorizes a write.
 *  3. The engine's own pre-flight and a fresh duplicate check run on those same records.
 *  4. Only then `commitReviewImport`, whose deterministic per-row key (`importTransferKey(rowId, sessionId)`, the very
 *     key "Already imported" detection looks up) makes every write replay-safe: a row that already landed is found by
 *     key and never written again — after a refresh, a second click, a second tab or a retry.
 */

import { commitReviewImport, detectFreshDuplicatesForCommit, getPreflightBlockers, type CommitRepositories } from "@/features/transaction-studio/lib/commit-review-import";
import type { Account } from "@/lib/models/account";
import { isCreditCardActive } from "@/lib/models/credit-card";
import type { StagedRecord } from "@/lib/models/document-import";
import { analyzeSession, type ReconciliationData } from "./analyze";
import { buildApprovalPlan, changedEvidence, stagedRecordsForImport, type ApprovalPlan } from "./approval-plan";
import { decisionFor } from "./decisions";
import type { DraftState } from "./reconciliation-draft";
import { reconciliationSessionId } from "./session-key";

/** What the user was looking at when they opened the approval — the baseline every commit-time check is made against. */
export interface ApprovalSnapshot {
  accountId: string;
  accountType: Account["type"];
  sessionId: string;
  evidence: Record<string, string>;
  candidateIds: Record<string, string[]>;
  takenAt: number;
}

export function takeSnapshot(session: DraftState, plan: ApprovalPlan, account: Pick<Account, "type">, now = Date.now()): ApprovalSnapshot | null {
  if (!session.accountId) return null;
  return { accountId: session.accountId, accountType: account.type, sessionId: reconciliationSessionId(session.fingerprint, session.accountId), evidence: plan.evidence, candidateIds: plan.candidateIds, takenAt: now };
}

export type StaleCode =
  | "no_account"
  | "account_missing"
  | "account_changed"
  | "card_unavailable"
  | "records_changed"
  | "row_blocked"
  | "preflight"
  | "new_duplicate"
  | "repeat_unacknowledged"
  | "nothing_to_review";

export interface StaleReason {
  code: StaleCode;
  message: string;
  rowId?: string;
  rowNumber?: number;
}

const PENDING_ROW_PREFIX = "pending-row-";

/**
 * Duplicate re-check on fresh records, through the engine's own `detectFreshDuplicatesForCommit`. A warning is only
 * acceptable when the user has already seen what it points at:
 *  - another row of this same capture (a genuine repeat purchase) needs the user's explicit acknowledgement;
 *  - a same-account, same-direction transaction must be one the review showed (or one the user rejected);
 *  - a different account's, or the opposite direction's, same-amount transaction is the informational coincidence the
 *    matcher already notes — never a match.
 */
export function classifyDuplicateWarnings(staged: StagedRecord[], data: ReconciliationData, accountId: string, sessionId: string, snapshot: Pick<ApprovalSnapshot, "candidateIds">, session: DraftState, rowNumber: (rowId: string) => number) {
  const warnings = detectFreshDuplicatesForCommit(staged, data.transactions, accountId, sessionId);
  const byId = new Map(data.transactions.map((t) => [t.id, t]));
  const unseen: StaleReason[] = [];
  const repeatRowIds = new Set<string>();
  for (const warning of warnings) {
    const row = staged.find((s) => s.id === warning.recordId);
    const seen = new Set([...(snapshot.candidateIds[warning.recordId] ?? []), ...decisionFor(session.decisions, warning.recordId).rejectedRecordIds]);
    for (const match of warning.result.matches) {
      if (match.transactionId.startsWith(PENDING_ROW_PREFIX)) {
        repeatRowIds.add(warning.recordId);
        repeatRowIds.add(match.transactionId.slice(PENDING_ROW_PREFIX.length));
        continue;
      }
      const existing = byId.get(match.transactionId);
      if (!existing || existing.deletedAt != null) continue;
      const sameDirection = (existing.type === "income") === (row?.direction === "credit");
      if (existing.accountId !== accountId || !sameDirection) continue;
      if (!seen.has(existing.id)) {
        unseen.push({ code: "new_duplicate", rowId: warning.recordId, rowNumber: rowNumber(warning.recordId), message: "A transaction that looks like this row has appeared since you reviewed it." });
      }
    }
  }
  return { unseen, repeatRowIds: [...repeatRowIds] };
}

export type Revalidation = { ok: true; plan: ApprovalPlan; staged: StagedRecord[]; repeatRowIds: string[] } | { ok: false; reasons: StaleReason[] };

/** Steps 2–3 above, pure over already-read records. Anything but `ok` means: write nothing, send the user back. */
export function revalidateApproval(params: { session: DraftState; fresh: ReconciliationData; reviewed: ApprovalSnapshot; repeatsAcknowledged: boolean; now?: Date }): Revalidation {
  const { session, fresh, reviewed, repeatsAcknowledged } = params;
  const reasons: StaleReason[] = [];
  const accountId = session.accountId;
  if (!accountId) return { ok: false, reasons: [{ code: "no_account", message: "No statement account is chosen." }] };
  const rowNumber = (rowId: string) => session.rows.findIndex((r) => r.id === rowId) + 1;

  if (accountId !== reviewed.accountId) return { ok: false, reasons: [{ code: "account_changed", message: "The statement account changed since you opened the approval." }] };
  const analysis = analyzeSession(session, fresh, { now: params.now });
  if (!analysis.account) return { ok: false, reasons: [{ code: "account_missing", message: "The statement account no longer exists in FlowFi." }] };
  if (analysis.account.type !== reviewed.accountType) return { ok: false, reasons: [{ code: "account_changed", message: "The statement account's type changed since you opened the approval." }] };

  const plan = buildApprovalPlan({ rows: session.rows, matches: analysis.matches, decisions: session.decisions, gate: analysis.gate });

  if (plan.counts.captured - plan.counts.excluded === 0) reasons.push({ code: "nothing_to_review", message: "No rows are included in this review." });
  const blocked = new Set<string>();
  for (const row of plan.rows) {
    if (row.status !== "blocked") continue;
    blocked.add(row.rowId);
    reasons.push({ code: "row_blocked", rowId: row.rowId, rowNumber: row.number, message: row.reasons[0] ?? "This row no longer has a valid decision." });
  }
  for (const rowId of changedEvidence(reviewed.evidence, plan.evidence)) {
    if (blocked.has(rowId)) continue;
    reasons.push({ code: "records_changed", rowId, rowNumber: rowNumber(rowId), message: "FlowFi's records for this row changed since you reviewed it." });
  }

  const importRowIds = new Set(plan.rows.filter((r) => r.status === "import").map((r) => r.rowId));
  if (importRowIds.size > 0 && analysis.account.type === "card") {
    if (!analysis.card) reasons.push({ code: "card_unavailable", message: "This card's profile can't be found, so its bill status can't be checked. Nothing was imported." });
    else if (!isCreditCardActive(analysis.card.status)) reasons.push({ code: "card_unavailable", message: `This card is ${analysis.card.status} — new transactions can't be imported onto it.` });
  }

  const staged = stagedRecordsForImport(session.rows, session.decisions, importRowIds);
  for (const blocker of getPreflightBlockers(staged, fresh.categories)) {
    reasons.push({ code: "preflight", rowId: blocker.recordId, rowNumber: rowNumber(blocker.recordId), message: blocker.blockingReasons[0]?.message ?? "This row can't be imported." });
  }

  const duplicates = classifyDuplicateWarnings(staged, fresh, accountId, reviewed.sessionId, reviewed, session, rowNumber);
  reasons.push(...duplicates.unseen);
  if (duplicates.repeatRowIds.length > 0 && !repeatsAcknowledged) {
    reasons.push({ code: "repeat_unacknowledged", message: `${duplicates.repeatRowIds.length} rows look like repeats of each other — confirm they are separate transactions before importing.` });
  }

  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, plan, staged, repeatRowIds: duplicates.repeatRowIds };
}

export type RowOutcomeKind = "imported" | "already_imported" | "linked" | "ignored" | "inbox" | "failed";

export interface RowOutcome {
  rowId: string;
  number: number;
  kind: RowOutcomeKind;
  transactionId?: string;
  error?: string;
}

export type ApprovalRunResult =
  /** The server couldn't be reached / read. Nothing was written. */
  | { status: "unavailable"; message: string }
  /** The review is out of date or ambiguous. Nothing was written. */
  | { status: "stale"; reasons: StaleReason[] }
  /** Another approval of this same review is already running in this tab. Nothing was written by this call. */
  | { status: "busy" }
  /** Every included row is resolved (imported / already imported / linked / ignored / left in Inbox). */
  | { status: "complete"; outcomes: RowOutcome[] }
  /** At least one row failed — retry is safe: rows that landed are found by their key and never written again. */
  | { status: "partial"; outcomes: RowOutcome[] };

export interface ApprovalDeps {
  readData: () => Promise<ReconciliationData>;
  repositories: CommitRepositories;
  now?: () => Date;
  /** Passed straight to the engine; tests use 0. */
  linkRetryDelayMs?: number;
}

function unsupported<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get(_target, property) {
      throw new Error(`Reconciliation never uses the ${name} (${String(property)}) — only expense, income and refund rows can be imported here.`);
    },
  });
}

/**
 * The repositories the commit engine is given. Only the transaction repository is real: expense, EMI, loan and
 * installment repositories belong to split / person / EMI / loan actions, which Reconciliation cannot import — so they
 * are tripwires that throw if anything ever reaches for them.
 */
export function commitRepositoriesFor(transactionRepository: CommitRepositories["transactionRepository"]): CommitRepositories {
  return {
    transactionRepository,
    expenseRepository: unsupported("expense repository"),
    emiRepository: unsupported("EMI repository"),
    loanRepository: unsupported("loan repository"),
    installmentRepositoryFor: () => {
      throw new Error("Reconciliation never uses an installment repository — only expense, income and refund rows can be imported here.");
    },
  };
}

/** One approval per review at a time within this tab — a double click or a repeated approval can never overlap. */
const inFlight = new Set<string>();

export async function runApproval(input: { session: DraftState; reviewed: ApprovalSnapshot; repeatsAcknowledged: boolean; deps: ApprovalDeps; onStage?: (stage: "checking" | "importing") => void }): Promise<ApprovalRunResult> {
  const { session, reviewed, deps } = input;
  if (inFlight.has(reviewed.sessionId)) return { status: "busy" };
  inFlight.add(reviewed.sessionId);
  try {
    input.onStage?.("checking");
    let fresh: ReconciliationData;
    try {
      fresh = await deps.readData();
    } catch (error) {
      return { status: "unavailable", message: error instanceof Error ? error.message : "FlowFi's records couldn't be re-read." };
    }

    const check = revalidateApproval({ session, fresh, reviewed, repeatsAcknowledged: input.repeatsAcknowledged, now: deps.now?.() });
    if (!check.ok) return { status: "stale", reasons: check.reasons };
    const { plan, staged } = check;

    const committed = new Map<string, string>();
    const failed = new Map<string, string>();
    if (staged.length > 0) {
      input.onStage?.("importing");
      try {
        const commit = await commitReviewImport({
          documentId: reviewed.sessionId,
          rows: staged,
          accountId: reviewed.accountId,
          categories: fresh.categories,
          // Only single-write actions (expense / income / refund) can be staged, so none of these are ever consulted.
          people: [],
          accounts: fresh.accounts,
          emis: [],
          loans: [],
          bills: [],
          repositories: deps.repositories,
          onRowCommitted: async (recordId, transactionId) => {
            committed.set(recordId, transactionId);
          },
          linkRetryDelayMs: deps.linkRetryDelayMs ?? 0,
        });
        for (const r of commit.results) {
          if (r.outcome === "committed" && r.transactionId) committed.set(r.recordId, r.transactionId);
          else if (r.outcome === "failed") failed.set(r.recordId, r.error ?? "The import failed.");
          else if (r.outcome === "blocked") failed.set(r.recordId, r.blockingReasons?.[0]?.message ?? "The import was blocked.");
        }
      } catch (error) {
        // The engine reports per-row failures itself; reaching here means it stopped part-way. Rows already written are
        // in `committed`; the rest are retryable (a retry finds written rows by key, so nothing is written twice).
        const message = error instanceof Error ? error.message : "The import stopped unexpectedly.";
        for (const s of staged) if (!committed.has(s.id)) failed.set(s.id, `${message} Check Transactions, then retry — nothing is written twice.`);
      }
    }

    const outcomes: RowOutcome[] = [];
    for (const row of plan.rows) {
      if (row.status === "excluded") continue;
      const base = { rowId: row.rowId, number: row.number };
      switch (row.status) {
        case "import": {
          const transactionId = committed.get(row.rowId);
          if (transactionId) outcomes.push({ ...base, kind: "imported", transactionId });
          else outcomes.push({ ...base, kind: "failed", error: failed.get(row.rowId) ?? "This row wasn't imported." });
          break;
        }
        case "already_imported":
          outcomes.push({ ...base, kind: "already_imported", transactionId: row.recordId ?? undefined });
          break;
        case "link":
          outcomes.push({ ...base, kind: "linked", transactionId: row.recordId ?? undefined });
          break;
        case "ignore":
          outcomes.push({ ...base, kind: "ignored" });
          break;
        case "inbox":
          outcomes.push({ ...base, kind: "inbox" });
          break;
        default:
          outcomes.push({ ...base, kind: "failed", error: "This row has no valid decision." });
      }
    }
    return outcomes.some((o) => o.kind === "failed") ? { status: "partial", outcomes } : { status: "complete", outcomes };
  } finally {
    inFlight.delete(reviewed.sessionId);
  }
}
