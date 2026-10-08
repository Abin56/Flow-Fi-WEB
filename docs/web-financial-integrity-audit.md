# FlowFi Web — Cross-System Financial Integrity Audit

**Date:** 2026-10-07 · **Scope:** Web only (Dashboard, Month Cycle, Transactions, Accounts, Credit Cards, People Ledger, Loan & EMI). Debt Planner excluded except shared engines. Flutter untouched.
**Code audited:** `HEAD` = `14059fd` ("7 oct commit"). When the audit started those 58 files were uncommitted in the worktree; a parallel session committed them unchanged at 19:46. The worktree was otherwise clean when the audit finished, so every conclusion below applies to `14059fd`.
**Mode:** Investigation only. No production code was changed. Two test files of **audit pins** were added (see §19). Each pin asserts current behaviour, including current wrong behaviour.

> **Phase 1 status (2026-10-07):** WFI-P0-01, P0-02 and P0-03 are **fixed** at the write layer. Their emulator pins in `tests/integration/web-financial-integrity-audit.test.ts` are now permanent regressions.
>
> **Contracts introduced:**
> - **Stale delete is refused.** If a transaction's money changed since the caller's copy, the delete throws `TransactionChangedError`.
> - **Repeat delete is a no-op.** A delete or restore that already happened writes nothing (transactions, transfer pairs, ledger entries).
> - **Owned money edits are refused.** Generic edits/deletes of the money of a Loan/EMI-, People- or split-owned transaction throw `OwnedTransactionEditError` / `OwnedTransactionDeleteError`, unless the owning feature passes `{ owner }`.
>
> **Read-only drift detector:** `lib/engines/stored-balance-drift.ts`.
>
> **Phase 2 (People / Split) status (2026-10-08):** WFI-P1-01, P1-09 and P1-10 are **fixed**.
> - **P1-01:** a split-share row Settle goes through Record Payment's `split` route (cash leg + settlement + installment, atomic).
> - **P1-09:** split edit / delete / unassign each run as ONE Firestore transaction and are idempotent.
> - **P1-10:** `deleteExpense` stamps the entries it retires with `retiredBy: "expense:<id>"`, and `restoreExpense` restores only those. Legacy entries without the stamp are never resurrected.
> - Read-only split consistency check: `splitLinkDrift` in `lib/engines/stored-balance-drift.ts`.
>
> All other P1–P4 findings below are unchanged.

---

## 1. Executive summary

**Verdict: FlowFi Web is *mostly* one linked financial system, but it is not yet safe.** The canonical engines are good: My Spend, card bills, People position/breakdown, ownership shares, Net Worth composition, and loan/EMI payment cores. Most money-moving writes are atomic Firestore transactions. The defects are in four places:

1. **Write-layer idempotency.** Deleting or restoring a transaction or a People ledger entry trusts the caller's in-memory copy and never checks whether it was already deleted. A repeat (two tabs, a stale dialog, or a cascade that re-runs) **reverses the balance twice** (proven, P0).
2. **Generic edit bypasses ownership.** The Transactions edit modal and Transaction Studio can edit the amount of a Loan/EMI-backed transaction, a People cash leg, or a split expense through the raw `editTransaction`. The account moves; the installment, ledger entry or expense does not (proven, P0).
3. **Duplicate calculation chains.**
   - Credit Cards has two independent bill formulas, and the standings chain double-counts a purchase made on statement day (proven).
   - Month Cycle and Dashboard cash-flow map transactions into engines whose input types cannot carry `excludeFromCalculations`, so "Don't count this in my totals" is ignored there (proven).
   - A card-linked EMI payment is counted twice in Month Cycle outflow (proven).
4. **Settlements without money.** Settling a split share from a People row clears the receivable but posts no account cash leg (proven).

| Severity | Count |
|---|---|
| P0 — data corruption / security | **3** |
| P1 — financial integrity | **10** |
| P2 — functional consistency | **13** |
| P3 — UI / explanation | **9** |
| P4 — polish / future hazard | **4** |

**Existing user data may already be affected.** Cached `Account.currentBalance` and `Person.currentBalance` can already carry double reversals. Loan/EMI and People cash-leg transactions may already have been edited out of step with their installments or ledger entries. The current read model does not surface this drift: People absorbs it silently into `unlinked`. See §21.

**Security:** user isolation is enforced by the rules (`users/{uid}/…`, owner-only). **No cross-user read/write gap was found.** Rules do not validate any financial field (balances, amounts, statuses), so every invariant is client-enforced. That is a hardening gap, not a cross-user exposure (WFI-P2-12).

**Suites:**

| Check | Result |
|---|---|
| Unit | 175 files / 2,210 tests pass |
| Integration (Firestore emulator) | 19 files / 219 tests pass |
| `tsc --noEmit` | clean |
| ESLint on the new files | clean |

---

## 2. Overall financial-system architecture

**Storage (all under `users/{uid}/`).**

| Collection / path | Holds |
|---|---|
| `accounts` | `currentBalance` is **stored** and adjusted on every write |
| `transactions` | Money movements |
| `people/{id}` | `currentBalance` is **stored** |
| `people/{id}/ledger` | Ledger entries |
| `people/{id}/advanceApplications` | Advance applications |
| `people/{id}/purposeFunds` | Purpose funds |
| `people/{id}/followUps` | Follow-ups |
| `expenses` | Split / assigned expenses |
| `paymentSchedules/{id}/installments/{id}/payments` | Shared by Loan, EMI, split Expense |
| `loans` (+ `reamortizationEvents`, `additionalDisbursements`) | Loans |
| `emis/{id}/paymentBreakdowns` | EMI payment breakdowns |
| `creditCards/{id}/statements` | Card statements; almost never materialized on Web |
| `sharedCreditLimits` | Shared credit limits |

The Month Cycle start day lives in **browser `localStorage`**, not Firestore.

**Balances: stored vs derived.**

| Figure | Kind | Source |
|---|---|---|
| Account balance | **Stored** | `Account.currentBalance`, written inside the same Firestore transaction as the movement (`AccountRepository.applyBalanceDelta`). `openingBalance + Σ balanceEffect` is never re-derived (`reconcileBalance` exists, unused). |
| Person direct balance | **Hybrid** | `Person.currentBalance` (stored) is the balance; ledger entries explain it (`personBalanceBreakdown`). Any drift between the two lands silently in `unlinked`. |
| Card outstanding / available / utilization | **Derived** | From transactions + statements + EMI locks (`computeCreditCardStandings` and, separately, `cardBillsForCard`) |
| Loan / EMI outstanding principal | **Derived** | Installments + payment records (`outstandingPrincipalAfterPrepaymentsFor`) |
| Net Worth | **Derived** | `netWorthWithLoans` = Σ account balances + lent − borrowed − EMI − card-locked EMI + People balance |
| My Spend | **Derived** | `classifyForMySpend` |

**Write layer (atomic unless noted).**

| Area | Write path | Atomicity |
|---|---|---|
| Transactions | `TransactionRepository` create / edit / softDelete / restore / transfer pair / link | Atomic. Transfer create is idempotent via `idempotencyKey`. |
| People | `LedgerRepository`: addEntry, addEntryWithTransaction, editEntry, softDelete*, changeExpenseFunding | Atomic |
| People | `PersonPaymentRepository` (Record Payment, revert, edit, applyAdvance) | Atomic via `TxSession` |
| Splits | `ExpenseRepository` | **Not atomic.** Sequential multi-transaction chains with a compensating journal on create/convert only. |
| Loans | `LoanRepository.createAgreementWithOrigination` | Atomic |
| Loans | `LoanAdvancePaymentRepository` record / reverse / edit | Atomic + idempotent core; re-amortization is a second unit |
| EMIs | `useEmiActions.recordPayment` / edit / reverse | Atomic + idempotent |
| Agreements | `agreement-deletion.ts` | Atomic money phase + resumable purge |
| Card payments | Transfer into the card account | People gate + statement intent checked inside the transaction (`card-bill-people-gate.ts`) |

---

## 3. Cross-feature dependency map

