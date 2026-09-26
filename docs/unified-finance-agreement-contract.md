# Unified Finance Agreement contract (Phase 3)

This is an additive, read-only adapter contract. It does not replace or rename `loans`, `emis`, payment schedules, installments, payments, transactions, credit cards, or people.

## Cross-platform field contract

| Canonical field | TypeScript | Dart | Loan mapping | EMI mapping | Null/default | Storage |
|---|---|---|---|---|---|---|
| `sourceType` | `"loan" \| "emi"` | `UnifiedAgreementSourceType` | `loan` | `emi` | never null | adapter only |
| `sourceId` | `string` | `String` | `Loan.id` | `Emi.id` | never null | adapter only |
| `agreementKind` | enum | enum | `loan` | `installmentPurchase` | never null | adapter only |
| `direction` | enum | enum | `taken→borrowed`, `given→lent` | `borrowed` | EMI direction is explicit normalized behavior | adapter only |
| `repaymentType` | enum | enum | `oneTime` or `scheduled` | `scheduled` | `flexible` is domain-only future support | adapter only |
| `fundingSource` | enum | enum | personal→person; named institution→bank; otherwise other | linked card→creditCard; lender→financeCompany; otherwise other | no guessing beyond stored links | adapter only |
| `personId` | `string \| null` | `String?` | `personId` | null | null if absent | adapter only |
| `creditCardId` | `string \| null` | `String?` | null | `linkedCreditCardId` | null if absent | adapter only |
| `purchaseTransactionId` | `string \| null` | `String?` | null | same persisted field | legacy missing→null | pass-through + persisted on EMI |
| `linkedAccountId` | `string \| null` | `String?` | null | null | no authoritative account ID exists on these records | adapter only |
| `accountReference` | `string \| null` | `String?` | `accountNumber` | `autoDebitAccount` | descriptive only | adapter only |
| `title` | `string` | `String` | name/institution/`Loan` | name | deterministic fallback | adapter only |
| `providerName` | `string \| null` | `String?` | institution | lender | null if absent | adapter only |
| `purchaseAmount` / `downPayment` | `number \| null` | `double?` | null | null | sources do not store these concepts | adapter only |
| `originalPrincipal` | `number` | `double` | `loanAmount` | `principalAmount` | never null | adapter only |
| `remainingPrincipal` | `number` | `double` | schedule principal remaining | schedule principal remaining | original principal while schedule is unavailable | adapter only |
| `liabilityPrincipal` | `number` | `double` | borrowed remaining principal | only adapter-owned EMI liability | zero when closed or purchase already owns it | adapter only |
| `receivablePrincipal` | `number` | `double` | lent remaining principal | zero | zero when closed | adapter only |
| `cardOwnedLiability` | `number` | `double` | zero | Cases B/C remaining principal | Case A zero | adapter only |
| `nonCardEmiLiability` | `number` | `double` | zero | non-card remaining principal | card EMI zero | adapter only |
| `paidPrincipal` | `number` | `double` | interest-first schedule allocation | same | zero while schedule unavailable | adapter only |
| `paidInterest` / `futureInterest` | `number` | `double` | schedule interest allocation | same | zero with no schedule interest | adapter only |
| `interestRate` | `number \| null` | `double?` | interest rate | interest rate | null if no interest | adapter only |
| `interestType` | `string \| null` | `String?` | source enum name | source enum name | null if no interest | adapter only |
| `repaymentFrequency` | `ScheduleType \| null` | `ScheduleType?` | installment frequency | installment frequency | one-time loan→null | adapter only |
| `installmentCount` | `number \| null` | `int?` | source value | source value | one-time loan→null | adapter only |
| `installmentAmount` | `number \| null` | `double?` | next/first schedule amount | next/first schedule amount | null without installments | adapter only |
| `nextDueDate` | `Date \| null` | `DateTime?` | one-time due date or next installment | next installment | null when settled/no data | adapter only |
| `status` | enum | enum | closed/overdue/dueSoon/active | closed/defaulted/overdue/dueSoon/active | `dueSoon` means within seven days | adapter only |
| `sourceStatus` | `string` | `String` | lossless source standing | lossless source standing | never null | adapter only |
| `scheduleId` / `createdAt` | existing source types | existing source types | pass-through | pass-through | never null | adapter only |

## Ownership and aggregation

Adapters call the existing `emiPurchaseRepresentedOnCard` predicate. They do not match amount, merchant, or date. An active linked purchase (Case A) makes adapter EMI liability zero because the purchase owns it. Missing or invalid linkage (Cases B/C) makes `cardOwnedLiability` equal remaining principal. Therefore a tracked ₹60,000 purchase plus its represented ₹60,000 EMI displays one plan while aggregate liability remains ₹60,000.

