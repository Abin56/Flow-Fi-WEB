# FlowFi WEB — Financial Workflow Performance & Responsiveness Audit

Date: 2026-10-16 · Scope: web only · Branch: `main` (uncommitted; nothing committed, pushed, reset, stashed or deployed)

## 0. Summary

- The slowness is **not mainly Wi-Fi or Firebase itself.** The biggest confirmed cause is code that issues Firestore reads **one after another** when they could be issued together. The wait then grows with the number of installments on the loan.
- On a 60-installment loan, with ~80 ms of simulated round-trip latency, **recording an installment payment fell from 6.35 s to 0.53 s**, and **reversing ("mark unpaid") fell from 13.3 s to 1.02 s** (medians).
- Deleting a transaction from Transaction Studio, the manage modal, bulk delete or the card-payment cancel dialog read the **entire expenses collection on every delete**. It is now one indexed query (335 ms → 115 ms with 200 expenses; the old cost grew with history).
- Plain workflows (add expense/income, transfer, People receipt, card bill payment, plain delete) are about **4–9 network round trips each** (0.3–0.75 s at 80 ms RTT). That is the Firestore-transaction floor, and I did not change it.
- The app already has a good progress system (`lib/operation-progress`, `OperationProgressView`). I found one real feedback gap (Transaction Studio bulk delete) and fixed it. I did **not** audit every dialog in the app (see §5).
- **Limits of this audit (read before trusting any number):** all timings come from the **Firestore emulator**, with latency **simulated** by a TCP delay proxy. No real Firestore, no real network, **no browser profiling** (no authenticated dev session was available). Absolute milliseconds are not production predictions; the relative changes and round-trip counts are the reliable part.

## 1. Method (Phase 1)

| Item | Detail |
| --- | --- |
| Backend | Firestore emulator (`firebase emulators:exec`), synthetic data only, no live data touched |
| Latency model | `tests/perf/latency-proxy.ts` — TCP proxy delaying every chunk by a fixed one-way time. 0 ms = direct; 40 ms one-way ≈ **80 ms RTT** |
| Harness | `tests/perf/workflow-timing.test.ts` (repositories), `tests/perf/app-flow-timing.test.ts` (through `repository-factory`, i.e. the wiring the screens use, incl. the card-bill People gate), `tests/perf/engine-timing.test.ts` (pure CPU) |
| Run | `npm run test:perf` (opt-in via `VITEST_PERF`, excluded from normal runs) |
| Samples | **n = 12** per scenario. "Cold" = first sample in a fresh process; median and p95 over all 12. With n = 12, **p95 is effectively the maximum** — treat it as "worst seen", not a stable percentile |
| Noise | Scenarios I did not change moved by up to ±5% at 80 ms RTT and up to ±25% at 0 ms (those operations take ~40–90 ms). Ignore differences inside that band |

What was **not** measured: click→visible-feedback time, React render/commit time, listener propagation to screens, bundle/chunk load time, real network jitter, Firestore transaction contention from multiple devices. These need a browser session (§8).

## 2. Workflow performance inventory (Phases 2–3)

Round trips ≈ median ÷ 80 ms at 80 ms RTT. "Measured" = timed in this audit.

