"use client";

import { ArrowUpRight, Building2, CheckCircle2, CreditCard, Lock, Trash2, UserRound, Wallet } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ClayBadge } from "@/components/clay/clay-badge";
import { ClayButton } from "@/components/clay/clay-button";
import {
  ConfirmDialog,
  CurrencyCell,
  DetailDrawer,
} from "@/components/finance";
import { EMI_TYPE_LABEL, emiBadges, emiCardLabel } from "@/features/emi/components/emi-card";
import { useEmiActions, useEmiRows, type EmiRow } from "@/features/emi/hooks/use-emi-data";
import {
  DetailHero,
  DetailSectionTitle,
  FactGrid,
  LinkedList,
  LinkedRow,
  Money,
  daysUntil,
  dueLabel,
} from "@/features/loans/components/loan-emi-ui";
import { recordKindForEmi } from "@/features/loans/lib/loan-emi-add";
import { RecordPaymentDialog } from "@/features/loans/components/record-payment-dialog";
import { installmentStatus, remainingAmount } from "@/lib/models/payment-schedule";
import { toast } from "@/store/toast-store";
import { cn } from "@/lib/utils";

const INSTALLMENT_STATUS_BADGE = {
  paid: { label: "Paid", tone: "success" },
  partiallyPaid: { label: "Partial", tone: "warning" },
  overdue: { label: "Overdue", tone: "expense" },
  skipped: { label: "Skipped", tone: "neutral" },
  upcoming: null,
} as const;

function GoTo({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowUpRight className="size-4" />
    </Link>
  );
}

export interface EmiWorkspaceProps {
  /** Opens this EMI's detail view — sent by the unified Loan & EMI list; `seq` makes repeat clicks count. */
  openRequest?: { id: string; seq: number } | null;
}

/**
 * Every EMI dialog — details, record payment, delete — for the unified Loan & EMI workspace, which owns
 * the list and the single Add flow. Renders no list of its own.
 */
