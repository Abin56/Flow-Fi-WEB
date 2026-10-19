# FlowFi WEB — Manual QA Report

Date: 2026-10-16 · Executed in real Chrome (Playwright, headless, `channel: chrome`) on Windows 11 against the **local Firebase Emulator Suite with synthetic data only**.

## 0c. Fifth pass — F-07 and D-06 fixed

F-07 (stale EMI payment) and D-06 (EMI funding label) are **fixed**; Loan was tested and had the same weakness, now fixed. Full browser suite: **73 / 73** (71 scenarios + 2 safety). Details in section 13.

## 0d. Sixth pass — payment-path safety follow-up

Stale-error wording (no retry), isolated card-linked EMI browser scenarios, payment-path substitution audit, and the approved `recordLumpSumSettlement` fix. Details and final verified results in section 14.

## 0b. Fourth pass — financial reversal / editing QA

20 new scenarios (People, EMI, Accounts) were added and **all pass**; the full suite is now **70 / 70** (68 scenarios + 2 safety). Two behaviours are recorded as documented **findings** (D-06 display label, F-07 stale second tab) — see section 12. No financial engine, repository or schema was changed.

## 0a. Third pass — D-05, People split account, historical-label reliability

D-05, the People Split Expense account default and the historical-label reliability issue are **fixed**; section 11 has the details.
**50 of 50 browser checks pass on the final code** (48 scenarios + 2 safety checks). Everything below this note that quotes "45 of 45" is the second pass.

## 0. Second pass — read this first

The three UX findings from the first run (D-02, D-03, D-04) are **fixed**, and the browser automation now lives in the repository
(`npm run test:e2e-qa`). **45 of 45 browser checks pass on the final code** (43 scenarios + 2 safety checks): the original 38, now running from the repo,
plus new D-02 / D-03 / D-04 scenarios. Section 10 has the details. Section 5's statuses are updated; the per-scenario write-ups in section 4 are from the
first run (they predate the fixes — e.g. the Loan payment button read "₹5,331" then and reads "₹5,330.93" now — and the re-run is in section 10).

## 1. Result at a glance

- **38 of 38 automated browser scenarios passed, 0 failed.** Each scenario drives the real FlowFi UI and then reads the *persisted* documents back from the emulator (account balances, transactions) — assertions are on stored state, not just on what the screen says.
- **No critical financial defect found.** Every money-moving flow wrote once, debited/credited the right account by the right amount, and reconciled to the statement.
- **The post-commit responsiveness work behaves as designed in a real browser** (section 3): success never precedes the commit, a slow refresh doesn't delay the confirmation, a failed refresh warns without retrying the write, the 8 s fallback fires, and duplicate clicks write once.
- **4 findings (D-01…D-04)**: one portal-bundling defect that I found in the QA tooling itself and fixed during this run (D-01), and three low/medium observations about existing app behaviour that I did *not* change (D-02…D-04). No financial engine, repository, rules or production config was modified.
- **Not executed / limited** (section 7): People edit/reverse, EMI mark-unpaid/edit and EMI refresh-failure, pagination balances, real touch devices, non-Chrome browsers, and the physical-device latency question.

> **Latency honesty.** Everything here ran against a local emulator on one machine. "Slow write" is a 3 s delay injected by Playwright on the Firestore `:commit` call; "slow/failed refresh" is injected by the QA portal into this tab's query client. Those numbers prove *behaviour under delay*, not production latency. The un-delayed timings are emulator timings.

## 2. Environment, safety and how it was run

| Item | Detail |
|---|---|
| Data | Firebase **Emulator Suite** (Auth + Firestore) on dedicated ports 9399 / 8380, project id `demo-flowfi-qa`. Synthetic user `qa.tester@flowfi-qa.test`. |
| App runtime | `next dev` on **a scratch copy of the working tree** (port 3210) with *no `.env.local`* — the QA runtime holds no production Firebase config at all. The developer's own dev server (3100) and an unrelated emulator already running on 8080/9099 were left untouched. |
| Guard | Portal refuses to operate unless: dev build · `NEXT_PUBLIC_QA_EMULATOR=1` · `demo-*` project id · localhost · Auth *and* Firestore SDKs actually connected to 127.0.0.1 emulators · both emulators reachable. Fails closed (test `guard-blocks`). Every seed/reset also re-asserts it and the QA-user email. |
| Production | `/dev/qa` returns **404** in a production build, and after fix D-01 the portal's code, QA credentials and `__qa` hook are **absent from the client bundle** (searched). |
| Unit tests | `npx vitest run`: 216 files / 2645 tests pass (second pass; first pass 211 / 2,599). `tsc --noEmit` and ESLint on the new files are clean. |
| Browsers/viewports | Chrome only. 1920×1080, 1366×768, 390×844 (viewport emulation, not a device); light and dark. |

### Fixtures (all created through the app's own repositories)