```
Transaction write (TransactionRepository)
  ├─► Account.currentBalance (same tx) ─► Accounts list ─► Dashboard Assets / Total balance ─► Net Worth
  ├─► My Spend (classifyForMySpend) ─► Month Cycle "My spend" / categories ─► Dashboard categories ─► Budgets
  ├─► amountFor() (dashboard-aggregation) ─► Month Cycle Income / Total outflow / savings rate   ⚠ no exclude flag
  ├─► cashFlowThisMonth() ─► Dashboard Income / Expenses tiles                                      ⚠ no exclude flag
  └─► card account rows ─► cardBillsForCard ─► Pay bill scope, Month Cycle card dues, People card gate
                         └► computeCreditCardStandings ─► Credit Cards outstanding/available/utilization,
                                                          Dashboard utilization, Net Worth card-EMI lock  ⚠ 2nd formula

Card purchase   → card account balance (−) → statements / derived bills → standings → Dashboard Debt (account) & Utilization (standings)
Card refund     → card account (+) → statement credit (−) ✔ → Month Cycle "income" ⚠
Card payment    → transfer pair (atomic, gated) → bank (−) / card (+) → settleCardPayments oldest-first → no My Spend ✔
People expense  → Transaction + Expense + schedule/installments + ledger "gave" (sequential, non-atomic)
                → My Spend = my share ✔ → Person.currentBalance (+) → People / Month Cycle sides / Net Worth receivable
People repayment (Record Payment) → cash-leg Transaction (isPersonLedgerMovement) + settlement entries + split installment (atomic) ✔
People repayment (split row Settle) → ledger receivedBack + InstallmentPayment ONLY — no cash leg ⚠
Advance         → advance entry + cash leg; application = AdvanceApplication only (no cash, no balance) ✔
Loan creation   → origination Transaction (excluded from income/spend) + Account (+/−) + Loan + schedule (atomic) ✔
Loan payment    → Transaction (loanId) + installments + payments + Account (atomic, idempotent) ✔ → outstanding principal → Net Worth, People loan positions
Prepayment      → same core + separate re-amortization batch (two units)
EMI payment     → installments + payments + breakdowns (+ card Transaction if card-linked) (atomic, idempotent)
                → non-card EMI: NO account movement ⚠ → outstanding principal ↓ → Net Worth ↑
Transfer        → two legs, one tx, deterministic ids ✔ → excluded from income/spend ✔
Split           → see People expense
```

**Same concept, more than one formula:** see §12.

---

## 4. Dashboard audit

Source: `features/dashboard/hooks/use-dashboard-data.ts`

| Figure | Source | Canonical? | Notes |
|---|---|---|---|
| Net Worth | `useLoanBalanceSheet().netWorth` → `netWorthWithLoans` | ✔ consumer | |
| Assets / Debt / Held for people | `netWorthComposition(netWorth, liabilityTotals(sheet, cardDebt), people)` | ✔ identity holds (Assets − Debt − Held = NW) | Card part of Debt = card **account balances** — differs from Utilization (WFI-P2-03) |
| Income / Expenses tiles | `useCashFlowThisMonth` → `cashFlowThisMonth` | ⚠ | Calendar month; counts excluded rows (WFI-P1-05); card-linked EMI counted as cash out via `emiPaidThisMonth` (WFI-P1-06); EMI/split receipts bucketed by due month / expense month (WFI-P2-11) |
| Cash-flow weekly bars | Inline loop | ⚠ duplicate | Re-implements the cash boundary; skips excluded rows? **No** — same gap |
| Expenses by category | `myConsumptionAmount` | ✔ | Calendar month (intentional label "this month") |
| Account totals | `Account.currentBalance` (cards excluded) | ✔ | |
| Card utilization | `useCreditCardStandings` | ✔ consumer | Inherits WFI-P1-02 / P1-04 |
| People receivable / payable | Through Net Worth composition | ✔ | |
| Recent activity | Newest-touched 5 | ✔ | |
| Upcoming payments | Bills + **stored** statements' `amountPaid` | ⚠ | Web Pay bill never writes `amountPaid`; derived bills ignored (WFI-P2-02) |
| Net Worth trend | 7-day cumulative signed flows from 0 | ⚠ P3 | Not a net-worth series (WFI-P3-05) |
| Needs attention | Next bill only | — | Documented gap |

**Scenario results (traced):**

| Scenario | Dashboard behaviour |
|---|---|
| Income / expense | Assets and NW move ✔ |
| Card purchase | Debt ↑ via account; Utilization ↑ via standings ✔ (P1-02 edge) |
| Card payment | NW unchanged ✔; not counted as expense ✔ (counted once as cash out ✔) |
| Transfer | NW unchanged ✔; income/expense unchanged ✔ |
| People expense (split on card) | Debt ↑ full; receivable ↑ others' share; NW −my share ✔ |
| People repayment via Record Payment | Cash ↑, receivable ↓, NW unchanged ✔ |
| People repayment via row Settle | Receivable ↓, **cash unchanged → NW drops** ✖ (P1-01) |
| Advance received | Cash ↑, Held ↑, NW unchanged ✔ |
| Advance application | No change ✔ |
| Loan creation (borrowed, deposited) | Assets ↑, Debt ↑, NW unchanged ✔ |
| Loan installment | Cash ↓, principal ↓ by principal portion, NW −interest ✔ |
| Loan prepayment | Cash ↓, principal ↓, NW unchanged ✔ |
| EMI payment (non-card) | **Principal ↓ with no cash ↓ → NW ↑** ✖ (P1-08) |
| EMI payment (card-linked) | Card debt ↑, lock ↓ ✔ |
| Deletion | Correct once; **twice → double reversal** ✖ (P0-01) |

Dashboard is a consumer of canonical engines except the cash-flow bars, the upcoming-payments list and the trend (inline math).

---

## 5. Month Cycle audit

**Canonical cycle window:** `cycleRangeFor(startDay, date)` (`lib/engines/month-cycle-range.ts`) is contiguous and inclusive. With start day 18, the cycle runs 18 Sep 00:00 → 17 Oct 23:59:59.999. Start days 29–31 clamp to short months. People's `cycleContaining` delegates to it ✔ (pinned PASS).

**Consumers using the canonical cycle:**

| Consumer | Rule |
|---|---|
| Month Cycle hero | ✔ |
| Loan dues (`loanCycleDues`) | ✔ per installment, carry-forward |
| Card dues (`cardBillsDueInCycle`) | ✔ by **card's own due date**, never forced to the Month Cycle |
| Bills | ✔ |
| People sides (current position, not cycle-scoped) | ✔ |
| People statement / PDF | ✔ |
| EMI receivable cutoff (`cycleContaining(now).end`) | ✔ |

**Problems found:**

| ID | Finding |
|---|---|
| WFI-P1-05 | Income and Total outflow include `excludeFromCalculations` rows (`DashboardTransaction` has no such field). My Spend excludes them, so the hero's figures disagree with each other. |
| WFI-P2-01 | A card refund counts as Month Cycle income. |
| WFI-P1-06 | A card-linked EMI payment counts twice in Total outflow (its card Transaction via `myExpenses` + `emiPaid`). |
| WFI-P2-05 | EMI dues show only `nextInstallment`. A carried overdue installment plus the current one shows a single row. Loans show each installment. |
| WFI-P2-06 | Three bucket-date rules in one hook (see the table below). |
| WFI-P3-03 | "vs last cycle" uses `previousRangeFor`, a length-shifted window. For start day 18 that is 19 Aug → 17 Sep, not 18 Aug → 17 Sep. |
| WFI-P2-04 | Start day is per browser (`localStorage`). Two devices can show different cycles and different People statements. |
| — | `budgetOverview` combines a calendar-month budget period with cycle-scoped spend (P3, folded into P2-06). |

Bucket-date rules (WFI-P2-06):

| Function | Bucket date |
|---|---|
| `bucketDateFor` | `accountingMonth ?? dateTime` |
| `heroBucketDate` | `dateTime` only (custom cycle) |
| `amountFor` | `dateTime` |

So for a custom cycle, a manual "count in month X" override is honoured by account-spend and transaction counts but ignored by My Spend and Income.

**Boundary behaviour (traced):**

| Case | Result |
|---|---|
| Day before cycle start | Excluded ✔ |
| Cycle start 00:00 | Included ✔ |
| Last day 23:59 | Included ✔ |
| Day after cycle end | Excluded ✔ |
| Future-dated transaction | Bucketed by its own date (future cycle) ✔. The UI blocks future dates on create. |
| Late payment / carry-forward | `isOwedInCycle` and `loanCycleDues` carry unpaid past-due items ✔ |
| Partial payment | Remainder shown ✔ |
| Advance / advance application | No cycle effect; held separately ✔ |

**Intentional calendar-month uses — do not "fix" without a product decision:**

- Dashboard Income/Expenses tiles and category donut ("this month").
- `usePeopleStats().settledThisMonth`.
- `resolveBudgetPeriod` for monthly budgets.
- Card statements: card cycle, by design.
- `paidThisMonth` EMI proxy (calendar *and* due-date based; see WFI-P2-11).

