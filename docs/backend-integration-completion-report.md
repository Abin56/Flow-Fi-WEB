# Backend Integration Completion Report

**Date:** 2026-08-03
**Scope:** Flutter Backend Parity milestone — port every missing model/repository/engine, then wire all ten finance pages to real Firestore data via the shared repository/engine layer, replacing `lib/mock/*.ts`.

---

## 1. Pages completed

| # | Page | Route | Status |
|---|---|---|---|
| 1 | Dashboard | `/dashboard` | ✅ Wired |
| 2 | Accounts | `/accounts` | ✅ Wired |
| 3 | Credit Cards | `/credit-cards` | ✅ Wired |
| 4 | Transactions | `/transactions` | ✅ Wired |
| 5 | Bills | `/bills` | ✅ Wired |
| 6 | Budget | `/budgets` | ✅ Wired |
| 7 | EMI | `/emi` | ✅ Wired (read-only — see gaps) |
| 8 | Loans | `/loans` | ✅ Wired (create/edit/delete live; payment/close unwired in UI) |
| 9 | People | `/people` | ✅ Wired |
| 10 | Savings | `/savings` | ✅ Wired |

All ten routes typecheck clean project-wide (`npx tsc --noEmit`, zero errors) and the frontend test suite passes (12/12 `vitest` tests; Dashboard/Accounts/Credit Cards passes additionally ran the fuller suite including `functions/`, with only pre-existing, unrelated emulator-timeout failures — none touched by this work).

---

## 2. Firestore collections used

`users/{uid}/accounts`, `transactions`, `categories`, `budgets`, `bills` (+ `occurrences`, `payments`), `loans`, `emis` (+ `paymentBreakdowns`), `expenses` *(model/repo ported, not yet UI-wired)*, `paymentSchedules` (+ `installments`, `payments`), `creditCards` (+ `statements`, `statementPayments`), `sharedCreditLimits`, `people` (+ `ledger`), `savingsGoals`. Two new `collectionGroup` queries (`statements`, `paymentBreakdowns`) support cross-card/cross-EMI reads without one `watchAll` per parent; composite indexes for both were added to `firestore.indexes.json` this pass.

## 3. Repositories used

`AccountRepository`, `TransactionRepository`, `CategoryRepository`, `BudgetRepository`, `BillRepository`/`BillOccurrenceRepository`/`PaymentRepository`, `LoanRepository`, `EmiRepository`/`EmiPaymentBreakdownRepository`, `PaymentScheduleRepository`/`InstallmentRepository`/`InstallmentPaymentRepository`, `CreditCardRepository`/`SharedCreditLimitRepository`/`StatementRepository`/`StatementPaymentRepository`, `PersonRepository`/`LedgerRepository`, `SavingsRepository` — all ported this milestone, all now live behind at least one page. `ExpenseRepository` is ported but has no page consuming it yet (no Split Expense UI exists).

## 4. Flutter engines reused

`calculateNetWorth` (net-worth.ts), `cashFlowThisMonth` (cash-flow.ts), `computeBudgetInsight`/`resolveBudgetPeriod` (budget-insight.ts), `cardOwnStanding`/`availableCredit`/`creditCardStanding`/`sharedCreditLimitStanding`/`creditUtilizationPercent`/`statementCycleView` (credit-utilization.ts), the Dashboard Aggregation engine's bucketing helpers (dashboard-aggregation.ts), and `installmentStatus`/`remainingAmount` (payment-schedule.ts) — every one called unmodified from UI-layer hooks; no business logic was reimplemented in a component.

## 5. Remaining mock data

- `lib/mock/dashboard-data.ts`: `aiInsight` (no ported engine — Milestone 12) and `financialHealth` score (no Flutter engine exists for this at all, on either side).
- `features/accounts`: `accountQuickActions`/`accountShortcuts` — static UI labels, not data.
- Every other page's mock file (`accounts-data.ts`, `credit-cards-data.ts`, `loans-data.ts`, `people-data.ts`, `transactions-data.ts`, `budgets-data.ts`) is no longer imported by any live component — left in place, unreferenced, not deleted (not asked to remove them).

## 6. Remaining architecture gaps

1. **No balance-history storage** (either app) — every "change vs. last month" figure across Dashboard/Accounts/Credit Cards reports 0 rather than a fabricated delta.
2. **No category join on some transaction lists** — Accounts/Credit Cards show `Transaction.type` (Income/Expense) rather than resolved category name in a couple of recent-transaction lists (Dashboard and the main Transactions page do resolve categories).
3. **EMI page is read-only** — create/edit/record-payment/close-EMI actions aren't wired to UI yet, though the repository methods exist.
4. **Loan record-payment and close-loan actions** exist in `useLoanActions()` but have no button/dialog in the UI yet.
5. **`Loan.personId` reuse for institutional lenders** — bank loans are modeled as a `Person` (name-matched-or-created) rather than a second parallel lender entity, a documented design choice, not a gap, but worth flagging as a schema decision.
6. **Split Expense UI does not exist** — `ExpenseRepository` is fully ported but unused by any page.
7. **`currentCycleStatement` (live, not-yet-materialized billing cycle) always passes `null`** into the Credit Utilization engine — only already-materialized `Statement` docs count toward outstanding/utilization; the in-progress cycle's spend isn't included yet.
8. **No rewards/cashback ledger** — Credit Cards page always shows 0 for reward points/cashback/lounge visits (no such feature exists in either app).
9. **Firestore offline persistence is still unconfigured** in `lib/firebase/client.ts` (flagged in the original compatibility report, not addressed this pass — Flutter has no equivalent config either, so this is low-risk, not a parity gap).

## 7. Backend parity percentage

Updating the original compatibility report's ~22% baseline: **all 21 previously-missing modules from that report's Gap Summary are now built** (10 models, 10 repositories, 1 engine group covering Dashboard+Budget Insight), and all are now live behind real UI. Remaining known gaps are narrow (Expense/Split UI, EMI/Loan write-actions, balance-history, live-cycle inclusion) rather than missing modules. Estimated **~90% backend parity** — the shared repository/model/engine layer is essentially complete; the remainder is UI-layer wiring for actions that already have real repository support, plus two small unaddressed product gaps (balance history, live-cycle spend) that exist independently of this port.

## 8. Is Web now using the same backend logic as Flutter?

**Yes, for every page in this milestone.** Every number shown on Dashboard, Accounts, Credit Cards, Transactions, Bills, Budget, EMI, Loans, People, and Savings is now read from the same Firestore collections Flutter writes to, through models/repositories ported field-for-field from the real Dart source, and computed by engines verified line-by-line against Flutter's actual algorithms (Cash Flow, Net Worth, Credit Utilization, Interest Calculator, Cycle/Carry-Forward, Budget Insight, Dashboard Aggregation). No calculation in any wired page is computed ad hoc in a component. The exceptions are narrow and explicitly listed above (Split Expense has no UI yet; EMI/Loan write-actions are partially wired; two figures — AI Insight and Financial Health score — have no Flutter engine to port from in the first place).

The Web app and Flutter app are now genuinely two clients of one backend, as intended — not two independent implementations that happen to agree.