Aggregate debt is `borrowed Loan liabilityPrincipal + EMI liabilityPrincipal + separately computed card transaction liability`. Lent principal is a receivable, never debt. Future interest is not principal.

## Compatibility findings

- Current Web and Flutter builds round-trip `purchaseTransactionId`; their edit flows retain it unless the user explicitly unlinks it or the card.
- Both repositories still use full-model writes in several edit paths. Builds predating the field cannot preserve a field they never deserialize. Already-distributed old binaries therefore cannot be made safe by this release; users must update before editing linked EMIs. No automatic relinking is permitted.
- Both legacy Loan parsers map an unknown persisted repayment type to `oneTime`. Persisting `flexible` today would therefore be corrupted by an older read/edit/save cycle. Phase 3 exposes `flexible` only in the unified domain enum. A later phase must first ship tolerant pass-through parsing (or capability/version-gated writes) to every supported client.

## Live read and performance architecture

Web composes existing live React Query/Firestore watchers for Loans, EMIs, installments, cards, and transactions in `useUnifiedFinanceAgreements`. Flutter composes the corresponding Riverpod streams in `unifiedFinanceAgreementsProvider`. Ordering is next due date, source type, then source ID. The `(sourceType, sourceId)` pair is the stable identity; no record is written or migrated.

Prepaid principal remains derived from payment/installment history. The Phase 2 code already centralizes this in shared balance-sheet/provider logic; Phase 3 reuses the live schedule streams and performs one in-memory fold per agreement. No persisted `prepaidTotal` or new query was added.

## Future create/persistence strategy

| Agreement | Owning collection/model | Authority and origination | Future payments |
|---|---|---|---|
| Standard Loan | `loans` / Loan | Loan + schedule own terms; direction determines liability/receivable; account transaction only where the existing Loan workflow creates one | existing Loan payment repository |
| Installment Purchase | `emis` / EMI | EMI + schedule own non-card liability; no guessed purchase transaction | existing/future EMI payment repository |
| Card-backed Installment Purchase | `emis` plus Credit Card/Transaction link | active linked purchase owns Case A exposure; EMI owns Cases B/C; create/link the purchase only from an explicit user action | EMI schedule payments; card exposure uses shared ownership predicate |
| Finance-company purchase | `emis` / EMI | lender metadata + EMI own liability; origination transaction only when the user explicitly records account movement | EMI schedule payments |
| Person-financed purchase | future explicit schema decision | do not overload `personId` until Person ledger ownership and transaction direction are specified | must route through one authoritative Person/EMI payment workflow |
| Flexible-repayment agreement | future Loan-compatible schema after client capability rollout | no fake schedule; principal/payment history is authoritative; do not persist `flexible` yet | irregular principal-reducing payments through a single transaction-linked repository |

No unified create UI, migration, schedule regeneration, route removal, or deployment is part of Phase 3.

## Phase 5 persistence decision (approved)

The earlier future-strategy table is superseded for new creation by this decision:

- New ordinary borrowed and lent agreements are `Loan` documents.
- New installment purchases are also `Loan` documents with `agreementKind=installmentPurchase`.
- New Loan documents may persist the additive, byte-compatible fields `fundingSource`, `linkedCreditCardId`, `purchaseTransactionId`, `purchaseAmount`, and `downPayment` on Web and Flutter.
- `loanAmount` is the financed principal and must equal `purchaseAmount - downPayment` for an installment purchase.
- Existing EMI documents remain legacy-compatible records. They are not migrated, regenerated, or used as the write model for new unified purchases.
- A tracked card purchase is linked only by `purchaseTransactionId`; the shared ownership predicate remains authoritative and amount/date matching is prohibited.
- Flexible repayment remains read-domain-only and is not persisted.
- Account origination remains opt-in (see "Phase 5 origination" below).

## Phase 5 origination (atomic, idempotent)

Canonical create path of the unified wizard on both platforms: `LoanRepository.createAgreementWithOrigination` (Web `lib/repositories/loan-repository.ts`, Flutter `lib/features/lending/data/loan_repository.dart`). The legacy `createLoan` is unchanged for the old Loans form.

**Atomicity boundary.** Loan + PaymentSchedule + every Installment + (the one origination Transaction + its Account balance) are written in ONE Firestore `runTransaction`. All reads (Loan sentinel, origination Transaction, movement Account, linked card + purchase) precede all writes; no nested transactions. There is no second phase: installments are built in memory from deterministic ids (`InstallmentRepository.buildInstallments`, the same builder `generateInstallments` now uses). To stay inside one commit, an origination is limited to `MAX_ATOMIC_ORIGINATION_INSTALLMENTS = 480` installments (≤ 484 writes); larger schedules are refused before any write rather than split.