export function EmiWorkspace({ openRequest = null }: EmiWorkspaceProps = {}) {
  const searchParams = useSearchParams();
  const { rows } = useEmiRows();
  const actions = useEmiActions();
  const [activeRow, setActiveRow] = useState<EmiRow | null>(null);
  const [handoffDetailId, setHandoffDetailId] = useState<string | null>(() => searchParams.get("agreement"));
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Incremented per open so each Record Payment gets a fresh mount (clean form, new guard state).
  const [paySeq, setPaySeq] = useState(0);
  const [payOpen, setPayOpen] = useState(false);

  const activeRowFresh = useMemo(() => {
    const id = activeRow?.emi.id ?? handoffDetailId;
    if (!id) return null;
    return rows.find((row) => row.emi.id === id) ?? activeRow;
  }, [rows, activeRow, handoffDetailId]);

  const [seenOpenRequest, setSeenOpenRequest] = useState(openRequest);
  if (openRequest !== seenOpenRequest) {
    setSeenOpenRequest(openRequest);
    const target = openRequest ? rows.find((r) => r.emi.id === openRequest.id) : undefined;
    if (target) setActiveRow(target);
  }

  function openPay() {
    setPaySeq((n) => n + 1);
    setPayOpen(true);
  }

  async function handleDelete() {
    if (!actions || !activeRowFresh) return;
    try {
      await actions.deleteEmi(activeRowFresh.emi);
      setDeleteOpen(false);
      setActiveRow(null);
    } catch (e) {
      toast.error("Couldn't delete EMI", e instanceof Error ? e.message : "Please try again.");
    }
  }

  async function handleClose() {
    if (!actions || !activeRowFresh) return;
    try {
      await actions.closeEmi(activeRowFresh.emi);
    } catch (e) {
      toast.error("Couldn't close EMI", e instanceof Error ? e.message : "Please try again.");
    }
  }

  const detail = activeRowFresh;
  const detailDone = detail != null && (detail.status === "closed" || detail.status === "completed");
  const detailPaid = detail ? detail.installments.reduce((sum, i) => sum + i.amountPaid, 0) : 0;
  const detailInstallment = detail ? (detail.nextInstallment?.amountDue ?? detail.installments[0]?.amountDue ?? 0) : 0;
  const detailCard = detail ? emiCardLabel(detail) : null;
  const detailOverdue = detail?.nextInstallment != null && daysUntil(detail.nextInstallment.dueDate) < 0;

  return (
    <>
      <DetailDrawer
        open={detail != null && !deleteOpen && !payOpen}
        onOpenChange={(open) => {
          if (!open) {
            setActiveRow(null);
            setHandoffDetailId(null);
          }
        }}
        className="sm:max-w-lg"
        title={detail?.emi.name ?? ""}
        description={
          detail
            ? `${recordKindForEmi(detail.emi).label} · ${detail.emi.lenderName ?? EMI_TYPE_LABEL[detail.emi.loanType]}${
                detail.emi.interest ? ` · ${detail.emi.interest.ratePercent}% p.a.` : " · No interest"
              }`
            : undefined
        }
        footer={
          detail && (
            <>
              {detail.nextInstallment ? (
                <ClayButton className="w-full gap-1.5 rounded-[8px] border-primary-accent-text font-bold" disabled={detail.status === "closed"} onClick={openPay}>
                  <Wallet className="size-4" />
                  Record Payment
                </ClayButton>
              ) : (
                <span className="flex h-10 w-full items-center justify-center gap-1.5 rounded-[8px] border-2 border-success text-sm font-bold text-success">
                  <CheckCircle2 className="size-4" />
                  Fully paid
                </span>
              )}
              <div className="flex gap-2">
                <ClayButton variant="ghost" size="sm" className="flex-1 gap-1.5 rounded-[6px] font-semibold text-foreground hover:bg-secondary" disabled={detail.status === "closed"} onClick={handleClose}>
                  <Lock className="size-3.5" />
                  Close EMI
                </ClayButton>
                <ClayButton variant="ghost" size="sm" className="flex-1 gap-1.5 text-expense hover:text-expense" onClick={() => setDeleteOpen(true)}>
                  <Trash2 className="size-3.5" />
                  Delete
                </ClayButton>
              </div>
            </>
          )
        }
      >
        {detail && (
          <div className="flex flex-col gap-5 text-sm">
            <DetailHero
              label="Outstanding"
              amount={detail.remainingBalance}
              paid={detail.installmentsPaid}
              total={detail.emi.installmentCount}
              badges={emiBadges(detail)}
            />

            {!detailDone && detail.nextInstallment && (
              <div className="flex items-center justify-between gap-3 rounded-[10px] border border-border-strong bg-secondary px-4 py-3">
                <div className="flex flex-col">
                  <span className={cn("text-xs", detailOverdue ? "font-semibold text-expense" : "font-medium text-muted-foreground")}>
                    Next installment · {dueLabel(detail.nextInstallment.dueDate)}
                  </span>
                  <Money amount={remainingAmount(detail.nextInstallment)} className="text-xl text-foreground" />
                </div>
                <span className="text-xs text-muted-foreground">
                  #{detail.nextInstallment.sequenceNumber} of {detail.emi.installmentCount}
                </span>
              </div>
            )}

            <FactGrid
              className="sm:grid-cols-2"
              facts={[
                { label: "Original amount", value: <Money amount={detail.emi.principalAmount} /> },
                { label: "Installment", value: <Money amount={detailInstallment} />, strong: true },
                { label: "Paid so far", value: <Money amount={detailPaid} /> },
                {
                  label: "Interest",
                  value: detail.emi.interest
                    ? `${detail.emi.interest.ratePercent}% ${detail.emi.interest.type === "flat" ? "flat" : "reducing"}`
                    : "No interest",
                },
                detail.emi.isAutoDebitEnabled ? { label: "Auto-debit", value: detail.emi.autoDebitAccount ?? "On" } : null,
              ]}
            />

            {(detailCard || detail.emi.beneficiaryPersonId || detail.emi.lenderName) && (
              <section>
                <DetailSectionTitle>Linked</DetailSectionTitle>
                <LinkedList>
                  {detailCard && (
                    <LinkedRow icon={CreditCard} label="Credit card" value={detailCard} action={<GoTo href="/credit-cards" label="Open Credit Cards" />} />
                  )}
                  {detail.emi.lenderName && <LinkedRow icon={Building2} label="Lender" value={detail.emi.lenderName} />}
                  {detail.emi.beneficiaryPersonId && (
                    <LinkedRow
                      icon={UserRound}
                      label="For"
                      value={detail.beneficiaryName ?? "Someone else"}
                      action={<GoTo href="/people" label="Open People" />}
                    />
                  )}
                </LinkedList>
              </section>
            )}

            <section>
              <DetailSectionTitle aside={<span className="text-xs text-muted-foreground tabular-nums">{detail.installments.length} total</span>}>
                Installments
              </DetailSectionTitle>
              <div className="flex flex-col divide-y divide-border overflow-hidden rounded-[10px] border border-border">
                {detail.installments.map((installment) => {
                  const status = installmentStatus(installment);
                  const badge = INSTALLMENT_STATUS_BADGE[status];
                  const isNext = installment.id === detail.nextInstallment?.id;
                  return (
                    <div
                      key={installment.id}
                      className={cn("flex items-center justify-between gap-3 px-3.5 py-2.5", isNext ? "bg-secondary shadow-[inset_3px_0_0_var(--primary-accent-text)]" : "bg-card", status === "paid" && "text-muted-foreground")}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="w-6 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{installment.sequenceNumber}</span>
                        <div className="flex min-w-0 flex-col">
                          <span className={cn("text-sm font-medium", status === "paid" ? "text-muted-foreground" : "text-foreground")}>
                            {installment.dueDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                          </span>
                          {isNext && <span className="text-[11px] font-bold text-primary-accent-text">Next due</span>}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {badge && <ClayBadge tone={badge.tone} className="px-2 py-0.5 text-[11px]">{badge.label}</ClayBadge>}
                        <CurrencyCell amount={installment.amountDue} signed={false} className="text-sm font-semibold" />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        )}
      </DetailDrawer>

      <RecordPaymentDialog
        key={`emi-pay-${paySeq}`}
        target={payOpen && detail ? { kind: "emi", row: detail } : null}
        open={payOpen && detail != null}
        onOpenChange={setPayOpen}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${detail?.emi.name ?? "EMI"}?`}
        description="This permanently removes the EMI, its schedule, installments, and payment breakdowns. This action cannot be undone."
        variant="destructive"
        confirmLabel="Delete"
        onConfirm={handleDelete}
      />
    </>
  );
}
