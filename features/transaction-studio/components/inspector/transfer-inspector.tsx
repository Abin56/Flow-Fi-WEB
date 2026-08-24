"use client";

import { ArrowRight } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { formatCurrencyPrecise } from "@/lib/format";
import type { Account } from "@/lib/models/account";
import type { GridRow } from "../../lib/grid-types";
import { InspectorShell } from "./inspector-shell";

/**
 * Action = Transfer (architecture §5/§7). Matches the real transfer model
 * exactly: `TransactionRepository.createTransferPair` takes one amount plus
 * a source and destination account and creates both legs itself — there's
 * no cross-row pairing to design, just "which account did this money go
 * to."
 */
export function TransferInspector({
  row,
  accounts,
  sourceAccountName,
  onCommit,
  onClose,
  hideClose,
  embedded,
}: {
  row: GridRow;
  accounts: Account[];
  sourceAccountName: string;
  onCommit: (destinationAccountId: string) => void;
  onClose: () => void;
  hideClose?: boolean;
  embedded?: boolean;
}) {
  const detail = row.actionDetail?.kind === "transfer" ? row.actionDetail : null;

  return (
    <InspectorShell
      title="Transfer"
      subtitle={formatCurrencyPrecise(row.amount)}
      onClose={onClose}
      hideClose={hideClose}
      embedded={embedded}
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2.5 text-sm">
          <span className="truncate font-medium">{sourceAccountName}</span>
          <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-muted-foreground">{accounts.find((a) => a.id === detail?.destinationAccountId)?.name ?? "Choose account"}</span>
        </div>

        <div>
          <Label className="mb-1.5 block text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Destination account</Label>
          <Select value={detail?.destinationAccountId ?? undefined} onValueChange={onCommit}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Choose the account this went to" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </InspectorShell>
  );
}
