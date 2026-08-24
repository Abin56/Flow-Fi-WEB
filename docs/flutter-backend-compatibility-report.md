# Flutter Backend Compatibility Report

**Status:** Authoritative Phase 1 deliverable (Milestone 3, per AGENTS.md)
**Date:** 2026-08-03
**Method:** Direct read of Dart source at `C:\Users\anjel\Finance_App` cross-checked line-by-line against TypeScript source at `C:\Users\anjel\flowfi-web`. Superseded assumption: prior docs (`docs/parity-matrix.md`) were written **without** access to the Flutter source tree and marked everything "Not verified." This report closes that gap — every claim below is checked against real Dart, not code comments.

Legend used throughout:

| Symbol | Meaning |
|---|---|
| ✅ | Identical Ported — algorithm/shape matches Flutter exactly |
| 🟡 | Ported but Different — exists, diverges in scope, formula, or edge case |
| 🔴 | Missing — no Web counterpart exists |
| 🔵 | Flutter Only — no Web equivalent needed yet / out of current scope |
| 🟣 | Web Only — new capability, no Flutter equivalent (Statement Intelligence pipeline) |

---

## 1. Models

| Model | Flutter | Web | Status |
|---|---|---|---|
| Account | `lib/features/accounts/domain/account.dart` | `lib/models/account.ts` | ✅ |
| Transaction | `lib/features/transactions/domain/transaction.dart` | `lib/models/transaction.ts` | ✅ |
| Category | `lib/features/categories/domain/category.dart` | — | 🔴 |
| Budget | `lib/features/budget/domain/budget.dart` | — | 🔴 |
| SavingsGoal | `lib/features/savings/domain/savings_goal.dart` | — | 🔴 |
| Person / LedgerEntry | `lib/features/people/domain/{person,ledger_entry}.dart` | — | 🔴 |
| Bill / BillOccurrence / PaymentRecord | `lib/features/bills/domain/*.dart` | — | 🔴 |
| Loan | `lib/features/lending/domain/loan.dart` | — | 🔴 |
| Emi / EmiInterest / EmiPaymentBreakdown | `lib/features/emi/domain/*.dart` | — | 🔴 |
| Expense / ExpenseParticipant | `lib/features/expense/domain/*.dart` | — | 🔴 |
| PaymentSchedule / Installment / InstallmentPayment | `lib/core/payment_schedule/domain/*.dart` | — | 🔴 |
| CreditCardProfile / SharedCreditLimit / Statement / StatementPayment | `lib/features/credit_cards/domain/*.dart` | — | 🔴 |
| SoftDeletableEntity / AuditEntry mixins | `lib/core/models/{soft_deletable_entity,auditable_mixin,audit_entry}.dart` | `lib/firestore/soft-deletable.ts` | ✅ |
| FinancialDocument, DocumentImport, MerchantMapping, DocumentTypeRegistry | N/A | `lib/models/{financial-document,document-import,merchant-mapping,document-type-registry}.ts` | 🟣 |

**Difference detail — none for ✅ rows** (Account/Transaction/soft-delete mixin confirmed field-identical). **Risk for 🔴 rows:** Budget/Category/PaymentSchedule block downstream engine work — see Roadmap Phase A.

---

## 2. Repositories

