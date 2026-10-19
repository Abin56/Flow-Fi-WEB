# FlowFi Web — Master Financial Integrity & Cross-Module Audit

**Date:** 2026-10-16 · **Scope:** Web only · **Code audited:** `HEAD` = `9e5ffb5` ("12 oct commit") **plus the uncommitted working tree** (99 modified files and ~45 untracked files at audit start — see MFI-O-01). Every conclusion below applies to the working tree as it stood during this audit, not to `HEAD`.
**Mode:** Audit-first. No production code was changed, nothing was committed, deployed, reset or reverted. One test file was added: `tests/integration/master-financial-integrity-audit.test.ts` (5 emulator tests, synthetic data only).
**Method:** Every finding in `docs/web-financial-integrity-audit.md` (2026-10-07) was re-verified against the current code, not trusted. New paths added since then were read from source. Claims marked **Verified** have a traced implementation *and* either a passing test or an executed scenario. Claims marked *code-read* were traced in source but not executed.

---

## A. Executive summary

**Verified state.** The core money paths are now sound. Transaction create/edit/delete/restore, transfer pairs, Record Payment (People), split expenses, Loan payments (record / edit / reverse), EMI payments and card-bill payments are each a single atomic Firestore transaction, are idempotent where a retry can happen, and re-read their inputs inside the transaction. The 2026-10-07 audit's three P0s, ten P1s and most P2/P3s are **fixed in the current code** (classification in §D.2). A new connected lifecycle test (loan + shared expense + partial reimbursement + lender payment edit/reverse + card bill pay/cancel + backdated edit + owner-aware delete + duplicate submits) reconciles to the paisa at every step and leaves **zero drift** by the read-only detectors.

**What is still wrong.**

| | Count |
|---|---|
| New **confirmed** defects | **6** — 1 × P0, 3 × P1, 1 × P2, 1 × P3 |
| Prior findings still **open** (confirmed) | **4** — WFI-P2-04, P2-10, P2-11 (cash-flow half), P2-12 |
| **Unverified / suspected** risks | **7** (§D.4) |
| Process / operational risk | 1 (MFI-O-01) |

**Highest-risk financial operations today**

1. **`/reset-balances` (MFI-P0-01).** An untracked, one-click page that overwrites *every* account and person balance with its opening balance. Not linked from the UI; live in the working tree and included in the production build.
2. **Editing a transaction or People entry from a tab that was open before it was deleted elsewhere (MFI-P1-01 / P1-02).** Moves the account / person balance for a row that stays in the trash. *Demonstrated* on the emulator.
3. **Bill "Mark paid" (MFI-P1-03).** Counts as cash-out in Dashboard and Month Cycle but moves no account — the same class as the old EMI gap (WFI-P1-08), still open for Bills.

**Ready for continued live financial entry?** **Yes, with restrictions** (§H). Ordinary entry — expenses, income, transfers, loans, EMIs, card bills, People, splits — is safe on the current code. The restrictions are: never open `/reset-balances` and delete it before any deploy; avoid saving an edit from a stale second tab; treat Bills "Mark paid" as a reminder, not a payment; and commit the working tree (a large share of the current financial logic exists only there).

---

## B. Financial architecture map

### B.1 Canonical source of truth per value

| Value | Canonical source | Written by | Derived / duplicate consumers |
|---|---|---|---|
| **Account balance** | `Account.currentBalance` (**stored**; rounded to the paisa on every write, `account-repository.ts:309`) | Only `AccountRepository.applyBalanceDelta` inside the same Firestore transaction as the movement | `openingBalance + Σ balanceEffect(active txns)` is the invariant; checked read-only by `accountBalanceDrift` (`lib/engines/stored-balance-drift.ts`) and by `account-statement.ts` |
| **Transaction effect** | `balanceEffect(t)` (`lib/models/transaction.ts:221`): 0 when person-funded or `excludeFromCalculations`, else signed amount | — | Every repository and the statement/breakdown views use this one function |
| **Person balance** | `Person.currentBalance` (**stored**, rounded on write) + ledger entries | `PersonRepository.applyBalanceDelta` inside the ledger-entry transaction | `personBalanceDrift`; `personBalanceBreakdown` splits it into To receive / To give / Advance |
| **Loan / EMI outstanding** | Installments + active payment records (`outstandingPrincipalAfterPrepaymentsFor`) | Loan: `LoanAdvancePaymentRepository`; EMI: `useEmiActions` (both one atomic transaction) | Net Worth, People loan positions, Debt Planner |
| **Card liability** | Card **account** `currentBalance` (stored) for the cash view; `cardBillsForCard` + `settleCardPayments` for bills/Pay bill; `computeCreditCardStandings` for outstanding / utilization | Transactions on the card account | See B.3 — two derived chains, now sharing `countsTowardCardStatement` |
| **Income / spend totals** | `classifyForMySpend` (My Spend); `cycle-transaction-mapping.ts` (Month Cycle hero + Dashboard cash flow) | — | Dashboard weekly bars and Reports weekly bars use **inline loops** (MFI-P2-01) |
| **Net Worth** | `netWorthWithLoans` = Σ account balances + lent − borrowed − EMI − card-locked EMI + People balance | — | Dashboard, Reports, My Money |
| **Month Cycle window** | `cycleRangeFor(startDay, date)` | — | Start day lives in browser `localStorage` (WFI-P2-04, open) |
| **Split / assigned expense** | `Expense` (shares) + its `Transaction` (account effect) + `PaymentSchedule/Installment` (settlement tracking) + ledger entries (`transactionRef`) | `ExpenseRepository` (one Firestore transaction for edit / delete / restore) | My Spend = `myShare`; People receivable = ledger |