| Workflow | Entry point | Measured median @ 80 ms RTT | Finding |
| --- | --- | --- | --- |
| Add expense / income | `TransactionRepository.createTransaction` | 312 / 313 ms | ~4 RTT, transaction floor. No change |
| Transfer (atomic pair) | `createTransferPairAtomic` | 592 ms | ~7 RTT. No change |
| Card bill payment | `createTransferPairAtomic` via factory (card-bill People gate on) | 725 ms | gate adds reads in-transaction. No change |
| Delete plain transaction | `softDeleteTransaction` | 503 ms | ~6 RTT incl. the owner-check query. No change |
| Delete from Studio / modal / cancel-bill dialog | `deleteTransactionWithLinkedEffects` | +335 ms lookup (200 expenses) | **full-collection read — fixed** |
| Loan/EMI record payment | `LoanAdvancePaymentRepository.record` | **6351 ms (60 inst.)** | **N sequential reads — fixed** |
| Loan payment reverse ("mark unpaid") | `reversePayment` | **13331 ms (60 inst.)** | **2 sequential loops — fixed** |
| Loan payment edit | `editPayment` → `editAtomically` | not timed | same sequential pattern — fixed with same helper (covered by integration tests, not timed) |
| People receipt (record) | `PersonPaymentRepository.recordPayment` | 491 ms write; 619 ms with the hook's category lookup | lookup is ~125 ms (20%) — candidate, §7 |
| People revert | `revertPayment` | 730 ms | preload + transaction. No change |
| Post-write refresh of derived queries | `DERIVED_QUERY_PREFIXES` invalidation, awaited by the dialogs | 596 ms (5 loans × 24 inst.) | partly fixed (→ 440 ms); the *await* is a UX decision, §7 |
| Pure aggregation (cash flow, month-cycle income, My Spend) | `lib/engines/*` | **≤ 12.4 ms p95 at 20,000 transactions** | **not a bottleneck — no change** |

Not timed (no reliable measurement made): credit-card cancel-payment flow, EMI mark paid/unpaid via `emi-repository`, bulk historical installments, People edit/advance flows, Dashboard / Month Cycle / Net Worth render cost, listener fan-out. They are listed so nothing is implied to be "fine" without evidence.

### Listener inventory
`hooks/use-firestore-watch.ts` is the one subscribe/error/cleanup pattern; ~20 hooks use it, and `lib/services/firestore-watch-registry.ts` already **reference-counts** the real `onSnapshot` so two components watching the same key share one listener. I found no duplicate-listener or teardown/re-setup problem there. The listeners are whole-collection (`where deletedAt == null`) with **no pagination** (`FirestoreCrudRepository.watchAll`); that is an architectural property, see §7.

## 3. Confirmed bottlenecks (Phase 3)

All traced to a specific function, and confirmed by a before/after measurement.

1. **`LoanAdvancePaymentRepository.record`** — `lib/repositories/loan-advance-payment-repository.ts:483` (core transaction ~`:528`). Read each installment with `for … await tx.get(...)`, one network round trip per installment, **inside** the Firestore transaction. Cost = RTT × installments, and it also lengthened the window in which a concurrent change forces a retry.
2. **`reversePayment` → `assertReversible`** (`:1211`) did `for each installment: await getDocs(payments)` — N sequential reads *before* the transaction.
3. **`reversePayment` → `assertScheduleUnchanged`** (`:1259`) did `for each installment: await tx.get(...)` — N more sequential reads *inside* the transaction.
4. **`editAtomically`** (`:1106`) had the same two loops (installments, payments).
5. **`deleteTransactionWithLinkedEffects` → `findExpense`** — `features/transactions/hooks/use-transactions-data.ts:238` called `expenseRepository.getAll()` then `.find(...)`. Studio single/bulk delete, the Studio manage modal and the card-payment cancel dialog don't pass the Expense, so each delete read the whole collection. Studio bulk delete runs the rows concurrently (`applyToCommittedRows`, `Promise.allSettled`), so N deletes did N simultaneous full reads. The same pattern was in `syncLinkedDescription` (`lib/services/transaction-description-sync.ts`) on every description edit.
6. **`useLoanPrincipalPrepaid` query function** — `hooks/use-loan-principal-prepaid.ts`: for every loan it awaited `getAll()` and then `getTrash()` in sequence, then fanned out per installment. This runs after every payment and the payment dialogs wait for it.

Checked and **ruled out**: aggregation engines (CPU ≤ 12 ms at 20k transactions), listener duplication (ref-counted), repeated modal remount (not observed in code; not profiled).

## 4. Safe optimizations implemented (Phase 5)

None of these changes what is read, what is written, any check, any error, or any amount. They change *when* independent reads are issued, or replace a full read with an indexed one.