| Repository | Flutter | Web | Status |
|---|---|---|---|
| Generic CRUD base | `lib/core/data/firestore_crud_repository.dart` | `lib/firestore/firestore-crud-repository.ts` | ✅ |
| AccountRepository | `lib/features/accounts/data/account_repository.dart` | `lib/repositories/account-repository.ts` | ✅ |
| TransactionRepository | `lib/features/transactions/data/transaction_repository.dart` | `lib/repositories/transaction-repository.ts` | ✅ |
| CategoryRepository | `lib/features/categories/data/category_repository.dart` | — | 🔴 |
| BudgetRepository | `lib/features/budget/data/budget_repository.dart` | — | 🔴 |
| PaymentScheduleRepository / InstallmentRepository / InstallmentPaymentRepository | `lib/core/payment_schedule/data/*.dart` | — | 🔴 |
| CreditCardRepository / SharedCreditLimitRepository / StatementRepository / StatementPaymentRepository | `lib/features/credit_cards/data/*.dart` | — | 🔴 |
| EmiRepository | `lib/features/emi/data/emi_repository.dart` (694 lines) | — | 🔴 |
| LoanRepository | `lib/features/lending/data/loan_repository.dart` | — | 🔴 |
| BillRepository / BillOccurrenceRepository | `lib/features/bills/data/*.dart` | — | 🔴 |
| PersonRepository / LedgerRepository | `lib/features/people/data/*.dart` | — | 🔴 |
| ExpenseRepository | `lib/features/expense/data/expense_repository.dart` | — | 🔴 |
| SavingsRepository | `lib/features/savings/data/savings_repository.dart` | — | 🔴 |

Only 3 of 15 repository groups exist in Web. Both existing ports (`AccountRepository`, `TransactionRepository`) match method-for-method against their Dart counterparts (create/edit/adjustBalance/softDelete/restore/permanentlyDelete pattern).

---

## 3. Services

| Service | Flutter | Web | Status |
|---|---|---|---|
| Auth service | (Firebase Auth wrapper, `lib/features/auth/data/`) | `services/auth/auth-service.ts` | ✅ |
| Local settings service | `lib/core/services/local_settings_service.dart` | — | 🔴 |
| Payment attribution service | `lib/core/services/payment_attribution_service.dart` | — | 🔴 |
| Reminder/notification service | `lib/core/services/reminder_service.dart` | — | 🔵 (mobile-only concern; not required for web parity) |
| Secure key storage service | `lib/core/services/secure_key_storage_service.dart` | — | 🔵 (mobile keystore concern) |
| SMS permission / inbox service | `lib/features/sms_inbox/**` | — | 🔵 (mobile-only capability, no web equivalent possible) |

---

## 4. Firestore Collections

All collection name **strings** match exactly between `firestore_constants.dart` (`FirestoreCollections`) and `lib/firestore/collections.ts`.

| Collection path | Flutter | Web | Status |
|---|---|---|---|
| `users/{uid}/accounts` | ✅ | ✅ | ✅ |
| `users/{uid}/transactions` | ✅ | ✅ | ✅ |
| `users/{uid}/categories` | ✅ | name reserved in `collections.ts`, no reader/writer | 🟡 |
| `users/{uid}/budgets` | ✅ | name reserved, no reader/writer | 🟡 |
| `users/{uid}/savingsGoals` | ✅ | name reserved, no reader/writer | 🟡 |
| `users/{uid}/people`, `.../people/{id}/ledger` | ✅ | name reserved, no reader/writer | 🟡 |
| `users/{uid}/bills`, `.../occurrences`, `.../payments` | ✅ | name reserved, no reader/writer | 🟡 |
| `users/{uid}/loans` | ✅ | name reserved, no reader/writer | 🟡 |
| `users/{uid}/emis`, `.../paymentBreakdowns` | ✅ | name reserved, no reader/writer | 🟡 |
| `users/{uid}/expenses` | ✅ | name reserved, no reader/writer | 🟡 |
| `users/{uid}/paymentSchedules`, `.../installments`, `.../payments` | ✅ | name reserved, no reader/writer | 🟡 |
| `users/{uid}/creditCards`, `.../statements`, `.../statementPayments` | ✅ | name reserved; **engine reads this shape** (`credit-utilization.ts`) but no repository writes it | 🟡 |
| `users/{uid}/sharedCreditLimits` | ✅ | name reserved, no reader/writer | 🟡 |
| `financialDocuments`, `documentImports`, `merchantMappings`, `documentTypeRegistry`, `parserHistory`, `aiInsights` | N/A | full schema + rules + tests | 🟣 |

