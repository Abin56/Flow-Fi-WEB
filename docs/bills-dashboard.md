# Bills dashboard

The Bills page answers five questions for the selected **Month Cycle**: what do I need to pay, what is overdue, what is
due next, what is already paid, what is still outstanding. It is a **read-only view over records that already exist**.
It creates no obligation, stores no balance and has no payment path of its own.

## One source of truth

```
live records ──► buildCycleObligations / buildCompletedEvents   (features/my-money/lib/cycle-obligations.ts)
                    │   cardBillsForCard + cardBillsDueInCycle     card statements (stored + derived, live totals)
                    │   loanCycleDues                              Loan / EMI schedule installments
                    │   billObligationsInCycle                     every outstanding bill cycle
                    │   emiPurchaseRepresentedOnCard               card-funded EMI → not counted twice
                    ▼
               buildBillsOverview                                 (features/bills/lib/bills-overview.ts)
                    ▼
        BillsSummary / BillsPaymentList                           (presentation only)
```

My Money's *To pay* and *Completed* are produced by the **same two builders** (the code was moved out of
`use-my-money-data.ts` unchanged), so Bills, My Money and Month Cycle cannot disagree. Month Cycle's own bill figure
(`billObligationsInCycle`) is asserted equal to Bills' in the emulator test.

## Definitions (selected cycle = the one `Settings → Month cycle` start day defines)

| Figure | Meaning |
|---|---|
| **Due this cycle** | Σ remaining of *counted* obligations owed in the cycle: due inside it, **plus** anything from an earlier cycle that is still unpaid (carried forward). Equals My Money's To pay. |
| **Overdue** | The past-due part of Due this cycle (it is *included in*, not added to, Due this cycle). Never dropped when the cycle rolls over. |
| **Upcoming** | Counted obligations falling due in the **next** cycle (a card's still-open statement included, flagged "Bill still open"). Carried items are not repeated. |
| **Paid** | Payments **recorded in the cycle, by their own payment date** — card bill payment legs, Loan/EMI installment payments, bill `PaymentRecord`s. A bill part that has no dated record stays undated; the due date is never shown as the payment date. |

*Counted* = `countsTowardTotal`. A card-linked Loan/EMI installment whose purchase is on the card (Case A,
`emiPurchaseRepresentedOnCard`) is **listed under "Included in a card bill" and never added** — the card statement
already carries that money. A Loan whose installments someone else pays is also listed, not counted. A lent Loan is a
receivable, never a due. Skipped and fully paid cycles are never owed. Partly paid obligations show only what is left.

## Paying

| Row | What "Pay" does |
|---|---|
| Regular bill | Opens the existing Pay dialog for **that row's exact cycle** (an older cycle reopened by a cancelled payment included). Choose *Pay from my account now* (one debit, funds checked in the write; any amount up to what is owed = a part payment) or *Already paid earlier* (status + real date only, **no transaction**). `BillPaymentRepository`: one atomic, idempotent Firestore transaction. |
| Loan / EMI installment | Deep-links to `/loans` or `/emi` with `agreement`, `installment`, `pay=1` — the owning module's own *Record payment*. |
| Card statement | `/credit-cards?card=…&pay=1` — the card's own *Pay bill*. |

Bills never writes a loan, EMI or card payment, so there is no way to record one twice.

## Due-date edits move the open cycle

`BillRepository.editBill` used to change only the template (`nextDueDate`); the already-materialised cycle kept its old
due date, so the page and Month Cycle ignored the edit. It now also moves the bill's **latest live, unsettled** cycle in
the same transaction (audit entry on the cycle), and refuses — nothing written — when the new date is already used by
another cycle, or when moving back by exactly the roll's steps would make the next roll land on this cycle's own
document id (cycle ids are `billId_yyyymmdd` of the *original* day). Paid / skipped cycles are history and are never
rewritten; a bill with no cycle yet just takes the new date. Amount edits still do **not** change an already
materialised cycle (documented snapshot design, unchanged).

## Freshness

Bill writes invalidate `bill-occurrences`, `bill-occurrence-history` and `billPayments`. Before, only the first was
invalidated, so the 60 s-stale history / payment-record queries (Paid, My Money Completed, Dashboard) could lag.

## Tests

| Layer | File |
|---|---|
| Builder, hand-computed oracle (18th-start cycle, carried, partial, card-EMI Case A, lent loan, skipped, undated) | `features/my-money/lib/cycle-obligations.test.ts` |
| Sections / headlines / filters, cross-checked with `summarizeToPay` | `features/bills/lib/bills-overview.test.ts` |
| Page behaviour (headlines, source labels, exact-cycle pay, owner hand-offs, filters) | `features/bills/components/bills-workspace.payments.test.tsx` |
| Real repositories on the emulator: part-pay → pay → cancel → pay again; idempotent key; concurrent pay; paid-earlier moves no money; 17th/18th cycle boundary; due-date edits | `tests/integration/bills-dashboard-sync.test.ts` |
| Real browser (emulator-backed), 4 widths × light/dark, My Money agreement, pay once, owner pay flows, due-date edit, cycle nav | `tests/e2e-qa/suites/bills-dashboard.mjs` |

## Known limits

- Amounts on rows are the engines' remainders; the page does not (and must not) edit a Loan/EMI/card obligation.
- Only a *stored* card statement carries a minimum due; the web app does not materialise statements, so it is usually
  absent (shown only when present, never invented).
- The overview loads the same live subscriptions My Money does (no People history), so *shared with people* splits are
  not shown on Bills rows; they remain on My Money and the People Ledger.
- `lib/engines/upcoming-dues.ts` (the earlier rolling 30-day list) is no longer wired to any screen.
- The Flutter app's `editBill` has the same template-only behaviour for due-date edits (not changed here).
