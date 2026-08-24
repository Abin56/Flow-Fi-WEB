# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Production Hardening Pass (2026-08-18)

A dedicated correctness/security/reliability pass across the full application, following up on Backend Parity below. Full detail in the session's review/reconciliation reports; summarized here.

**Fixed**
- Account, Transaction, and Person/Ledger balance mutations made atomic — `createTransaction`/`editTransaction`/`softDeleteTransaction`/`restoreTransaction` and the person-ledger equivalents now run inside a single Firestore transaction with a fresh read of the current balance, replacing non-transactional read-modify-write. Closes both a partial-write risk and a stale-caller-supplied-balance risk.
- Transfer transaction integrity: editing a transfer leg's amount/account/date is now blocked (`TransferEditRestrictedError`, with its specific message surfaced to the user instead of a generic fallback); deleting/restoring a transfer now atomically reverses/reapplies both legs together instead of only the one leg being acted on.
- Account/Credit Card deletion now blocks while active transactions still reference the account, instead of silently orphaning them from every income/expense/category total.
- Loan deletion now cascades (schedule, installments, payments) via the same `permanentlyDeleteLoan` path EMI deletion already used, instead of a bare soft-delete that left the schedule active.
- `ExpenseRepository.createExpense` now compensates (soft-deletes the just-created Transaction) if schedule/ledger generation fails partway through, preventing a retry from double-posting.
- Statement duplicate detection: the exact-document-hash dedup path is now actually wired (`documentHash` was previously hardcoded `null`), so re-uploading the same PDF is caught instead of relying only on the weaker period+balance fallback.
- Duplicate-detector merchant matching now uses whole-word matching (reusing the merchant normalizer's existing fix) instead of raw substring matching, closing a false-positive class (e.g. "CRED" matching inside "CREDIT CARD PAYMENT").
- `retryDocumentParsing`'s final write now re-checks document status inside its Firestore transaction (mirroring the worker's existing guard), closing a race window with a concurrent status change.
- Cloud Function Storage path ownership is now explicitly validated (`assertOwnedStoragePath`) at every callable entry point that accepts a client-supplied storage path.
- Firestore offline persistence enabled (`persistentLocalCache` + multi-tab manager) — was previously unconfigured.
- Firestore watcher errors (a failed live listener) now surface to the user via a shared `useFirestoreWatch` mechanism, a global `WatcherErrorBanner`, and a retry path, instead of only reaching `console.error` and leaving the screen looking stuck on "still loading".
- Budget "spent" totals now bucket by the same `accountingMonth`-aware `effectiveMonth` helper Dashboard/Analytics/Reports already used, closing an inconsistency where a transaction with `accountingMonth` set could show in a different month depending on which screen displayed it.
- Credit Card "Available Credit" now reads the engine-computed value (accounting for EMI-locked principal) instead of a UI-side `creditLimit - currentBalance` recomputation that ignored it.
- Dashboard/Reports cash flow now includes real EMI/Loan paid-this-month figures (previously hardcoded to 0); bills remain 0 pending a bill-occurrence payment-history data source (documented, not fabricated).
- Bills and EMI mutation error handling: `bills-workspace.tsx`/`emi-workspace.tsx`'s save/delete/payment/close actions now surface a real toast on failure instead of a `try/finally`-without-`catch` (or no handling at all) that silently absorbed the error while still resetting UI state as if nothing happened.

**Added**
- Firestore rules test coverage extended to every money-bearing collection (`transactions`, `budgets`, `loans`, `emis`, `people`/ledger, `bills`, `expenses`, plus `accounts`/`categories`/`savingsGoals`/`paymentSchedules`/`creditCards`/`sharedCreditLimits`) — owner access, cross-user read/write/delete denial, and unauthenticated denial, plus nested-subcollection coverage (ledger entries, bill occurrences/payments, loan/EMI installments).
- New end-to-end integration test: a parsed statement row approved through to a real Transaction with a real account-balance effect, against a live Firestore emulator.
- Regression tests for every fix above where the existing test architecture allows it (repository-level atomicity/rollback tests, duplicate-detector whole-word-matching tests, watcher-error query-cache-state tests, transfer-pair integrity tests).

