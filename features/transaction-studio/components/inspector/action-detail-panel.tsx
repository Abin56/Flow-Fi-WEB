"use client";

import type { ReactNode } from "react";
import type { Account } from "@/lib/models/account";
import type { Bill } from "@/lib/models/bill";
import type { Emi } from "@/lib/models/emi";
import type { Loan } from "@/lib/models/loan";
import type { Person } from "@/lib/models/person";
import type { RecordAction, RecordActionDetail } from "@/lib/models/document-import";
import { deriveRecordAction } from "../../lib/action-metadata";
import type { GridRow } from "../../lib/grid-types";
import { EmiLoanInspector, type EmiLoanTargetType } from "./emi-loan-inspector";
import { SharedExpenseInspector } from "./shared-expense-inspector";
import { SomeoneElsesExpenseInspector } from "./someone-elses-expense-inspector";
import { TransferInspector } from "./transfer-inspector";

/**
 * The Action-specific editor a row's current Action implies (architecture §5) — Shared Expense's
 * split, Someone Else's Expense's person picker, Transfer's destination account, EMI/Loan/Bill
 * linking. Extracted out of `RightSidebar` so both the docked Inspector and `TransactionManageModal`
 * render the exact same components/commit path instead of two implementations that could drift.
 * Renders `fallback` for every Action that has no dedicated editor (plain expense/income/refund/…) —
 * callers decide what that looks like (`RightSidebar` shows `RowDetailsPanel`; the modal shows its
 * own compact "no additional people involved" note since its Details section already covers
 * category/notes/amount).
 */
export function ActionDetailPanel({
  row,
  accounts,
  sourceAccountName,
  people,
  emis,
  loans,
  bills,
  onCommitActionDetail,
  onClose,
  hideClose = false,
  embedded = false,
  fallback,
}: {
  row: GridRow;
  accounts: Account[];
  sourceAccountName: string;
  people: Person[];
  emis: Emi[];
  loans: Loan[];
  bills: Bill[];
  onCommitActionDetail: (patch: { action?: RecordAction; actionDetail: RecordActionDetail | null }) => void;
  onClose: () => void;
  hideClose?: boolean;
  /** Passed straight through to `InspectorShell` — set by `TransactionManageModal`, whose People & Split section already provides its own bordered card. */
  embedded?: boolean;
  fallback: ReactNode;
}) {
  switch (deriveRecordAction(row)) {
    case "shared_expense":
      return (
        <SharedExpenseInspector
          row={row}
          people={people}
          onCommit={(participants, splitType) => onCommitActionDetail({ actionDetail: { kind: "shared_expense", participants, splitType } })}
          onClose={onClose}
          hideClose={hideClose}
          embedded={embedded}
        />
      );
    case "someone_elses_expense":
      return (
        <SomeoneElsesExpenseInspector
          row={row}
          people={people}
          onCommit={(personId, personName) => onCommitActionDetail({ actionDetail: { kind: "someone_elses_expense", personId, personName } })}
          onClose={onClose}
          hideClose={hideClose}
          embedded={embedded}
        />
      );
    case "transfer":
      return (
        <TransferInspector
          row={row}
          accounts={accounts}
          sourceAccountName={sourceAccountName}
          onCommit={(destinationAccountId) => onCommitActionDetail({ actionDetail: { kind: "transfer", destinationAccountId } })}
          onClose={onClose}
          hideClose={hideClose}
          embedded={embedded}
        />
      );
    case "existing_emi":
    case "create_emi":
    case "existing_loan":
    case "create_loan":
    case "recurring_bill":
      return (
        <EmiLoanInspector
          row={row}
          emis={emis}
          loans={loans}
          bills={bills}
          people={people}
          onCommit={(action: EmiLoanTargetType, detail) => onCommitActionDetail({ action, actionDetail: detail })}
          onClose={onClose}
          hideClose={hideClose}
          embedded={embedded}
        />
      );
    default:
      return fallback;
  }
}
