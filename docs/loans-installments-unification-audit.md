# Loans & Installments unification — Phase 0 audit

Status: **read-only audit, no behavior changes.** Covers `flowfi-web` and `Finance_App` (Flutter) as of 2026-09-25.
Evidence is cited as `file:line`; "code-read" marks findings traced through code but not yet reproduced on the emulator.

## 1. What exists today

Both platforms share the same Firestore shapes:

| Collection | Owner | Notes |
|---|---|---|
| `users/{uid}/loans/{id}` | Loan | `direction` given/taken, `category` personal/institutional, `repaymentType` installment/oneTime |
| `users/{uid}/emis/{id}` | EMI | always installments, rich bank metadata, `linkedCreditCardId` |
| `users/{uid}/emis/{id}/paymentBreakdowns/{paymentId}` | EMI | principal/interest/GST/fees split per payment |
| `users/{uid}/paymentSchedules/{id}` (+ `installments`, + `payments`) | shared | both Loan and EMI point at one schedule via `scheduleId` |
| `users/{uid}/loans/{id}/reamortizationEvents`, `/additionalDisbursements` | Loan only | prepayment / borrow-more / reversal bookkeeping |
| `users/{uid}/transactions` | shared | loan-generated rows carry `loanId`, `installmentId`, `installmentPaymentId`, `paymentAllocationType` |

Shared engines already exist on both platforms: interest calculator (flat / reducing, weekly/monthly), installment settlement planner, outstanding-principal formula, reduce-tenure (prepayment) and hold-tenure (disbursement) policies.

## 2. Capability matrix

| Capability | Web Loan | Flutter Loan | Web EMI | Flutter EMI |
|---|---|---|---|---|
| Borrowed / lent direction | ✅ | ✅ | ❌ (always "I owe") | ❌ |
| Personal (Person) vs institution | ✅ | ✅ | lender name only | lender name only |
| Installment schedule (monthly/weekly) | ✅ | ✅ | ✅ (+custom, due-day-of-month) | ✅ (+custom, due-day-of-month) |
| One-time repayment | model only, UI can't create | ✅ create; **payments throw** (code-read, §4.5) | ❌ | ❌ |
| Flexible repayment (no schedule) | ❌ | ❌ | ❌ | ❌ |
| Flat / reducing / zero interest | ✅ | ✅ | ✅ | ✅ |
| Payment moves an Account + writes a Transaction | ✅ atomic, idempotent | ✅ atomic, idempotent | ❌ schedule only, 2 non-atomic writes | ❌ schedule only |
| Partial / advance EMI | ✅ | ✅ | partial ✅ | partial ✅ |
| Multi-installment ("Pay Multiple EMIs") | ✅ | ✅ (Settle) | ❌ | ✅ multi-payment + lump sum sheets |
| Extra principal (reduce tenure) | ✅ | ✅ | ❌ | ❌ |
| Borrow/Lend more (hold tenure) | ✅ | ✅ | ❌ | ❌ |
| Reversal | repo only, no UI | repo (check UI) | ❌ | ❌ |
| Edit terms (re-plan unpaid tail) | ✅ | ✅ | ✅ | ✅ |
| Close / reopen | ✅ | ✅ | ✅ | ✅ |
| Mark defaulted / close early | ❌ | ❌ | ✅ | ✅ |
| Trash / restore | ✅ | ✅ | ❌ **permanent delete only** | ✅ trash screen |
| Payment charge breakdown (GST, fees, penalty) | ❌ | ❌ | ✅ | ✅ |
| Bank metadata (sanction date, fees, auto-debit…) | partial | partial | ✅ | ✅ |
| Credit-card link (`linkedCreditCardId`) | ❌ | ❌ | ✅ | ✅ |
| People ledger posting | ✅ | check | ❌ | ❌ |
| Reminders | — | ? | — | ✅ |

**Conclusion:** Loan has the stronger money engine (accounts, transactions, idempotency, prepayment, disbursement, reversal). EMI has the richer purchase/bank metadata, the card link, charge breakdowns, and "defaulted". Neither supports flexible repayment.

## 3. Legacy map (what must keep its meaning)

- Loan docs with `institutionName == null` still resolve their lender through a shadow Person (`features/loans/hooks/use-loans-data.ts` module comment).
- `InstallmentPayment.allocationType` missing ⇒ `regularEmi` (`lib/models/payment-schedule.ts:95`).
- `InstallmentPayment.transactionId == null` ⇒ older payment with **no** Transaction behind it (all EMI payments, older Loan payments).
- `loanRepaymentTypeFromName` falls back to `oneTime` for unknown values on both platforms. So a new enum value such as `flexible` reads as `oneTime` in older app builds, a graceful fallback.
- EMIs are schedule-only: their cash movement was never recorded as Transactions.

## 4. P0 financial findings (exist today, before any unification)

These would be inherited by a unified "I Owe / Owed to Me" summary, so they come first.

1. **Loan payments are double-counted in Cash Flow (both platforms).** A Loan payment writes an `expense`/`income` Transaction (`lib/repositories/loan-advance-payment-repository.ts:490`). Cash Flow counts it once via transactions and again via the installment payments.
   - Web: `lib/engines/cash-flow.ts:76`, fed by `hooks/use-transactions.ts:110`.
   - Flutter: `cash_flow_providers.dart:713` (expense loop) plus `:767` (loan-payment loop).
   - Fix rule (ID-based, no heuristics): count an installment payment in the schedule-derived line **only when `payment.transactionId == null`**. Otherwise the Transaction already counts it.