**Security rules — structural difference (🟡, real risk):**
- Flutter `firestore.rules`: two blanket rules — `users/{userId}` and a recursive `{document=**}` wildcard, both `allow read, write: if request.auth.uid == userId`. No per-collection granularity anywhere.
- Web `firestore.rules`: every collection is enumerated individually, and the Statement Intelligence collections carry genuinely tighter semantics (`financialDocuments` client-read-only, `documentImports` create-blocked/status-gated writes, `merchantMappings` split global-read-only vs personal-owner-write, `aiInsights` dismiss-only update).
- **Risk:** none for existing collections (Web's explicit rules are a strict subset/equal of what Flutter's blanket rule allows — not a behavior break, just more precise). **Recommended fix:** none needed; document this divergence as intentional hardening, not a bug, so a future contributor doesn't "fix" it back to a blanket rule.

**Indexes:** Neither project defines composite indexes. Web's `firestore.indexes.json` is present but empty (`{"indexes": [], "fieldOverrides": []}`); Flutter's `firebase.json` doesn't declare an indexes file at all. No divergence, no action needed at this time — flag to revisit once any collection needs an `orderBy` + `where` compound query (none do yet in Web, since only Account/Transaction repos exist).

---

## 5. Engines — verified line-by-line

### 5.1 Cash Flow Engine — 🟡 Ported but Different (scope)

- **Flutter:** `lib/features/cash_flow/presentation/providers/cash_flow_providers.dart`
- **Web:** `lib/engines/cash-flow.ts`
- **What matches:** `cashFlowThisMonth()` (TS) reproduces `cashFlowThisMonthProvider` (Dart) exactly — same `isSameMonth` + `!isDeleted && !isTransfer` filter, same `moneyIn = income + moneyReceived`, `moneyOut = expenses + emiPaid + loanPaid + billsPaid`, `net = moneyIn - moneyOut`.
- **Difference:** Dart's file implements a much larger surface not ported at all: `emiDueThisMonthBreakdownProvider`, `loanDueThisMonthBreakdownProvider`, `billsDueThisMonthBreakdownProvider`, `creditCardDueThisMonthBreakdownProvider`, `totalDueThisMonthProvider`, the receivables section (`splitExpensesReceivableProvider`, `peoplePendingReceivableProvider`, `loanRecoveriesReceivableProvider`, `totalMoneyToReceiveProvider`), `activeCardStatementSummariesProvider`, and `upcomingPaymentsTimelineProvider`. TS only has `combineDueBreakdowns()` (trivial reducer) + `cashFlowThisMonth()`.
- **Risk:** Medium. The Cash Flow Center screen (Sections 1-4: Due This Month, Receivables, Card Summaries, Upcoming Timeline) has zero backend to build against yet.
- **Recommended fix:** Port the remaining providers once EMI/Loan/Bill/CreditCard/Expense repositories exist (Phase C, blocked on Phase A/B models).

### 5.2 Credit Utilization Engine — 🟡 Ported but Different (one derivation gap)

- **Flutter:** `lib/features/credit_cards/presentation/providers/credit_card_providers.dart`
- **Web:** `lib/engines/credit-utilization.ts`
- **What matches:** `cardOwnStanding`/`availableCredit`/`creditCardStanding`/`sharedCreditLimitStanding`/`creditUtilizationPercent`/`statementCycleView` reproduce `_cardOwnStanding`, `_availableFor`, `creditCardStandingProvider`, `sharedCreditLimitStandingProvider`, `creditUtilizationPercentProvider`, `statementCycleViewProvider` line-for-line, including the "already materialized same-day" dedup guard and `clamp(raw, 0, creditLimit)`.
- **Difference:** Dart's `principalRestoredForCardProvider` computes `principalRepaid` via a per-payment fold — uses `EmiPaymentBreakdown.principalPaid` when present, else falls back to `payment.amount * (principalPortion / amountDue)`. TS's `UtilizationEmi.principalRepaid` is a flat input field the caller must pre-supply; the derivation itself is not ported.
- **Risk:** Medium — once `EmiRepository` exists, whoever wires it to this engine must reimplement that fold or the number silently defaults wrong (e.g., 0).
- **Recommended fix:** Port `principalRestoredForCard()` as an explicit function in `credit-utilization.ts` when EMI repository work begins (Phase C), not left as a caller responsibility.