| # | Change | Why it is safe |
| --- | --- | --- |
| 1 | New private helper `readInstallmentsInTransaction` (`loan-advance-payment-repository.ts:444`): reads the installments with `Promise.all(tx.get(...))`. Used by `record`, `reversePayment`, `editAtomically` | Same document set, still read inside the transaction, so every one is still tracked for conflicts. All reads still precede all writes. Results are keyed by id, so ordering can't change |
| 2 | `reversePayment`: installment, payment and overflow-payment reads issued together | Independent reads; same read set; same writes |
| 3 | `assertScheduleUnchanged`: installments read together, then the same fingerprint comparison runs in the same order | Same checks; still throws `PaymentReversalBlockedError` for the first changed installment |
| 4 | `assertReversible`: the per-installment payments reads issued together, then the same checks in the same order | Read-only, outside the transaction; same exceptions in the same order |
| 5 | New `ExpenseRepository.findActiveByTransactionId` (`expense-repository.ts:279`): `where("transactionId","==",id)`, filters `deletedAt == null` in memory. Used by `use-transactions-data.ts:238` and `syncLinkedDescription` | Same result as `getAll().find(...)`. It is the same single-field equality query `repository-factory` already runs for the owner guard, so no new index. **No schema or rules change** |
| 6 | `fetchPrincipalPrepaidByLoan` (extracted from the hook): active and retired installment reads issued together | Read-only; same data feeding the same `principalPrepaidFor` |
| 7 | Studio bulk delete: in-flight guard + progress (§5) | UI only |

Test-side changes: `description-sync.person-linked.test.ts` mock updated for the renamed dependency; `vitest.config.mts` excludes `tests/perf/**` unless `VITEST_PERF` is set; `package.json` gets a `test:perf` script.

**Not changed, by design:** no dependent write was parallelized; authoritative balance/funds checks, idempotency, stale-data guards, People gate and Firestore transactions are untouched; no optimistic "paid/received" state; no duplicated balance state.

## 5. Before / after timing (Phase 1 evidence)

Median / p95 in ms, **n = 12**, emulator + simulated latency. "Before" and "after" are separate runs on the same machine.

### At ~80 ms RTT (40 ms each way)

| Scenario | Before cold | Before median | Before p95 | After cold | After median | After p95 | Median change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Loan EMI record, 12 installments | 1654 | 1599 | 1695 | 543 | 530 | 550 | **0.33×** |
| Loan EMI record, **60** installments | 6346 | 6351 | 7459 | 579 | 533 | 579 | **0.08×** |
| Loan payment reverse, 12 installments | 3250 | 3267 | 3495 | 902 | 881 | 915 | **0.27×** |
| Loan payment reverse, **60** installments | 16754 | 13331 | 16754 | 1087 | 1018 | 1158 | **0.08×** |
| Find Expense behind a transaction (200 expenses) | 327 | 336 | 360 | 103 | 115 | 120 | **0.34×** |
| Derived refresh, prepaid (5 loans × 24 inst.) | 840 | 596 | 840 | 637 | 440 | 706 | **0.74×** |
| *Control:* add expense | 465 | 320 | 1441 | 419 | 312 | 419 | 0.97× (noise) |
| *Control:* add income | 355 | 323 | 1061 | 331 | 313 | 334 | 0.97× (noise) |
| *Control:* transfer pair | 690 | 621 | 785 | 619 | 592 | 647 | 0.95× (noise) |
| *Control:* People record (lookup + write) | 624 | 654 | 681 | 698 | 619 | 698 | 0.95× (noise) |
| *Control:* People revert | 749 | 739 | 772 | 746 | 730 | 763 | 0.99× (noise) |
| *Control:* card bill payment | 745 | 696 | 745 | 758 | 725 | 758 | 1.04× (noise) |
| *Control:* delete plain transaction | 518 | 510 | 539 | 514 | 503 | 534 | 0.99× (noise) |

The "controls" are paths I did not change; they show the run-to-run noise floor. The loan payment cost is now flat in the number of installments (533 ms for 60 vs 530 ms for 12).

### At 0 ms added latency (emulator only)
Loan record 60 inst.: 250 → 93 ms; loan reverse 60 inst.: 1129 → 245 ms; find Expense: 70 → 19 ms. Sub-100 ms operations in this mode are noisy (controls moved 0.74–1.20×).