---

## 6. Transactions audit

| Type / path | Account | Card | People | Loan | My Spend | Income | Net Worth | Month Cycle | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Income | +amt | — | — | — | — | ✔ | +amt | ✔ | |
| Expense (bank) | −amt | — | — | — | full | — | −amt | ✔ | |
| Expense (card) | card −amt | statement + | — | — | full (on purchase date) | — | −amt | ✔ | |
| Card refund (income on card) | card +amt | statement credit | — | — | — | ⚠ counted as income (Month Cycle) | +amt | ⚠ | P2-01 |
| Transfer | src −, dst + | — | — | — | — | — | 0 | excluded ✔ | Atomic + idempotent create ✔ |
| Card bill payment | bank −, card + | settles oldest | gate ✔ | — | — | — | 0 | cash out ✔ | |
| Split expense | −full | if card | +others' shares | — | my share | — | −my share | ✔ | Non-atomic chain (P1-09) |
| Assigned ("I gave", owes toggle) | −full | | +full | | 0 | | 0 | | |
| Person-funded ("they paid directly") | none | | "borrowed" + | | full | | −amt | ✔ | Atomic ✔ |
| Money I gave / borrowed (cash) | ∓ | | ± | | excluded ✔ | excluded ✔ | 0 | | Atomic ✔ |
| Record Payment | ± cash leg | | − obligations | | excluded | excluded | 0 | | Atomic ✔ |
| Split row Settle | **none** | | − | | | | **−share** | | **P1-01** |
| Loan origination | ± | | | +principal | excluded | excluded | 0 | | Atomic ✔ |
| Loan installment | − | | | − principal | per recognition rule | | −interest | dues ✔ | Atomic ✔ |
| EMI (card) | card − | lock ↓ | | | per rule | | | ⚠ double outflow | P1-06 |
| EMI (no card) | **none** | | | − principal | | | **+principal** | emiPaid | P1-08 |
| SMS / PDF / Studio import | via the same repositories | | | | | | | | Card payments imported with an explicit historical acknowledgement |

**Lifecycle operations:**

| Operation | Result |
|---|---|
| Create | Atomic per transaction. Plain create has no idempotency key (P2-10). Transfer create is keyed ✔. |
| Edit | Fresh read inside the tx ✔. Transfer legs locked for amount/account/date ✔, but `type` and `excludeFromCalculations` are not blocked at the repository. The Transactions modal hides them for transfers; Studio's committed editor exposes exclude but its UTC date rewrite makes every transfer-leg save throw first (P3-08). **Loan/EMI/People/split rows are editable through the raw path — P0-02.** |
| Delete | Routed by `deleteTransactionWithLinkedEffects` ✔ (transfer pair / expense / People cash leg / plain). **Not idempotent and stale-copy based — P0-01.** Loan/EMI rows blocked from generic delete ✔. |
| Restore | Idempotent check ✔ but applies the *caller's* copy (stale amount possible — part of P0-01). Card-payment restore re-gated ✔. |
| Orphans | `findTransferSibling` fallback deletes a single leg ✔ (legacy); after a double delete it **re-reverses** (P0-01). |
| Transfer integrity | Source −once, destination +once, no income, no spend, no NW change ✔ — on create (pinned by existing tests). Broken only by repeat delete. |

---

## 7. Accounts audit

- **Balance model:** stored `currentBalance`, adjusted in the same Firestore transaction as each movement. Every production path reads the account fresh inside the transaction ✔. `AccountRepository.adjustBalance` (non-transactional) has **no callers** (P4-02).
- **Opening balance** is immutable after creation ✔.
- **Account `type` is editable** after creation (bank ↔ cash ↔ card). There is no migration and no guard when a card profile exists (P3-07, not executed).

**Sequence test** (traced by hand; each step proven by repository code and existing tests):

| Step | Balance |
|---|---|
| Opening | ₹5,000 |
| + ₹30,000 loan origination | 35,000 |
| − ₹3,000 loan installment | 32,000 |
| + ₹1,000 People reimbursement (Record Payment) | 33,000 |
| − ₹2,000 transfer out | 31,000 |
| Revert the transfer (delete pair) | **33,000** ✔ |
| A second delete of the same transfer (other tab) | **35,000** ✖ (pinned) |

**Paths that modify a transaction but not the right balance:**

- Repeat delete (P0-01).
- Stale delete after an edit: the old amount is reversed and the stored doc is overwritten with the stale copy (P0-01, pinned).
- Loan principal edit leaves the origination deposit at the old amount (P1-07).

Account deletion (`account-deletion.ts`) is a type-to-confirm permanent cascade; traced, not executed.

---

## 8. Credit Cards audit

**Two bill engines:**

| Engine | Function | Feeds |
|---|---|---|
| A | `cardBillsForCard` → `cardStatementPaymentScope` | Pay bill, Pay Now prefill, Month Cycle card dues, the People write gate |
| B | `computeCreditCardStandings` (`unbilledSpendForCard` + `uncoveredClosedSpendForCard` + `settleCardPayments`) | Credit Cards outstanding / available / utilization, "Spent this month", **Pay Full Outstanding prefill (`ownUsage`)**, Dashboard utilization, the Net Worth card-EMI lock |

**Verified (PASS):**

- Statement window = day after the previous statement day → statement day inclusive; due date in the following month on `paymentDueDay`.
- Credits and refunds subtract from the statement they are dated in.
- Payments settle oldest due first; excess credit spills forward and never shows a negative due.
- A card payment is never My Spend.
- A shared limit is counted once (`creditCardTotalsFrom` dedupe); statements and payments stay per physical card.
- The People gate is checked **inside** the payment transaction for create, restore and link, with the person/card/statements read in the tx so a concurrent change re-runs it.
- Normal Pay Now carries a statement intent that refuses spill-over (`CardStatementChangedError`).
- Transfer retry with changed data is refused (`TransferRetryMismatchError`).
- No gate bypass was found through Transactions, Studio linking, purpose money or restore. `StatementPaymentRepository.recordPayment` is ungated but has no UI caller (P4-01).

**Broken:**

| ID | Finding | Status |
|---|---|---|
| WFI-P1-02 | Engine B double-counts a purchase dated on statement day after 00:00 when a stored statement covers that day: ₹1,000 owed shows as ₹2,000 outstanding, available is ₹1,000 short, and Pay Full pre-fills ₹2,000. | Pinned |
| WFI-P1-03 | With no stored statements (normal on Web), Engine B puts *all* unpaid spend into the "current cycle", so "Spent this month" = every unpaid rupee ever. | Pinned |
| WFI-P1-04 | A transfer *out of* a card (card→bank, card→card, which the modal allows) raises the card account's debt but appears on no statement and in no standing. | Pinned |

Consequence of WFI-P1-04: Dashboard Debt (account) ≠ Credit Cards outstanding ≠ Pay bill. A card account's non-zero `openingBalance` has the same split: it is in Net Worth but in no bill.

**Invariant check: closed due + open-cycle spend = physical outstanding.**

| Chain | Holds? |
|---|---|
| Engine A vs account balance | Only when opening balance = 0 and there are no transfers out of the card |
| Engine B | Not even then (statement-day double count) |

---

## 9. People Ledger audit

**Verified (PASS):**

| Area | What was checked |
|---|---|
| Directions | TO RECEIVE / TO GIVE / ADVANCE HELD / ADVANCE PAID come from one breakdown (`personBalanceBreakdown`). `toReceive − toGive + advance === net` by construction. Held advance never becomes receivable or payable. Month Cycle sides are gross. |
| Record Payment | One atomic write. Rejects if the person's balance moved since the screen opened (double-click, retry or other tab → `StalePersonPaymentError`). Split installments re-read fresh. Every rupee classified. Revert and edit are atomic and re-read fresh. |
| Advance application | Moves no cash and no balance; capped in the breakdown. |
| Ownership shares | Integer paise, largest remainder (pinned PASS for 2–6 parties). One person's action only writes that person's docs (person-scoped ledger paths). |
| Cash legs | Excluded from My Spend and income everywhere. |

**Broken:**