2. **Web counts lent-loan repayments as Money Out.** `paidThisMonth(loanInstallments)` ignores `direction` (`hooks/use-transactions.ts:110`); Flutter gates this by direction correctly.
3. **Web Reports: lent money is counted as a liability.** `features/reports/hooks/use-reports-data.ts:176` sums `outstandingPrincipal` over every loan, including `given` ones, which are receivables.
4. **Net Worth ignores loans entirely** (`use-reports-data.ts:24`). Borrowing raises Net Worth by the full amount and lending lowers it (spec invariants 1–2 fail).
5. **Flutter one-time loans cannot record payments** (code-read). The "Pay"/"Settle" buttons (`loan_detail_screen.dart:359`) call `LoanAdvancePaymentRepository.record`, which throws for non-installment loans (`loan_advance_payment_repository.dart:296`).
6. **Extra principal doesn't lower displayed Outstanding** (both platforms), from the previous task: `outstandingPrincipalFor` ignores prepayments. Pinned by `tests/integration/loan-live-refresh-and-audit.test.ts` (`it.fails`).
7. **Loan principal flows are ordinary income/expense.** Borrow-more shows as income, and `excludeFromCalculations` can't be reused because it also zeroes balance effect (`lib/models/transaction.ts:138`).

## 5. Credit-card EMI: who owns the liability

- The card's liability is its **statements**: `outstanding = Σ unpaid statement remaining + live current-cycle spend` (`lib/engines/credit-utilization.ts:84`).
- A linked EMI **locks** its full principal against available credit and releases it as `EmiPaymentBreakdown.principalPaid` accrues: `available = limit − outstanding − linkedEmiPrincipal + principalRestored` (`credit-utilization.ts:113`).
- Reports then add **card outstanding + EMI remaining balance** as two separate liabilities (`use-reports-data.ts:176-181`).

Double-count risk (to reproduce on the emulator before any Phase 5 work):
- If the ₹60,000 purchase also sits on a statement, available credit drops by ₹1,20,000 and liabilities show ₹1,20,000.
- If the bank bills each EMI on the statement *and* the EMI installment is marked paid, Cash Flow counts the EMI line, while the statement payment isn't counted (by design). Whether that double counts depends on whether the monthly EMI charge is also entered as a card expense.
- The codebase doesn't state which convention users follow, so this is decision D2.

## 6. Recommended architecture (for approval — not implemented)

**No collection renames, no migration.** Additive only.

1. **Unified read model, not a new collection.** Each platform gets a pure `FinanceItem` adapter built from existing `Loan` and `Emi` docs. It carries:
   - `source` (loan | emi)
   - `kind` (loan | installmentPurchase)
   - `direction`
   - `repaymentStructure` (scheduled | flexible | oneTime)
   - `fundingSource`
   - amounts computed by the existing engines only

   The unified workspace renders this; each item's actions still dispatch to its own repository.
2. **New items are written as Loan docs**, because Loan has the complete money engine. Additive, optional Loan fields, with identical keys and enum strings in TS and Dart and old-document defaults in parentheses:

   | Firestore key | Type | Default when absent | Meaning |
   |---|---|---|---|
   | `agreementKind` | `"loan" \| "installmentPurchase"` | `"loan"` | UI naming + filters |
   | `fundingSource` | `"bank" \| "financeCompany" \| "creditCard" \| "person" \| "other"` | derived: personal→person, institutional→bank | filters, card rules |
   | `linkedCreditCardId` | string? | null | same meaning as EMI's field |
   | `purchaseAmount` | number? | null | installment purchases |
   | `downPayment` | number? | null | installment purchases; `loanAmount` stays the financed principal |
   | `repaymentType` | adds `"flexible"` | — | older builds read it as `oneTime` (safe fallback) |

3. **Legacy EMIs stay EMI docs** and appear in the unified list through the adapter, keeping their existing actions. Converting an EMI to a Loan is only ever an explicit per-item user action, designed separately.
4. **Flexible repayment** reuses the one-time mechanism: a single open installment with repeated partial payments, so no fake EMIs. It needs the one-time payment path fixed (§4.5) and a `flexible` variant with an optional due date.
5. **Card-linked installment purchases:** the card stays the liability owner. The plan contributes the schedule and the credit lock only, and must be excluded from the Loans/EMIs liability total when `fundingSource == creditCard && linkedCreditCardId != null`. Proven with emulator tests before being enabled (Phase 5).

## 7. Proposed order

- **Phase 0.5:** fix P0 items 1–3 and 5 (small and ID-based), with emulator + unit tests on both platforms.
- **Phase 1:** additive fields + the adapter, plus cross-platform golden fixtures.
- **Phase 3:** unified web workspace, with EMI routes kept.
- **Phase 4:** unified Flutter workspace.
- **Phase 5:** card/person integration after D2.

## 8. Decisions needed

### Phase 5 resolution

D1 is approved: all new unified records, including installment purchases, use additive Loan documents. Existing EMI records remain legacy read/edit records and are never migrated automatically. The Loan schema carries `agreementKind`, `fundingSource`, `linkedCreditCardId`, `purchaseTransactionId`, `purchaseAmount`, and `downPayment` with identical Web/Flutter enum strings. Flexible repayment remains blocked. This resolution supersedes any earlier wording in this audit that described the model as merely proposed.

- **D1** — Approve §6: adapter + Loan as the write model for new items, EMIs read-through, no migration.
- **D2** — Card EMI convention: is the original purchase recorded on the card statement, and are monthly EMI charges entered as card spending? This decides the single liability owner.
- **D3** — Do Phase 0.5 (P0 fixes) before any unification work?
- **D4** — Extra-principal outstanding (§4.6): store a prepaid total on the Loan (both apps change), or derive it from payment records?
- **D5** — Net Worth: should it include loan liabilities and receivables? That changes a headline number users already see.