### B.2 Write layer

All money-moving writes use `runTransaction` and read fresh inside it. No Cloud Function writes any financial collection: the only functions are document ingestion, parsing and staging, and none touches `currentBalance`, transactions, ledger entries or installments (grep of `functions/src`). There is therefore no server-side balance maintenance — **every invariant is client-enforced**, and the rules validate no financial field (WFI-P2-12).

### B.3 Duplicated calculations (the places two answers are possible)

| Concept | Chains | Status |
|---|---|---|
| Card bill / outstanding | `cardBillsForCard` (Pay bill, Month Cycle dues, Dashboard upcoming, People gate) vs `computeCreditCardStandings` (outstanding, available, utilization, Pay-full prefill) | Both now filter through `countsTowardCardStatement` / `cardStatementAmount`; the statement-day double count, the all-unpaid-as-this-month bug and the card→bank transfer gap are fixed (`credit-card-repository.ts:513-575, 950-969`). Still two chains. |
| Money-out / money-in | `cycle-transaction-mapping.ts` → Month Cycle + Dashboard tiles; inline loops → Dashboard bars, Reports bars | **Inconsistent** — MFI-P2-01 |
| Cash vs accrual for card spending | Dashboard Money Out: cash basis (card purchase counted when the bill is paid). Month Cycle: accrual (counted at purchase) | Intentional product exception (§D.5) |

---

## C. Cross-module consistency matrix

Legend — **V** Verified (traced + executed/tested) · **F** Failed · **P** Partially verified · **N** Not tested. "Idem." = idempotent under retry. Test refs: **LA/LB** = this audit's Lifecycle A/B, **MFI-T1**, **WFI** = `web-financial-integrity-audit.test.ts`, **PF** = `payment-funding.test.ts`.

| # | Event | Entry → repository | Docs written | Account cash | Liability / People | Reports (Dashboard · Month Cycle · NW) | Reversal | Atomic · Idem. | Tests | Result |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Create expense | Add-transaction modal → `createTransaction` | `transactions`, `accounts` | −amt once | — | Month Cycle outflow, My Spend, NW −amt | `softDeleteTransaction` | Atomic · **no idempotency key** (WFI-P2-10) | LA, WFI | **V** (retry-after-lost-response **P**) |
| 2 | Edit expense | Edit modal → `editTransactionInTransaction` | same | Δ of fresh doc | owner-owned money edits refused (`:856-868`) | recalculated | — | Atomic · reads fresh | WFI, LA step 9 | **F** — editing a **trashed** row still moves the account (MFI-P1-01) |
| 3 | Delete expense | modal → `softDeleteTransaction` | same | +amt once | split/People/loan-owned refused | disappears | `restoreTransaction` | Atomic · idempotent · stale-safe (`:946-965`) | WFI, LA | **V** |
| 4 | Create income | same path as 1 | same | +amt | — | income | delete | as 1 | WFI | **V** |
| 5 | Edit / delete income | as 2 / 3 | | | | | | | | **F** (edit of trashed, MFI-P1-01) / **V** (delete) |
| 6 | Transfer | modal → `createTransferPairAtomic` | 2 legs (+fee), 2 accounts | src −, dst + (fee netted) | — | excluded from income/spend; NW 0 | `deleteTransferPair` | Atomic · idempotent (`xfer_<key>`), retry with changed data refused | LA (retry), WFI | **V** |
| 7 | Transfer cancel | → `deleteTransferPair` | | both legs reversed once | — | | `restoreTransferPair` | Atomic · idempotent (repeat = no-op) | LA (cancelled twice), WFI | **V** |
| 8 | Loan creation / disbursement | `createAgreementWithOrigination` | loan, schedule, installments, origination txn, account | +principal (taken) | liability +principal | **not income** (`additionalDisbursement`), NW unchanged | `reverseOrigination` | Atomic · idempotent | LA step 2 + existing origination suites | **V** |
| 9 | Loan principal edit | `editLoanTerms` | loan, schedule | none | refused while deposit active (`loan-repository.ts:949-955`) | — | — | pre-check outside the write (race negligible) | **MFI-T1** (new; fix had no test) | **V** |
| 10 | Loan installment | `LoanAdvancePaymentRepository.record` | txn, installments, payment, account | −amt once | outstanding −principal portion | outflow per recognition rule | `reversePayment` (latest only) | Atomic · idempotent | LA, loan-payment-*.test | **V** |
| 11 | Partial EMI payment | `useEmiActions.recordPayment` | installments, payment, breakdown, **txn on chosen account** (WFI-P1-08 fixed) | −amt | remaining kept | outflow once (`emiId` rows dropped, installment counted) | `reversePayment` | Atomic · idempotent (`emiPaymentId(key,0)`) | PF, emi-paid-earlier | **V** (UI requires an account; the repository does not — MFI-P3-02) |
| 12 | Extra principal | `record` with overflow | + re-amortization event | −amt | principal ↓, schedule re-planned | | `reversePayment` / `editPayment` | Core atomic; **re-plan is a second unit** (retry completes it) | loan-payment-edit, loan-advance-payment | **P** |
| 13 | Bulk installments | `bulk-recorded-earlier` → per-installment `recordPayment` | per installment | none (recorded earlier) or per-row | per installment | | per payment | Each installment atomic + own key; retry only failed | `bulk-recorded-earlier.test`, `emi-paid-earlier.test` (existing) | **V** |
| 14 | Loan payment edit / reversal | `editPayment` / `reversePayment` | | net delta once | | | latest action only | Atomic (or reverse-then-record with resumable error) | LA steps 6–7, loan-payment-edit | **V** |
| 15 | Card-linked EMI payment | `recordPayment` with `linkedCard` | card txn, installments | card account (no bank debit) | card lock ↓ | outflow when bill paid (Dashboard) / at payment (Month Cycle) | `reversePayment` | Atomic · idempotent | card-emi-ownership, PF | **V** |
| 16 | Card purchase | `createTransaction` on card account | txn, card account | card balance −amt | statement/bill + | Month Cycle at purchase; Dashboard at bill payment | delete | as 1 | LA step 8 | **V** |
| 17 | Card bill payment / cancel | `createTransferPairAtomic` (People gate, statement intent) / `deleteTransferPair` | | bank −, card + | bills settled oldest-first | not an expense; cash-out once | cancel restores both | Atomic · idempotent · gated | LA steps 8, card-bill-people-gate | **V** |
| 18 | People assignment / split create | `createExpense` | expense, schedule, installments, ledger, txn | −full | Ravi +share (owner share not a receivable) | My Spend = my share | `deleteExpense` | Atomic (one tx) | LA/LB | **V** |
| 19 | People receipt | `PersonPaymentRepository.recordPayment` | cash leg (`isPersonLedgerMovement`), ledger, installment | +amt into chosen account **only when real** | receivable −amt | not income | `revertPayment` | Atomic · idempotent key · stale-person refusal | LA step 4, LB, WFI | **V** |
| 20 | People settlement reversal | `revertPayment` | | −amt | receivable restored | | | Atomic · "already reverted" | LA step 12, LB | **V** |
| 21 | Split edit / delete / restore | `editExpense` / `deleteExpense` / `restoreExpense` | all of #18 | Δ once | shares ± ; retired entries stamped `retiredBy` | | delete↔restore | **One Firestore transaction**, idempotent | LB (delete ×2, restore ×2, refused edit) | **V** |
| 22 | Historical payment already in balance | `recordedEarlier` / `excludeFromCalculations` | txn flagged / no txn | **none** (`balanceEffect = 0`) | installment/ledger updated | excluded from totals | revert | Atomic | LA step 10, emi-paid-earlier, historical-reimbursement | **V** |
| 23 | Backdated edit | `editTransaction` with a new `dateTime` | | Δ only | | re-bucketed by `effectiveMonth` / cycle window | | Atomic | LA step 9 (balance); period attribution unit-tested only | **V** (balance) · **P** (period) |
| 24 | Purpose money / advances | `purpose-fund-repository` (+ `enforceFunds`) | | out via expense + gate | advance held, not receivable | | `revertPayment` blocks while used | Atomic | `purpose-fund-repository.test` (24 unit); no emulator scenario here | **P** |
| 25 | **Bill "Mark paid"** | `BillOccurrenceRepository.markPaid` | occurrence `amountPaid` only (+ optional `PaymentRecord`) | **none** | — | **counted as outflow** in Dashboard + Month Cycle | n/a | single `update` of the caller's copy; `recordPayment` is two writes (not wired to UI) | none for the cross-module effect | **F** (MFI-P1-03) |

