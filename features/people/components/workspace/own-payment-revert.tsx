"use client";

import { Pencil, Undo2 } from "lucide-react";
import type { LedgerRow, PaymentRecord } from "@/features/people/lib/person-ledger-rows";
import { money } from "@/lib/engines/person-cycle-statement-share";

/**
 * Revert on a STANDALONE payment row (a general payment — "reduces the overall balance", tied to no item). Before this a
 * general receipt said "revert that payment first" in its details but offered no control to do it. It reuses the exact
 * handler and confirmation every other People payment uses (`onUndoPayment` → the whole Record Payment is reverted: cash,
 * every allocation, any advance), so no new money path exists.
 */
export function OwnPaymentRevert({ row, onUndo, onEdit }: { row: LedgerRow; onUndo?: (p: PaymentRecord) => void; onEdit?: (p: PaymentRecord) => (() => void) | null }) {
  const p = row.ownPayment;
  if (!p || !onUndo) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]" data-testid="own-payment-revert">
      <span className="text-foreground/75">
        Recorded payment of <span className="font-semibold text-foreground tabular-nums">{money(p.amount)}</span>
      </span>
      {(() => {
        const edit = onEdit?.(p);
        return edit ? (
          <button
            type="button"
            onClick={edit}
            title="Edit this payment"
            className="flex h-6 items-center gap-1 rounded-[5px] px-1.5 font-semibold text-foreground/70 outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Pencil className="size-3.5" strokeWidth={1.75} aria-hidden />
            Edit
          </button>
        ) : null;
      })()}
      {p.undo ? (
        <button
          type="button"
          onClick={() => onUndo(p)}
          title="Revert this payment"
          className="flex h-6 items-center gap-1 rounded-[5px] px-1.5 font-semibold text-foreground/70 outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Undo2 className="size-3.5" strokeWidth={1.75} aria-hidden />
          Revert
        </button>
      ) : (
        <span className="text-foreground/60">{p.undoBlock ?? "Can't be reversed here"}</span>
      )}
    </div>
  );
}
