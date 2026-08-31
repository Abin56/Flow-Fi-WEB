/**
 * Direct port of
 * `lib/features/transactions/domain/history_entry.dart` and
 * `lib/shared/domain/transaction_kind.dart` — presentation-layer view
 * models only, never persisted. `HistoryEntry.id` doesn't necessarily
 * address a single Firestore document (a loan/bill/EMI/statement entry
 * synthesizes its own, prefixed per source — see `lib/engines/history-builder.ts`).
 */

// --- TransactionKind (transaction_kind.dart) ---

/** Unified classification for History/Person Statement/Search tiles. */
export type TransactionKind =
  | "myExpense"
  | "myIncome"
  | "transfer"
  | "splitExpense"
  | "people"
  | "bill"
  | "creditCard"
  | "loan"
  | "emi"
  | "savings"
  | "investment"
  | "adjustment"
  | "system";

// --- HistoryCategory (history_entry.dart) ---

/** Which History filter chip a `HistoryEntry` belongs to. */
export type HistoryCategory =
  | "transaction"
  | "splitExpense"
  | "loan"
  | "bill"
  | "emi"
  | "moneyReceived"
  | "statementGenerated"
  | "statementPaid";

export function historyCategoryLabel(category: HistoryCategory): string {
  switch (category) {
    case "transaction":
      return "Transactions";
    case "splitExpense":
      return "Shared expenses";
    case "loan":
      return "Loans";
    case "bill":
      return "Bills";
    case "emi":
      return "EMI";
    case "moneyReceived":
      return "Money received";
    case "statementGenerated":
      return "Statement generated";
    case "statementPaid":
      return "Statement paid";
  }
}

/**
 * A split expense's aggregate standing across every participant's tracking
 * installment — distinct from `InstallmentStatus` (which is per-participant)
 * since the History tile represents the whole expense as one row. `overdue`
 * takes priority over `partial`/`pending` whenever any unpaid installment's
 * own status is overdue — see `splitExpenseDetailFor` in `history-builder.ts`,
 * the one place this is computed.
 */
export type SplitExpenseHistoryStatus = "pending" | "partial" | "overdue" | "completed";

export function splitExpenseHistoryStatusLabel(status: SplitExpenseHistoryStatus): string {
  switch (status) {
    case "pending":
      return "Still to Pay";
    case "partial":
      return "Partly Paid";
    case "overdue":
      return "Overdue";
    case "completed":
      return "Paid";
  }
}

/** One participant's name and share, for the "You ₹400 · John ₹600" style breakdown on a splitExpense tile. */
export interface SplitShare {
  name: string;
  share: number;
  isMe: boolean;
}

/** Extra detail only a `splitExpense`-category entry carries. */
export interface SplitExpenseHistoryDetail {
  participantCount: number;
  /** Still owed back by other participants — "Need To Collect"/"Pending". */
  amountToCollect: number;
  status: SplitExpenseHistoryStatus;
  /** The payer's own share of this expense — see `myShare` in `lib/models/expense.ts`. */
  myShare: number;
  /** Sum already paid back by other participants. */
  collected: number;
  /** Every participant's name/share, "Me" first. */
  shares: SplitShare[];
}

/**
 * One line in the unified History feed — built by `buildHistory`
 * (`lib/engines/history-builder.ts`) from every feature that moves money.
 * Presentation-layer view model only: never persisted.
 */
export interface HistoryEntry {
  id: string;
  date: Date;
  title: string;
  subtitle: string;
  /** Always positive — direction comes from `isCredit`. */
  amount: number;
  /** Whether this entry added money (credit) or removed/committed it (debit). */
  isCredit: boolean;
  category: HistoryCategory;
  kind: TransactionKind;
  /** Where selecting this entry should navigate, if anywhere. */
  routePath: string | null;
  /** Only populated when `category` is "splitExpense". */
  splitExpenseDetail: SplitExpenseHistoryDetail | null;
  /**
   * Only ever true/set for an entry built from a plain `Transaction` — every
   * other source (loan/bill/EMI/statement) has no such flag, so these
   * default false/null for them.
   */
  excludeFromCalculations: boolean;
  accountingMonth: Date | null;
}