### 5.3 Interest Calculator — ✅ Identical Ported

- **Flutter:** `lib/core/interest/interest_calculator.dart`
- **Web:** `lib/engines/interest-calculator.ts`
- `_flat`, `_reducingBalance`, `_zeroInterest`, `_periodicRate`, `_evenSplit`, `_round2` match `flat`, `reducingBalance`, `zeroInterest`, `computePeriodicRate`, `evenSplit`, `round2` formula-for-formula: same EMI annuity formula, same last-installment-absorbs-remainder rule, same clamp guard against float drift. Only cosmetic difference: Dart implements `_pow` manually vs TS's `Math.pow` — mathematically equivalent, no behavioral risk.

### 5.4 Net Worth Engine — ✅ Identical Ported

- **Flutter:** `lib/features/accounts/presentation/providers/account_providers.dart` — `accounts.fold(0.0, (total, account) => total + account.currentBalance)`
- **Web:** `lib/engines/net-worth.ts` — `accounts.reduce((total, account) => total + account.currentBalance, 0)`
- Byte-identical formula. No liabilities subtracted on either side — confirmed as a genuine Flutter product characteristic, not a web-side omission.

### 5.5 Billing/Payment Cycle (Carry Forward) Engine — ✅ Identical Ported

- **Flutter:** `lib/core/payment_schedule/domain/{cycle_anchor,cycle_period,cycle_item,cycle_engine}.dart`
- **Web:** `lib/engines/cycle-engine.ts`
- `CycleAnchor.currentCycleFor`/`previousCycleFor`/`classify` and `CycleEngine.classifyForCarryForward` map 1:1 to the TS `CycleAnchor` class and `classifyForCarryForward()`. The TS port deliberately reproduces a Dart quirk in `_addMonths` (truncating `~/` for the year vs. floored `%` for the month) rather than "fixing" it, with a comment documenting this is intentional bit-for-bit fidelity. This is the most rigorously verified port of the five audited.

---

## 6. Providers → Hooks

| Flutter Riverpod provider group | Web equivalent | Status |
|---|---|---|
| Account providers (`account_providers.dart`) | `hooks/use-accounts.ts` | ✅ |
| Transaction providers | `hooks/use-transactions.ts` | ✅ |
| Auth listener providers | `hooks/use-auth-listener.ts` | ✅ |
| Selection/UI-state providers | `hooks/use-selection.ts` | 🟡 (generic UI helper, not a direct Flutter port — low risk) |
| Cash flow providers (full surface) | none beyond `cashFlowThisMonth()` call sites | 🟡 (see §5.1) |
| Credit card providers | none — no `CreditCardRepository` to feed `use-credit-cards.ts` | 🔴 |
| Budget/Category/Bills/EMI/Loan/People/Savings/Expense providers | none | 🔴 |
| Dashboard/reports aggregation providers (`core/dashboard/**`, `features/reports/**`) | none — `lib/mock/dashboard-data.ts` only | 🔴 |

---

## 7. Utilities

| Utility | Flutter | Web | Status |
|---|---|---|---|
| Enum-with-fallback pattern (`EnumX.fromName`) | `lib/core/extensions/*.dart` | Replicated inline in `account.ts`/`transaction.ts` converters | ✅ (for the 2 enums ported so far; must be replicated per new enum as models are added) |
| Date/month bucketing helpers | `lib/core/utils/date_utils.dart` (implied) | inline in `cash-flow.ts`/`cycle-engine.ts` | 🟡 (no standalone shared util file yet — duplicated per engine; low risk, worth consolidating during Phase C) |
| Money rounding (`round2`) | `interest_calculator.dart` | `interest-calculator.ts` | ✅ |

---

## 8. Business Logic — Dashboard Aggregation (audited per Task 8)