---

## D. Findings register

### D.1 New findings (this audit)

#### MFI-P0-01 · **P0** · Confirmed (code-read; not executed) · Accounts + People · A one-click page resets every balance to its opening balance
- **Files:** `app/(app)/reset-balances/page.tsx` (untracked, `?? ` in `git status`).
- **Root cause:** A "TEMPORARY one-off page — delete this folder after use". `run()` loops every account and person and calls `updateFresh(id, fresh => ({ ...fresh, currentBalance: fresh.openingBalance }))`. It ignores all live transactions and ledger entries, writes no `editHistory`, and has no confirmation, no type-to-confirm and no dry run. It sits under `app/(app)/`, so it is a real route behind sign-in only (`RouteGuard`). The production build lists `○ /reset-balances`.
- **Reproduction:** Sign in → open `/reset-balances` → press **Reset balances**. (Not executed against any data.)
- **Impact:** Every account and every person balance becomes `openingBalance` while all transactions and entries remain. Net Worth, Accounts, Credit Cards (card account), People and the drift detectors are then all wrong. Recovery requires recomputing `openingBalance + Σ balanceEffect` per account and `openingBalance + Σ signedAmount` per person.
- **Coverage:** none (intentionally).
- **Fix:** Delete the folder. No migration needed. If a reset is ever needed again, recompute from the records (the `accountBalanceDrift` / `personBalanceDrift` detectors already compute the expected value) behind a dry run + type-to-confirm.
- **Risk of correcting:** none.
- **Safe temporary restriction:** do not open `/reset-balances`; delete the folder before any `next build` that is deployed.

