"use client";

import Link from "next/link";
import { Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Person } from "@/lib/models/person";
import type { RecordAction } from "@/lib/models/document-import";
import { actionBadgeClassName, actionLabel } from "../../lib/action-metadata";

/**
 * The read-only replacement for `FlowOwnershipHeader` once a row is committed — shared by
 * `TransactionManageModal` and `RightSidebar` so the two edit surfaces say exactly the same thing
 * instead of drifting. There is no repository operation anywhere in the app that safely converts an
 * already-committed Transaction/Expense's fundamental type after the fact, so this is a display, not
 * a disabled-looking-but-secretly-broken form.
 */
export function CommittedClassificationNotice({ action }: { action: RecordAction | null }) {
  return (
    <div className="flex flex-col gap-2">
      <Badge variant="outline" className={cn("w-fit text-[11px]", actionBadgeClassName(action))}>
        {actionLabel(action)}
      </Badge>
      <p className="text-xs text-muted-foreground">
        Already imported — classification can&apos;t change after import. Delete and re-add it if it needs a different type.
      </p>
    </div>
  );
}

/**
 * The read-only replacement for `ActionDetailPanel`'s People & Split once a row is committed —
 * shared by `TransactionManageModal` and `RightSidebar`. Assigning/splitting a committed expense
 * already has a complete, ledger-safe implementation at `/transactions`
 * (`TransactionManagerSheet` → `applyOwesPersonChange`/`ExpenseRepository`); this links out to it
 * rather than forking a second, partial copy of that logic into Transaction Studio.
 */
export function CommittedPeopleNotice({ linkedPerson }: { linkedPerson: Person | null }) {
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-sm text-foreground">{linkedPerson ? `Assigned to ${linkedPerson.name}` : "Not assigned to anyone"}</p>
      <p className="text-xs text-muted-foreground">
        Assigning or splitting an imported transaction is managed from the Transactions page, where the person ledger stays consistent.
      </p>
      <Button variant="outline" size="sm" className="w-fit" asChild>
        <Link href="/transactions">
          <Users className="size-3.5" /> Manage in Transactions
        </Link>
      </Button>
    </div>
  );
}