| ID | Finding | Status |
|---|---|---|
| WFI-P0-02 (b) | Editing a People cash leg's amount in the Transactions modal goes `applyOwesPersonChange` → raw `editTransaction`. The `isPersonLedgerMovement` routing in `actions.editTransaction` is never reached from the modal. | Pinned |
| WFI-P0-03 | `softDeleteEntry` / `restoreEntry` have no fresh `deletedAt` check; repeats double-apply. The cached balance is the People balance, and the drift is hidden in `unlinked`. | Pinned |
| WFI-P1-01 | Split-share row Settle → `settleParticipant`: ledger and installment only, no account, no cash leg. | Pinned |
| WFI-P1-10 | `restoreExpense` restores every trashed entry with that `transactionRef`, including a ✓-status entry that was undone before the delete. | Pinned |
| WFI-P2-07 | `applyAdvance` reads existing applications before the transaction; two concurrent applies can overdraw one advance. | Traced |
| WFI-P2-08 | An opening-balance obligation row's Settle sends `accountId: ""` and always fails with "Select an account.". | Traced |

Not executed: overpayment, future obligations and multi-person transactions are covered by existing unit tests (`person-payment.settle-cap`, `person-gross-settlement`, `people-direction-sides`); spot-read, consistent.

---

## 10. Loan & EMI audit

**Verified (PASS):**

| Area | What was checked |
|---|---|
| Loan origination | One transaction: Loan + schedule + origination Transaction + Account. Excluded from income and spend. Trash blocked while origination money is active. |
| Loan payment / advance / prepayment / reversal / edit | Atomic, idempotent (deterministic Transaction id sentinel), allocation from fresh installments. People gate inside the tx. Reversal only for the latest action. |
| Additional disbursement | Atomic core. |
| Agreement permanent delete | Atomic money phase + resumable purge. |
| EMI payment / edit / reversal | Atomic, idempotent (deterministic breakdown id). Card-linked EMI posts a card Transaction and moves the card account by the net difference on edit. |
| Paise | Ownership shares reconcile exactly to every installment (pinned). Outstanding principal never includes future interest. Card-owned EMI/Loan principal is counted once (card lock), never again as EMI or Loan debt. |

**Broken / risky:**

| ID | Finding | Status |
|---|---|---|
| WFI-P0-02 (a) | A Loan/EMI-backed transaction is editable through generic edit (Transactions modal, Studio): the account moves, the installment and payment do not. | Pinned |
| WFI-P1-07 | `editLoanTerms` changes `loanAmount` (the edit form leaves Principal enabled) but never touches the origination deposit Transaction. Loan ₹40,000 vs deposit ₹30,000 → NW −₹10,000 with no movement. | Traced, not executed |
| WFI-P1-08 | A non-card EMI payment has no account leg (Flutter parity). Each payment raises NW by the principal portion unless the user also records the bank debit — and if they do, Dashboard cash flow counts it twice (expense + `emiPaidThisMonth`). Needs a product decision. | Traced |
| WFI-P1-06 | A card-linked EMI payment is double-counted in Month Cycle outflow. | Pinned |
| WFI-P2-09 | Prepayment re-amortization is a second write unit; `assertReversible` runs outside the tx. | Traced |

Not re-verified here (covered by existing integration suites that pass): installment progress %, next due and paid/partial counts. Their source is the new `installment-progress.ts`, now committed.

---

## 11. Cross-feature lifecycle audit

| Scenario | Result |
|---|---|
| 1 Cash expense → My Spend → Month Cycle → Dashboard → delete | ✔ once. ✖ second delete double-reverses (P0-01). |
| 2 Card purchase → statement → pay → account | ✔ via Engine A. Engine B over-reports on statement day (P1-02). Pay Full prefill can overpay. |
| 3 Split card expense → my share / receivable → person repays | ✔ via Record Payment (cash in, receivable out, card untouched, My Spend = my share). ✖ via row Settle: no cash (P1-01). ✖ delete/restore can resurrect retired entries (P1-10). |
| 4 Shared loan → shares → installment → reimbursement → advance → revert | ✔ (existing integration `shared-loan-ownership-lifecycle`, `loan-advance-payment` pass). Editing the loan transaction directly breaks it (P0-02). |
| 5 EMI → partial → advance → People share → revert | ✔ atomic/idempotent. Non-card EMI NW effect (P1-08). Card-linked outflow double (P1-06). |
| 6 Transfer A→B, edit/delete/retry | ✔ create/retry. Amount/account/date edit refused ✔. ✖ repeat delete creates money (pinned: A 12,000). |
| 7 Delete / restore | Transactions ✔ once / ✖ repeat. Expenses ✖ restore over-restores. Loans ✔ (origination guard). Ledger ✖ repeat. |

---

## 12. Calculation consistency audit

| Concept | Intended canonical source | Other computations | Classification |
|---|---|---|---|
| Card outstanding | `cardBillsForCard` | `computeCreditCardStandings` (different formula); Dashboard Debt uses `Account.currentBalance` | **DANGEROUS** (P1-02/03/04, P2-03) |
| Card bill paid / remaining | `settleCardPayments` over live totals | Dashboard Upcoming uses stored `Statement.amountPaid` | **DANGEROUS** (P2-02) |
| Income / spend totals | `classifyForMySpend` + `isNonIncomeExpenseMovement` | `amountFor` (Month Cycle), `cashFlowThisMonth` (Dashboard), Dashboard weekly bars inline, Month Cycle account-spend inline | **DANGEROUS** (exclude flag lost, P1-05; EMI double, P1-06) |
| Month Cycle bucketing | `cycleRangeFor` | three bucket-date helpers | DANGEROUS (P2-06) |
| Cycle window | `cycleRangeFor` | `CycleAnchor` (cards, Dart-quirk port), `previousRangeFor` | SAFE for cards except January (P3-01); P3-03 |
| People balance | `Person.currentBalance` + breakdown | `toActivityItem.remainingAmount` (ignores advance applications) | SAFE (display) |
| Loan outstanding | `outstandingPrincipalAfterPrepaymentsFor` | People loan positions reuse `useLoanRows` | SAFE |
| Net Worth | `netWorthWithLoans` | Settings / Reports sum `currentBalance` | SAFE (labelled "balance", not NW) |
| Installment progress | `installment-progress.ts` | — | SAFE |

---

## 13. Precision / rounding audit

**Mixed approach:**

| Area | Method |
|---|---|
| Ownership shares, People breakdown applications | Integer paise ✔ |
| Splits, payments, ledger, card bills | `Math.round(v*100)/100` on floats |
| Account and Person balances | **Raw float accumulation**: `applyBalanceDelta` never rounds. Only `agreement-deletion` rounds. |

**Results:**

| Case | Result |
|---|---|
| Equal split of ₹100 / 3, ₹999.99 / 4, ₹1,000.01 / 5, ₹1,234.57 / 7 | Exact (pinned PASS) |
| ₹0.03 / 4 | One ₹0.00 share; `addEntry` then rejects the save (P3-02) |
| Ownership 2–6 parties, odd installments (₹0.03, ₹999.99) | Exact, never negative (pinned PASS) |
| Floating drift in stored balances | Possible after many edits (e.g. 0.1 + 0.2), never rounded. Not observed as a user-visible ₹0.01 in tests; documented (P4-03). |
| Card `remaining` | Clamped ≥ 0 ✔ |
| Breakdown | Uses `Math.max(0, …)` ✔ |

Negative zero, payment above remaining, and progress over 100%: no path found.

---

## 14. Date / boundary audit

| Area | Behaviour |
|---|---|
| Dates | Local-time `Date`s stored as Timestamps. Day comparisons use `dayIndex` / `dateOnly` (local) ✔. |
| Month Cycle and card statement boundaries | Correct at 00:00 / 23:59 (pinned PASS) |
| WFI-P1-02 | The *only* time-of-day bug: `unbilledSpendForCard` compares `dateTime > periodEnd` (midnight) against a day-inclusive statement. |
| WFI-P3-01 | `CycleAnchor.currentCycleFor` in January returns start (16 Dec 2027) after end (15 Jan 2027). Affects only `statementCycleView` (which stored statement the card tile labels "next due"). Card windows themselves route through `periodEndingFor` ✔. |
| WFI-P3-08 | Studio committed-row editor writes `dateTime = new Date("YYYY-MM-DDT00:00:00.000Z")` and `accountingMonth = "YYYY-MM-01T00:00Z"`. In IST the day is preserved (05:30) but time-of-day is lost; in negative-offset zones the day and month shift back. |
| Validation | The transaction modal blocks future dates. Overdue logic uses local `today` ✔. |

---

## 15. Concurrency / idempotency audit