#### MFI-P1-01 · **P1** · **Confirmed — executed** · Transactions → Accounts · Editing a *trashed* transaction still moves the account
- **Files:** `lib/repositories/transaction-repository.ts` — `editTransactionInTransaction` (`:756-915`). It re-reads the document but never checks `fresh.deletedAt`; `softDeleteTransactionInTransaction` (`:946-951`) does.
- **Reproduction (pinned):** Bank ₹5,000 → create expense ₹1,000 (bank 4,000) → tab A deletes it (bank 5,000) → tab B, opened before the delete, saves the amount as ₹2,000 → **bank 4,000** while the row is still in the trash. `accountBalanceDrift` reports drift. Test: `master-financial-integrity-audit.test.ts` — "PINS BUG MFI-P1-01".
- **Root cause:** The edit computes `delta = newEffect − oldEffect` from the fresh *trashed* document, whose effect was already reversed at delete time.
- **Modules affected:** Accounts, Dashboard assets, Net Worth, Credit Cards (card account). Not Month Cycle (row is trashed).
- **Impact:** Drift equal to (new amount − old amount) per occurrence. Requires two tabs/devices plus a delete; no data is lost, but the account and its records disagree until corrected.
- **Fix (smallest):** In `editTransactionInTransaction`, after the fresh read: `if (fresh.deletedAt != null) throw new TransactionChangedError()` (or a dedicated "was deleted" error already mapped in `error-toast.ts`). Flip the pin to expect the throw and an unchanged balance.
- **Risk of correcting existing data:** possible existing drift cannot be inferred from the code. Use the read-only **Financial Audit** page (`/financial-audit`, built on the same detectors) to find affected accounts; correct manually.

#### MFI-P1-02 · **P1** · **Confirmed — executed** · People · Editing a *trashed* ledger entry still moves the person's balance
- **Files:** `lib/repositories/person-repository.ts` — `LedgerRepository.editEntry` (`:564-626`); `softDeleteEntry` (`:657`) and `restoreEntry` (`:819`) check `deletedAt`, `editEntry` does not.
- **Reproduction (pinned):** Entry "gave ₹1,500" → deleted (balance 0) → stale tab edits the amount to ₹2,000 → **person balance ₹500** with the entry in the trash. Test: "PINS BUG MFI-P1-02".
- **Impact:** Receivable/payable shown for a deleted entry; flows into People, Month Cycle sides and Net Worth. Same two-tab precondition as MFI-P1-01.
- **Fix:** `if (fresh.deletedAt != null) throw …` after the fresh read in `editEntry`. Same data-detection route.

#### MFI-P1-03 · **P1** (needs a product decision) · Confirmed (code-read) · Bills ↔ Accounts ↔ Dashboard / Month Cycle · "Mark paid" moves no account yet counts as cash-out
- **Files:** `lib/repositories/bill-repository.ts` `markPaid` (`:409-419`), `PaymentRepository.recordPayment` (`:464-484`); `features/bills/hooks/use-bills-data.ts:17-24` documents it ("never creates a Transaction or touches `Account.currentBalance`" — Flutter parity). Consumers: `hooks/use-transactions.ts` (`billsPaidThisMonth` → Dashboard Money Out) and `use-month-cycle-data.ts` (bill occurrences in total outflow).
- **Effect:** Paying a ₹2,000 bill: Money Out +2,000, Month Cycle outflow +2,000, but the bank balance and Net Worth do not move. If the user also records the bank debit as an expense (which is what the bank statement shows), the outflow is counted twice. This is the exact class WFI-P1-08 described for EMIs, which was fixed by posting a transaction on a chosen account; Bills were not given that treatment.
- **Secondary (not UI-reachable):** `PaymentRepository.recordPayment` is two sequential writes and `softDeletePayment` reverses the occurrence *then* deletes; a failure between them double-reverses on retry. Documented as "FUTURE ENTRY POINT — not reachable from any UI".
- **Fix direction:** Add a paid-from account and post a transaction like EMI/Loan payments do (and exclude `emiId`-style rows from the bills outflow), **or** stop counting bills in Money Out. Needs a product decision and Flutter coordination (Flutter has the same contract).
- **Data impact:** none stored; the discrepancy is between accounts and the outflow figures.

#### MFI-P2-01 · **P2** · Confirmed (code-read) · Dashboard / Reports · Weekly cash-flow bars disagree with the headline Money In / Out
- **Files:** `features/dashboard/hooks/use-dashboard-data.ts:213-222`, `features/reports/hooks/use-reports-data.ts:142-159`.
- **Root cause:** Both build the weekly bars with inline loops instead of `cashFlowTransactions` (`lib/engines/cycle-transaction-mapping.ts`), which is what the headline tiles use. The loops skip `excludeFromCalculations` (the headline drops those rows — WFI-P1-05 fix), still include `emiId` payment rows (the headline replaces them with installment amounts), and the Reports loop also includes card-account purchases (the headline treats those as non-cash) and counts expenses only.
- **Impact:** Bars do not sum to the tile when any excluded/"recorded earlier", EMI or card-account row exists in the month. Display only; no stored value is wrong.
- **Fix:** Feed both loops from `cashFlowTransactions` (+ the same month filter). No data migration.
- **Coverage:** none — the engine tests receive pre-filtered inputs (same gap the earlier audit named).

#### MFI-P3-01 · **P3** · Confirmed (code-read) · People · `editEntry` has no repository-level ownership refusal
- **Files:** `person-repository.ts:564-626`; the only guard is the UI predicate `isEditable` (`ledger-ui.tsx:200`, `row.entryId != null && row.deletable`).
- **Effect:** Calling `editEntry` on a Record-Payment-owned entry (`paymentId` set) changes the person's balance without touching its cash leg, installment or obligations. The Transactions page routes only `borrowed`/`gave` cash legs to it (`use-transactions-data.ts:293-318`), and generic edits of the payment's cash leg are refused (`OwnedTransactionEditError`), so no current UI path reaches this.
- **Fix:** Refuse entries with `paymentId`/`installmentPaymentRef`/split `transactionRef` in the repository, mirroring `declaredTransactionOwner`.