The "derived refresh" row compares the old and new query function inside the **same** run (the old one kept as a reference in the test), so it isn't affected by run-to-run drift.

### Not measured (no numbers invented)
Click→feedback latency, validation time, calculation time inside React, listener→screen propagation, "dialog usable again", bundle/chunk loading.

## 6. Loading / progress UX (Phase 4)

**Already in place and verified by reading the code** — I did not rebuild this:
- `lib/operation-progress/operation-progress.ts` + `components/feedback/operation-progress.tsx` + `store/operation-progress-store.ts`: honest stage model (the percentage is stage progress, not fake network progress; 100% only after success; failure freezes the bar and can offer "Try again"; no arbitrary timeouts simulating progress).
- `features/loans/lib/payment-submission.ts`: a **synchronous** in-flight guard (a double click can't start two writes), real stages, and "write committed → a failed refresh is never reported as a failed payment". This is exactly the "Saved but refreshing" distinction.
- Seen in the code with a guard and/or the progress surface: Loan/EMI record, edit and reverse dialogs (`createPaymentSubmission` + `useOperation`), card payment cancel (`card-payment-cancel-dialog.tsx`, `inFlight` ref), People Record Payment (`saving` disables submit), transaction delete in Transactions (`startOperation`), loan delete/save, card save/delete, accounts workspace.
- Write-layer idempotency (`idempotencyKey`) makes a retry after a failure safe; this is covered by the integration suite.

**Gap found and fixed:** Transaction Studio **bulk delete** (`features/transaction-studio/components/bulk-action-bar.tsx`). The confirm dialog closed immediately, then the rows were deleted with **no progress and no guard**, and the toolbar's Delete stayed clickable. Now: a synchronous `deletingRef` guard, Delete buttons disabled while running, and a floating "Deleting N transactions" progress via `startOperation`. The result is still reported by the existing success / per-row-failure toasts (failed rows stay selected for retry), so there is no duplicate or false success message.

**Not audited exhaustively:** I did not review every dialog for a guard. A grep-level pass flagged these as having no obvious in-flight guard or progress surface; I have **not** confirmed whether that is a real gap in each: Studio right-sidebar delete, bills, savings, budgets workspaces, People workspace create/edit/delete handlers. Treat as a follow-up list, not findings.

## 7. Cross-module refresh (Phase 6)

What I could verify without a browser:
- Data layer: after a confirmed write, every screen reads from the same Firestore-listener-backed cache (`useFirestoreWatch`), so Accounts, Transactions, Dashboard and Reports converge when the listener delivers the new snapshot. Derived queries (`loanScheduledPayments`, `loanPrincipalPrepaid`, `emiInstallmentPayments`) are keyed by a fingerprint of live installment state, so they re-run when the installments change, in addition to the explicit invalidation the dialogs trigger.
- Persisted state: the integration suite (`loan-live-refresh-and-audit`, `loan-payment-reversal`, `card-to-account-transfer`, `payment-funding`, `master-financial-integrity-audit` etc.) reads balances, transactions and schedules back from the emulator after each write and reversal through the same engines the screens use. All pass with the changes.
- My changes don't touch what is written, so what converges is unchanged.

**Not verified:** actual on-screen refresh in a browser for Loan → Accounts → Transactions → People → Dashboard → Reports, Credit Card → statements/available credit, People receipt → Dashboard. No authenticated dev session was available.

## 8. Test results (Phase 8)

| Check | Result |
| --- | --- |
| Unit tests (`vitest run`) | **208 files / 2578 tests passed** |
| Emulator integration (`npm run test:integration`) | **31 files / 391 tests passed** (includes 4 new tests in `tests/integration/payment-read-concurrency.test.ts`) |
| TypeScript (`tsc --noEmit`) | clean (an earlier run showed 2 errors in two other untracked in-progress files; they were gone on re-run — not mine) |
| ESLint (whole project) | 0 errors; 1 pre-existing warning (`useReactTable` incompatible-library) unrelated to this work |
| Production build (`next build`) | succeeded |
| Rules / functions emulator suites | not run — no rules, schema or functions changes |

New tests cover: the **same idempotency key sent three times concurrently debits once** on a 24-installment loan; **two different concurrent payments both land with no lost update**; **reversal is still refused** when another payment landed after it; `findActiveByTransactionId` returns the live expense, ignores trashed, returns null when none. Existing tests already cover concurrent payments, concurrent reversals and idempotent re-reversal on the real emulator.

Not run: failed-write and slow-write UI behavior, "no false success" and "loading state cleanup" in a rendered UI against the emulator (I did not verify these end to end; some are likely covered by the existing mocked-UI unit tests, none by an emulator-backed UI run).

## 9. Remaining limitations and items needing your decision

These are **reported, not changed**.

1. **Dialogs wait for the derived-query refresh before showing success.** `record-payment-dialog.tsx` / `recorded-payment-dialog.tsx` `await` `invalidateQueries` on five query prefixes after the write has already committed. Measured ≈ 440 ms at 80 ms RTT for 5 loans × 24 installments (≈ 45% of write + refresh, using the 533 ms write measured above; it was ≈ 600 ms before my fix). The refresh cost scales with the total number of loans/installments the user has, not with the loan just paid. Letting the dialog show "Saved" as soon as the write commits and refresh in the background would feel faster, and the money is already confirmed. But it changes when the dialog closes relative to updated history figures — a deliberate existing design — so I need your call.
2. **Category lookup before every People write** (`getOrCreatePersonalLoanCategory`, 12 call sites): ≈ 125 ms = 1 round trip, ~20% of a People receipt. The id is deterministic, so it could be cached per session, but a cache needs invalidation rules and touches test isolation. Not done.
3. **Transaction floor of 4–9 round trips** for plain writes (begin, reads, commit, plus owner-check queries such as `splitOwnerCandidates` before delete). Some pre-transaction queries could be overlapped; the gain is ~1 RTT each and I didn't measure per-call-site.
4. **Whole-collection listeners with no pagination** (all transactions, expenses, etc.). Every snapshot rebuilds the full cached list. Engine CPU is small (≤ 12 ms at 20k), so the likely cost is React render/commit and listener payload — **unmeasured**. Pagination/virtualization is an architectural change and is not attempted.
5. **Studio bulk delete is N concurrent transactions**, many touching the same account document → possible transaction retries/contention. It already behaved this way; I only removed the N full-collection reads. Contention was not measured.
6. **Other sequential read loops, not measured and not changed:** `loan-repository.ts` (~`:724`, `:763` — edit loan terms), `person-payment-repository.ts` (advance applications, `:282`/`:351`), `loan-advance-payment-repository.ts` `restoreSchedule` / re-amortization (extra-principal path), `agreement-deletion.ts`, `credit-card-deletion.ts`. Worth the same measure-first treatment.
7. **No browser profiling, no real Firestore, no real network.** Simulated latency is a fixed delay per chunk; real networks add jitter, TLS/HTTP2 behavior and server time. Re-measure in a browser with the Performance panel before quoting numbers to users.
8. `tests/perf/*` are measurement tools, not pass/fail tests; they print timings and write JSON lines to `PERF_OUT`. Re-run with `PERF_ONE_WAY_MS=40 PERF_OUT=<file> npm run test:perf`.

## 10. Files touched

Changed: `lib/repositories/loan-advance-payment-repository.ts` (this file also had uncommitted changes from parallel work; I edited only the read paths described above), `lib/repositories/expense-repository.ts`, `features/transactions/hooks/use-transactions-data.ts`, `lib/services/transaction-description-sync.ts`, `hooks/use-loan-principal-prepaid.ts`, `features/transaction-studio/components/bulk-action-bar.tsx`, `lib/repositories/description-sync.person-linked.test.ts`, `vitest.config.mts`, `package.json`.
Added: `tests/perf/{latency-proxy,workflow-timing.test,app-flow-timing.test,engine-timing.test}.ts`, `tests/integration/payment-read-concurrency.test.ts`, this document.