| Write | Mechanism | Verdict |
|---|---|---|
| Transfer create / Pay bill | Transaction + deterministic leg ids + mismatch refusal + gate in tx | **Idempotent** ✔ |
| Plain transaction create | Transaction, random id; component `useRef` re-entry guard | Unsafe on lost-response retry (P2-10) |
| Transaction edit | Transaction, fresh read | Safe ✔ (last writer wins on fields) |
| Transaction soft delete | Transaction, **caller's copy, no deleted check** | **Unsafe** — double reversal, stale overwrite (P0-01) |
| Transfer pair delete | Transaction on the caller's copies; single-leg fallback | **Unsafe** (P0-01) |
| Transaction restore | Fresh live-check ✔, caller's copy for delta | Partially safe |
| Record Payment | Transaction + stale-balance refusal | **Safe** ✔ |
| Payment revert / edit | Transaction, fresh re-reads, "already reverted" | **Safe** ✔ |
| Advance application | Transaction, pre-read list outside tx | Unsafe under concurrency (P2-07) |
| Ledger entry delete / restore (single) | Transaction, no deleted / live check | **Unsafe** (P0-03) |
| Ledger multi-delete (`softDeleteEntries`, `…WithCashLegs`) | Transaction, skips trashed | **Safe** ✔ |
| Split create / convert | Sequential transactions + rollback journal | Non-atomic, compensating (P1-09) |
| Split edit / delete / unassign / resplit | Sequential, no rollback | **Unsafe** on partial failure (P1-09) |
| Loan payment / reverse / edit | Transaction + sentinel id | **Idempotent** ✔ (re-amortization a second unit, P2-09) |
| EMI payment / edit / reverse | Transaction + sentinel id | **Idempotent** ✔ |
| Agreement delete | Transaction + resumable purge | **Safe** ✔ |
| Loan trash / restore | Transaction on fresh doc | **Safe** ✔ |

---

## 16. Firestore / security audit

| Layer | Finding |
|---|---|
| Security rules | Every user collection is matched explicitly under `users/{uid}/…` with `isOwner(uid)`; `{document=**}` covers nested People / statements / installments / payments / breakdowns. No blanket rule. Global collections are read-only. **No cross-user read or write path found.** Collection-group helpers exist but are unused (statements and breakdowns fan out per parent), so no collection-group rule is needed. |
| Field validation | **None** for financial collections. A signed-in client can write any `currentBalance`, `amount`, `amountPaid` or `deletedAt` on its own data (WFI-P2-12). Firestore *transactions* give atomicity, not validation. |
| Repository validation | Present (funding consistency, transfer edit lock, amount > 0, People/card gates). Bypassed by any direct `update` / `add` call and by the inherited CRUD methods (documented as test-only). |
| UI restriction | Some invariants exist only in UI, e.g. transfer-leg exclude toggle hidden, future-date block, Studio date lock. |
| Rules tests | `tests/rules/*` exist; not run in this audit (only the unit and integration suites were run). |

---

## 17. Failure / offline audit

| Situation | Behaviour |
|---|---|
| Listener error | `useFirestoreWatch` marks the cache entry errored → `WatcherErrorBanner` with Retry ✔. Not swallowed. |
| Converter throw (missing `createdAt` / `dateTime` / `date` on a legacy doc) | Throws inside the snapshot mapping; the whole list errors (P2-13). |
| Write failure | `withErrorToast` shows a toast and rethrows ✔. Actionable messages from `LoanPaymentTransactionRestrictedError`, `PersonCashLegDeleteBlockedError` and `TransactionFundingMismatchError` are replaced by "Please try again." (P3-04). |
| Offline | `persistentLocalCache` gives cached reads ✔. `runTransaction` fails while offline (every balance write fails cleanly, nothing written) ✔. Plain `setDoc` writes (account / person create, installment and expense steps inside split edit/delete) queue and their promises stay pending, so a split edit/delete chain can stall mid-way until reconnect (unproven, part of P1-09). |
| Optimistic UI | Studio grid cells roll back on failure ✔. No optimistic balance display found. |
| Partial statements emit | `useAllCreditCardStatements` publishes after each card's first snapshot, so totals can briefly mix loaded and unloaded cards (P3-09). |

---

## 18. Legacy-data audit (Web reading old Web/Flutter docs)

**Tolerant (✔):**

- `transferId`, `status`, `source`, `isPersonLedgerMovement`, `fundedByPersonId`, `loanId`/`emiId`, `paymentAllocationType` → null/false defaults.
- `ownershipSharesFromData` → null on malformed; resolves from the beneficiary opt-in.
- Legacy Loan-generated ledger entries de-duplicated by `transactionRef ∈ loanIds`.
- Stored statements re-totalled live; credit-inflated totals repaired conservatively.
- Missing Month Cycle start day → 1.

**Fragile (✖):**

- Required timestamps (`createdAt`, `dateTime`, `date`, `periodStart`…) are cast without null checks (P2-13).
- `amount` is cast without a type check: a string amount from an old import would concatenate.
- Statements with mismatched stored periods still go through Engine B's midnight comparison (P1-02 applies to any Flutter-materialized statement).

---

## 19. Test-quality audit

**Suite size:**

| Suite | Files | Tests |
|---|---|---|
| Unit | 175 | 2,210 |
| Integration | 19 | 219 |

Coverage is broad and mostly outcome-based (balances, People totals, cross-platform fixtures).

**What is actually protected:**

- Transfer atomicity / idempotency.
- Card People gate (extensive).
- Record Payment and revert.
- Loan / EMI payment cores and reversal.
- Agreement deletion.
- My Spend classifier.
- Card bills Engine A.
- People breakdown identities.
- Ownership paise.

**False-confidence and missing tests:**

- Engine tests feed `amountFor` / `cashFlowThisMonth` already-filtered inputs. Nothing tests the **hooks' mappings**, which is where the exclude flag is lost (P1-05). The hooks are untested glue.
- Card standings tests use noon timestamps, so the midnight-vs-day boundary between Engine A and B was never exercised (P1-02).
- No test repeats a delete/restore. Every existing delete test deletes once (P0-01, P0-03).
- No test asserts that loan / People / split-backed transactions refuse a generic edit (P0-02). The modal's People-cash-leg routing test covers `actions.editTransaction`, which the modal's edit branch does not call.
- Split edit/delete partial-failure tests cover create/convert rollback only.
- No lifecycle test spans more than one section's *read model* (e.g. "settle split row → Dashboard NW unchanged").

**Added in this audit (pins; production code unchanged):**

| File | Kind | Pins |
|---|---|---|
| `tests/integration/web-financial-integrity-audit.test.ts` | Emulator, 9 tests | WFI-P0-01 ×3, P0-02 ×2, P0-03 ×2, P1-01, P1-10 |
| `features/credit-cards/hooks/web-financial-integrity-audit.test.ts` | Unit, 14 tests | WFI-P1-02, P1-03, P1-04, P1-05 ×2, P1-06, P2-01, P3-01, P3-02 + 5 PASS pins |

Each "PINS BUG" test will fail once its finding is fixed. Replace it then with the regression test named in its finding.

---

## 20. All findings (P0 → P4)

### WFI-P0-01 · P0 · Transactions / Accounts · Transaction and transfer deletes are not idempotent and trust a stale copy

**Real scenario.** A user opens a transaction in two tabs (or a Dashboard drawer plus the Transactions page) and presses Delete in both. Or an edit is made in tab A and the old row is deleted from tab B.

**Steps to reproduce.**
1. Create a ₹1,000 expense on Bank (opening ₹5,000).
2. `softDeleteTransaction(copy)` twice.

Variant: edit to ₹3,000 elsewhere, then delete the ₹1,000 copy. Transfer variant: `deleteTransferPair(out)` twice.

**Expected.** Bank ₹5,000. A repeat delete is a no-op. A stale delete reverses the current amount.

**Actual (pinned).**
- Bank ₹6,000 after a double delete.
- ₹3,000 after the stale delete, and the trashed doc is the stale ₹1,000 version.
- Transfer: source A goes to ₹12,000 — ₹2,000 created.

**Root cause.**
- `softDeleteTransactionInTransaction` computes `-balanceEffect(transaction)` from the argument and writes `{...transaction, deletedAt}`. It never re-reads the document or checks `deletedAt`.
- `deleteTransferPair` does the same for both legs. Its fallback (sibling already trashed) single-deletes the stale leg again.
- `restoreTransactionInTransaction` checks liveness, but applies the argument's amount.
- The modal's `handleDelete` re-entry guard is React state, not a ref.

**Files / functions.**
- `lib/repositories/transaction-repository.ts`: `softDeleteTransactionInTransaction` (694), `softDeleteTransaction` (753), `restoreTransactionInTransaction` (768), `deleteTransferPair` (835), `restoreTransferPair` (869).
- `features/transactions/components/transaction-details-modal.tsx`: `handleDelete`.
- Callers: `lib/services/transaction-deletion.ts`, `person-cash-leg-deletion.ts`, `expense-repository.deleteExpense`, Studio bulk delete.