#### MFI-P3-02 · **P3** · Confirmed (code-read) · EMI · `recordPayment` accepts a non-card, non-"recorded earlier" payment with no account and silently posts nothing
- **Files:** `features/emi/hooks/use-emi-data.ts:299-318` (`payingAccountId = … ?? params.accountId ?? null`; `if (payingAccountId)`).
- **Effect:** The UI blocks it (`record-payment-dialog.tsx:352,362`), so only a non-UI caller reproduces the old WFI-P1-08 state (principal ↓, no cash movement). Hardening: throw when `!recordedEarlier && linkedCard == null && params.accountId == null`.

#### MFI-O-01 · Process risk · Confirmed · Large amount of financial logic is not in git
- At audit start: 99 modified and ~45 untracked files, including whole financial modules — `lib/engines/payment-funding.ts` (insufficient-funds enforcement), `recorded-earlier.ts`, `historical-reimbursement.ts`, `bulk-recorded-earlier.ts`, `financial-audit.ts`, `features/accounts/lib/balance-breakdown.ts`, `account-statement.ts`, `card-payment-cancellation.ts`, six integration suites, and `app/(app)/financial-audit` / `reset-balances`. The last commit (`9e5ffb5`) predates all of it. A lost working tree loses the guards this audit relies on. (This audit did not commit — per its rules.)

### D.2 Prior findings (2026-10-07) — current classification

| ID | Status | Evidence (current code) |
|---|---|---|
| P0-01 delete idempotency / stale | **Fixed** | `transaction-repository.ts:946-965`, `:1110-1146`; WFI integration tests; LA/LB |
| P0-02 owned-transaction edits | **Fixed** | `:856-868`, `declaredTransactionOwner :190`; WFI tests 11–16 |
| P0-03 ledger delete/restore idempotency | **Fixed** | `person-repository.ts:643-664, 806-826` |
| P1-01 split Settle without cash | **Fixed** | `ledger-ui.tsx:392` (all kinds need an account); `settleParticipant` `@deprecated`, unwired |
| P1-02 statement-day double count | **Fixed** | `credit-card-repository.ts:513-517, 549`; pin flipped to FIXED |
| P1-03 "Spent this month" = all unpaid | **Fixed** | `:541-549, 570-575` |
| P1-04 transfer out of a card on no bill | **Fixed** | `countsTowardCardStatement :950-952` (outgoing leg billed) |
| P1-05 exclude flag lost | **Fixed** | `cycle-transaction-mapping.ts:12, 25, 51` — **but see MFI-P2-01 for the bars** |
| P1-06 card EMI double outflow | **Fixed** | `:28`, `use-transactions.ts:152` |
| P1-07 loan principal edit vs deposit | **Fixed (code)** — now also tested | `loan-repository.ts:949-955`; **MFI-T1** |
| P1-08 non-card EMI no account leg | **Fixed for new writes**; legacy payments remain (§G); API gap MFI-P3-02 | `use-emi-data.ts:299-318` |
| P1-09 / P1-10 split atomicity, scoped restore | **Fixed** | `expense-repository.ts:915-1000, 1359-1493`; LB |
| P2-01 card refund as income | **Fixed** | `cycle-transaction-mapping.ts:29` |
| P2-02 Dashboard upcoming reads stored `amountPaid` | **Fixed** | `use-dashboard-data.ts:387-415` |
| P2-03 two card-debt figures | **Unverified** (not re-traced) |  |
| P2-04 cycle start day per browser | **Open** | `use-user-preferences.ts:4, 103, 131` (`localStorage`) |
| P2-05 EMI dues show only next installment | **Fixed** | `use-month-cycle-data.ts:358-379` |
| P2-06 three bucket-date rules | **Partially fixed** — hero + account-spend share `mySpendBucketDate` (`:81-82`); `amountFor` still has its own strategy |  |
| P2-07 concurrent advance apply | **Fixed** | lock-token write, `person-payment-repository.ts:281-305` |
| P2-08 opening obligation Settle | **Fixed** | `ledger-ui.tsx:391-392` |
| P2-09 reversal eligibility outside tx | **Fixed** | re-check inside the transaction (`loan-advance-payment-repository.ts:1231-1235`) |
| P2-10 no idempotency key on plain/split create | **Open** | no `idempotencyKey` passed by the modal (only transfers) or `createExpense` |
| P2-11 proxy month attribution | **Partially fixed** — EMI by payment date (`use-month-cycle-data.ts:264-266`); `moneyReceivedThisMonth` still by the expense's month (`use-transactions.ts:156-167`) |  |
| P2-12 no rules field validation | **Open** | `firestore.rules` unchanged; owner-only `read, write` |
| P2-13 converters throw on bad doc | **Fixed for list reads** | `lib/firestore/safe-docs.ts` |
| P3-01, P3-02, P3-03, P3-04, P3-07 | **Fixed** | `web-financial-integrity-audit.test.ts` (credit-cards) FIXED pins; `expense-repository.ts:315`; `use-month-cycle-data.ts:248`; `error-toast.ts:25-36`; `account-repository.ts:146` |
| P3-08 Studio UTC dates | **Likely fixed** (`committed-transaction-sync.ts:82` is now only a parse fallback) — not executed |  |
| P3-05, P3-06, P3-09, P4-01, P4-04 | **Unverified** (UI / dead-code items, not re-traced) |  |
| P4-02 dead `adjustBalance` / `reconcileBalance` | **Open** (still present, `account-repository.ts:323-347`; detector now exists separately) |  |
| P4-03 raw float balances | **Fixed** (rounded on write, both repositories) |  |

