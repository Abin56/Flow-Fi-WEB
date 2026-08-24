import type { GridRow } from "./grid-types";

export interface StudioSummary {
  totalRows: number;
  includedRows: number;
  ignoredRows: number;
  expensesTotal: number;
  incomeTotal: number;
  transfersTotal: number;
  emiTotal: number;
  loanPaymentTotal: number;
  sharedAmount: number;
  myAmount: number;
  someoneElseAmount: number;
  netBalance: number;
  pendingReviewRows: number;
}

/**
 * Live footer totals (architecture §2's footer, §7's locked "myShare
 * everywhere" decision). Only `include: true` rows count toward any total —
 * ignored rows are excluded from validation and statistics the same way
 * they're excluded from commit (architecture §5's Ignore row, "excluded
 * from totals").
 *
 * Split rows use `myShare` (the row's "Me" participant's own share), not
 * the full transaction amount, for `myAmount`/`expensesTotal` — a
 * deliberate fix over the Flutter app's own category-breakdown
 * inconsistency (documented in the mobile research), applied consistently
 * everywhere in this workspace rather than just in the headline figure.
 */
export function computeStudioSummary(rows: GridRow[]): StudioSummary {
  const summary: StudioSummary = {
    totalRows: rows.length,
    includedRows: 0,
    ignoredRows: 0,
    expensesTotal: 0,
    incomeTotal: 0,
    transfersTotal: 0,
    emiTotal: 0,
    loanPaymentTotal: 0,
    sharedAmount: 0,
    myAmount: 0,
    someoneElseAmount: 0,
    netBalance: 0,
    pendingReviewRows: 0,
  };

  for (const row of rows) {
    if (!row.include || row.flowType === "ignore") {
      summary.ignoredRows += 1;
      continue;
    }
    summary.includedRows += 1;
    if (row.flowType == null || row.needsReview) summary.pendingReviewRows += 1;

    if (row.flowType === "transfer") {
      summary.transfersTotal += row.amount;
      continue;
    }
    if (row.flowType === "debt_movement") {
      if (row.actionDetail?.kind === "existing_loan" || row.actionDetail?.kind === "create_loan") {
        summary.loanPaymentTotal += row.amount;
      } else {
        summary.emiTotal += row.amount;
      }
      summary.myAmount += row.amount;
      continue;
    }

    if (row.direction === "credit") {
      summary.incomeTotal += row.amount;
      summary.netBalance += row.amount;
      continue;
    }

    // Every remaining direction === "debit" row is some flavor of expense.
    summary.netBalance -= row.amount;

    if (row.ownership === "shared" && row.actionDetail?.kind === "shared_expense") {
      const me = row.actionDetail.participants.find((p) => p.isMe);
      const myShare = me?.share ?? 0;
      const othersShare = row.amount - myShare;
      summary.sharedAmount += row.amount;
      summary.myAmount += myShare;
      summary.someoneElseAmount += othersShare;
      summary.expensesTotal += myShare;
    } else if (row.ownership === "someone_else") {
      summary.someoneElseAmount += row.amount;
      // Not mine at all — doesn't add to expensesTotal/myAmount.
    } else {
      summary.expensesTotal += row.amount;
      summary.myAmount += row.amount;
    }
  }

  return summary;
}
