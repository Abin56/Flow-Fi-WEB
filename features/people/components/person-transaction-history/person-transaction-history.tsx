"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ClayAvatar } from "@/components/clay/clay-avatar";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { PersonActivityItem, PersonViewRow } from "@/features/people/hooks/use-people-data";
import { PersonTransactionSummary } from "./person-transaction-summary";
import { PersonTransactionList } from "./person-transaction-list";

interface PersonTransactionHistoryProps {
  person: PersonViewRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isLoading?: boolean;
  error?: string | null;
  onSettleEntry?: (item: PersonActivityItem) => void;
}

/**
 * Replaces `PersonOverviewPanel`'s cramped `Timeline` tab (a permanently-docked `w-80` `<aside>`)
 * with a focused, adaptive transaction-history surface: a centered dialog on desktop/tablet, a
 * near-full-height bottom sheet on mobile. Same `PersonViewRow` data (`activity`, `youAreOwed`,
 * `youOwe`, `transactionsCount`) the old tab read — no new queries, no changed calculations.
 *
 * The rest of `PersonOverviewPanel` (contact info, notes, attachments, EMI, actions) is untouched;
 * only the transaction-history piece moves out into this dedicated surface.
 */
export function PersonTransactionHistory({ person, open, onOpenChange, isLoading, error, onSettleEntry }: PersonTransactionHistoryProps) {
  const isDesktop = useMediaQuery("(min-width: 768px)");

  if (!person) return null;

  const title = "Transaction History";
  const header = (
    <div className="flex items-center gap-3">
      <ClayAvatar name={person.name} size={40} />
      <div className="min-w-0">
        <p className="truncate text-sm text-muted-foreground">{title}</p>
        <p className="truncate text-base font-semibold text-foreground">{person.name}</p>
      </div>
    </div>
  );

  const body = (
    <>
      <PersonTransactionSummary transactionsCount={person.transactionsCount} youAreOwed={person.youAreOwed} youOwe={person.youOwe} />
      <PersonTransactionList activity={person.activity} isLoading={isLoading} error={error} onSettleEntry={onSettleEntry} />
    </>
  );

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[85vh] w-full flex-col gap-4 sm:max-w-[760px]">
          <DialogHeader>
            <DialogTitle asChild>
              <div>{header}</div>
            </DialogTitle>
            <DialogDescription className="sr-only">Transaction history for {person.name}</DialogDescription>
          </DialogHeader>
          {body}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="flex max-h-[92vh] flex-col gap-3 rounded-t-2xl border-border px-4 pb-4">
        <SheetHeader className="px-0 pb-0">
          <SheetTitle asChild>
            <div>{header}</div>
          </SheetTitle>
          <SheetDescription className="sr-only">Transaction history for {person.name}</SheetDescription>
        </SheetHeader>
        {body}
      </SheetContent>
    </Sheet>
  );
}