### D.3 Carried-over findings still open

WFI-P2-04, WFI-P2-10, WFI-P2-11 (cash-flow half), WFI-P2-12 — unchanged from the prior register; see `docs/web-financial-integrity-audit.md` §20 for their reproduction.

### D.4 Unverified / suspected risks

| ID | Risk | Why unverified |
|---|---|---|
| MFI-U-01 | **Unbounded `editHistory` on `Account` / `Person`.** `recordEdit` appends one entry per balance write (`soft-deletable.ts:28-41`, `applyBalanceDelta`). At roughly 130 B per entry, a Firestore document (1 MiB) fills after on the order of 8,000 balance writes to one account or person; every later write to it would then fail (cleanly — the transaction aborts). | Size is an estimate, not reproduced. Capping the history changes a field the Flutter app also reads, so it needs coordination. |
| MFI-U-02 | Real-data drift from the already-fixed P0-01/02/03, P1-01, P1-07, P1-09 and from MFI-P1-01/02. | Needs the read-only Financial Audit run on real records (§G). |
| MFI-U-03 | Account permanent-delete cascade and Credit-card deletion with live People/Loan links. | Read at a high level only; not executed. |
| MFI-U-04 | Purpose-money flows end-to-end (release to advance/income, uses, revert-while-used). | Unit tests only; no emulator scenario in this audit. |
| MFI-U-05 | Legacy Flutter-written documents with odd shapes (string amounts, missing timestamps on point reads). | `safe-docs` covers lists; point reads and the `amount` cast are unchanged. |
| MFI-U-06 | Cloud Functions suite (`npm run test:functions`) — **could not run**: `functions/node_modules` is not installed (all 15 failed suites are `Cannot find package 'firebase-admin/...'` / `pdfjs-dist`, plus 18 PDF tests with the same root cause). Not a financial path (no function writes money). | Environment; installing dependencies would modify the tree. |
| MFI-U-07 | Bills occurrence writes use whole-document `update` of the caller's copy (a stale tab can overwrite a concurrent skip/paid). | Code-read; low value, not reproduced. |

### D.5 Documented product-specific exceptions (not defects)

1. **`excludeFromCalculations` = account-neutral.** `balanceEffect` is 0 for such rows, so historical / "already in my balance" records never move an account (verified: LA step 10; recorded-earlier, historical-reimbursement suites).
2. **Cash vs accrual for card spending.** Dashboard Money Out counts a card purchase when the *bill* is paid; Month Cycle counts it at *purchase*. Both count a bill payment as a transfer (never an expense).
3. **Deleting a split expense keeps real repayments.** The share is retired; Ravi's ₹400 that really arrived stays, so Ravi's balance becomes −₹400 (I owe him) until that repayment is reverted. Verified in LA step 11 → 12.
4. **Funds enforcement is opt-in per caller.** `enforceFunds` is set by payment flows (Loan, EMI, People "I paid", card bill, purpose money, transfers). A plain income/expense create or a generic transaction edit never checks the balance — by design (it records what happened), but it means "insufficient funds" is a UX-layer promise for those flows, not a repository invariant.
5. **Dashboard "Money In" includes split reimbursements** (from `Installment.amountPaid`), bucketed by the expense's month.

---

## E. Test evidence

All commands run from the repo root on 2026-10-16.

| Check | Command | Result |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | **exit 0**, no errors |
| ESLint | `npx eslint` | **0 errors, 1 warning** (`react-hooks/incompatible-library` on TanStack `useReactTable`, `spreadsheet.tsx:77`, pre-existing) |
| Unit | `npx vitest run` | **208 files / 2,578 tests — all pass** |
| Integration (emulator) | `npm run test:integration` | **29 files / 369 tests — all pass** (28 files / 364 existing + the 5 new tests) |
| New file only | `firebase emulators:exec … vitest run tests/integration/master-financial-integrity-audit.test.ts` | **5 / 5 pass** |
| Firestore rules | `npm run test:rules` | **3 files / 118 tests — all pass** |
| Production build | `npm run build` | **exit 0** ("Compiled successfully", Next 16.2.12 Turbopack); routes include `/financial-audit` and **`/reset-balances`** |
| Cloud Functions | `npm run test:functions` | **could not run** — `functions/node_modules` missing (MFI-U-06): 18 failed files/tests, all `Cannot find package`; 407 other tests passed |

**What the new file proves** (`tests/integration/master-financial-integrity-audit.test.ts`; expectations computed independently in integer paise, then cross-checked with `accountBalanceDrift` / `personBalanceDrift` after every step):

| Test | Scenario |
|---|---|
| PINS BUG MFI-P1-01 | stale edit of a trashed expense drifts the account (asserts current wrong behaviour; fails when fixed) |
| PINS BUG MFI-P1-02 | stale edit of a trashed ledger entry drifts the person balance |
| MFI-T1 | loan principal edit refused while the deposit is active; term-count edit still works; nothing moves |
| **Lifecycle A** | Bank ₹1,00,000 / Savings ₹20,000 / Card → real ₹50,000 loan disbursement (not income) → ₹2,000 dinner split with Ravi → Ravi repays ₹400 into *Savings* → lender instalment ₹10,000 → **edit to ₹6,000** → **reverse** (Ravi untouched throughout) → card purchase ₹3,000 → bill paid (idempotent retry = no-op) → **cancelled twice** → backdated edit of the purchase to ₹3,500 → account-neutral ₹7,777 historical row (no change) → owner-aware delete of the dinner → revert of the reimbursement. Final conservation: ₹1,66,500 = 1,00,000 + 20,000 + 50,000 − 3,500. |
| **Lifecycle B** | split → full repayment into Cash → over-reaching edit refused → revert → edit total 1,200→600 → delete ×2 → restore ×2 → duplicate submit with one idempotency key records the cash once |