**Other sections affected.** Accounts, Dashboard Assets/NW, Credit Cards (card account), Month Cycle (none — the row is trashed).

**Data corruption?** YES. **Existing data needs repair?** UNKNOWN. Detectable by recomputing `openingBalance + Σ balanceEffect(active)` per account.

**Safe fix direction.**
- Inside the transaction, re-read the transaction (and sibling); return if already deleted; compute the delta from the fresh doc; write the fresh doc plus `deletedAt`.
- Same for restore.
- Make `handleDelete` use a ref guard.

**Test that should protect it.** Emulator: delete twice / delete-after-edit / pair-delete twice → balances unchanged after the first delete (replace the pins).

### WFI-P0-02 · P0 · Transactions → Loans/EMI, People, Splits · Generic edit bypasses the owning record

**Real scenario.**

| Sub-case | What the user does | What breaks |
|---|---|---|
| (a) | Opens a "Loan" EMI-payment row in Transactions and fixes the amount ₹5,000 → ₹500 | Account moves; Loan still shows ₹5,000 paid |
| (b) | Opens a "Money I Gave ₹2,000" cash leg and changes it to ₹3,000 | Account moves; Ravi still owes ₹2,000 |
| (c) | Changes a split expense's amount in Transaction Studio (grid cell or manage modal) | `Expense.totalAmount` and shares are stale |

**Steps.** Pinned for (a) and (b) at repository level. The UI path is traced: modal `handleSaveOnce` edit branch → `actions.applyOwesPersonChange` → `transactionRepository.editTransaction`. Studio: `saveGridFieldCommittedAware` and `transaction-manage-modal` → `editTransaction`.

**Expected.** Loan/EMI rows edited only through the Loan/EMI payment edit. Cash legs through `LedgerRepository.editEntry` (already implemented in `actions.editTransaction`). Splits through `editExpense`.

**Actual.**
- (a) Bank 49,500; installment and payment unchanged.
- (b) Bank −3,000 but the person and entry stay at +2,000.

**Root cause.**
- `editTransactionInTransaction` blocks only transfer amount/account/date.
- `softDelete` / `restore` block `loanId` / `emiId`, but edit does not.
- The modal's edit branch never calls `actions.editTransaction`, so its cash-leg routing is dead for the modal.

**Files.**
- `lib/repositories/transaction-repository.ts` `editTransactionInTransaction`
- `features/transactions/components/transaction-details-modal.tsx` (1036–1120)
- `features/transactions/lib/owes-person-transition.ts` (final branch)
- `features/transaction-studio/lib/committed-transaction-sync.ts`
- `features/transaction-studio/components/inspector/transaction-manage-modal.tsx`
- `features/transactions/hooks/use-transactions-data.ts` `editTransaction`

**Other sections.** Loans/EMI outstanding, Net Worth, People position, Month Cycle sides, card gate inputs.

**Data corruption?** YES. **Repair?** UNKNOWN. Detect by comparing:
- Loan Transaction amount vs Σ linked `InstallmentPayment.amount`.
- Cash-leg amount vs its entry.
- Split Transaction amount vs `Expense.totalAmount`.

**Safe fix direction.**
- Repository: refuse amount/date/account/type/exclude edits when `loanId`/`emiId` is set (a new `LoanPaymentTransactionRestrictedError` for edit), and when `isPersonLedgerMovement` (route to ledger), unless called from the owning repository.
- UI: route modal and Studio edits through the owning action, or lock the fields with an explanation.

**Test.** Emulator: each owned transaction type refuses a generic amount edit. The modal edit of a cash leg updates the entry.

### WFI-P0-03 · P0 · People · Ledger entry delete/restore not idempotent → cached person balance drift

**Real scenario.** Delete the same People entry from two tabs. Or an expense delete/unassign cascade re-runs after a partial failure, because those loops call `softDeleteEntry` per entry from a pre-read list.

**Steps.** `softDeleteEntry(entry)` twice; `restoreEntry` twice (pinned).

**Expected.** 0 / 1,500. **Actual.** −1,500 / 3,000.

**Root cause.** `softDeleteEntry` / `restoreEntry` read the entry fresh but never check `deletedAt`. The multi-entry variants do check.

**Files.**
- `lib/repositories/person-repository.ts` `softDeleteEntry` (634), `restoreEntry` (794)
- Callers: `expense-repository` (resplit, editExpense, unassign, delete, setParticipantReceivedStatus), `use-people-data.deleteLedgerEntry`, `loan-ledger-sync`

**Other sections.** People to-receive/to-give, Month Cycle sides, Net Worth People balance, Dashboard People debt. Drift is absorbed into `unlinked`, so it is invisible as an error.

**Data corruption?** YES. **Repair?** UNKNOWN. Detect: `Person.currentBalance` vs `openingBalance + Σ signedAmount(active entries)`.

**Fix.** Early-return on an already-deleted (or already-live) entry inside the transaction.

**Test.** Emulator double delete/restore → no change (replace the pins).

### WFI-P1-01 · P1 · People ↔ Accounts · Split-share row Settle records no money

**Scenario.** Meera hands back ₹500 for her dinner share. The user clicks Settle on her split row ("Meera pays you").

**Expected.** Bank +₹500, receivable −₹500, NW unchanged. This is what Record Payment does.

**Actual (pinned).** Receivable −₹500; no cash leg; Bank unchanged → NW −₹500. Month Cycle and Dashboard cash-in miss it.

**Root cause.** `EntrySettleForm.needsAccount` excludes `split`. `person-detail-workspace.settleRow` calls `txActions.settleParticipant`, which writes an `InstallmentPayment` and a `receivedBack` entry with no Transaction.

**Files.**
- `features/people/components/workspace/ledger-ui.tsx` (317)
- `features/people/components/person-detail-workspace.tsx` (414–434)
- `lib/repositories/expense-repository.ts` `settleParticipant` / `settleAcrossPending`

**Data corruption?** NO stored corruption, but a missing cash record. **Repair?** YES — affected settlements have `transactionRef = expense.transactionId` and no cash leg.

**Fix.** Route split rows through Record Payment's `split` route (it already exists and posts the cash leg atomically), or add an account choice and post a cash leg in the same transaction.

**Test.** Emulator: settling a split row moves the chosen account by the amount.

### WFI-P1-02 · P1 · Credit Cards · Statement-day purchase double-counted by the standings chain

**Scenario.** A stored statement (Flutter-materialized) ends 15 Aug. The user buys ₹1,000 at 14:30 on 15 Aug.

**Actual (pinned).**

| Surface | Shows |
|---|---|
| Credit Cards outstanding | ₹2,000 |
| Available | short by ₹1,000 |
| Utilization | doubled |
| Pay Full Outstanding prefill | ₹2,000 |
| Pay bill (Engine A) | ₹1,000 |
| Card account | ₹1,000 |

**Root cause.** `unbilledSpendForCard` uses `t.dateTime > latest periodEnd` (midnight), while `statementPeriodTotal` includes the whole `periodEnd` day.

**Files.**
- `lib/repositories/credit-card-repository.ts` `unbilledSpendForCard` (501), `uncoveredClosedSpendForCard` (529)
- `features/credit-cards/hooks/use-credit-cards-data.ts` `computeCreditCardStandings`
- `credit-cards-workspace.tsx:1544`

**Other sections.** Dashboard utilization, Net Worth card lock (no), payment amount.

**Data corruption?** NO. A user paying the pre-filled amount over-pays. **Repair?** NO.

**Fix.** Compare by `dayIndex` (end of day) — better, derive Engine B from `cardBillsForCard` so there is one formula.

**Test.** Pin → assert ₹1,000.

### WFI-P1-03 · P1 · Credit Cards · "Spent this month" = all unpaid spend when no statement is stored

**Actual (pinned).** ₹1,000 (overdue July cycle) + ₹200 (current) → "Spent this month" ₹1,200. Engine A's open cycle = ₹200.

**Root cause.** With no stored statements, `billedThrough = epoch`, so everything is "unbilled" and the derived closed cycles are empty.

**Files.** As WFI-P1-02. **Fix.** Use Engine A's open-cycle bill. **Data corruption?** NO.

### WFI-P1-04 · P1 · Credit Cards ↔ Accounts ↔ Dashboard · Transfers out of a card are on no bill

**Actual (pinned).** Card→bank ₹5,000 → card account −₹5,000 (Dashboard Debt, NW) but Pay bill ₹0 and Credit Cards outstanding ₹0. The same split applies to a card account's opening balance.

