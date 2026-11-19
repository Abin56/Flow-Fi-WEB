/**
 * CSV export of one Reports period — every number is copied from the already-computed `PeriodDetail` (no arithmetic
 * beyond what the engine produced), so the file always matches the screen. Plain CSV: any spreadsheet opens it.
 */

import type { PeriodDetail } from "@/lib/engines/period-report";

function esc(v: string | number): string {
  const s = typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : v;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function periodReportCsv(params: {
  detail: PeriodDetail;
  accountName: (id: string) => string;
  categoryName: (id: string) => string;
}): string {
  const { detail: d, accountName, categoryName } = params;
  const lines: (string | number)[][] = [];
  lines.push(["FlowFi report", d.period.label]);
  lines.push(["From", iso(d.period.start), "To", iso(d.period.end)]);
  lines.push([]);
  lines.push(["Summary", "Amount", "Basis"]);
  lines.push(["Income", d.income, "Month Cycle"]);
  lines.push(["Total outflow", d.outflow, "Month Cycle"]);
  for (const [k, v] of Object.entries(d.outflowBreakdown)) lines.push([`  ${k}`, v, "Month Cycle"]);
  lines.push(["Net (income − outflow)", d.net, "Month Cycle"]);
  lines.push(["My spend", d.mySpend, "My share only"]);
  lines.push(["Others' share I paid", d.othersShare, "My share only"]);
  lines.push(["Cash money in", d.cash.moneyIn, "Cash basis"]);
  lines.push(["Cash money out", d.cash.moneyOut, "Cash basis"]);
  lines.push(["Card bill payments", d.debt.cardBillPayments, "Cash basis"]);
  lines.push(["EMI installments paid", d.debt.emiPaid, "Payments"]);
  lines.push(["Loan repayments made", d.debt.loanRepaid, "Payments"]);
  lines.push(["Loan repayments collected", d.debt.loanCollected, "Payments"]);
  lines.push(["Received from people", d.people.receivedFromPeople, "People"]);
  lines.push(["Paid to people", d.people.paidToPeople, "People"]);
  lines.push([]);
  lines.push(["Category", "My spend", "Transactions"]);
  for (const [id, v] of [...d.spendByCategory].sort((a, b) => b[1].amount - a[1].amount)) lines.push([categoryName(id), v.amount, v.count]);
  lines.push([]);
  lines.push(["Account", "Opening", "Money in", "Money out", "Closing", "Transfers in", "Transfers out"]);
  for (const a of d.accounts) lines.push([accountName(a.accountId), a.opening, a.moneyIn, a.moneyOut, a.closing, a.transfersIn, a.transfersOut]);
  lines.push([]);
  lines.push(["Date", "Description", "Category", "Account", "Amount paid", "My share"]);
  for (const r of d.spendRows) {
    lines.push([iso(r.transaction.dateTime), r.transaction.description || categoryName(r.transaction.categoryId), categoryName(r.transaction.categoryId), accountName(r.transaction.accountId), r.grossAmount, r.myAmount]);
  }
  return lines.map((row) => row.map(esc).join(",")).join("\n");
}