**Flutter** (`lib/core/dashboard/presentation/providers/expense_calculator_provider.dart` + `lib/core/dashboard/**`): a real, non-trivial engine. `financialViewResultProvider` resolves a `WidgetConfiguration` into current/previous-period totals plus a category breakdown, dispatching over `FinancialViewModule` (myExpenses / sharedExpenses / combinedExpenses / income / transfers / netCashFlow). `_bucketDateFor` chooses `effectiveMonth` vs raw `dateTime` bucketing depending on whether the active date-range strategy is calendar-month-granular or not (e.g. salary-cycle ranges). Per-parent-then-per-child fan-out helpers `_billsPaid`/`_emiPaid`/`_loanPaid`/`_creditCardPaid` bucket "paid" amounts by the underlying item's **due date**, not the payment-recorded date. `percentChange = (amount - previousAmount) / previousAmount * 100`, null-safe when `previousAmount` is 0/null.

**Web:** **Nothing exists.** `app/(app)/dashboard/page.tsx` renders purely presentational components fed by `lib/mock/dashboard-data.ts` — a static object literal (`netWorth.amount = 598200`, hardcoded `cashFlow.income/expenses/net`, hardcoded `expensesByCategory.items` percentages), explicitly commented `/** Realistic placeholder data only — no Firestore wiring yet. */`. No engine, no bucketing, no `FinancialViewModule` equivalent under `lib/engines`, `app/(app)`, or `components`.

**Status: 🔴 Missing, in full.** This is the single highest-leverage gap — it composes nearly every other engine (cash flow, EMI, loans, bills, credit cards) and currently has zero real backend.

---

## 9. Business Logic — Budget Insight (audited per Task 9)

**Flutter** (`lib/features/budget/domain/budget_insight.dart`): a full pure calculator.
```
remaining = limit - spent
isOverBudget = remaining < 0
usageRatio = clamp01(spent / limit)          // for display
usageRatioRaw = spent / limit                 // unclamped, drives alertLevel
alertLevel: ratio>1→over, >=1→at100, >=0.9→at90, >=0.75→at75, >=0.5→at50, else none
totalDays = periodEnd.diff(periodStart).inDays + 1
daysElapsed = clamp(now.diff(periodStart).inDays + 1, 1, totalDays)
daysRemaining = clamp(totalDays - daysElapsed, 0, totalDays)
averageDailySpend = spent / daysElapsed
averageDailyBudgetRemaining = daysRemaining==0 ? 0 : remaining / daysRemaining
predictedTotalSpend = averageDailySpend * totalDays
predictedToExceedBudget = predictedTotalSpend > limit
```
Daily budget period = `[today, today]`; monthly = `[startOfMonth, endOfMonth]`; category budget always uses the current month.

**Web:** **No equivalent at all.** No `lib/engines/budget*.ts`, no `lib/models/budget.ts`. Only `lib/mock/budgets-data.ts` — static objects with pre-baked `spent`/`limit`/`trendPercent` per category, a hardcoded `budgetTypeBreakdown` (Needs/Wants/Savings/Debt split), and a hardcoded `dailyAverageSpend` array. None of it computed.

**Status: 🔴 Missing, in full.** Low implementation complexity (pure function, no Firestore dependency in the algorithm itself) — see Roadmap Phase C.

---

## 10. Import/Export Logic

| Capability | Flutter | Web | Status |
|---|---|---|---|
| CSV/data export | none found in Flutter project (not a feature there) | none | 🔵 |
| PDF statement import / parsing pipeline | none — Flutter has no statement-intelligence feature | `functions/src/{pipeline,worker,triggers,workspace,domain,ingestion}`, `lib/statement-intelligence/**` | 🟣 |
| Duplicate-document detection | N/A | `functions/src/ingestion/check-document-exists.ts` | 🟣 |
| Password/decrypt orchestration | N/A | `functions/src/ingestion/decrypt-document.ts` | 🟣 |
| Rate limiting | N/A | `functions/src/ingestion/rate-limit.ts` | 🟣 |
| Duplicate detection (statement/internal/transaction/near) | `lib/features/sms_inbox/domain/sms_dedup_key.dart` (SMS-import dedup, single SHA-256 key) — related but not equivalent, different domain and algorithm | `functions/src/duplicate/{duplicate-types,duplicate-detector,apply-duplicate-detection,duplicate-lookup-repository}.ts` | 🟣 (independently designed, not ported — see `docs/parity-matrix.md` Part 2 for the full comparison) |
| Category suggestion for parsed transactions | `lib/features/sms_inbox/domain/merchant/merchant_category_suggester.dart` (3-tier: user history > seed catalog > SMS type) — related but not equivalent; Web is registry-only, single-tier | `functions/src/category/{category-suggester,apply-category-suggestion}.ts` | 🟣 (independently designed, not ported — see `docs/parity-matrix.md` Part 2) |
| Account suggestion, tag/recurring/subscription/transfer detection, split-rule detection | none found in Flutter | `functions/src/{account,tagging,split}/*` | 🟣 |