**Idempotency.** The caller creates one key per wizard session (reused on every retry; renewed only after success). Every id derives from it:

| Document | Id |
|---|---|
| Loan | `orig_{key}_loan` |
| PaymentSchedule | `orig_{key}_sched` |
| Installment #n | `orig_{key}_inst_{n}` |
| Origination Transaction | `orig_{key}_txn` |

The Loan is the sentinel read first inside the transaction. Existing → `alreadyCreated: true`, nothing written. A concurrent duplicate conflicts on that read and Firestore re-runs it against the committed sentinel. A retry whose request differs (direction, kind, repayment type, category, movement presence/account/amount) throws `OriginationConflictError` / `OriginationConflictException`.

**Money movement (opt-in; account never inferred from a selection alone).**

| Agreement | Transaction | Account | Allocation | Income/expense totals |
|---|---|---|---|---|
| Money I Borrowed | income, principal | +principal | `additionalDisbursement` | excluded |
| Money I Lent | expense, principal | −principal | `additionalDisbursement` | excluded |
| Installment Purchase, down payment recorded | expense, down payment | −down payment | none | counted (purchase spending) |
| Installment Purchase, financed principal | — | — | — | — |

No purchase Transaction is ever created: a tracked card purchase is only linked (`purchaseTransactionId`, validated to be a live expense on that card's account); Case B keeps using the locked remaining installment principal. Card accounts are refused as movement accounts, which also keeps "my card used for someone else" unavailable. Categories use the existing `loan_payment` placeholder id.

**Classification.** Principal movements reuse the existing `additionalDisbursement` value (every current client parses and round-trips it; a new enum value would be coerced to `regularEmi` by older builds). `isLoanPrincipalDisbursement` = `loanId != null && paymentAllocationType == additionalDisbursement`; such Transactions stay visible in Transactions and keep `excludeFromCalculations=false` (that flag also zeroes `balanceEffect`), but are excluded from income/expense totals — Flutter at `calculableTransactionsProvider`, Web at the Cash Flow / Dashboard / Reports / Analytics / Budgets / Month Cycle aggregation sites via `isNonIncomeExpenseMovement`. This deliberately also reclassifies existing Borrow More / Lend More Transactions (same economic event). Net Worth = accounts ± Loan principal, so origination leaves it unchanged.

**Person ledger.** The origination does not touch `Person.currentBalance`/ledger; `Loan.personId` is the linkage. (Web's legacy `createLoan` action still posts a ledger entry; Flutter never has. The unified wizard on both platforms now matches Flutter.)

**Undo — "Reverse & Delete".** Generic Transaction delete/restore is blocked for `loanId` Transactions. `reverseOrigination(key)` soft-deletes the origination Transaction (reversing its balance effect exactly once) and trashes the Loan in ONE transaction; schedule/installments stay with the trashed Loan. It is idempotent (retry / stale / concurrent duplicates apply once) and refuses (`OriginationReversalBlockedError` / `…Exception`, `reason` = `payment | disbursement | scheduleChanged | closed`) once any payment record exists (even a reversed one), any Borrow/Lend More, any re-amortization event, a changed/skipped installment set, an edited principal/terms/loan date, or a closed Loan. Renames and notes don't block. UI: Web Loan detail "Reverse & Delete" (replaces "Delete Loan"); Flutter Loans swipe-to-delete; both Trash screens.

**Trash and permanent-delete rule (both platforms, enforced in `LoanRepository`).** Trash is an accounting state, not just visibility: a trashed Loan leaves Net Worth. Therefore:

| Origination money state | Trash | Restore | Permanent delete |
|---|---|---|---|
| Legacy / non-wizard Loan | unchanged | unchanged | unchanged |
| Wizard Loan, no movement recorded | allowed | allowed | allowed |
| Movement still active | refused (`OriginationDeleteBlockedError`) → use Reverse & Delete | n/a | refused → UI offers the reversal instead |
| Movement reversed | (already trashed by the reversal) | refused — would bring the debt back without its money | allowed; the reversed Transaction remains as audit in Transactions trash |

A Loan trashed by an older app while its money is active is recovered by the same reversal from Trash. Payment Transactions of trashed legacy Loans are outside this rule (pre-existing, unchanged).

**Remaining.** Flexible repayment is still not persisted. "My tracked card used for someone else" needs a separate Person receivable relationship and remains unavailable.
