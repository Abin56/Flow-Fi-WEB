# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Transaction Inbox: day-wise browsing - Month, Day, Cards or Rows (2026-11-19)

The Inbox no longer lists every month's transactions in one long scroll, in Grid or in List. A compact day bar sits above them: a month control (previous / next month, plus a menu of the months that have transactions, grouped by year) and a single row of small day numbers - only the days of that month that have transactions. Choosing a day shows only that day's transactions, in whichever layout is selected, under a "03 October 2026 - 2 transactions" heading with previous / next day buttons that cross month and year boundaries.

**Day dock**
- Each day is just its number (about 26px wide; a 31-day month fits on one line on a desktop window). The number of transactions is a quiet row of up to four dots under it (a short bar when there are more); weekday and the exact count are in a small floating label on hover and in the accessible name. The open day is a filled pill in the theme accent (it pops in briefly), the numbers sit on a soft rounded shelf, and they come forward from slightly quieter as the pointer nears.
- Under a mouse the numbers magnify like the macOS Dock: the number under the pointer grows to 1.5x, its neighbours a little (about 1.2x), falling off smoothly and flowing with the pointer; everything returns to its size when the pointer leaves. It is transform-only on a fixed layout, so nothing around it ever moves; it is skipped for touch input and under reduced motion. A click selects the day with a short fill/scale transition and swaps the rows.
- On a narrow window the row scrolls sideways (mouse wheel, trackpad, arrow keys / Home / End) with faded edges, and keeps the open day in view.

**Behaviour**
- Counts, available days and months all come from the rows the existing search / view / direction / account / month filters already produced, so they follow every filter. The chosen day is kept for as long as it has rows; while it has none (filter, dismissal) the closest day with rows shows instead, and the chosen day returns when its rows do (clear the filter, Undo). It is also remembered for the browser session, so coming back to the Inbox lands on it. A new SMS on a newer day adds a day but never moves the view.
- The day bar is sticky under the Inbox's pinned bars; changing day brings the heading back into view if a long day had scrolled it away. Rows of a newly chosen day fade in (none under reduced motion).
- "Select all eligible" now applies to the open day's rows only, in Grid and List (it never ticks rows you can't see) and says so; ticked rows on other days stay ticked and the heading says "N selected on other days".
- The Review drawer's previous / next (J / K, Import & next) still walks every filtered candidate, across days; the day bar stays where you left it.

**Not changed**
- Presentation only: no SMS parsing, candidate/Firestore data, dates, duplicate or account matching, import, Review / Dismiss / Undo handlers or financial calculations are touched; choosing a day reads nothing new and writes nothing. The cards and list rows themselves are unchanged.

**Tests**
- features/transaction-candidates/lib/candidate-day-nav.ts (pure day/month index, nearest-day, adjacency, formatting) + candidate-day-nav.test.ts; components/day-navigator.tsx (dock, month control, heading) + candidate-ledger-days.test.tsx (incl. dockScale and pointer-driven magnification); candidate-ledger.test.tsx.
- tests/e2e-qa/suites/sms-day-nav.mjs (iday-*, incl. real-browser magnification, no-layout-shift and List checks); tests/e2e-qa/lib/inbox-days.mjs (seed on one day / walk the days); the older Inbox suites (sms-*, smsv-*, igrid-*, fs-*, dupm-*, insp-*) now seed on one day or walk the days.

### Sidebar navigation: one click, no stuck top bar (2026-11-18)

**Fixed**
- Sidebar rows sometimes needed a second click, and the slim loading bar at the top of the window could stay frozen at 85 %. Cause: the sidebar set its own "opening" state on pointerdown; that re-render swapped the hover highlight under the cursor, so Chrome dropped the click (no navigation) while the state stayed set - and only a successful route change could clear it.
- The "opening" state now mirrors the router itself (components/layout/nav-pending.tsx, built on useLinkStatus): it is cleared when the route commits, when another click supersedes it, or when the link unmounts, and nothing re-renders a link before its click completes. One progress bar is mounted in the app shell; it runs while a page is opening, then completes and fades.
- tests: components/layout/nav-pending.test.ts; tests/e2e-qa/suites/nav-click.mjs (real hover-press-release on every sidebar row at three click spots, quick-access tiles, drag-off, rapid A-to-B, Back/Forward, slow route). The QA runner now skips a suite file that fails to load instead of aborting the run, and QA_SHOW_SERVER=1 prints the dev server's output.

### Bills dashboard (2026-11-17)

The Bills page is now one cycle-aware payments dashboard instead of a bill list plus a separate 30-day dues strip.

**Added**
- Four headlines for the selected Month Cycle - Due this cycle, Overdue, Upcoming (next cycle) and Paid - with a cycle switcher that follows Settings > Month cycle (start day), not the calendar month. Overdue from earlier cycles is carried until paid.
- One list of every obligation (regular bills, borrowed Loan installments, EMI installments, credit-card statements), each row naming its source module, status and related account/card, filterable by type and status. Bills are paid in place through the existing Pay dialog (account debit, part payment, or already-paid-earlier); Loan / EMI / card rows open the owning module own pay flow for that exact installment, so a payment is recorded once, where the money is tracked.
- Card-funded EMI installments are listed as included in the card statement and never added to any total (existing Case A rule).
- features/my-money/lib/cycle-obligations.ts: the obligation + completed-payment builders extracted from the My Money hook, now shared by My Money and Bills, so the two pages read one set of numbers.
- tests: cycle-obligations.test.ts / bills-overview.test.ts (hand-computed oracle, mutation-checked), bills-workspace.payments.test.tsx, tests/integration/bills-dashboard-sync.test.ts (emulator), tests/e2e-qa/suites/bills-dashboard.mjs.

**Fixed**
- Editing a bill due date changed only the template: the cycle already on screen kept its old date (and its place in Month Cycle / My Money). BillRepository.editBill now also moves the one open, unsettled cycle in the same transaction, audits the move, and refuses (nothing written) a date another cycle already uses or a backwards move that would make the bill roll onto its own record. Paid / skipped cycles are never rewritten.
- Bill writes now also refresh the cycle-history and payment-record queries (60 s stale), so Paid / My Money Completed / Dashboard no longer lag behind a payment made on the Bills page.

**Removed**
- The Bills Card, Loan & EMI Dues strip and its 30-day window (superseded by the cycle-based list). lib/engines/upcoming-dues.ts and its tests are left in place, unused by any screen.

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