**Verified:** 427/427 main tests, 493/493 functions tests (all passing, including the two Cloud Functions tests whose expectations had drifted from a `pdfjs-dist` message-text change), 112/112 Firestore rules tests, clean typecheck/lint (web + functions), production build succeeds (Next.js + functions).

**Known gaps after this pass** — see `KNOWN_LIMITATIONS.md`.

### Backend Parity — Flutter → Web (2026-08-03)

Ported every missing model/repository/engine from the Flutter app and wired all ten finance pages to real Firestore data, replacing `lib/mock/*.ts`.

**Added**
- Repositories: `AccountRepository`, `TransactionRepository`, `CategoryRepository`, `BudgetRepository`, `BillRepository`/`BillOccurrenceRepository`/`PaymentRepository`, `LoanRepository`, `EmiRepository`/`EmiPaymentBreakdownRepository`, `PaymentScheduleRepository`/`InstallmentRepository`/`InstallmentPaymentRepository`, `CreditCardRepository`/`SharedCreditLimitRepository`/`StatementRepository`/`StatementPaymentRepository`, `PersonRepository`/`LedgerRepository`, `SavingsRepository`, `ExpenseRepository` (ported, unused by UI yet).
- Engines ported/wired: net worth, cash flow, budget insight, credit utilization (own/shared/statement-cycle), dashboard aggregation, payment schedule status.
- `collectionGroup` queries for `statements` and `paymentBreakdowns`, with new composite indexes.
- Pages wired to live Firestore data: Dashboard, Accounts, Credit Cards, Transactions, Bills, Budget, EMI (read-only), Loans (partial write actions), People, Savings.

**Known gaps** — see `KNOWN_LIMITATIONS.md`.

### Milestone 1 — Document Upload Foundation (2026-08-03, frozen)

**Added**
- Firestore schema types, `firestore.rules`, `firestore.indexes.json` reconciled onto the existing Flutter-canonical collections (ADR-002).
- `documentTypeRegistry` schema + seed entry for `credit_card_statement` (HDFC, ICICI, Axis, SBI).
- Firebase Storage bucket structure + `storage.rules`.
- Client-side PDF ingestion caps (50MB / 300 pages, magic-byte check), shared client/server logic.
- SHA-256 document hashing (Web Crypto) + `checkDocumentExists` callable Cloud Function.
- Deterministic dedupe key with a Firestore-transaction race fix (closed RFC §28.9 Critical risk #1).
- `PdfDocumentProvider` abstraction over `pdfjs-dist`, standardized error codes, no leaked pdfjs types.
- `decryptDocument` callable for password-protected statement unlock, with a per-key rate limiter (3 attempts / 15 min).
- `functions/` package bootstrapped (Firebase Functions v2, TypeScript), pulled forward from Milestone 2 (ADR-003).
- Local emulator test infrastructure: `npm run test:rules`, `npm run test:functions`.

**Fixed** (root-caused during milestone + freeze, see `docs/milestone-1-exit-report.md` §6 and §8 for full detail)
- Firestore rules: removed a blanket `users/{uid}/{document=**}` rule that silently overrode stricter per-collection rules (Firestore is OR-across-matches, not most-specific-wins).
- Encrypted-PDF test fixture generator: full per-object RC4 encryption, disabled `pdf-lib`'s object-stream packing and default-page injection for fixtures that need exact byte control.
- `PdfjsDocumentProvider`: fixed `doc.destroy is not a function` (destroy via `loadingTask` instead); defensively copies input buffers before handing them to `pdfjs-dist` (which transfers/detaches them).
- Root `tsconfig.json` was accidentally typechecking `functions/` under the wrong environment; added `functions/tsconfig.test.json` and excluded `functions/` from the root config.
- `functions/tests`: replaced non-existent `App.delete()` with `deleteApp(app)`.
- Rate-limit test isolation: `vitest.config.mts` now sets `fileParallelism: false` (tests share one external emulator); test-only namespace used instead of the production rate-limit key.
- `.gitignore`: unanchored `node_modules` pattern so `functions/node_modules` is actually ignored; added `functions/lib/`.
- ESLint: ignored `functions/lib/` (compiled output).

### Initial commit

- Project scaffolded from Create Next App.
