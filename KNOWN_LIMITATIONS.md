# Known Limitations

Status as of 2026-08-18 (production hardening pass). This is an honest snapshot, not a defect backlog — items here are either explicitly deferred, out of current milestone scope, or documented product/schema decisions. See `CHANGELOG.md`'s "Production Hardening Pass" entry for what was fixed since the 2026-08-04 snapshot this file previously reflected.

## Backend parity (Web vs. Flutter)

Estimated **~90% backend parity**. Every wired page reads from the same Firestore collections Flutter writes to, through field-for-field ported models/repositories and engines verified against the real Dart source. Remaining gaps:

1. **No balance-history storage** (either app) — every "change vs. last month" figure on Dashboard/Accounts/Credit Cards reports 0 instead of a computed delta.
2. **No category join on some transaction lists** — Accounts and Credit Cards show raw `Transaction.type` (Income/Expense) instead of resolved category name in a couple of recent-transaction lists. Dashboard and the main Transactions page already resolve categories correctly.
3. **EMI create/delete/record-payment/close are now wired** (fixed in the production hardening pass — see `CHANGELOG.md`), including user-facing error handling on all four. `editEmi`/`editEmiTerms`/`reopenEmi`/`markDefaulted`/`clearDefaulted` still have no UI wiring (repository methods exist, no button/dialog calls them).
4. **Loan record-payment and close-loan actions** exist in `useLoanActions()` but still have no button/dialog in the UI yet.
5. **`Loan.personId` reuse for institutional lenders** — bank loans are modeled as a `Person` (name-matched-or-created) rather than a separate lender entity. This is a documented design choice (see `docs/backend-integration-completion-report.md` §6), not a bug.
6. **No Split Expense UI** — `ExpenseRepository` is fully ported but no page consumes it yet.
7. **`currentCycleStatement` always passes `null`** into the Credit Utilization engine — only already-materialized `Statement` documents count toward outstanding balance/utilization; the in-progress billing cycle's spend is not yet included.
8. **No rewards/cashback ledger** — Credit Cards page always shows 0 for reward points/cashback/lounge visits. No such feature exists in either app yet.
9. **Firestore offline persistence is now enabled** (`persistentLocalCache` + multi-tab manager, fixed in the production hardening pass) — was previously unconfigured.
10. **`aiInsight` and `financialHealth` score** on the Dashboard remain mock data — no ported engine exists for either, on either platform (tracked for a later milestone).
11. **Bills `recordPayment` (custom-amount payment) has no UI** — only the quick "Mark Paid"/"Skip" actions are wired; the repository method exists for a future partial-payment screen.
12. **`billsPaidThisMonth` in cash-flow figures stays 0** — EMI/Loan paid-this-month are now real (production hardening pass), but bills have no payment-history data source yet (`useBills()` only returns templates, not per-cycle occurrence history). Needs a new data-fetching hook before it can be wired.

## Deferred product/architecture decisions (identified, not yet acted on)

1. **Loan and EMI deletion are both irreversible** (hard-delete, no Trash) after the production hardening pass made their behavior *consistent* with each other — `deleteLoan` now cascades the same way `deleteEmi` already did. Whether either (or both) should instead be soft-delete/reversible via Trash is an open product decision, deliberately not made during the hardening pass.
2. **Money amounts remain plain floating-point `number`s.** The immediate partial-write/stale-read risk this created was closed (all balance-affecting repository writes are now atomic, reading fresh state inside a Firestore transaction), but the underlying question of migrating to integer minor units (paise) — and the blast radius of doing so — remains a separate, larger decision, not attempted here.

## Document Ingestion Engine (Milestone 1 baseline)

1. **`onCall` wrapper layer untested end-to-end** — `functions/src/index.ts`'s callable-function glue (auth guard, request shaping) has not been exercised through the real Firebase Functions Emulator + Auth Emulator HTTP round-trip. The business logic underneath it is fully tested directly against the Firestore Emulator. Medium severity; planned for Milestone 2 when the Functions Emulator is stood up for the ingestion worker anyway.
2. **`PDF_UNSUPPORTED` error code has no fixture-proven test** — the classification logic (regex-based fallback) exists but no test constructs a PDF that genuinely triggers it via `pdfjs-dist`.
3. **`lib/models/credit-card.ts` (repository) did not exist as of the M1 freeze** — later completed as part of Backend Parity (see above); this entry is retained for historical accuracy of the M1 baseline.
4. **ADR-002's Flutter-compatibility caveat** (additive fields on the `Transaction` shape) remains unverified against real Flutter-written documents. Becomes load-bearing at the Import Engine milestone, not before.
5. **PDF ingestion caps (50MB / 300 pages)** are a reasoned implementation default (Architecture §30 item 7), not yet reviewed by product/security stakeholders. Easily tunable — two constants in `lib/statement-intelligence/ingestion-caps.ts`.
6. **No coverage tooling wired up** (no `v8`/`istanbul`) — coverage claims in milestone reports are qualitative, not percentage-based.
7. **No project formatter configured** — no Prettier config or formatting ESLint rules in either package.
8. **`retryDocumentParsing`'s concurrency guard (added in the production hardening pass) has no dedicated regression test** — `functions/tests/retry-document-parsing.test.ts` documents that this environment has no Storage emulator wired up for it, and reproducing the race needs the full unlock-then-parse flow. The fix itself structurally mirrors `document-analyzer-worker.ts`'s already-tested equivalent guard.

## Local development

- The Firebase Emulator Suite does not always shut down cleanly on all machines — a Java process backing the Storage rules-runtime can occasionally survive `SIGINT` and hold ports 8080/9199. Not a defect in shipped code; kill the process manually if a subsequent emulator run fails to bind.