**Root cause.** `countsTowardCardStatement` excludes all transfer legs, including the expense leg *out of* the card.

**Fix direction.** Product decision: either treat an outgoing transfer leg on a card as a charge (cash advance / balance transfer), or block card-as-source transfers. Also decide how opening card debt enters the first bill.

**Data corruption?** NO.

### WFI-P1-05 · P1 · Month Cycle / Dashboard · "Don't count this in my totals" is ignored by Income / Outflow / cash-flow

**Actual (pinned).** Excluded ₹10,000 income and ₹4,000 expense appear in Month Cycle Income / Total outflow / savings rate and in Dashboard Money In/Out. My Spend excludes them.

**Root cause.**
- `DashboardTransaction` and `CashFlowTransaction` have no exclude field.
- `use-month-cycle-data.ts` (254) and `hooks/use-transactions.ts` (133) map without filtering.

**Fix.** Filter `excludeFromCalculations` (and `deletedAt`) in both mappings, or add the field to the engines.

**Test.** Hook-level test with an excluded row.

### WFI-P1-06 · P1 · Month Cycle / Dashboard ↔ EMI · Card-linked EMI payment double-counted in outflow

**Actual (pinned).** A ₹5,000 card-linked EMI payment → Month Cycle Total outflow ₹10,000.

On Dashboard the card Transaction is excluded (card account), but `emiPaidThisMonth` still counts ₹5,000 as cash out at payment time. Paying the card bill later counts it again.