**Coverage not added** (existing suites already cover and passed): transfer atomicity/idempotency, Record Payment stale/duplicate refusal, Loan/EMI payment edit/reverse, bulk historical retry, payment-funding, agreement deletion, shared-loan ownership, card People gate.

---

## F. Repair plan (awaiting approval — nothing below has been implemented)

Ordered by accounting risk × dependency × regression potential. All are small, local changes unless noted.

| # | Fix | Finding | Size | Migration / manual step |
|---|---|---|---|---|
| 1 | **Delete `app/(app)/reset-balances/`** | MFI-P0-01 | Delete a folder | None |
| 2 | Refuse edits to a trashed transaction (`editTransactionInTransaction`) and a trashed ledger entry (`editEntry`); flip the two pins | MFI-P1-01, P1-02 | ~6 lines + 2 tests | None to schema. Run the Financial Audit page first to find existing drift; **correct manually, never overwrite balances** |
| 3 | Feed Dashboard + Reports weekly bars from `cashFlowTransactions`; add a hook-level test with an excluded row, an EMI row and a card-account row | MFI-P2-01 | Small | None |
| 4 | Bills: decide the contract. Option A (recommended): paid-from account + posted transaction like EMI. Option B: remove bills from Money Out / outflow | MFI-P1-03 | Medium (A) | Product + Flutter decision; legacy paid occurrences keep no transaction |
| 5 | Repository-level refusals: `editEntry` on payment/split-owned entries; EMI `recordPayment` with no account | MFI-P3-01, P3-02 | Small | None |
| 6 | Commit the working tree (after review) | MFI-O-01 | — | — |
| 7 | Idempotency key on plain create and `createExpense` (as transfers do) | WFI-P2-10 | Medium | None |
| 8 | Collapse `amountFor` bucketing onto `mySpendBucketDate`; bucket split money-received by receipt date | WFI-P2-06, P2-11 | Medium | None |
| 9 | Cap / compact `editHistory` for `currentBalance` entries | MFI-U-01 | Medium | **Schema/behaviour change shared with Flutter — coordinate first** |
| 10 | Persist the cycle start day to `users/{uid}` | WFI-P2-04 | Medium | Flutter coordination |
| 11 | Firestore rules: type/immutability checks on financial fields | WFI-P2-12 | Larger | **Rules change — deploy separately** |

---

## G. Live-data limitations

Nothing in this audit read real user records. These conclusions need a separate **read-only** inspection:

- **Whether stored balances have already drifted.** The code can no longer produce drift through the paths the prior audit found, but data written before those fixes (double deletes, generic edits of owned rows, split chains interrupted mid-way) may carry it, as may MFI-P1-01/02 in the interim. `/financial-audit` (untracked, read-only, built on `accountBalanceDrift`, `personBalanceDrift`, `splitLinkDrift` and link checks) is the right tool; it proposes text only.
- **Legacy non-card EMI payments** (before the paid-from account existed) have no bank leg. Whether their money is already inside an opening balance cannot be determined from code. The audit engine files these as *suspected*, never *confirmed*.
- **Legacy People settlements without a cash leg**, and **old split Settle rows** (WFI-P1-01 data) — same: ask the owner before recording any cash.
- **Loans whose principal was edited after origination** (WFI-P1-07 data): compare `loanAmount` with the active `orig_…` transaction.
- **A card account's non-zero `openingBalance`** is in Net Worth but in no bill. New cards are created with 0 (`use-credit-cards-data.ts:727`); an older or Flutter-created card may differ.
- **Do not treat a balance difference as proof the stored balance should be overwritten.** An account may legitimately differ from `opening + Σ effect` because of a documented opening balance, an account-neutral historical row, or a deliberate manual correction.

---

## H. Release / operational recommendation

**Usable with identified restrictions.**