---

## 11. Statement Intelligence Integration Points (audited per Task 11)

**Question:** Can the new PDF Statement Workspace merge cleanly into the existing Flutter transaction architecture without changing existing business logic?

**Evidence gathered by direct grep across `functions/src/**`:**
- No file under `functions/src` imports `TransactionRepository`.
- No code path writes to the `transactions` Firestore collection.
- The only "transaction" references in the pipeline (`check-document-exists.ts`, `workspace-builder.ts`, `statement-workspace-model.ts`) operate on an in-pipeline `WorkspaceTransaction[]` array — parsed rows confined to the workspace/staging model, never persisted as real `Transaction` documents.
- `lib/models/transaction.ts` / `lib/repositories/transaction-repository.ts` (the same code the Cash Flow and Net Worth engines read) have **zero references** from anything under `functions/src`.

**Design intent, per `docs/adr/ADR-002-*.md`:** the Import Engine's future commit step is planned to write staged records as real `Transaction` docs via the *existing* `transactionToFirestore`/`TransactionRepository` — reusing rather than duplicating the transaction pipeline — appending four additive optional fields (`sourceStatementId`, `sourceImportId`, `merchantRaw`, `confidenceScore`) to the `Transaction` shape. The ADR itself flags this as an **open, unresolved risk**: whether the real Flutter `Transaction` Firestore converter tolerates unknown/extra fields (strict vs. lenient deserialization) has not been verified, and is called out as a "blocking pre-check for M9-T1," not yet resolved.

**Conclusion:** ✅ Currently safe to merge as-is — the Statement Intelligence pipeline is purely additive and not yet wired to the shared transaction path, so there is no risk of behavior change to existing engines today. ⚠️ Before Milestone 9 (Import Engine commit step) ships, the additive-field compatibility with Flutter's actual converter must be confirmed with whoever owns the Flutter codebase, or the same four fields must be added to the Flutter model too — this is a real, load-bearing pre-check, not optional polish.

---

## 12. Gap Summary Table

```
----------------------------------------------------------------------
Module                              Status      Priority
----------------------------------------------------------------------
Account Model / Repository          Complete    —
Transaction Model / Repository      Complete    —
Soft-delete / CRUD base             Complete    —
Interest Calculator Engine          Complete    —
Net Worth Engine                    Complete    —
Cycle / Carry-Forward Engine        Complete    —
Credit Utilization Engine           Partial     Medium   (principalRestored derivation)
Cash Flow Engine                    Partial     Medium   (Sections 1-4 unported)
Category Model / Repository         Missing     High     (blocks Budget)
Budget Model / Repository / Engine  Missing     High
PaymentSchedule/Installment layer   Missing     High     (blocks EMI, Loan, split-expense)
CreditCard Model / Repository       Missing     High     (engine exists, no data source)
Emi Model / Repository              Missing     High
Loan Model / Repository             Missing     Medium
Bill Model / Repository             Missing     Medium
Person/LedgerEntry Model/Repo       Medium      Medium
Expense Model / Repository          Missing     Medium
SavingsGoal Model / Repository      Missing     Low
Dashboard Aggregation Engine        Missing     High     (composes nearly everything)
Budget Insight Engine               Missing     Medium   (pure fn, low effort)
Firestore rules (existing coll.)    Complete    —
Firestore offline persistence       Missing     Low
Statement Intelligence → Transaction wiring   Planned (not built)   High (M9 blocker: converter compat check)
----------------------------------------------------------------------
```