Bank ₹100,000 and Cash ₹5,000 · Loan A (12 installments, ₹60,000) · Loan B (60 installments, ₹300,000) · personal Loan C (4 installments, from QA Lender) · EMI ₹24,000 / 6 · historical account-neutral payment (Loan A #1, "already paid earlier") · credit card with ₹12,000 outstanding · people QA Priya / QA Ravi / QA Lender · shared expense ₹3,000 split three ways · regular unpaid bill ₹1,500 · salary ₹40,000 and groceries ₹850. **Not seeded:** a pre-recorded *partial reimbursement* — it is created by the `people-receipt` scenario instead — and a paid EMI installment, created by `emi-record`. Dates are relative to "today", and the card's statement day is 1, so the card shows its ₹12,000 as "not billed yet" (app behaviour, not a defect).
Reset test fixtures wipes only `/emulator/v1/projects/demo-flowfi-qa/…` — an endpoint that exists only on the local emulator.

## 3. Loan & EMI post-commit behaviour — what was observed

Measured in Chrome; "write" is the `:commit` round trip; the injected delays are marked.

| Scenario | Write | Commit → success shown | Success → dialog closed | Notes |
|---|---|---|---|---|
| `loan-record` | 187 ms | 36 ms | 847 ms |  |
| `loan-duplicate-click` | 92 ms | 28 ms | 894 ms |  |
| `loan-slow-write` | 3349 ms | 34 ms | 787 ms | 3 s injected on commit → success appeared 28–35 ms after commitEnd, never before |
| `loan-slow-refresh` | 108 ms | 28 ms | 3067 ms | 3 s refresh injected → closes ≈3 s after success; label 'Saved · Updating balances…' |
| `loan-refresh-fail` | 90 ms | 30 ms | 783 ms | refresh warning at +503 ms after success; one commit; no retry |
| `loan-refresh-8s` | 217 ms | 26 ms | 8755 ms | 12 s refresh injected → closes at ≈8 s + 0.7 s hold with the 'Updating balances…' notice |
| `loan-mark-unpaid` | 161 ms | 13 ms | 791 ms |  |
| `loan-unpaid-slow-refresh` | 203 ms | 12 ms | 3034 ms | 3 s refresh injected |
| `loan-edit-payment` | 227 ms | 23 ms | 913 ms |  |
| `emi-record` | 146 ms | 26 ms | 796 ms |  |

Reading guide: *commit → success* is the confirmation lag and is 12–39 ms in every Loan/EMI run, including when the refresh was delayed 3 s or 12 s — i.e. the slow refresh does not delay the confirmation. The sub-5 ms "success before commitEnd" blips seen in the People flow are measurement resolution (the XHR `loadend` listener can run after Firestore's own completion handler), not a real ordering problem; the Loan/EMI flow showed success strictly after commit in every run.
The five requested UI states were all observed: **Recording…** (`loading`) → **Payment recorded** (success) → **Saved · Updating balances…** → refresh complete (dialog closes) → **refresh-failed warning** ("Saved — balances couldn't refresh. Your change is saved and won't be repeated…").
Timing method note: the page clock is reset immediately before the Playwright click call, so "click → loading" values include locator/actionability time (tens to a few hundred ms) and are upper bounds. Intervals between events (write, confirmation lag, close delay) are unaffected. *Click → dependent UI reflects the change* was **not timed separately**; correctness of the dependent views (statement, Dashboard, Month Cycle, loan list) was verified after the fact instead.

## 4. Scenario results

### 0. Safety

#### guard-blocks — Safety: portal fails closed when the emulators can't be verified
- **Result:** ✅ Pass (3 checks) · **Timing:** —
- **Steps:** Open /dev/qa with every request to the emulator ports aborted.
- **Expected:** Portal renders only the failed-check list; no sign-in / seed / reset controls.
- **Observed:**
  - ✓ portal is blocked when the emulators can't be verified
  - ✓ no Sign-in / Initialize / Reset controls are rendered while blocked
  - ✓ failure list names the unreachable emulators — `QA portal blocked /  / The portal only runs against the local emulator with synthetic data. These checks failed:`
- **Screenshots:** [guard-blocked.png](qa-screenshots/guard-blocked.png)

### 1. Loan & EMI (highest priority)

#### loan-record — Loan: record full installment from bank
- **Result:** ✅ Pass (6 checks) · **Timing:** write 187 ms · commit→success 36 ms · success→closed 847 ms · click→loading ≤ 311 ms · **Defect:** D-03
- **Steps:** Loan & EMI → QA Loan 12 → Record Payment → Paid from QA Bank → Pay ₹5,331 to lender.
- **Expected:** 'Recording…' immediately; one commit; success only after the commit; dialog closes; bank −₹5,331 persisted.
- **Observed:**
  - ✓ loading feedback shown — `311 ms after t0`
  - ✓ exactly one Firestore commit — `1`
  - ✓ success appears only AFTER the commit finished — `commitEnd 706 ms, success 742 ms`
  - ✓ dialog closed — `1589 ms`
  - ✓ bank debited by ~₹5,331 (persisted) — `136150 -> 130819.07`
  - ✓ success -> close < 2.5 s when refresh is fast — `847 ms`
- **Screenshots:** [loan-record-after.png](qa-screenshots/loan-record-after.png)

#### loan-partial — Loan: partial payment of ₹2,000 via Other amount
- **Result:** ✅ Pass (3 checks) · **Timing:** write 194 ms · commit→success 39 ms · success→closed 936 ms · click→loading ≤ 94 ms
- **Steps:** Record Payment → Other amount → Enter a custom amount → ₹2,000 → QA Bank → Pay.
- **Expected:** Button shows ₹2,000; bank −₹2,000 exactly; success after commit.
- **Observed:**
  - ✓ primary action reflects the partial amount — `Pay ₹2,000 to lender`
  - ✓ bank debited exactly ₹2,000 (persisted) — `136150 -> 134150`
  - ✓ success after commit; dialog closed — `{"loading":94,"dialogOpen":94,"commitStart":207,"commitEnd":401,"success":440,"updating":440,"dialogClosed":1376}`
- **Screenshots:** [loan-partial-dialog.png](qa-screenshots/loan-partial-dialog.png)

#### loan-insufficient — Loan: insufficient funds (QA Cash ₹5,000 < ₹5,331)
- **Result:** ✅ Pass (4 checks) · **Timing:** —
- **Steps:** Record Payment → Paid from QA Cash (₹5,000) for a ₹5,331 installment; try to force-click Pay.
- **Expected:** Warning with the shortfall, Pay disabled, no write, cash unchanged.
- **Observed:**
  - ✓ user is warned about insufficient funds — `Not enough balance — short by ₹330.93. Choose another account or lower the amount.`
  - ✓ payment cannot be submitted — `disabled=true`
  - ✓ no write attempted — `0`
  - ✓ cash unchanged (persisted) — `5000 -> 5000`
- **Screenshots:** [loan-insufficient-dialog.png](qa-screenshots/loan-insufficient-dialog.png)

#### loan-duplicate-click — Loan: rapid repeated clicks record once
- **Result:** ✅ Pass (2 checks) · **Timing:** write 92 ms · commit→success 28 ms · success→closed 894 ms · click→loading ≤ 246 ms
- **Steps:** Pay with 3 synchronous click() calls, a triple physical click and Enter.
- **Expected:** One Firestore commit; bank debited once.
- **Observed:**
  - ✓ exactly one Firestore commit — `1`
  - ✓ bank debited once (₹5,331), not 2x/3x (persisted) — `136150 -> 130819.07`

#### loan-slow-write — Loan: slow Firestore write (3 s injected on :commit)
- **Result:** ✅ Pass (6 checks) · **Timing:** write 3349 ms · commit→success 34 ms · success→closed 787 ms · click→loading ≤ 414 ms
- **Steps:** Playwright route delays every Firestore :commit by 3 s; click Pay; inspect at +1.5 s; press Escape; wait.
- **Expected:** 'Recording…' + disabled while pending, no success before the commit, Escape ignored, one commit.
- **Observed:**
  - ✓ loading feedback shown before the write finishes — `{"dialogOpen":265,"loading":414,"commitStart":577}`
  - ✓ NO success while the write is pending — `{"dialogOpen":265,"loading":414,"commitStart":577}`
  - ✓ primary button shows Recording… and is disabled — `1`
  - ✓ Escape cannot dismiss the dialog mid-write
  - ✓ success only after commit completed — `commitEnd 3926, success 3960`
  - ✓ one commit; bank debited once — `136150 -> 130819.07`
- **Screenshots:** [loan-slow-write-mid.png](qa-screenshots/loan-slow-write-mid.png)

#### loan-slow-refresh — Loan: slow derived refresh (3 s)
- **Result:** ✅ Pass (6 checks) · **Timing:** write 108 ms · commit→success 28 ms · success→closed 3067 ms · click→loading ≤ 311 ms
- **Steps:** QA-portal fault injection: payment-derived refresh delayed 3 s; pay.
- **Expected:** Success right after the commit (not delayed); 'Saved · Updating balances…'; dialog closes once the refresh settles.
- **Observed:**
  - ✓ success confirmation NOT delayed by the slow refresh — `commitEnd 581, success 609`
  - ✓ 'Saved · Updating balances…' visible while refreshing — `Saved · Updating balances…`
  - ✓ dialog still open at +1.2 s (waiting for refresh)
  - ✓ dialog closes after refresh (~3 s + hold) — `closed 3067 ms after success`
  - ✓ no refresh-failure warning
  - ✓ one commit only
- **Screenshots:** [loan-slow-refresh-mid.png](qa-screenshots/loan-slow-refresh-mid.png)

#### loan-refresh-fail — Loan: derived refresh fails (injected)
- **Result:** ✅ Pass (5 checks) · **Timing:** write 90 ms · commit→success 30 ms · success→closed 783 ms · success→refresh warning 503 ms · click→loading ≤ 294 ms
- **Steps:** QA-portal fault injection: payment-derived refresh rejects after 0.5 s; pay.
- **Expected:** Confirmed as recorded + visible refresh-failure warning; no retry; one commit; dialog closes.
- **Observed:**
  - ✓ payment confirmed as recorded — `{"dialogOpen":178,"loading":294,"commitStart":387,"commitEnd":477,"success":507,"updating":507,"refreshWarn":1010,"dialogClosed":1290}`
  - ✓ visible warning that balances couldn't refresh — `at 1010 ms`
  - ✓ committed payment NOT retried (one commit) — `1`
  - ✓ bank debited exactly once (persisted) — `136150 -> 130819.07`
  - ✓ dialog closed — `1290`
- **Screenshots:** [loan-refresh-fail-after.png](qa-screenshots/loan-refresh-fail-after.png)

#### loan-refresh-8s — Loan: refresh still running at the 8 s fallback
- **Result:** ✅ Pass (4 checks) · **Timing:** write 217 ms · commit→success 26 ms · success→closed 8755 ms · 8 s fallback notice at +9437 ms · click→loading ≤ 338 ms
- **Steps:** QA-portal fault injection: refresh delayed 12 s; pay.
- **Expected:** Dialog waits (Updating balances…) then closes at the 8 s cap with an 'Updating balances…' notice.
- **Observed:**
  - ✓ still open with 'Updating balances' at +6 s — `{"dialogOpen":175,"loading":338,"commitStart":439,"commitEnd":656,"success":682,"updating":682}`
  - ✓ dialog closes at the ~8 s cap (7.5-9.5 s after success) — `8755 ms after success`
  - ✓ 'Updating balances…' fallback notice shown — `9437`
  - ✓ one commit only
- **Screenshots:** [loan-refresh-8s-after.png](qa-screenshots/loan-refresh-8s-after.png)

#### loan-mark-unpaid — Loan: mark a recorded payment as unpaid (incl. Keep payment)
- **Result:** ✅ Pass (6 checks) · **Timing:** write 161 ms · commit→success 13 ms · success→closed 791 ms · click→loading ≤ 37 ms
- **Steps:** Pay installment 2 → open it → Mark as unpaid → Keep payment (no write) → Mark as unpaid again (double click) → confirm.
- **Expected:** Keep payment writes nothing; confirm reverses once; bank back to its pre-payment balance.
- **Observed:**
  - ✓ Keep payment performs no write — `commits 0`
  - ✓ loading feedback shown — `37 ms`
  - ✓ success only after the commit finished — `commitEnd 371, success 384`
  - ✓ double-click on confirm writes once — `commits 1 (reversal tx may use >1 commit)`
  - ✓ bank balance restored to pre-payment value (persisted) — `136150 -> pay -> 130819.07 -> unpay -> 136150`
  - ✓ dialog closed — `1175`
- **Screenshots:** [loan-mark-unpaid-after.png](qa-screenshots/loan-mark-unpaid-after.png)

#### loan-unpaid-slow-refresh — Loan: mark unpaid with a slow (3 s) refresh
- **Result:** ✅ Pass (3 checks) · **Timing:** write 203 ms · commit→success 12 ms · success→closed 3034 ms · click→loading ≤ 3092 ms
- **Steps:** Pay installment 2, arm 3 s slow refresh, Mark as unpaid → confirm.
- **Expected:** Confirmation immediate; 'Updating balances…'; closes after the refresh.
- **Observed:**
  - ✓ confirmation not delayed by the slow refresh — `commitEnd 3478, success 3490`
  - ✓ 'Updating balances…' shown while refreshing — `{"dialogOpen":2964,"loading":3092,"commitStart":3275,"commitEnd":3478,"success":3490,"updating":3490}`
  - ✓ dialog closes after the refresh settles — `3034 ms after success`

#### loan-edit-payment — Loan: edit a recorded payment (₹5,331 → ₹4,000)
- **Result:** ✅ Pass (4 checks) · **Timing:** write 227 ms · commit→success 23 ms · success→closed 913 ms · click→loading ≤ 59 ms
- **Steps:** Pay installment 2 (₹5,331) → Edit payment → amount ₹4,000 → Save.
- **Expected:** One correction; account reflects ₹4,000 only (not 5,331+4,000).
- **Observed:**
  - ✓ save button reflects an actual change — `Save ₹4,000`
  - ✓ success only after the commit finished — `commitEnd 606, success 629`
  - ✓ bank reflects the corrected amount only (persisted) — `136150 -> 132150 (expected -4000)`
  - ✓ dialog closed — `1542`
- **Screenshots:** [loan-edit-dialog.png](qa-screenshots/loan-edit-dialog.png)

#### emi-record — EMI: record installment of QA Phone EMI from bank
- **Result:** ✅ Pass (4 checks) · **Timing:** write 146 ms · commit→success 26 ms · success→closed 796 ms · click→loading ≤ 287 ms
- **Steps:** Loan & EMI → QA Phone EMI → Record Payment → QA Bank → Pay ₹4,000.
- **Expected:** Same lifecycle as loans; bank −₹4,000.
- **Observed:**
  - ✓ dialog identified the EMI installment — `Pay EMI |  | QA Phone EMI · Installment #1 of 6 |  | TO PAY LENDER | ₹4,000`
  - ✓ success only after the commit finished — `commitEnd 499, success 525`
  - ✓ bank debited by the EMI amount (persisted) — `136150 -> 132150`
  - ✓ dialog closed — `1321`
- **Screenshots:** [emi-record-after.png](qa-screenshots/emi-record-after.png)

### 2. Transactions

#### txn-expense — Transactions: add expense ₹250 (+ triple-click duplicate guard)
- **Result:** ✅ Pass (6 checks) · **Timing:** write 396 ms · click→form reset 790 ms · **Defect:** D-02
- **Steps:** Transactions → Add Transaction → Expense → account QA Bank → ₹250 'QA coffee' → triple-click Add Expense.
- **Expected:** One transaction; bank −₹250; row appears; amount resets.
- **Observed:**
  - ✓ submit enabled once amount + description are filled
  - ✓ [observation] panel state after save — `panel stays open after save`
  - ✓ exactly one transaction persisted despite 3 clicks — `1`
  - ✓ bank debited once, ₹250 (persisted) — `136150 -> 135900`
  - ✓ amount resets after save (save-and-add-another; second save blocked until an amount is entered) — `790 ms after click`
  - ✓ new row visible in the list
- **Screenshots:** [txn-expense-after-save.png](qa-screenshots/txn-expense-after-save.png)

#### txn-income — Transactions: add income ₹1,000
- **Result:** ✅ Pass (2 checks) · **Timing:** write 364 ms · click→form reset 862 ms
- **Steps:** Add Transaction → Income → QA Bank → ₹1,000 → Add Income.
- **Expected:** One income transaction; bank +₹1,000.
- **Observed:**
  - ✓ income persisted once
  - ✓ bank credited ₹1,000 (persisted) — `136150 -> 137150`

#### txn-validation — Transactions: error/loading states — empty submit and failed write
- **Result:** ✅ Pass (4 checks) · **Timing:** —
- **Steps:** Open Add Expense empty and submit; then fill it and submit with every Firestore :commit aborted.
- **Expected:** Empty submit writes nothing and lists what's missing; a rejected commit leaves nothing saved and the panel open.
- **Observed:**
  - ✓ empty form lists what's still needed — `Still needed: Amount Description`
  - ✓ empty submit writes nothing and shows validation — `commits 0, btn disabled=false`
  - ✓ a rejected commit leaves no transaction persisted — `0`
  - ✓ user sees an error or the panel stays open (not a silent success) — `panel remained open`
- **Notes:** console: [warning] [2026-10-16T12:08:47.513Z]  @firebase/firestore: Firestore (12.17.0): RestConnection RPC 'Commit' 0x128476df failed with error:  {"code":"unavailable","name":"FirebaseError"} url:  http://127.0.0.1:8380/v1/projects/demo-flowfi-qa/databases/(
- **Screenshots:** [txn-failed-write.png](qa-screenshots/txn-failed-write.png)

#### txn-edit-delete — Transactions: edit amount ₹250→₹300, then delete
- **Result:** ✅ Pass (3 checks) · **Timing:** —
- **Steps:** Add ₹250 expense → edit amount to ₹300 → Save changes → delete → confirm.
- **Expected:** Account reflects ₹300 (not 550); delete restores the balance; row gone.
- **Observed:**
  - ✓ edit persisted: account reflects ₹300 (not 250+300) — `136150 -> 135850; buttons seen: Save changes`
  - ✓ delete restores the account balance (persisted) — `135850 -> 136150 (base 136150); confirm buttons: Cancel,Delete,Close`
  - ✓ deleted transaction no longer listed
- **Screenshots:** [txn-edit-form.png](qa-screenshots/txn-edit-form.png), [txn-delete-confirm.png](qa-screenshots/txn-delete-confirm.png)

### 3. People Ledger

#### people-receipt — People: Priya pays ₹400 of ₹1,000 into QA Bank (partial settlement)
- **Result:** ✅ Pass (3 checks) · **Timing:** write 472 ms · commit→success -4 ms
- **Steps:** People Ledger → QA Priya → Record payment → ₹400 of ₹1,000 into QA Bank → Record (double click).
- **Expected:** Bank +₹400 once; ₹600 still owed.
- **Observed:**
  - ✓ primary action shows the amount to record — `Record ₹400 received`
  - ✓ bank credited ₹400 exactly once (persisted) — `136150 -> 136550`
  - ✓ ledger shows ₹600 still owed — `CURRENT PENDING ₹600 You need to receive from QA How is`
- **Screenshots:** [people-receipt-form.png](qa-screenshots/people-receipt-form.png), [x9-after-receipt.png](qa-screenshots/x9-after-receipt.png)

#### people-payment — People: record a payment TO QA Lender (₹2,000 from QA Bank)
- **Result:** ✅ Pass (2 checks) · **Timing:** —
- **Steps:** People Ledger → QA Lender → Record payment → Paid to QA Lender → ₹2,000 from QA Bank (double click).
- **Expected:** Bank −₹2,000 once.
- **Observed:**
  - ✓ primary action shows the amount — `Record ₹2,000 paid`
  - ✓ bank debited ₹2,000 exactly once (persisted) — `136150 -> 134150; initial dialog: Record payment — QA Lender |  | Record payment — QA Lender |  | Q | Record payment | · QA Lender |  | QA Lender | 01 Oct – 31 Oct 2026 |  | Money received | Rec`
- **Screenshots:** [people-payment-form.png](qa-screenshots/people-payment-form.png)

### 4. Credit Cards

#### card-pay — Credit Card: pay full outstanding ₹12,000 from QA Bank
- **Result:** ✅ Pass (3 checks) · **Timing:** write 365 ms
- **Steps:** Credit Cards → Pay full outstanding ₹12,000 → From QA Bank → Pay (double click).
- **Expected:** Bank −₹12,000 once; card liability cleared.
- **Observed:**
  - ✓ bank debited ₹12,000 exactly once (persisted) — `136150 -> 124150`
  - ✓ card liability cleared (persisted) — `-12000 -> 0`
  - ✓ UI shows card outstanding ₹0 — `CREDIT USED ₹0 0% used CREDIT LIMIT ₹50,0`
- **Screenshots:** [card-pay-after.png](qa-screenshots/card-pay-after.png)

#### card-cancel — Credit Card: open payment then Cancel
- **Result:** ✅ Pass (2 checks) · **Timing:** —
- **Steps:** Open the card payment panel → Cancel.
- **Expected:** No write; balances unchanged.
- **Observed:**
  - ✓ panel closed
  - ✓ no write attempted; bank unchanged

#### card-cancel-recorded — Credit Card: pay ₹12,000 then 'Cancel recorded payment' (bank + card liability restored)
- **Result:** ✅ Pass (7 checks) · **Timing:** write 1375 ms
- **Steps:** Pay ₹12,000 → card Transactions → Payment actions → Cancel recorded payment → confirm (double click).
- **Expected:** Confirmation lists the effects; bank and card liability restored; written once.
- **Observed:**
  - ✓ precondition: payment recorded (bank −₹12,000, card ₹0) — `136150 -> 124150; card -12000 -> 0`
  - ✓ the recorded payment exposes a 'Payment actions' menu
  - ✓ confirmation states the effects (amount / bank / card) — `Cancel this recorded payment? |  | Amount: ₹12,000 · QA Credit Card |  | WHAT WILL CHANGE |  | Card outstanding: ₹0 → ₹12,000 | Available credit: ₹50,000 → ₹38,000 | QA Bank balance: ₹1,24,150 → ₹1,36,150 | Keep payment | Cancel r`
  - ✓ bank restored to the pre-payment balance (persisted) — `136150 -> 136150`
  - ✓ card liability restored to −₹12,000 (persisted) — `-12000 -> -12000`
  - ✓ confirm double-click wrote once — `commits 1`
  - ✓ UI shows the card outstanding again — `CREDIT USED |  | ₹12,000`
- **Screenshots:** [card-cancel-recorded-confirm.png](qa-screenshots/card-cancel-recorded-confirm.png)

### 5. Regular Bills

#### bill-pay — Bills: Pay from my account now (QA Bank ₹1,500)
- **Result:** ✅ Pass (2 checks) · **Timing:** write 294 ms
- **Steps:** Bills → QA Electricity → Pay… → Pay from my account now → Pay now (double click).
- **Expected:** Bank −₹1,500 once; dialog closes.
- **Observed:**
  - ✓ bank debited ₹1,500 exactly once (persisted) — `136150 -> 134650; dialog: Pay QA Electricity | Choose exactly what happened to the money. | Pay from my account now | Debits the account you choose, once, and marks the bill paid. | Already paid earlier — included in my balanc`
  - ✓ dialog closed — `888 ms`
- **Screenshots:** [bill-pay-form.png](qa-screenshots/bill-pay-form.png)

#### bill-earlier — Bills: Already paid earlier — no balance change
- **Result:** ✅ Pass (2 checks) · **Timing:** —
- **Steps:** Pay… → Already paid earlier → record.
- **Expected:** Account balance unchanged; bill shows paid.
- **Observed:**
  - ✓ account balance unchanged (account-neutral, persisted) — `136150 -> 136150; dialog: Pay QA Electricity | Choose exactly what happened to the money. | Pay from my account now | Debits the account you choose, once, and marks the bill paid. | Already paid earlier — included in my balance | `
  - ✓ bill shows as paid in the UI
- **Screenshots:** [bill-earlier-form.png](qa-screenshots/bill-earlier-form.png)

#### bill-insufficient — Bills: ₹1,500 bill paid from QA Cash holding only ₹1,000 — insufficient funds
- **Result:** ✅ Pass (4 checks) · **Timing:** —
- **Steps:** Spend ₹4,000 of QA Cash via Add Expense (₹1,000 left) → Pay… ₹1,500 bill → Paid from QA Cash.
- **Expected:** Message explains, Pay disabled, no write.
- **Observed:**
  - ✓ fixture: QA Cash holds ₹1,000 and the bill is ₹1,500 — `cash 1000`
  - ✓ user is told why payment can't proceed (insufficient-funds message) — `That account doesn't have enough balance — choose another account or lower the amount.`
  - ✓ Pay now is disabled or blocked
  - ✓ payment is NOT recorded: cash unchanged, no commit (persisted) — `1000 -> 1000; commits 0; after force-click: no message`
- **Screenshots:** [bill-insufficient-form.png](qa-screenshots/bill-insufficient-form.png)

#### bill-cancel-edit — Bills: Cancel the pay dialog, then Edit the bill amount
- **Result:** ✅ Pass (3 checks) · **Timing:** —
- **Steps:** Pay… → Cancel; then Edit the bill amount to ₹1,800 → Save.
- **Expected:** Cancel writes nothing; edit persisted.
- **Observed:**
  - ✓ cancel performs no write
  - ✓ edit form exposes the bill amount — `|e.g. Electricity|QA Electricity ; |0.00|1500 ; |dd/mm/yyyy|19/10/2026`
  - ✓ edited amount persisted (₹1,800) — `[["QA Electricity",1800]]`
- **Screenshots:** [bill-edit-form.png](qa-screenshots/bill-edit-form.png)

### 6. Accounts

#### acct-running — Accounts: Debit / Credit / Running Balance, newest-first, after real writes
- **Result:** ✅ Pass (5 checks) · **Timing:** —
- **Steps:** Add a ₹250 expense, then Accounts → View QA Bank balance breakdown.
- **Expected:** Debit / Credit / Balance columns, newest first, every row reconciles down to the opening balance and the persisted balance.
- **Observed:**
  - ✓ statement has rows — `4`
  - ✓ newest-first ordering (dates non-increasing) — `2026-10-16 > 2026-10-14 > 2026-10-12 > 2026-10-10`
  - ✓ first row's running balance equals the persisted current balance — `135900 vs persisted 135900`
  - ✓ every row: previous balance + credit − debit = row balance (down to opening balance) — `opening 100000`
  - ✓ sheet headline equals persisted balance — `135900 vs 135900`
- **Screenshots:** [acct-breakdown.png](qa-screenshots/acct-breakdown.png)

#### acct-filter — Accounts: 'Money out' filter keeps true running balances
- **Result:** ✅ Pass (2 checks) · **Timing:** —
- **Steps:** Breakdown → 'Money out' filter.
- **Expected:** Only debits, each keeping its true running balance.
- **Observed:**
  - ✓ filter shows only debits — `3 rows`
  - ✓ filtered rows keep the balance they had in the full statement (not recomputed) — `QA statement coffee:135900 | QA groceries:136150 | QA team dinner:137000`
- **Screenshots:** [acct-filter-out.png](qa-screenshots/acct-filter-out.png)

#### acct-mismatch — Accounts: stored balance deliberately corrupted in the emulator → mismatch surfaced
- **Result:** ✅ Pass (2 checks) · **Timing:** —
- **Steps:** Corrupt QA Bank's stored balance by +₹777 in the emulator, reload, open the breakdown.
- **Expected:** A visible mismatch warning that says nothing was adjusted.
- **Observed:**
  - ✓ fixture corruption written to the EMULATOR (+₹777) — `200`
  - ✓ a balance mismatch warning is shown — `Your records explain ₹1,36,150.00, but the balance shown is ₹1,36,927.00. The remaining ₹777.00can't be traced to a record — it may come from an older edit or data added outside the app.`
- **Screenshots:** [acct-mismatch.png](qa-screenshots/acct-mismatch.png)

### 7. Dashboard / Month Cycle

#### dash-totals — Dashboard / Month cycle: totals follow confirmed writes without reload
- **Result:** ✅ Pass (4 checks) · **Timing:** —
- **Steps:** Add a ₹250 expense (client-side), then Dashboard and Month Cycle.
- **Expected:** Expenses, total balance, recent list and 'My spend' all follow the write.
- **Observed:**
  - ✓ Expenses (cash flow) increased by ₹250 — `3,850 -> 4,100`
  - ✓ Total balance reflects the debit (persisted) — `1,40,900 vs 140900`
  - ✓ new transaction listed under Recent transactions
  - ✓ Month cycle 'My spend' includes the new ₹250 (₹13,850 -> ₹14,100) — `MY SPEND | Combined | Mine only | ₹14,100`
- **Screenshots:** [dash-after-expense.png](qa-screenshots/dash-after-expense.png), [month-cycle.png](qa-screenshots/month-cycle.png)

#### dash-stale — Dashboard: no stale balance after a Loan payment (client-side navigation)
- **Result:** ✅ Pass (2 checks) · **Timing:** —
- **Steps:** Pay Loan 12's installment, then navigate to Dashboard client-side.
- **Expected:** Total balance equals the persisted balance immediately; Debt tile moved.
- **Observed:**
  - ✓ dashboard total equals the persisted balance right after the payment — `1,35,819 vs 135819.07 (before 141150)`
  - ✓ Debt tile moved (loan principal reduced) — `Debt 4,06,491`

### 8. Responsive, theme, keyboard

#### resp-desktop-light — Responsive: desktop 1920x1080, light theme — Loan payment dialog
- **Result:** ✅ Pass (14 checks) · **Timing:** write 848 ms · commit→success 28 ms · success→closed 794 ms · click→loading ≤ 38 ms
- **Steps:** desktop viewport, light theme: Loan list → payment dialog → account → keyboard Tab to Pay → Enter twice.
- **Expected:** No overflow, dialog inside the viewport, reachable 40 px+ primary button, contrast ≥ 4.5:1, focus indicator, one write, toast visible.
- **Observed:**
  - ✓ loans list: no horizontal page overflow — `0px`
  - ✓ dialog fits inside the viewport — `{"x":1400,"y":0,"w":520,"h":1080}`
  - ✓ dialog: no horizontal overflow — `0px; vertical scroll area present=false`
  - ✓ account picker options are within the viewport — `{"x":1429,"y":404,"w":315}`
  - ✓ primary button visible & reachable in the viewport — `{"x":1727,"y":1028,"w":169,"h":40}`
  - ✓ primary button touch target ≥ 40px tall — `40px`
  - ✓ primary button text contrast ≥ 4.5:1 — `16.03:1 fg 8,8,7 on 195,247,97`
  - ✓ label text ('TO PAY LENDER') contrast ≥ 4.5:1 — `7.75:1 fg 82,83,79 on 255,255,255`
  - ✓ amount text contrast ≥ 4.5:1 — `17.07:1`
  - ✓ keyboard: Tab reaches the primary 'Pay' button
  - ✓ keyboard: focused primary button shows a focus indicator
  - ✓ keyboard: Enter submits exactly once (2 Enter presses) — `commits 1`
  - ✓ success toast is visible inside the viewport — `{"x":1630,"y":1008,"w":222}`
  - ✓ no horizontal overflow after the payment — `0px`
- **Screenshots:** [resp-desktop-light-dialog.png](qa-screenshots/resp-desktop-light-dialog.png), [resp-desktop-light-toast.png](qa-screenshots/resp-desktop-light-toast.png)

#### resp-desktop-dark — Responsive: desktop 1920x1080, dark theme — Loan payment dialog
- **Result:** ✅ Pass (14 checks) · **Timing:** write 918 ms · commit→success 26 ms · success→closed 779 ms · click→loading ≤ 39 ms
- **Steps:** desktop viewport, dark theme: Loan list → payment dialog → account → keyboard Tab to Pay → Enter twice.
- **Expected:** No overflow, dialog inside the viewport, reachable 40 px+ primary button, contrast ≥ 4.5:1, focus indicator, one write, toast visible.
- **Observed:**
  - ✓ loans list: no horizontal page overflow — `0px`
  - ✓ dialog fits inside the viewport — `{"x":1400,"y":0,"w":520,"h":1080}`
  - ✓ dialog: no horizontal overflow — `0px; vertical scroll area present=false`
  - ✓ account picker options are within the viewport — `{"x":1429,"y":338,"w":315}`
  - ✓ primary button visible & reachable in the viewport — `{"x":1727,"y":1028,"w":169,"h":40}`
  - ✓ primary button touch target ≥ 40px tall — `40px`
  - ✓ primary button text contrast ≥ 4.5:1 — `16.03:1 fg 8,8,7 on 195,247,97`
  - ✓ label text ('TO PAY LENDER') contrast ≥ 4.5:1 — `6.48:1 fg 154,154,151 on 21,21,19`
  - ✓ amount text contrast ≥ 4.5:1 — `16.56:1`
  - ✓ keyboard: Tab reaches the primary 'Pay' button
  - ✓ keyboard: focused primary button shows a focus indicator
  - ✓ keyboard: Enter submits exactly once (2 Enter presses) — `commits 1`
  - ✓ success toast is visible inside the viewport — `{"x":1630,"y":1008,"w":222}`
  - ✓ no horizontal overflow after the payment — `0px`
- **Screenshots:** [resp-desktop-dark-dialog.png](qa-screenshots/resp-desktop-dark-dialog.png), [resp-desktop-dark-toast.png](qa-screenshots/resp-desktop-dark-toast.png)

#### resp-laptop-light — Responsive: laptop 1366x768, light theme — Loan payment dialog
- **Result:** ✅ Pass (14 checks) · **Timing:** write 937 ms · commit→success 31 ms · success→closed 903 ms · click→loading ≤ 48 ms
- **Steps:** laptop viewport, light theme: Loan list → payment dialog → account → keyboard Tab to Pay → Enter twice.
- **Expected:** No overflow, dialog inside the viewport, reachable 40 px+ primary button, contrast ≥ 4.5:1, focus indicator, one write, toast visible.
- **Observed:**
  - ✓ loans list: no horizontal page overflow — `0px`
  - ✓ dialog fits inside the viewport — `{"x":846,"y":0,"w":520,"h":768}`
  - ✓ dialog: no horizontal overflow — `0px; vertical scroll area present=false`
  - ✓ account picker options are within the viewport — `{"x":875,"y":403,"w":314}`
  - ✓ primary button visible & reachable in the viewport — `{"x":1173,"y":716,"w":169,"h":40}`
  - ✓ primary button touch target ≥ 40px tall — `40px`
  - ✓ primary button text contrast ≥ 4.5:1 — `16.03:1 fg 8,8,7 on 195,247,97`
  - ✓ label text ('TO PAY LENDER') contrast ≥ 4.5:1 — `7.75:1 fg 82,83,79 on 255,255,255`
  - ✓ amount text contrast ≥ 4.5:1 — `17.07:1`
  - ✓ keyboard: Tab reaches the primary 'Pay' button
  - ✓ keyboard: focused primary button shows a focus indicator
  - ✓ keyboard: Enter submits exactly once (2 Enter presses) — `commits 1`
  - ✓ success toast is visible inside the viewport — `{"x":1076,"y":696,"w":222}`
  - ✓ no horizontal overflow after the payment — `0px`
- **Screenshots:** [resp-laptop-light-dialog.png](qa-screenshots/resp-laptop-light-dialog.png), [resp-laptop-light-toast.png](qa-screenshots/resp-laptop-light-toast.png)

#### resp-laptop-dark — Responsive: laptop 1366x768, dark theme — Loan payment dialog
- **Result:** ✅ Pass (14 checks) · **Timing:** write 925 ms · commit→success 29 ms · success→closed 792 ms · click→loading ≤ 45 ms
- **Steps:** laptop viewport, dark theme: Loan list → payment dialog → account → keyboard Tab to Pay → Enter twice.
- **Expected:** No overflow, dialog inside the viewport, reachable 40 px+ primary button, contrast ≥ 4.5:1, focus indicator, one write, toast visible.
- **Observed:**
  - ✓ loans list: no horizontal page overflow — `0px`
  - ✓ dialog fits inside the viewport — `{"x":846,"y":0,"w":520,"h":768}`
  - ✓ dialog: no horizontal overflow — `0px; vertical scroll area present=false`
  - ✓ account picker options are within the viewport — `{"x":875,"y":371,"w":315}`
  - ✓ primary button visible & reachable in the viewport — `{"x":1173,"y":716,"w":169,"h":40}`
  - ✓ primary button touch target ≥ 40px tall — `40px`
  - ✓ primary button text contrast ≥ 4.5:1 — `16.03:1 fg 8,8,7 on 195,247,97`
  - ✓ label text ('TO PAY LENDER') contrast ≥ 4.5:1 — `6.48:1 fg 154,154,151 on 21,21,19`
  - ✓ amount text contrast ≥ 4.5:1 — `16.56:1`
  - ✓ keyboard: Tab reaches the primary 'Pay' button
  - ✓ keyboard: focused primary button shows a focus indicator
  - ✓ keyboard: Enter submits exactly once (2 Enter presses) — `commits 1`
  - ✓ success toast is visible inside the viewport — `{"x":1076,"y":696,"w":222}`
  - ✓ no horizontal overflow after the payment — `0px`
- **Screenshots:** [resp-laptop-dark-dialog.png](qa-screenshots/resp-laptop-dark-dialog.png), [resp-laptop-dark-toast.png](qa-screenshots/resp-laptop-dark-toast.png)

#### resp-mobile-light — Responsive: mobile 390x844, light theme — Loan payment dialog
- **Result:** ✅ Pass (14 checks) · **Timing:** write 991 ms · commit→success 31 ms · success→closed 793 ms · click→loading ≤ 48 ms
- **Steps:** mobile viewport, light theme: Loan list → payment dialog → account → keyboard Tab to Pay → Enter twice.
- **Expected:** No overflow, dialog inside the viewport, reachable 40 px+ primary button, contrast ≥ 4.5:1, focus indicator, one write, toast visible.
- **Observed:**
  - ✓ loans list: no horizontal page overflow — `0px`
  - ✓ dialog fits inside the viewport — `{"x":0,"y":0,"w":390,"h":844}`
  - ✓ dialog: no horizontal overflow — `0px; vertical scroll area present=false`
  - ✓ account picker options are within the viewport — `{"x":25,"y":403,"w":340}`
  - ✓ primary button visible & reachable in the viewport — `{"x":112,"y":792,"w":258,"h":40}`
  - ✓ primary button touch target ≥ 40px tall — `40px`
  - ✓ primary button text contrast ≥ 4.5:1 — `16.03:1 fg 8,8,7 on 195,247,97`
  - ✓ label text ('TO PAY LENDER') contrast ≥ 4.5:1 — `7.75:1 fg 82,83,79 on 255,255,255`
  - ✓ amount text contrast ≥ 4.5:1 — `17.07:1`
  - ✓ keyboard: Tab reaches the primary 'Pay' button
  - ✓ keyboard: focused primary button shows a focus indicator
  - ✓ keyboard: Enter submits exactly once (2 Enter presses) — `commits 1`
  - ✓ success toast is visible inside the viewport — `{"x":100,"y":772,"w":222}`
  - ✓ no horizontal overflow after the payment — `0px`
- **Screenshots:** [resp-mobile-light-dialog.png](qa-screenshots/resp-mobile-light-dialog.png), [resp-mobile-light-toast.png](qa-screenshots/resp-mobile-light-toast.png)

#### resp-mobile-dark — Responsive: mobile 390x844, dark theme — Loan payment dialog
- **Result:** ✅ Pass (14 checks) · **Timing:** write 946 ms · commit→success 27 ms · success→closed 907 ms · click→loading ≤ 45 ms
- **Steps:** mobile viewport, dark theme: Loan list → payment dialog → account → keyboard Tab to Pay → Enter twice.
- **Expected:** No overflow, dialog inside the viewport, reachable 40 px+ primary button, contrast ≥ 4.5:1, focus indicator, one write, toast visible.
- **Observed:**
  - ✓ loans list: no horizontal page overflow — `0px`
  - ✓ dialog fits inside the viewport — `{"x":0,"y":0,"w":390,"h":844}`
  - ✓ dialog: no horizontal overflow — `0px; vertical scroll area present=false`
  - ✓ account picker options are within the viewport — `{"x":25,"y":338,"w":340}`
  - ✓ primary button visible & reachable in the viewport — `{"x":112,"y":792,"w":258,"h":40}`
  - ✓ primary button touch target ≥ 40px tall — `40px`
  - ✓ primary button text contrast ≥ 4.5:1 — `16.03:1 fg 8,8,7 on 195,247,97`
  - ✓ label text ('TO PAY LENDER') contrast ≥ 4.5:1 — `6.48:1 fg 154,154,151 on 21,21,19`
  - ✓ amount text contrast ≥ 4.5:1 — `16.56:1`
  - ✓ keyboard: Tab reaches the primary 'Pay' button
  - ✓ keyboard: focused primary button shows a focus indicator
  - ✓ keyboard: Enter submits exactly once (2 Enter presses) — `commits 1`
  - ✓ success toast is visible inside the viewport — `{"x":100,"y":772,"w":222}`
  - ✓ no horizontal overflow after the payment — `0px`
- **Screenshots:** [resp-mobile-dark-dialog.png](qa-screenshots/resp-mobile-dark-dialog.png), [resp-mobile-dark-toast.png](qa-screenshots/resp-mobile-dark-toast.png)

#### resp-esc-idle — Keyboard: Escape closes an idle payment dialog without writing
- **Result:** ✅ Pass (2 checks) · **Timing:** —
- **Steps:** Open the payment dialog, press Escape.
- **Expected:** Closes, no write.
- **Observed:**
  - ✓ dialog closed by Escape
  - ✓ no write

## 5. Findings

| ID | Severity | Status | Finding |
|---|---|---|---|
| D-01 | Medium (tooling / exposure) | **Fixed in this run** | The QA portal page imported the portal statically, so although `/dev/qa` 404'd in production, the portal's UI code, the synthetic QA user's password constant and the `window.__qa` fault-injection hook were still bundled into a client chunk. Fixed by loading the portal through a dynamic import inside a `NODE_ENV === "development"` branch (`app/dev/qa/page.tsx`); re-built and re-searched: 0 matches in the client bundle, 0 in the server output. A tiny inert remainder (the SDK emulator-connect helper in the *server* bundle, unreachable when `NODE_ENV` ≠ development) is expected. |
| D-02 | Medium (existing behaviour, UX/financial-safety) | **Fixed — second pass (section 10)** | **Add Transaction preselects an arbitrary account.** With no account flagged default, the Add Expense panel pre-fills the first account in Firestore document order (a random id), and shows it as an ordinary selection. In two fresh runs the same untouched form saved to *QA Cash* and then to *QA Credit Card* (the transaction does land on the account shown, so it is not a display/save mismatch). Easy to save a bank expense to the wrong account; it also sits oddly with the "no silent account" principle the Loan/EMI payment dialogs follow. Evidence: [x8-before-submit-1.png](qa-screenshots/x8-before-submit-1.png). *Recommend:* require an explicit pick, or default to the account marked default / most recently used. Not verified: behaviour when an account is flagged default. |
| D-03 | Low (existing behaviour) | **Fixed — second pass (section 10)** | **Whole-rupee display vs paise debited.** The Loan dialog's button and note read "Pay ₹5,331 to lender / ₹5,331 will be taken from QA Bank" while the same dialog's line item and the account debit are ₹5,330.93. Amounts are right; the headline just rounds. Evidence: [resp-mobile-dark-dialog.png](qa-screenshots/resp-mobile-dark-dialog.png). *Recommend:* show paise when the figure has them. |
| D-04 | Low (existing behaviour) | **Fixed — second pass (section 10)** | **"Already paid earlier" payment looks like money out in lists.** The historical account-neutral payment is tagged *Not counted* on Transactions, but its amount column still reads "−₹5,331", and Dashboard → Recent transactions lists "Loan payment … (already paid earlier) −₹5,331" with no *not counted* marker. Balances are correct (the statement excludes it and says so). *Recommend:* mute the amount / carry the tag in Dashboard rows. |

| D-05 | Low (existing behaviour, observed in the second pass) | **Fixed — third pass (section 11)** | **A fresh load of `/transactions?account=<id>` drops the account filter.** The page resolves the filter before the accounts have loaded and discards the id as "stale"; following the in-app path (Accounts → account → Transactions) works. Observed by scenario `ux-d02-explicit-context`; unrelated to the D-02 change. *Recommend:* keep the id until accounts have loaded. |

Observations that are **not** defects: the Transaction Studio deliberately stays open after saving, resets the amount and keeps the description (second save is blocked by "Still needed: Amount"); the Dashboard shows *Expenses ₹3,850* (cash-flow basis) beside *Spending by category ₹13,850* (includes the unpaid card purchase and only your share of the split) — different bases, both internally consistent; the Next.js dev-tools "N" bubble overlaps Cancel on mobile in dev builds only.

### Harness corrections made during the run (full disclosure)

My first pass produced false failures that were **test-script faults, not app defects**, and were fixed before the final run: a locator that needed "Other amount" before "Enter a custom amount"; a toast matcher that missed "*Advance* payment recorded successfully"; an insufficient-funds matcher that missed the Bills wording "doesn't have enough balance"; assumptions that the Studio panel closes after save; a bill fixture I first tried to patch at the wrong field; and the emulator dying once when its parent shell exited (the portal correctly blocked itself while it was down). The final results come from re-running every scenario on the fixed scripts; `results.json` holds the last run per scenario.

## 6. Critical failures and recommended fixes

**Critical failures: none.** *(Second pass: D-02, D-03 and D-04 below are now fixed; the remaining follow-ups are D-05 and the items in section 7.)* Original recommendations, in order: (1) D-02 — make the paying/receiving account an explicit choice in Add Transaction; (2) D-04 — carry the *not counted* treatment into list amounts and Dashboard rows; (3) D-03 — paise-accurate headline amounts; (4) execute the items in section 7 before relying on this as a release gate.

## 7. Not executed / limitations

| Item | Status | Why |
|---|---|---|
| People: edit and reverse a recorded payment | **Not executed** | After recording a receipt, the ledger shows the payment under *Payment history* but no discoverable edit/revert control was exposed via the UI paths I tried (hover/click/menus). Needs guidance on the intended entry point. |
| EMI: mark unpaid / edit payment; EMI refresh-failure | **Not executed** | Loan variants of these pass and the EMI dialogs share the same code, but EMI-specific runs were not done. |
| Accounts: paginated balances | **Not executed** | Fixture has < 1 page of rows (page size 20). The *filtered* statement was executed (`acct-filter`). |
| Loan B (60 installments), Loan C (personal) | Seeded, not exercised | Visible in the list; no dedicated payment scenario. |
| Real devices, touch, Safari/Firefox | **Not executed** | Chromium only, mouse + keyboard; 390×844 is viewport emulation. |
| Production latency | **Not measured** | Emulator only (see the latency note above). |
| Contrast | Partial | Computed ratios on three elements per theme (button, label, amount), not a full audit; semi-transparent layers are approximated by the first opaque ancestor. |
| Concurrency / second tab | **Not executed** | Single tab. |
| Portal checklist | Manual use | The portal's Pass/Fail checklist stores in the viewer's own browser; this report is the record of the automated run. |

## 8. What was added, and how to remove it

All QA code is isolated and deletable; nothing was committed.

| Path | Purpose |
|---|---|
| `app/dev/qa/page.tsx` | Dev-only route; 404 and no portal code in production builds. |
| `features/dev-qa/components/qa-portal.tsx` | The portal UI, checklist, results, timings, fault injection. |
| `features/dev-qa/lib/guard.ts`, `seed.ts` | Runtime guard; fixture seeding / emulator-only reset. |
| `lib/firebase/qa-emulator.ts` | Emulator wiring, gated by dev build + flag + `demo-*` project + localhost. |
| `lib/firebase/client.ts` (**modified, 3 small hunks**) | Imports the above; in QA mode uses an in-memory Firestore cache and connects the emulators. Inert otherwise. This is the only existing production file touched. |
| `docs/FLOWFI_WEB_MANUAL_QA_REPORT.md`, `docs/qa-screenshots/` | This report and screenshots. |

To remove: delete the five QA paths above and revert the three hunks in `lib/firebase/client.ts`.

### How to re-run locally (superseded)

*Superseded by the repository suite — run `npm run test:e2e-qa` (see `tests/e2e-qa/README.md`). The manual steps below remain valid for using the portal by hand.*

1. `npx firebase emulators:start --only auth,firestore --project demo-flowfi-qa` (use non-default ports if another emulator is running; set `NEXT_PUBLIC_QA_AUTH_PORT` / `NEXT_PUBLIC_QA_FIRESTORE_PORT` to match).
2. Start Next with `NEXT_PUBLIC_QA_EMULATOR=1`, a `demo-*` `NEXT_PUBLIC_FIREBASE_PROJECT_ID` and dummy Firebase values, and **without** `.env.local` (run from a copy, or move it aside). Do not use `npm run dev` here: its `predev` step kills whatever owns port 3000.
3. Open `/dev/qa` → Sign in as QA user → Reset test fixtures. For fault injection, arm it on the portal and then navigate with the page links (client-side) — a reload clears it.
4. If the portal says *blocked*, the failed check names why.

## 9. Manual checklist for the items not executed

1. People Ledger → a person with a recorded receipt → find the payment under *Payment history* → edit amount → confirm account, ledger and "still owed" all move; then revert and confirm they return. **Expected:** one write each, balances exact.
2. Loan & EMI → QA Phone EMI → pay, open the installment → Mark as unpaid / Edit payment; arm *fail* on the portal first to confirm the warning and no retry. **Expected:** same lifecycle as the Loan scenarios.
3. Add 25+ transactions to one account → Accounts → breakdown → page through with and without a filter. **Expected:** each row's balance unchanged by filter and page.
4. On a real phone and in Safari/Firefox, repeat the payment dialog with the keyboard and touch. **Expected:** as the responsive scenarios.

## 10. Second pass — fixes, preserved automation and re-verification

### What changed (web only; no financial write path, repository, rule or calculation changed)

**D-02 — Add Transaction never preselects an account from Firestore order.** Cause: `TransactionDetailsModal` initialised the account with `accounts[0]`
(expense) or the first non-card account (income) — i.e. whatever the query returned first, which is arbitrary — and "Split Expense" did the same.
Now an account is preselected only when the form is opened from an explicit account context (the Transactions list filtered to one account, via the new
`initialAccountId` prop) **and** that account is eligible for the kind; otherwise the account selector shows "Select account" and saving is refused
("Select an account."). Switching Expense→Income with a card selected clears the selection instead of silently substituting another account;
income still excludes credit cards; a transfer's source account is still always an explicit choice. The rule lives in one pure function
(`features/transactions/lib/initial-account.ts`). Evidence: [ux-d02-no-account-blocked.png](qa-screenshots/ux-d02-no-account-blocked.png), [ux-d02-explicit-context.png](qa-screenshots/ux-d02-explicit-context.png).

**D-03 — exact payable amount.** New display-only `formatCurrencyExact` (whole rupees stay "₹5,331"; anything with paise shows "₹5,330.93") and an opt-in
`exact` mode on the Loan/EMI `Money` component, used in the payment dialog, the edit/unpay dialog and the payment-history rows. The amount itself is never
rounded; integer-paise calculations are untouched. Other Loan/EMI summary views (cards, schedule totals) still show whole rupees by design.
Evidence: [ux-d03-exact-dialog.png](qa-screenshots/ux-d03-exact-dialog.png) (button, headline, option amount, note and "Loan outstanding ₹55,269.07" all exact; persisted debit ₹5,330.93).

**D-04 — historical payments are explained.** One shared helper (`features/loans/lib/historical-payment.ts`; the description marker it recognises is now
a single constant shared with the write path, string unchanged) drives: the **Transactions** list (badge "Already paid earlier · no account debit", the amount
shown muted and unsigned with the caption "No account debit", replacing the generic "Not counted"; expanded detail adds the full sentence), the
**Dashboard** recent-transactions card (same wording, muted unsigned amount), the **Loan/EMI payment history** rows (badge "Already paid earlier" plus
"· no account debit recorded"; "credit" for a Loan I gave) and the **Installments** list (which previously said "Paid 13 Oct 2026 · from QA Bank" for such a
payment; it now says "already paid earlier — no account debit"). The genuine amount is always visible; no cash-flow or balance accounting changed
(Dashboard Expenses ₹3,850 and Total balance ₹1,41,150 are asserted unchanged). Evidence: [ux-d04-desktop-light-transactions.png](qa-screenshots/ux-d04-desktop-light-transactions.png),
[ux-d04-mobile-dark-transactions.png](qa-screenshots/ux-d04-mobile-dark-transactions.png), [ux-d04-mobile-dark-dashboard.png](qa-screenshots/ux-d04-mobile-dark-dashboard.png), [ux-d04-desktop-light-loan-history.png](qa-screenshots/ux-d04-desktop-light-loan-history.png).
Layout note: at 390 px the badge and the amount caption sit close together in the Transactions row; nothing overflows (0 px horizontal overflow asserted on both pages).

### Browser automation now in the repository

`npm run test:e2e-qa` (optionally `-- <id-prefix>`, and `-- --copy` to run from a temporary copy when you already have `next dev` running) starts throw-away
emulators and a local dev server, runs every scenario in Chrome and tears down. `npm run test:qa-bundle` proves the QA code does not ship. Everything is in
`tests/e2e-qa/` (README there). Fail-closed design: demo-project / no real credentials / no non-local emulator hosts / ports must be free / no unoverridden
`NEXT_PUBLIC_FIREBASE_*` in env files; the portal re-verifies Auth *and* Firestore are on 127.0.0.1; the browser blocks and records any non-localhost request
(a deliberate probe proves it). The QA user's password is random per run and no longer in source. No absolute paths remain.

### Results

| Check | Result |
|---|---|
| Browser scenarios (repo suite, final code) | **45 / 45 pass** — the original 38 (scenario `guard-blocks` is now `safety-guard-blocks`) + `ux-d02-no-silent-account`, `ux-d02-explicit-context`, `ux-d02-split-expense`, `ux-d03-exact-amount`, `ux-d04-desktop-light`, `ux-d04-mobile-dark` + `safety-egress-blocked` |
| D-02 across three fresh Firestore orderings (card>bank>cash, bank>card>cash, cash>bank>card) | empty start every time; submit without a choice writes nothing; a deliberate pick saves to exactly that account |
| D-03 | button "Pay ₹5,330.93 to lender"; no rounded ₹5,331 left in the dialog; persisted debit ₹5,330.93 |
| D-04 | labelled in Transactions, Dashboard, Loan history and the Installments list; desktop·light and mobile·dark; ordinary rows unchanged |
| Unit tests (`vitest run`) | 216 files / 2645 tests pass — includes new tests for every ordering of Cash/Bank/Credit Card, the account-required refusal, exact formatting, and the historical labels |
| Emulator integration tests (loan payment/edit/reversal, EMI & historical paid-earlier, payment funding, principal/one-time) | 86 pass |
| `tsc --noEmit`, ESLint (changed areas + `tests/e2e-qa`) | clean |
| Production build (`npm run test:qa-bundle`: webpack build in a temp copy with the worst-case QA env set) | builds; **no QA UI text, QA email, per-run sentinel credential, `__qa` hook or emulator-connect wiring in any client bundle**; `/dev/qa` → 404 on a production server. One note: Next's file-trace manifest `server/app/dev/qa/page.js.nft.json` still lists the portal's source *path* (no code or text) — relevant only if a deploy step packages traced source files |

Existing unit tests that relied on the silent first-account default were updated to open the form from an explicit account context (or rewritten to assert the new
no-default behaviour): `transaction-details-modal.{validation,people-gate,person-funded,card-transfer}.test.tsx`.

### Still open / limitations after the second pass

- D-05 (above) and the items in section 7 (People edit/reverse, EMI mark-unpaid/edit and EMI refresh-failure, paginated balances, real devices and non-Chrome browsers, concurrency) remain.
- The first-account default also exists in the **People ledger's** own split-expense form (`features/people/components/workspace/split-expense-mode.tsx`) and the Transaction Studio's EMI/loan inspector's first-person default; they are separate modules outside this fix and were not changed.
- A paid-earlier payment is recognised from the description marker the write path stamps on the Loan transaction; if a user later edits that description, the list label would no longer appear (the Loan/EMI history rows use the payment record's own flag and are unaffected).
- The Transactions "Account" filter chip is treated as the explicit account context for Add Transaction (visible in the list header); say if you would rather require a pick even there.
- Timings in this report are local-emulator timings; the injected delays are simulated.

## 11. Third pass — D-05, People Split Expense, historical-label reliability

Web only. No payment amount, cash-flow classification, balance, split calculation, People Ledger accounting, repository write path or schema changed.

### Task A — D-05: the account filter on a direct link
**Cause (two defects).** (1) The page decided whether the URL's account id was "stale" from `isLoading` and the live account list, but for these watch hooks
neither is reliable: with no signed-in user yet the query is disabled with `initialData: []`, and once enabled its `queryFn` immediately resolves `[]`
before the first Firestore snapshot — so the page saw "loaded, zero accounts", discarded the id and rewrote the URL. (2) The URL was copied into React state
once at mount, so Back/Forward could never change the filter (and the URL-sync effect would overwrite it).
**Fix.** The URL is now the single source of truth (`useAccountFilter`): refresh and Back/Forward just work. The id is validated by a direct read of the
signed-in user's **own** account document (`users/{uid}/accounts/{id}`, active only) — an empty or not-yet-loaded list is never evidence that an id is
invalid. While checking, the filter stays applied (no unfiltered flash); a confirmed-invalid id (unknown, deleted, or another user's) applies **no** filter,
is **not** replaced by any account, shows a visible notice ("That account wasn't found … all transactions are shown", dismissible, which clears the bad id), and
gives Add Transaction / Split Expense no account context. Only a validated id becomes explicit context. Accounts → Transactions is unchanged.
Evidence: [ux-d05-direct-link.png](qa-screenshots/ux-d05-direct-link.png), [ux-d05-invalid-account.png](qa-screenshots/ux-d05-invalid-account.png). The pure rule is `deriveAccountFilter` (`features/transactions/lib/account-filter-param.ts`).

### Task B — People Split Expense
`SplitExpenseMode` defaulted its funding account to `accounts[0]` (Firestore order). It now starts empty unless an explicit, eligible `initialAccountId`
is passed (the People ledger passes none), uses the same pure rule as Add Transaction (`initialAddAccountId`), treats a picked account that vanished as no pick, and Save is
refused with "Select the account this expense was paid from." Split calculations and the save call are untouched. Evidence: [ux-b-split-empty.png](qa-screenshots/ux-b-split-empty.png).

### Task C — historical label reliability
**Findings.** The `Transaction` carries no historical flag, so no reliable field is available on it. The structured fact exists on the **payment document** the
Transaction points at (`InstallmentPayment.recordedEarlier`, linked by `installmentPaymentId`); an edit re-writes the payment with the flag carried over, and a legacy payment simply has none.
**Minimal safe approach (no schema, repository, rules or index change):** for the few *candidate* transactions (a Loan payment, excluded from calculations, that names its
installment and payment) read that one payment document directly — `useHistoricalPaymentFlags`, cached for good, one read per payment — and use its flag. The description text
is now only a **provisional hint while that read is in flight or unavailable**; once the structured answer is in, text can neither remove nor fake the label, a payment with no flag
(legacy / ordinary) is never labelled, and date is never used. Applied to the Transactions list (via a context) and the Dashboard recent card. A collection-group query was
deliberately avoided because it would need a new Firestore index (a deploy-affecting config change).
**Description edit is supported** by the generic Transactions edit dialog (and the repository), and the browser scenario confirms: after renaming the transaction to "Car EMI October" the
Transactions row and the Dashboard (which shows the stored text) both keep "Already paid earlier · no account debit"; amount, exclusion and balance are unchanged.
Evidence: [ux-c-dashboard-after-edit.png](qa-screenshots/ux-c-dashboard-after-edit.png).
*Also fixed during this pass:* my first version of the hook produced a React "useMemo dependency size changed" console error (variable-length deps); the browser run caught it and it is gone (0 occurrences in the final run).

### Results

| Check | Result |
|---|---|
| Browser, final code | **50 / 50 pass** (48 scenarios + 2 safety). New: `ux-d05-direct-url` (direct link, refresh, back/forward, clear), `ux-d05-accounts-path-and-orders` (Accounts → Transactions + direct links for Cash/Bank/Card over three Firestore orderings), `ux-d05-invalid-account` (unknown id, another user's id, dismiss), `ux-b-people-split-account` (three orderings: empty start, blocked save with message, deliberate pick saves on exactly that account), `ux-c-historical-after-edit`. `ux-d02-explicit-context` now also observes that a fresh deep link keeps the filter. |
| Unit tests | 218 files / 2668 tests pass — new: filter derivation (direct navigation, invalid, ownership, no flash), split-expense account across all 6 orderings, historical resolution rules and the hook (structured flag beats text both ways) |
| Emulator integration (new `historical-payment-flag` + loan payment/edit/reversal, EMI & historical paid-earlier, funding, principal/one-time) | 88 pass — new test proves the payment document carries the flag, the Transaction links to it, an ordinary payment has none, and a description edit leaves the flag, amount and balance intact |
| `tsc --noEmit`, ESLint (features, lib, app, components, hooks, tests) | clean (one pre-existing `react-hooks/incompatible-library` warning in a table component, unrelated) |
| Production build + bundle check (`npm run test:qa-bundle`) | builds; **no QA UI text, QA email, sentinel credential, `__qa` hook or emulator wiring in any client bundle**; `/dev/qa` → 404. Same single note as before: Next's file-trace manifest names the portal's source *path* (no code) |

### Remaining limitations
- A historical payment is labelled provisionally from its description marker until its payment-document read returns (milliseconds in the emulator); if that read fails permanently (e.g. offline with no cache) the marker remains the fallback.
- The Dashboard shows the stored transaction description (here the user's edited text); the Transactions list shows the loan-derived label — both carry the historical label.
- Account-context for Add Transaction/Split Expense is still the validated account filter of the Transactions page; nothing else supplies context.
- The remaining items in section 7 (People edit/reverse, EMI mark-unpaid/edit and EMI refresh-failure, paginated balances, real devices, non-Chrome browsers, concurrency) are unchanged; timings remain local-emulator timings.
- The Transaction Studio's EMI/loan inspector still defaults to `people[0]` for the *person* (not an account) — a different field, not changed.

## 12. Fourth pass — People, EMI and Accounts reversal / editing

Method: every action is driven through the real UI in Chrome, then verified against **persisted emulator data** (account balances, transactions, installment `amountPaid`); duplicate clicks are physical rapid clicks; two-tab cases use two pages in one browser context. Synthetic data only. New opt-in fixtures (portal buttons, so earlier scenarios are unaffected): a **shared EMI** (₹9,000 / 3, shared with QA Priya and QA Ravi) and a **36-transaction statement history** on QA Bank with four records at one identical timestamp.

### Results (20 scenarios)

| Area | Scenario | Result |
|---|---|---|
| People | `rev-people-receipt-partial-duplicate` — ₹400 partial receipt, triple-click | ✅ bank +₹400 once, one receipt transaction, ₹600 still owed |
| People | `rev-people-revert` (+ `-mobile-dark`) — revert, confirm double-click | ✅ confirmation says "remove ₹400 from QA Bank"; bank refunded exactly once; ₹1,000 owed again; 0 px overflow on mobile·dark. [rev-people-revert.png](qa-screenshots/rev-people-revert.png) |
| People | `rev-people-stale-revert-two-tabs` — tab B holds the revert confirmation open while tab A reverts | ✅ B's confirm is disabled by the live update; no second refund |
| People | `rev-people-insufficient` — pay out ₹6,000 from ₹5,000 cash | ✅ "Not enough balance — short by ₹1,000…", Record disabled, nothing written |
| People | `rev-people-edit-and-stale-edit` — edit ₹1,000→₹700 (double-click Save), cancel, then stale save from tab B | ✅ bank nets +₹700 (not +₹1,700), cancel refunds exactly ₹700, stale save is refused with **"This payment no longer exists."** and moves nothing. [rev-people-stale-edit.png](qa-screenshots/rev-people-stale-edit.png) |
| People ↔ lender | `rev-people-vs-lender-schedule` — ₹1,500 receipt (dinner ₹1,000 + ₹500 of her EMI share) | ✅ **the lender's EMI installments stay unpaid** (`amountPaid` 0/0/0 persisted; Loan & EMI still shows ₹9,000 remaining) — a People receipt never marks a lender installment paid |
| EMI | `rev-emi-record-unpaid` — pay ₹4,000 (triple-click), mark unpaid (double-click) | ✅ one debit, one transaction, installment paid; unpaid refunds once. ⚠ finding **D-06** |
| EMI | `rev-emi-edit-amount` (+ `-mobile-dark`) — ₹4,000→₹3,000 (double-click Save) | ✅ bank nets −₹3,000 (not −₹7,000), one active ₹3,000 transaction, installment ₹3,000/₹4,000 |
| EMI | `rev-emi-slow-refresh`, `rev-emi-refresh-fail` | ✅ confirmation not delayed; "Saved · Updating balances…"; failure warning with no retry; one effect per action (payment and mark-unpaid) |
| EMI | `rev-emi-two-tabs-unpaid` — both tabs mark the same payment unpaid | ✅ refunded exactly once (tab B's stale confirm is clickable, reports success, but the idempotent reversal moves nothing) |
| EMI | `rev-emi-two-tabs-pay` — A pays installment #1, B (dialog still on #1) pays | ⚠ finding **F-07** below; money stays consistent |
| EMI ↔ People | `rev-emi-shared-people-independent` — pay the lender from own money, then receive from Priya | ✅ lender: installment 1 ₹3,000 once (double-click); no receipt/settlement created for Priya/Ravi; Priya still owes ₹2,000; a later ₹2,000 receipt leaves the lender schedule exactly as it was |
| Accounts | `rev-acct-pagination-reconcile` (+ `-mobile-dark`) — 39 counted rows, Show more, four same-timestamp records | ✅ first page 30 rows + "Show 9 more"; **all 39 displayed rows (description, debit, credit, running balance) equal an independent reconstruction from the persisted transactions**; newest balance = stored balance; tie order matches (time added, then id); reload gives an identical statement. [rev-acct-pagination-reconcile-sheet.png](qa-screenshots/rev-acct-pagination-reconcile-sheet.png), [rev-acct-pagination-mobile-dark-sheet.png](qa-screenshots/rev-acct-pagination-mobile-dark-sheet.png) |
| Accounts | `rev-acct-filters-paginated` | ✅ Money out (33 rows, one "Show more") and Money in (6) each keep every row's true running balance from the full history |
| Accounts | `rev-acct-backdated-edit` | ✅ stored balance unchanged; the row moves to the oldest end; all 39 balances re-equal the reconstruction |
| Accounts | `rev-acct-deleted` | ✅ balance restored by the expense; row gone; 38 rows reconcile; no mismatch warning |

Whole-suite: **70 / 70** pass, with the two findings below reported separately (they do not fail the run — each is a visible `FINDING` line in every run). Also re-run on the final code: unit tests 218 files / 2,668 tests pass, `tsc` and ESLint clean, and `npm run test:qa-bundle` passes (no QA code, credentials or emulator wiring in a production client bundle; `/dev/qa` → 404).

### Findings (documented; financial engines NOT modified)

| ID | Severity | Finding |
|---|---|---|
| **F-07** (RESOLVED — see §13) | **Medium — behaviour** | **A stale second tab can silently charge a different installment.** Tab B opened *Pay EMI* for installment #1. Tab A then paid #1. Tab B's dialog still read "Installment #1 · Pay ₹4,000 to lender"; clicking it succeeded as an *advance* payment of **installment #2** ("Advance payment recorded successfully — Installment #2 paid"), debiting a second ₹4,000. The data stays consistent (account debit = Σ installment `amountPaid`, one transaction per paid installment, no installment over-paid), and each debit follows a deliberate click, but the dialog never told the user that what it showed was out of date, and the payment landed on a different installment than the one displayed. Evidence: [rev-emi-two-tabs-b.png](qa-screenshots/rev-emi-two-tabs-b.png). *Recommendation (needs approval, not done):* when the target installment is already paid at write time, refuse and ask the user to re-open, as the "already paid earlier" path already does. Not tested for Loan payments (same write path pattern, unverified). The People revert/edit paths and mark-unpaid are protected (see results). |
| **D-06** (RESOLVED — see §13) | Low — display | **EMI payment details say "Charged to: Schedule only (no account)"** for a non-card EMI payment that did debit QA Bank (persisted: ₹4,000 transaction on the account, bank −₹4,000). The label comes from `recorded-payment-dialog.tsx` which only knows card EMIs. Money is right; the label is wrong. Evidence: [rev-emi-details.png](qa-screenshots/rev-emi-details.png). |

### Other observations
- **People Edit is deliberately limited:** a receipt applied to a **split-expense share or an EMI share** offers *Revert* but not *Edit* (change = revert + re-record); Edit is offered for ledger obligations such as money given. The edit scenario therefore uses a "money given to Ravi" entry.
- **EMI "change funding account":** not offered — the EMI edit dialog has amount, date, note, GST and processing fee only. **Not executed** (feature absent), not claimed as passing.
- After a stale revert in another tab, the app's live listener disables the confirm button, so the *repository-level* stale-write guard is exercised for the edit path (message above) but not independently for revert.
- Switching tabs closed tab A's open Pay dialog in one run, so the scenario re-opens it and says so.
- Same-timestamp ordering follows the app's rule (date → time added → id); this suite proves the *display equals the reconstruction under that rule* — it does not judge the rule itself.

### Remaining limitations
Chrome only; mouse + keyboard; local-emulator timings; Loan (non-EMI) two-tab payment, concurrent *edits* from two tabs, a card-linked EMI, and People payments against a **People-Ledger-only** EMI share edit (revert + re-record) are not covered; the reconstruction handles income/expense records (no transfers or card-statement legs on QA Bank).

## 13. Fifth pass — F-07 (stale installment payment) and D-06 (funding label)

### Investigation
- **EMI:** the dialog sends `targetInstallmentId`, but `planEmiPaymentAllocation` did `payable.find(target) ?? payable[0]` — if the target was already paid it silently fell back to the next unpaid installment (the F-07 cause).
- **EMI, second path found while testing:** the dialog's header used the installment captured at open, but its allocation preview used live rows. After tab A made a *partial* payment, tab B's full ₹4,000 spilled ₹1,000 onto #2 (browser run: paid `[4000,1000,…]`). Same class of defect.
- **Loan: vulnerable.** `expectedFirstInstallmentId` was only enforced for "already paid earlier"; a normal payment took whatever was oldest-due at write time, and a part-paid target let the excess silently become extra principal. Proven at repository level and in the browser (before the fix this was the same pattern; after it, refused).

### Fix (smallest write-boundary change)
- New `lib/engines/stale-installment.ts`: `StaleInstallmentError`, the user-facing message, and `assertReviewedAllocation` (fresh allocation must touch exactly the reviewed installments, and a Loan must not gain extra principal the user did not see).
- EMI: an explicit target must still be payable (checked in-transaction on fresh reads) — no fallback; `expectedInstallmentIds` verified in the same transaction. Past-payment path keeps its existing "already paid" error.
- Loan: `expectedAllocation { installmentIds, overflow }` verified inside the payment transaction for normal payments.
- Dialog: the reviewed allocation is planned from a snapshot taken when the dialog opens. Callers that pass no expectation (adjustment, lump sum, bulk historical) behave as before. Existing partial-payment behaviour is preserved (a second partial on the same installment still works).
- **D-06:** `recorded-payment-dialog.tsx` now derives an EMI payment's funding from the Transaction it posted (matched by stored `installmentPaymentId` + `emiId`), card label first. No such transaction → "Schedule only (no account)"; "already paid earlier" → "Paid before FlowFi · no balance change". Mark-unpaid text and chain text use the same source. No amounts or movements changed.

### New / changed tests
- Integration `tests/integration/stale-installment-payment.test.ts` (9, emulator): EMI stale #1 rejected + explicit #2 works; racing submits with different keys → one debit; same-key duplicate idempotent; EMI partial-vs-full rejected; card-linked EMI; pure allocator refuses paid/skipped/removed target; Loan stale #1 rejected + explicit #2; Loan partial rejected (no silent extra principal); Loan race → one debit.
- Browser: `rev-emi-two-tabs-pay` (F-07 finding turned into hard checks, plus explicit #2 payment), new `rev-emi-two-tabs-partial`, new `rev-emi-label-funding`, new `loan-stale-two-tabs`, `rev-emi-record-unpaid` (D-06 now a hard check). Every scenario reads back account balance, active transactions and installment `amountPaid` from the emulator. No existing test was weakened.

### Results
| Check | Result |
|---|---|
| Unit (vitest) | 218 files / 2,668 tests pass |
| Integration (emulator) | 35 files / 423 tests pass (incl. the 9 new) |
| Browser QA | **73 / 73** (71 scenarios + 2 safety), 0 failed |
| `tsc --noEmit`, `next build` | clean / success |
| ESLint | 0 errors; 1 existing warning (react-table, unrelated) |

Browser evidence: A pays #1 (−₹4,000) → B's stale Pay refused with "This installment has changed…", bank stays −₹4,000, one transaction, `[4000,0,…]`; reopening and paying #2 → −₹8,000, `[4000,4000,…]`, two transactions. Partial: `[1000,0,…]` after B refused. Loan: one new transaction, only the reviewed installment gained `amountPaid`. Labels: account-funded shows "QA Bank"; historical shows "Paid before FlowFi · no balance change".

### Remaining risks
- The failure toast offers "Try again"; retrying a stale payment is refused again (harmless, slightly misleading).
- Bulk-historical and Loan adjustment/lump-sum paths do not send a reviewed allocation (unchanged; bulk already pins its installment).
- A card-linked EMI is covered at integration level, not in the browser (no such fixture).
- Chrome only; emulator timings.

## 14. Sixth pass — payment-path safety follow-up

### 14.1 Stale-installment message
The stale error now reads **"This installment has changed since you opened it. Refresh and select the installment again."** The Record Payment dialog shows it as "Installment changed — Nothing was saved. …" with **no "Try again"** and no automatic retry (repeating the same submit can never succeed). Other errors keep their retry.

### 14.2 Isolated card-linked EMI fixture and browser scenarios
Portal button **Add card EMI** (`seedCardEmi`): its own card "QA EMI Card" (₹50,000 limit, no other charges) and "QA Card EMI" ₹12,000 / 4. Scenarios (suite `card-emi.mjs`):
- `card-emi-pay-and-reverse`: dialog names the card and asks for no bank account; double-click pay → card −₹3,000 once, **bank untouched**, one transaction on the card account, installment 3000/0/0/0; details "Charged to: Card ••9090"; mark unpaid (double-click) → card restored once, no active transaction, installment unpaid.
- `card-emi-stale-two-tabs`: A pays #1; B's stale dialog charges nothing more (card still ₹3,000, one transaction, #2 = 0); message shown with no retry; reopening and paying #2 explicitly → card ₹6,000, installments 3000/3000, two transactions.
Note: in these two-tab runs B's Pay is already blocked in the dialog (its live preview reports the same stale error), so the *write-boundary* refusal for a card EMI is proven by the emulator tests (stale-installment-payment), and in the browser for the non-card partial case (`rev-emi-two-tabs-partial`, where the button is clickable and the write refuses).

### 14.3 Audit — can any path charge a different installment / principal allocation than confirmed?
| Path | Mechanism | Result |
|---|---|---|
| Record Payment — EMI / Loan | reviewed allocation (ids, overflow) re-checked in-transaction | **Safe** (section 13; tests) |
| Bulk "mark several" — EMI | explicit `targetInstallmentId` + `onlyTargetInstallment`; target must still be payable | **Safe** — tested: paid-meanwhile target refused; part-paid target + amount that would reach the next is refused |
| Bulk — Loan (pay-now and paid-earlier) | `onlyInstallmentId`; paid target refused; excess over a part-paid target refused ("paid in part elsewhere") / extra principal refused for past payments | **Safe** — tested |
| Borrow More / Lend More | moves exactly the typed amount; touches no installment `amountPaid` | **Safe for money** — tested. Schedule-shape risk below |
| Loan extra principal via Pay dialog | reviewed overflow enforced | **Safe** — tested |
| `recordLumpSumSettlement` | had **no** reviewed allocation: after another tab paid #1 the same call silently paid #2 (reproduced) | **Finding → fixed with approval (14.4)** |

### 14.4 `recordLumpSumSettlement` fix (approved, narrowly scoped)
- **Reachability:** a search of the whole repo (source, tests, docs, scripts) finds **no caller**; it exists only on `useLoanActions()`. It is not reachable from any production UI today, but was a latent hazard for any future caller.
- **Change:** the function is kept. It now **requires** `reviewedAllocation: { installments: [{ installmentId, amount }], extraPrincipal? }`. Before any read/write it is validated (non-empty, no duplicate ids, positive amounts, sums to the amount being paid). Inside the payment transaction, after fresh reads and before any write, the fresh allocation must equal the reviewed one — **same installments in order, same per-installment amounts, same extra principal** — else `StaleInstallmentError` and nothing is written. Implemented as an optional `amounts` on the existing `expectedAllocation` (and `assertReviewedAllocation`), so no other path changed. Idempotency (same key → `alreadyRecorded`) is unchanged.
- **Tests** (`tests/integration/lump-sum-settlement.test.ts`, 8, emulator): exact 3-installment split (one debit, no principal rows, same-key retry writes nothing); partial last installment; money beyond the listed installments is refused unless declared, and extra principal is honored only when reviewed; missing/empty/duplicate/mismatching-total/negative allocations refused with nothing written; stale tab (another tab paid #1) refused; part-paid elsewhere refused; changed per-installment amounts with same ids and total refused; racing submits with different keys → one debit.

### 14.5 Borrow More / Lend More — preview vs re-amortization (documented, NOT changed)
The money step (loan amount + account + transaction) commits atomically for exactly the typed amount. The **schedule re-amortization is a separate, later, non-transactional step** that re-reads the schedule fresh. If another tab pays or changes installments between the preview and that step, the *revised installment amount / remaining count* can differ from what the preview showed, although the money moved is exactly what was confirmed. The write also does not re-check the preview. Recommendation (needs approval): carry the previewed result as a reviewed expectation and warn/refuse when the fresh solve differs, or perform the re-solve inside the same transaction.

### 14.6 Final verified results
**Verified (this pass's own scope):**
- Integration (emulator): 37 files / 437 tests pass — includes stale-installment-payment (9), payment-path-substitution-audit (7), lump-sum-settlement (8).
- `tsc --noEmit` clean; `next build` succeeds; ESLint 0 errors (2 warnings, neither in files changed here).
- Before the lump-sum change, the previous full run was: unit 2,668 pass, integration 429 pass, browser 75/75.

**NOT a clean full browser result — and why.** While this pass's final run was executing, the working tree was being changed by other in-progress work that is not part of this task (new/edited People-in-payment files such as `installment-people-panel.tsx`, `historical-people-reconcile.tsx`, an edited `record-payment-dialog.tsx` and `recorded-payment-dialog.tsx`, and new browser suites `loan-people-ux.mjs` / `people-date-and-advance.mjs`). The run therefore covered a different tree than the one verified before: 82 scenarios, **77 passed / 7 failed** — `loan-partial`, `rev-emi-two-tabs-partial`, `rev-emi-label-funding` (Pay-dialog controls such as "Other amount" / the old-EMI link no longer found within 30 s), `uxp-hist-24-mixed-people`, `uxp-people-in-balance-and-advance`, `uxp-collect-return-to-payment`, `rev-people-revert`. A repeat unit run on the same moving tree gave 2,709 pass / 2 fail (`transaction-details-modal.person-funded.test.tsx`, not a file touched here); an earlier repeat gave 5 failures — the failing set changes between runs. None of the failing tests exercises the lump-sum or stale-installment code. These failures have **not** been diagnosed or fixed here (they belong to the in-progress work), and the three that are Pay-dialog scenarios of this QA suite must be re-run once that work settles. **Do not treat the browser suite as green until then.**

### 14.7 Remaining risks
- Borrow More / Lend More schedule-shape drift (14.5), unchanged by design.
- Chrome only; emulator timings; the `unavailable` Firestore warnings in the run log come from the deliberate slow/failed-write fault-injection scenarios.
- `recordLumpSumSettlement` still has no UI; a future caller must build its reviewed allocation from what the user actually saw.

## 15. People payment date edit + held-advance display (approved, narrowly scoped)

**Issue A — date-only edit.** `PersonPaymentRepository.editPaymentDate(person, paymentId, { date, expectedDate })`: one Firestore transaction that re-reads every entry of the payment, refuses (`PersonPaymentChangedError`, nothing written) if any is gone / reverted / belongs elsewhere / no longer dated `expectedDate`, then moves the date in place on the entries, the People cash leg (edited with `owner: "people"`, zero balance delta), a separate income part and split installment payments. `paymentId`, transaction id, amounts, account and allocation are untouched; no revert/re-record, no account or person-balance write. Payments that keep purpose money are refused (revert + re-record, as before); "already in my account" payments keep their treatment and cannot be future-dated. The generic Transaction guard is unchanged (re-proved in a test). UI: Transaction Details → **Edit in People Ledger** → `/people?person&cycle&paymentTx=<cash-leg id>` → People resolves the payment from its own entries and opens a "Change payment date" dialog (a gave/borrowed entry or an already-removed payment gets a specific message; the link waits for the ledger to load).

**Issue B — display + navigation only.** `installmentBreakdown` exposes `advanceHeld` (display); the pay dialog's People panel says "Holding ₹X advance from <name> — not applied to this share yet" with a link to People's existing Apply advance panel, opened with that obligation preselected (`?applyAdvance=1&obligation=`). No new persisted link, schema field or engine; nothing is settled by paying the lender.

**Verification (synthetic emulator data only).** Unit: 5 new repository tests (in-place edit, cycle moves, stale/reverted refusal, recorded-earlier, generic guard), 2 engine + 2 component tests. Browser (`tests/e2e-qa/suites/people-date-and-advance.mjs`): `pdate-edit-from-transaction` (same ids, date moved, bank unchanged, Account Statement reconciles), `pdate-stale-two-tabs`, `padv-held-advance-shown-and-applied` (advance shown → applied via People: 1 application ₹1,000, no cash, one receipt → lender paid once, bank −₹3,000 once). Regression: `rev-people-*` 7/7, `rev-emi-shared-people-independent` 1/1. `tsc` clean, `eslint` 0 errors, production build OK (webpack, in a temporary copy).

**Not covered / caveats.** Dashboard and Monthly Report were not driven in the browser — they read the same cash-leg `dateTime` the Account Statement check covers. `record-payment-dialog.people-gate.test.tsx` has 22 failures that come from a separate, concurrent uncommitted redesign of that dialog and its tests (not from this change; they assert UI that dialog no longer has) — they need their own pass.