| Area | Assessment |
|---|---|
| Expenses, income, transfers, card bills, People receipts, splits, Loan payments, EMI payments | **Safe for ordinary continued use** on the current code. Verified atomic, idempotent and drift-free across the lifecycle scenarios. |
| Editing or deleting from a second tab / device that was open before another change | **Use caution.** Deletes are safe. *Edits* of a row deleted in the meantime move a balance (MFI-P1-01/02) until fix #2. |
| Bills "Mark paid" | **Not safe as a financial record.** Treat it as a reminder; do not rely on Money Out / Month Cycle outflow for bills (MFI-P1-03). |
| `/reset-balances` | **Do not open. Do not deploy with it.** Delete the folder (fix #1). |
| Dashboard / Reports weekly bars | Cosmetic mismatch only (MFI-P2-01); trust the headline tiles. |
| Long-lived, very active accounts | Watch MFI-U-01 (document growth) — no action needed this quarter on typical volume. |
| Operations | Commit the working tree (MFI-O-01); run `/financial-audit` once to establish a drift baseline. |

**Stop point.** The audit is complete. No financial fix has been made. Awaiting approval before implementing §F.

---

## I. Repair status (2026-10-16, follow-up pass — scope MFI-P0-01, MFI-P1-01..03)

| Finding | Status | Change |
|---|---|---|
| MFI-P0-01 | **Disabled** | `app/(app)/reset-balances/page.tsx` now calls `notFound()` and contains no write. The folder held only that 49-line temp script (no other user work, no references); the original was copied outside the repo. Nothing executed. Folder can be deleted. |
| MFI-P1-01 | **Fixed** | `editTransactionInTransaction` throws the new `TransactionDeletedError` (shown to the user via `error-toast.ts`) right after the fresh read, before any account read or write. A missing document already threw "Transaction not found". |
| MFI-P1-02 | **Fixed** | `LedgerRepository.editEntry` re-validates the fresh entry inside the transaction: wrong person, trashed, or owned by a recorded payment (`paymentId`) → rejected before any write (also covers the linked cash leg and account). Closes MFI-P3-01 for payment-owned entries. |
| MFI-P1-03 | **Mitigated; product decision still required** | New `lib/engines/bill-cash-flow-policy.ts` (`BILL_PAYMENTS_COUNT_AS_CASH_OUT = false`): bill "Mark paid" no longer counts in Dashboard Money Out or Month Cycle outflow/breakdown, because it moves no account. No bill record, occurrence or account was changed; Bills page, due lists and My Money's completed list are unchanged. Options still open: **A** account-funded (post a real expense on a chosen account, then count it once) or **B** historical (record only, never cash out). Flip the flag only after choosing; A also needs a paid-from account in the UI and a transaction link on the occurrence. |

Tests: `tests/integration/master-financial-integrity-audit.test.ts` (10 tests): stale edit of a trashed transaction (5 param variants) rejected with account/trash/history byte-identical; missing target; concurrent edit+delete (4 rounds) ends in exactly one outcome; idempotent retries; restore-then-edit works; stale edit of a trashed People entry rejected (person, account, cash leg unchanged); wrong-person and payment-owned entries refused; legitimate edits keep entry, person and cash leg in step. Suite results: `tsc` exit 0; ESLint 0 errors; unit 208 files / 2,578 tests; integration 29 files / 374 tests; build exit 0.

Unresolved: the bill decision (above); existing drift in live data (unknown, run `/financial-audit`); MFI-P2-01 (bars), MFI-P3-02, MFI-U-01 and the carried-over P2s are out of this pass's scope.

---

## J. MFI-P1-03 resolved — explicit bill payment modes (follow-up pass)

**Decision implemented:** "Mark paid" is gone from the UI. A bill is paid in exactly one of two explicit ways, each one atomic, idempotent Firestore transaction (`lib/repositories/bill-payment-repository.ts`):

| Mode | Writes | Account effect | Cash flow / Month Cycle |
|---|---|---|---|
| **Pay from my account now** (`payFromAccount`) | one expense Transaction (`billPaymentId` → the `PaymentRecord`), `PaymentRecord`, occurrence `amountPaid` | −amount on the chosen bank / cash / wallet account (never a card); funds re-checked fresh inside the write | counted once, as that ordinary expense |
| **Already paid earlier** (`recordPaidEarlier`) | `PaymentRecord` (`recordedEarlier`, real date) + occurrence `amountPaid` | none | never counted |

Also: `reversePayment` (cancel: debit reversed once, record trashed, bill reopens; repeat = no-op), `editPayment` (net difference only, funds checked on the net, one write). The debit is owned by the bill (`TransactionOwnerKind` "bill"): generic delete / money edits are refused, text edits allowed. Credit-card statement payments are unchanged (bank→card transfer); a card cannot fund a bill, so a card bill payment is never an expense.

**Temporary policy removed.** `bill-cash-flow-policy.ts` is deleted; bill occurrences are no longer summed anywhere in Dashboard Money Out or Month Cycle outflow — bills reach those figures only through their account debit. (Engine `billsPaid` is untouched and unused by these hooks.)

**Legacy data:** nothing migrated. Occurrences already marked paid (with or without a bare `PaymentRecord`) stay as stored, count as historical/neutral (never cash out), show "Marked paid before payments tracked money", and cannot be cancelled here. Purpose-money's "also mark the bill paid" now records *paid earlier* (the money already left via the purpose payment — no second debit).

**Files:** `lib/repositories/bill-payment-repository.ts` (new), `lib/models/bill.ts`, `lib/models/transaction.ts`, `lib/repositories/transaction-repository.ts`, `features/bills/{hooks/use-bills-data.ts, components/bill-payment-dialog.tsx (new), components/bills-workspace.tsx}`, `features/people/components/workspace/purpose-money.tsx`, `features/credit-cards/lib/card-payment-cancellation.ts`, `hooks/use-transactions.ts`, `features/month-cycle/hooks/use-month-cycle-data.ts`, `tests/integration/bill-payment.test.ts` (new, 13 tests).

**Verification:** `tsc` 0; ESLint 0 errors (1 old warning); unit 208 files / 2,578 tests; integration 31 files / 391 tests; build OK.

**Remaining risks:** recurring-bill roll-forward and `Bill.accountId` are unchanged (a suggestion only); Flutter still has the old "mark paid" contract and will not post a debit — a bill paid there stays neutral on Web; `markPaid`/`PaymentRepository.recordPayment` remain in the repository (unreachable from UI) and should be removed after Flutter coordination; permanently deleting an account leaves bill payment records pointing at its trashed debits; the History / My Money lists show bill payments by occurrence data and do not yet label the two modes.
