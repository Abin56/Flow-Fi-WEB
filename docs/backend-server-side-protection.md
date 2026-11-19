# Server-side protection of financial integrity — findings and options

Audit of 2026-11-17. Evidence is from `tests/integration/global-consistency-audit.test.ts` (Firestore emulator, synthetic data)
unless marked *code-read*.

## 1. What Firestore rules enforce today

| Collection | Rule | Effect |
|---|---|---|
| everything under `users/{uid}` | owner-only | another signed-in user can read or write **nothing** (probed: `SERVER: another signed-in user…`) |
| `transactions` | owner-only, plus: a transaction linked to a Loan/EMI payment (`earlierPaymentLink`) cannot be deleted, and its money fields cannot be edited | the only financial relationship the rules protect |
| `accounts`, `people` (+ `ledger`), `loans`, `emis`, `expenses`, `paymentSchedules` (+ installments, payments), `creditCards`, `bills` | `allow read, write: if isOwner(uid)` | **no validation of any field** |

Probed with real direct writes as the owner (these are pinned as "SERVER GAP" tests and will fail the day the rules change,
so the change is noticed):

* the owner's client **can delete an EMI that has a person repayment** — the client-side guard is the only protection;
* the owner's client **can write any `currentBalance`** to an account — the drift detector catches it afterwards.

## 2. Why the delete guard cannot be a plain rule

A rule can only `get()` / `exists()` / `getAfter()` documents at **known paths**, at most 20 per request. It cannot run a query.
"Does any ledger entry of any person point at this EMI's installments?" is a query. Three further limits:

* the repayment is a ledger entry under `people/{personId}/ledger`, and the agreement document stores no list of them;
* a statement import or a bulk reconciliation writes hundreds of transactions in one batch — a per-transaction balance rule
  (`getAfter(account).balance == get(account).balance + effect`) costs ≥ 2 reads each and would exceed the 20-call limit;
* agreement deletion itself hard-deletes up to ~480 owned transactions in one transaction, each needing its account reversal.

So "balances always equal their records" and "no repayments ⇒ may delete" are **not expressible in rules** without new stored state.

## 3. What was implemented instead (web, client + backstops)

1. **Delete guard** (`lib/engines/agreement-deletion.ts`, `lib/repositories/agreement-deletion.ts`): blocked while a live person
   repayment settles an installment; re-evaluated *inside* the delete transaction after reading every participant's person
   document. Every repayment writes its person's balance, so a repayment that commits meanwhile makes the delete retry and then
   refuse. Verified by 48 staggered races (delete won 36, lost 12): the invariant "EMI gone ⇒ no live repayment" held every time.
2. **Repayment guard** (`PersonPaymentRepository.assertAgreementStillExists`): inside the repayment transaction the installment
   must exist under the schedule of a live agreement whose schedule is not stamped deleted. A stale tab recording a repayment
   against a deleted EMI is refused (it previously succeeded: bank +₹500, person −₹500 — "I owe them").
3. **Backstop for anything else** (`orphan-share-settlement` in `lib/engines/financial-audit.ts`): the read-only Financial
   Audit reports a repayment whose installment/agreement no longer exists (other clients, direct writes, deletions made
   before the guard). Detection only; it never changes a balance.

## 4. Where the web protections do NOT reach (*code-read*, Flutter app in `C:\Users\anjel\Finance_App`, not modified)

* `EmiRepository.permanentlyDeleteEmi` (`lib/features/emi/data/emi_repository.dart:700`) and `LoanRepository.permanentlyDeleteLoan`
  (`lib/features/lending/data/loan_repository.dart:1104`) are **sequences of individual deletes** — no Firestore transaction,
  no reversal of the agreement's payment transactions, **no check for person repayments** (the Loan version only blocks while
  origination money is active). Reachable from the EMI detail screen and the Trash screens. A failure part-way leaves a partial
  agreement.
* Flutter's repayment write (`lib/features/people/data/person_payment_repository.dart`, `DerivedRoute`) does not verify that the
  installment/agreement still exists.
* Flutter's weekly cash-flow bars do not exist, so that web defect has no Flutter counterpart.
* `TransactionRepository.createTransferPair` (Flutter) flags both legs `excludeFromCalculations: true` and then applies
  `leg.balanceEffect` (= 0), so it would move no money; its comment says it mirrors the web, which does not flag the legs.
  It is only called from tests (no UI path), so it is latent.

Because the Android app ships these behaviours, a person's repayment can still be orphaned from Flutter. Detection (3) covers it;
prevention needs a Flutter change.

## 5. Options for real server-side enforcement (not implemented — needs a decision)

| Option | Closes | Cost / risk |
|---|---|---|
| **A. Settlement counter on the schedule document** (`personSettlementCount`), incremented/decremented inside every repayment / revert; rule: an agreement document may be deleted only if its schedule's counter is 0 | direct deletes by any client, once that client maintains the counter | schema change shared with Flutter; **every** path that creates or reverses a repayment must maintain it (revert, edit, ledger deletion, historical flows) — a missed path leaves a counter > 0 and **locks the agreement undeletable with no in-app escape**; legacy records have no counter (fail-open until backfilled) |
| **B. Cloud Function on `emis`/`loans` delete** that re-creates nothing but flags/quarantines the orphan, plus a scheduled audit | detection and alerting for every client | cannot *prevent*; functions codebase has known clashes; deploy needs approval |
| **C. Ship the guard to Flutter** (atomic transaction + the same two checks) | the only live bypass today | a Flutter release (APK 1.0.3+4 is current) |
| **D. Keep A–C out; rely on 3 (audit) + client guards** | — | what is in place now |

Recommendation: **C first** (it removes the one live bypass), **B** if alerting is wanted, **A** only after the counter's
maintenance paths are inventoried; do not deploy A without a backfill and an in-app "recompute counter" escape.

None of the rules changes above were made or deployed.