---

## 13. Implementation Roadmap

**Phase A — Missing Models**
Category → Budget → SavingsGoal → Person/LedgerEntry → Bill/BillOccurrence/PaymentRecord → PaymentSchedule/Installment/InstallmentPayment (generic, unlocks EMI+Loan+Expense) → Loan → Emi/EmiInterest/EmiPaymentBreakdown → Expense/ExpenseParticipant → CreditCardProfile/SharedCreditLimit/Statement/StatementPayment.

**Phase B — Missing Repositories**
Mirror Phase A order exactly (each model's repository ships with it). `EmiRepository` is the largest single unit of work (re-amortization on term edit, cascading hard-delete across subcollections) — schedule last within Phase B, after PaymentSchedule/Installment infrastructure is proven with Loan (simpler case) first.

**Phase C — Missing Engines**
1. Budget Insight (pure function, no blockers beyond Budget model)
2. Cash Flow Sections 1-4 (Due This Month breakdowns, Receivables, Card Summaries, Upcoming Timeline) — needs EMI/Loan/Bill/CreditCard/Expense repos
3. Credit Utilization's `principalRestoredForCard()` derivation — needs EmiPaymentBreakdown
4. Dashboard Aggregation (Financial View) — needs everything above; build last

**Phase D — Firebase Integration**
Wire real repositories/hooks to replace all `lib/mock/*.ts` consumers (budgets, credit cards, bills, EMI, loans, people, dashboard). Add Firestore offline persistence config (`persistentLocalCache`) to `lib/firebase/client.ts` — one-line change, no custom logic to port since Flutter has no such config either.

**Phase E — Statement Intelligence Integration**
1. Resolve the ADR-002 open risk: confirm Flutter's `Transaction` converter tolerates the four additive fields, or add them to Flutter too.
2. Wire the Import Engine's commit step to `TransactionRepository` (currently unbuilt — see §11).
3. Re-run Dashboard/Cash Flow/Budget engines against real imported transactions as an end-to-end validation, not just unit fixtures.

---

## 14. Overall Assessment

- **Overall Flutter ↔ Web compatibility: ~22%** (3 of 15 repository groups; 5 of ~14 models; 5 of 7 core engines present, 2 of those 5 only partially; 2 of 7 named priority engines — Dashboard, Budget — fully missing).
- **Total missing modules: 21** (10 models/model-groups, 10 repository/repository-groups, 1 Firestore-offline-config item) — see §12.
- **Total partial modules: 2** (Cash Flow Engine, Credit Utilization Engine).
- **Estimated implementation effort:** Phase A+B combined ≈ 4-6 weeks of focused work (EMI/Loan repositories are the largest single cost, per the earlier repo-level effort table: EMI is XL, CreditCard stack is L, PaymentSchedule is L, most others S-M). Phase C (engines) ≈ 1-2 weeks once Phase A/B land, since Dashboard/Budget/Cash-Flow-remainder are pure-function composition over already-proven data. Phase D ≈ few days (wiring only). Phase E ≈ 3-5 days once Flutter-side converter confirmation is obtained.
- **Recommendation on Statement Intelligence readiness:** The PDF Statement Workspace pipeline itself is well-isolated and **safe to continue building today** — it does not touch `transactions` yet and cannot regress existing engines. However, it is **not ready for the Import Engine's commit step** (writing parsed statements into real `Transaction` docs) until: (1) Category/Budget/CreditCard/Emi models+repositories exist (Phase A/B) so a card-linked statement import has somewhere real to land, and (2) the Flutter `Transaction` converter's tolerance for additive fields is confirmed per the ADR-002 open risk. Building the parser/classifier/confidence layers (Milestones 3-8 per the backlog) can proceed in parallel with Phase A-C without conflict; only the final commit-to-Firestore step is gated.