**Root cause.** `combinedExpenses` adds `emiPaid` (all EMI installments' `amountPaid`) on top of transaction expenses. Web EMI payments on cards also post a Transaction.

**Fix.** Exclude card-linked EMIs from `emiPaid` (and from `paidThisMonth`), or exclude `emiId` transactions from `myExpenses` when `emiPaid` covers them.

### WFI-P1-07 · P1 · Loans ↔ Accounts · Editing loan principal does not adjust the origination deposit

**Scenario.** A loan was created as ₹30,000 deposited to Bank; the user corrects the principal to ₹40,000 in Edit.

**Expected.** Either the deposit is updated atomically, or the edit is refused / explained while origination money is active.

**Actual (traced).** `editLoanTerms` writes `loanAmount = 40,000` and re-plans the schedule. The `orig_…` Transaction and the account are unchanged → NW −₹10,000.

**Files.**
- `lib/repositories/loan-repository.ts` `editLoanTerms`
- `features/loans/components/loans-workspace.tsx` (principal field enabled in edit; 256–300)

**Data corruption?** YES (Loan vs Account disagree). **Repair?** UNKNOWN.

**Fix.** Block `loanAmount` change while `originationMoneyState === "moneyActive"` (offer Reverse & re-create, or Borrow More), or move the deposit atomically.

**Test.** Emulator origination + edit principal → NW unchanged or refused. **Not executed in this audit.**

### WFI-P1-08 · P1 (needs product decision) · EMI ↔ Accounts / Net Worth · Non-card EMI payments move no account

**Actual (traced).** `recordPayment` posts a Transaction only for card-linked EMIs. Paying a bank EMI lowers outstanding principal, so NW rises by the principal portion with no cash outflow. If the user also records the bank debit as an expense, Dashboard cash flow counts it twice (expense + `emiPaidThisMonth`).

**Fix direction.** Add a paid-from account (the EMI already has `autoDebitAccount`) and post a Transaction like loans do. Otherwise label the NW effect.

**Data corruption?** NO (by design today), but NW is materially wrong for these users.

### WFI-P1-09 · P1 · Splits / People · Split expense edit, delete, unassign and resplit are non-atomic sequences

**Actual (traced).**
- `deleteExpense`: delete Transaction → soft-delete installments one by one → delete entries person by person → delete Expense. Each is a separate write.
- `editExpense`, `unassignFromPerson` and `resplitExpense` likewise; resplit has no rollback.
- A failure or closed tab mid-way leaves, for example, the Transaction trashed but People obligations live. Offline, plain `setDoc` steps stall.
- Only `createExpense` / `convertToSplit` have a rollback journal.

**Fix.** A two-phase design like `agreement-deletion` (one atomic money transaction for Transaction + entries + person balances; then a batched purge), or a session-buffered single transaction as Record Payment does.

**Data corruption?** YES on partial failure.

### WFI-P1-10 · P1 · People · `restoreExpense` resurrects deliberately retired entries

**Actual (pinned).** ✓ received → ✕ undo (the status entry is trashed) → delete expense → restore → Kiran's share shows 0 instead of ₹800.

**Root cause.** `getTrashByTransactionRef` restores everything with that ref, not only what `deleteExpense` trashed.

**Fix.** Stamp the entries trashed by a delete (`deletedBy: "expense:<id>"` or a shared `deletedAt`) and restore only those. Make `restoreEntry` idempotent (P0-03).

### WFI-P2-01 · P2 · Month Cycle · Card refunds counted as income

Pinned. A non-transfer income on a card account is a credit, not income. Fix: exclude card-account rows from `income`. Product decision: should a refund reduce My Spend? See §23.

### WFI-P2-02 · P2 · Dashboard · Upcoming payments read stored `Statement.amountPaid`

Web never updates `amountPaid` (payments settle via allocation), so paid statements look unpaid and derived (unstored) bills never appear. Fix: use `cardStatementPaymentScope` / `cardBillsForCard`.

### WFI-P2-03 · P2 · Dashboard / Credit Cards · Two card-debt figures on one screen

Debt (card) uses `-Σ card Account.currentBalance`; Utilization uses standings. They diverge on opening balances, transfers out of cards and P1-02. Fix: one card-debt source, with the reconciliation explained.

### WFI-P2-04 · P2 · Month Cycle / People · Cycle start day is per browser

`localStorage` only (`use-user-preferences.ts`). Other devices and Flutter see a different cycle, so People statement PDFs differ by device. Fix: persist to `users/{uid}` (product + Flutter coordination).

### WFI-P2-05 · P2 · Month Cycle · EMI dues show only the next installment

A carried overdue installment plus the current one shows one row, so the total is short. Fix: per-installment like `loanCycleDues`.

### WFI-P2-06 · P2 · Month Cycle · Inconsistent bucket dates / accountingMonth handling

Three helpers (see §5). Fix: one bucket rule for every Month Cycle figure.

### WFI-P2-07 · P2 · People · Concurrent advance applications can overdraw an advance

`applyAdvance` pre-reads existing applications outside the transaction. Fix: query inside — not possible client-side, so keep a running `appliedAmount` on the advance entry, read and written in the transaction.

### WFI-P2-08 · P2 · People · Opening-balance obligation Settle always fails

`needsAccount` is false for `opening`; `accountId: ""` → `TransactionFundingMismatchError("Select an account.")`. Fix: require an account (or settle without a cash leg, explicitly).

### WFI-P2-09 · P2 · Loans · Prepayment re-plan is a second unit; reversal eligibility is checked outside the transaction

Documented design. If unit 2 fails, the schedule is stale until retried. A concurrent payment between `assertReversible` and the reversal is not re-checked. Fix: re-check "latest action" inside the transaction.

### WFI-P2-10 · P2 · Transactions · Plain create / split create have no idempotency key

A lost response then Save again creates a duplicate (the in-component ref only blocks concurrent clicks). Fix: a deterministic id from a dialog-scoped key, as transfers do.

### WFI-P2-11 · P2 · Dashboard / Month Cycle · Proxy month attribution

`emiPaid` / `paidThisMonth` bucket by installment **due** date, and `moneyReceived` by the **expense's** month — not payment date. A late or advance payment lands in the wrong month. Fix: bucket by `InstallmentPayment.date`.

### WFI-P2-12 · P2 (security hardening) · Firestore rules · No financial-field validation

Owner-only rules; no type, amount or immutability checks (e.g. `openingBalance`, `createdAt`, negative amounts, `deletedAt` toggling). Not cross-user. Fix direction: field-type / immutability rules first; server-side balance maintenance later (§23).

### WFI-P2-13 · P2 · Legacy · Converters throw on missing timestamps

One malformed doc errors an entire live list. Fix: tolerant parsing plus quarantine of the bad doc id.

### WFI-P3-01 · P3 · Credit Cards · `CycleAnchor` January window inverted

Pinned: start 16 Dec 2027 > end 15 Jan 2027. Only `statementCycleView` (the next-due statement label) is affected. Fix: floored year arithmetic for Web (card windows already avoid it).

### WFI-P3-02 · P3 · Splits · ₹0.00 shares from tiny equal splits

Pinned. Fix: validate before writing ("amount too small to split"). A blocked save, not corruption.

### WFI-P3-03 · P3 · Month Cycle · "vs last cycle" compares a length-shifted window

`previousRangeFor`. Fix: `adjacentCycleRange`.

### WFI-P3-04 · P3 · Errors · Actionable error messages replaced with "Please try again."

`USER_FACING_ERROR_TYPES` lacks `LoanPaymentTransactionRestrictedError`, `PersonCashLegDeleteBlockedError` and `TransactionFundingMismatchError`.

### WFI-P3-05 · P3 · Dashboard · Net Worth "trend" is a 7-day cumulative flow from 0

It is not net worth, and it includes People cash legs.

### WFI-P3-06 · P3 · People · "Settled this month" uses the calendar month

The People "settled this month" stat is a calendar-month sum. Month Cycle shows the configured cycle. Label or align.

### WFI-P3-07 · P3 · Accounts · Account type editable after creation

Bank ↔ card ↔ cash with no migration, and no guard when a card profile exists. Not executed.

### WFI-P3-08 · P3 · Transaction Studio · Committed-row edits write UTC-midnight dates

Time-of-day is lost. In negative UTC offsets the date and month shift. Any save on a transfer leg throws `TransferEditRestrictedError` (the date "changed").

### WFI-P3-09 · P3 · Credit Cards · Statement watcher publishes partial per-card sets

Totals are briefly inconsistent while cards load.

### WFI-P4-01 · P4 · `StatementPaymentRepository.recordPayment` is unsafe if ever wired

Bank-only leg, ungated (already documented in code). Remove or guard.

### WFI-P4-02 · P4 · Dead non-transactional `AccountRepository.adjustBalance` and unused `reconcileBalance`

Remove the first. Repurpose the second as a read-only drift detector.

### WFI-P4-03 · P4 · Stored balances accumulate raw floats

No rounding in `applyBalanceDelta`. Consider paise integers or round-on-write.

### WFI-P4-04 · P4 · Unused collection-group query factories

`repository-factory.ts` 326, 404. If ever used they need explicit rules. Remove.

---

## 21. Existing-data repair risks

Run **read-only diagnostics first**; do not auto-repair.

| Risk | How to detect | Source |
|---|---|---|
| Account balance drift | `currentBalance ≠ openingBalance + Σ balanceEffect(active transactions)` | P0-01, P0-02, P1-07 |
| Person balance drift | `currentBalance ≠ openingBalance + Σ signedAmount(active entries)` | P0-03, P1-09, P1-10 |
| Loan/EMI transaction vs installment payments | `Transaction.amount ≠ Σ linked InstallmentPayment.amount` | P0-02a |
| Cash leg vs its ledger entry | Amount mismatch | P0-02b |
| Split transaction vs Expense | `amount ≠ Expense.totalAmount` | P0-02c |
| Split settlements without cash | `receivedBack` entries with `transactionRef == expense.transactionId` and note "Split settlement:" | P1-01 — the money may need recording, ask the user |
| Origination drift | Loans with `loanAmount` edited after origination: `editHistory` "loanTerms" + an active `orig_` Transaction amount ≠ `loanAmount` | P1-07 |
| Partial split cascades | Trashed Expense / Transaction with live entries, or the reverse | P1-09 |

Unknown at this point: whether any of these exist in real data. Web cannot query production from here.

---

## 22. Recommended fix order

1. **P0-01 and P0-03 (idempotent deletes/restores).** Small, local changes with high value. Ship with a read-only drift report (P4-02 → detector).
2. **P0-02 (edit routing/locks)** for Loan/EMI, then People cash legs, then splits. Start by locking the fields in the modal/Studio and refusing at the repository.
3. **P1-01** (split Settle → Record Payment route).
4. **P1-05 / P1-06 / P2-01** (one mapping fix in Month Cycle + Dashboard cash flow; add hook-level tests).
5. **P1-02 / P1-03 / P1-04 / P2-02 / P2-03** — collapse the card Engine B into Engine A. One card bill truth everywhere.
6. **P1-07** (block or sync principal edits with active origination).
7. **P1-09 / P1-10** (atomic split cascades; scoped restore).
8. **P1-08** (product decision on EMI account legs).
9. P2s by user impact (P2-04 cycle persistence, P2-10 idempotent create, P2-05, P2-06, P2-07, P2-08, P2-12 rules hardening, P2-13).
10. P3 / P4.

---

## 23. Future functionality discovered (not bugs)

- Server-side (Cloud Functions) balance maintenance or validation, so invariants don't rely on every client (relates to P2-12).
- Account / Net Worth history snapshots ("change this month" is stubbed to 0 today).
- Statement materialization / closing on Web, with a stored, locked closed due (today everything is live-derived).
- A refund architecture that links a refund to its purchase (to decide whether refunds reduce My Spend, and in which cycle).
- Cash-advance / balance-transfer modelling on cards (P1-04's product half).
- EMI paid-from account (P1-08).
- Firestore-backed user preferences shared with Flutter (P2-04).
- Automated drift-repair tooling with user review.

---

## 24. Areas proven correct (KNOWN SAFE)

Only items traced through real code **and** covered by a passing test (existing or added here):

- **PASS** — Transfer create: source −once, destination +once, no income, no spend, no NW change; atomic; idempotent via `idempotencyKey`; a changed-data retry is refused.
- **PASS** — Transfer leg amount / account / date cannot be edited in place.
- **PASS** — Card payment is never My Spend and never income; it counts as cash out once (Dashboard).
- **PASS** — Card credits / refunds subtract from the statement they're dated in (pinned).
- **PASS** — Card payments settle oldest-due-first; no negative due.
- **PASS** — Shared card limit is counted once in totals; statements and payments stay per physical card.
- **PASS** — The card People gate runs inside the payment transaction on create, restore and link (no bypass found).
- **PASS** — Card statement windows close on the statement day inclusive and use the card's own cycle, not the Month Cycle (pinned).
- **PASS** — Month Cycle window is contiguous and inclusive at both ends; People cycles use the same engine (pinned).
- **PASS** — My Spend: split / assigned → my share only; transfers, People cash legs and loan principal excluded; excluded rows excluded.
- **PASS** — Person reimbursement does not pay the lender; a lender payment does not change the People balance (existing People ↔ loan integration tests).
- **PASS** — Record Payment is atomic, rejects stale / duplicate submits, and revert/edit restore the exact state (existing integration).
- **PASS** — Held advance never becomes receivable or payable; application moves no cash or balance.
- **PASS** — Loan origination is atomic; Trash is blocked while origination money is active; restore is blocked after reversal.
- **PASS** — Loan and EMI payments are atomic and idempotent; reversal is limited to the latest action.
- **PASS** — Ownership shares reconcile to the paisa for 2–6 parties and odd installments (pinned).
- **PASS** — Equal splits reconcile to the paisa for 3, 4, 5 and 7 people (pinned).
- **PASS** — Net Worth composition identity: Assets − Debt − Held = Net Worth.
- **PASS** — Card-owned EMI / card-funded Loan principal is counted once (card lock), never again as EMI or Loan debt.
- **PASS** — User isolation in Firestore rules (owner-only per `users/{uid}` path; existing rules tests).
- **PASS** — Listener errors surface (banner + retry), are not swallowed.

---

## 25. Areas that could not be proven

- Real production data: whether drift from P0-01, P0-02, P0-03 or P1-07 already exists.
- WFI-P1-07 (loan principal edit) — traced in code, not executed against the emulator.
- UI-level double-click on Delete (React state timing). The two-tab / stale-copy form is proven at the repository.
- Offline behaviour of the non-transactional split chains (pending `setDoc` promises) — reasoned from Firestore SDK semantics, not reproduced.
- Rules suite (`npm run test:rules`) — not run. Rules were reviewed by reading.
- Transaction Studio PDF/SMS commit paths (`commit-review-import.ts`) — the routing was spot-checked (same repositories), not audited end to end.
- Purpose-fund flows, follow-ups / reminders, and People statement PDF numbers — spot-read only.
- Flutter-written legacy documents with unusual shapes — reasoned from converters only.
- Account `type` change effects (P3-07) and account permanent-delete cascade — read, not executed.
- Installment progress / next-due / counts (`installment-progress.ts`) — relies on existing tests, not re-derived.

Environment note: the integration suite was run against a Firestore emulator already running on 127.0.0.1:8080 (started by another session). The audit tests use their own project id, so they do not interfere with it. `firebase emulators:exec` could not bind the port while that emulator was up.
