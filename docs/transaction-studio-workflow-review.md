# Transaction Studio: Is the Workflow Production-Complete?

*Transaction Intelligence & Financial Workflow Review*

A review of whether every real bank-statement transaction can become a correct financial record — and what's structurally missing before implementation locks in.

**Prepared for:** FlowFi product & engineering
**Scope:** Transaction Studio (upload → review → commit)
**Date:** 2026-08-06
**Type:** Architecture recommendations, no code

---

## Contents

1. [The verdict](#01-the-verdict)
2. [Transaction taxonomy coverage](#02-transaction-taxonomy-coverage)
3. [Fixing the Action model itself](#03-fixing-the-action-model-itself)
4. [Owner assignment](#04-owner-assignment)
5. [Shared expense workflow](#05-shared-expense-workflow)
6. [EMI workflow](#06-emi-workflow)
7. [Loan workflow](#07-loan-workflow)
8. [Transfer workflow](#08-transfer-workflow)
9. [Monthly budgeting workflow](#09-monthly-budgeting-workflow)
10. [Category workflow](#10-category-workflow)
11. [Commit workflow](#11-commit-workflow)
12. [Validation workflow](#12-validation-workflow)
13. [Import workflow & one-click](#13-import-workflow--one-click)
14. [Full lifecycle review](#14-full-lifecycle-review)
15. [What's already right](#15-whats-already-right)
16. [Priority punch list](#16-priority-punch-list)

---

## 01 · The verdict

Transaction Studio's ten user-facing actions cover the easy half of real banking behavior. The harder half — and the part that's expensive to retrofit — is money movement that doesn't cleanly belong to one person or one category.

The current model handles a plain purchase, a plain income credit, a simple transfer, an EMI or loan against a person, cashback, a refund, and "ignore" competently. What it can't yet represent are the transactions that make real statements messy: a credit card bill payment (which is a transfer that also has to move a liability), a personal loan from a bank rather than a friend, a reversal that has to stay linked to the charge it cancels, a subscription that's both recurring *and* shared with a roommate, cash that vanishes into an untracked wallet the moment it leaves an ATM.

Two structural issues sit underneath most of the individual gaps:

> **Structural issue 1 — one enum, two questions**
> `RecordAction` currently answers "what kind of money movement is this" and "whose money is it" in a single flat value. That's why a shared EMI, a business cash withdrawal, or a split-and-shared purchase have no legal representation today — the enum can only pick one axis at a time.

> **Structural issue 2 — the commit engine doesn't know the Action model exists**
> Every staged row, regardless of which of the fifteen `RecordAction` values the reviewer picks, currently commits as a plain expense or income. The Review Workspace will let a user select "EMI" or "Shared Expense" and silently produce a generic transaction instead — a data-integrity trap, not a missing feature. This needs to be closed, or explicitly fenced off, before the workspace ships.

Neither issue requires a rewrite. The underlying primitives — EMI payment breakdown, payment schedules, expense participants, the confidence engine — are well designed and reusable. The gap is entirely in how a statement line gets routed to the right one.

---

## 02 · Transaction taxonomy coverage

Walking the real-world list against what the model can represent today.

**Legend:** `covered` — represented correctly today · `partial` — representable but lossy, or designed but not wired up · `missing` — no representation at all

### Money movement

| Transaction | Status | Gap & recommendation |
|---|---|---|
| UPI / NEFT / RTGS / IMPS to own account | `covered` | Works when the destination account is also tracked in FlowFi. Only reliable case today. |
| Transfer to an external, untracked account | `missing` | `transfer`'s only detail today is a destination `accountId` — there's no "external / not tracked" option, so the row either can't be committed or is misfiled as a transfer to nowhere. Give transfer an explicit external-destination mode that behaves like a plain expense for reporting purposes. |
| Credit card bill payment | `partial` | Falls back to generic transfer. It should also reduce the card's outstanding balance and reconcile against the specific statement being paid — a bank-to-bank transfer and a card payoff are not the same event downstream. |
| Same real transfer appearing on two statements | `missing` | A transfer legs itself as a debit on one account's statement and a credit on another's, imported separately, possibly months apart. Duplicate detection only looks within/across statements for the *same* account pattern — it doesn't pair transfer legs across accounts. Left unfixed, every user who imports both sides double-counts the transfer in cash flow and net worth. |
| Cheque issued / deposited | `missing` | No clearing-delay concept — see Status & timing below. |
| Cash withdrawal (ATM) | `partial` | Lands as a plain expense categorized "Cash Withdrawal." The cash then disappears from the system — any later cash spending the user tracks is either invisible or double-counted. Default behavior should route it as a transfer into a Cash account, with expense-only as the explicit override. |
| ATM fee / bank fee | `partial` | Committable as a plain expense, but not tagged as a fee subtype, so Reports can't break "fees paid" out from ordinary spending. A modifier flag, not a new action. |
| Standing instruction / auto-debit | `partial` | Detected as a boolean (`recurringDetected`) but doesn't default the row's Action to `recurring_bill` or offer a Bill match — the signal exists and is thrown away at review time. |

### Debt & credit

| Transaction | Status | Gap & recommendation |
|---|---|---|
| EMI installment (existing EMI) | `partial` | Modeled well at the data layer (principal/interest/GST/fees per payment) but the commit path that would populate it from a parsed EMI line isn't wired up yet. |
| New EMI created from a statement's EMI section | `partial` | Same commit gap as above. |
| EMI foreclosure / prepayment charge | `missing` | No action or status transition ties a "Foreclosure Charges" statement line to closing out the EMI record early. |
| Personal loan from a bank or NBFC | `missing` | The Loan record requires a person as counterparty — it's shaped for peer lending, not institutional debt. A bank isn't a Person. This needs a counterparty type, not a workaround. |
| Loan disbursement vs. loan repayment | `missing` | "Create loan" and "existing loan" don't say which direction the money is moving. A disbursement is a one-time credit that creates a liability; a repayment is a recurring debit against it. Two different downstream effects from one undifferentiated action today. |
| Interest charged (card revolve, loan) | `partial` | Lands as a generic expense, unflagged as interest — loses tax/reporting distinction. |
| Interest earned (savings, FD) | `partial` | Same gap, income side. |

### Investment & rewards

| Transaction | Status | Gap & recommendation |
|---|---|---|
| SIP debit | `missing` | No investment domain entity exists anywhere in the system yet — the `investment` action has nowhere real to write to. |
| Dividend received | `missing` | Schema drafted for a future document type, not implemented. |
| Buy / sell, NAV-based holdings | `missing` | Same — planned, not built. |
| Cashback | `partial` | Action exists, commit doesn't implement it, and there's no rewards ledger downstream — the Credit Cards screen hardcodes rewards to zero regardless of what's imported. |
| Reward points earned / redeemed | `missing` | Parsed and available at extraction time, consumed by nothing after that. |

### Reversal, status & ownership

| Transaction | Status | Gap & recommendation |
|---|---|---|
| Refund | `partial` | Linked to its original charge by a free-text merchant name, not a hard reference — two "Amazon" refunds in the same month are indistinguishable from each other's originals. |
| Chargeback / dispute reversal | `missing` | Real reversal lines are imported as ordinary transactions with no link to what they reverse — net spend for the period is silently wrong until a human notices. |
| Statement adjustment / correction | `missing` | No representation. |
| Split-by-category line (one purchase, several categories) | `partial` | The split/merge audit trail exists and is correctly kept separate from person-splitting — but there's no Action outcome that pairs with "this row is about to become several," so a row mid-split still has to carry some single Action. |
| Future-dated / pending transaction | `missing` | The transaction record has no status field of any kind — not pending, not posted, not reversed. This is the single field most expensive to add after the fact, once real transactions exist without it. |
| Business expense | `missing` | Explicitly required by the product vision and present as an expense-type value, but absent from the Action list entirely — falls through to a plain expense, losing the distinction on import. |
| Shared EMI / shared loan installment | `missing` | "Shared" and "EMI" are different, mutually exclusive Action values today. A roommate-financed purchase's EMI can't be both. |

---

## 03 · Fixing the Action model itself

Most of the gaps above trace back to one design choice: Action tries to be one enum answering two unrelated questions.

Split it into two independent axes instead. Neither is new information — both already exist in the system in some form — but today they're fused into a single pick-one list, which is exactly what makes combinations like "shared EMI" or "business cash withdrawal" unrepresentable.

**Axis 1 — flow type**
- Expense
- Income
- Transfer (internal / external / card payoff)
- Debt movement (disbursement or repayment, against a person *or* an institution)
- Investment movement
- Reversal / adjustment (linked to an origin transaction)
- Ignore

**Axis 2 — ownership (expense/income only)**
- Mine
- Shared (participants + split type)
- Someone else's (pass-through)

**Modifiers (apply independent of either axis)**
- Business
- Recurring / bill-linked
- Split-by-category

With this shape, "roommate-shared EMI installment" is simply *flow type: debt repayment, linked to Emi X, ownership: shared, participants: [...]* — a legal combination instead of a fork in the road the reviewer has to lose information at. The commit engine dispatches on flow type first (which collection family it writes to), then applies ownership and modifiers as properties of that write, rather than branching on fifteen flat values that already conflate the two.

This also fixes the redundancy between `owner` and `action` that exists today — a staged row can currently claim `owner: shared` while `action: normal_expense`, two fields disagreeing about the same fact with nothing to catch it.

---

## 04 · Owner assignment

Ownership is currently tracked in two places that can drift apart — a standalone `owner` field (`me` / `shared` / `someone_else` / `transfer`) and, redundantly, inside `action` (`my_expense` / `shared_expense` / `someone_elses_expense`). Nothing enforces that they agree. Collapse to one source of truth — ownership as its own axis (§3) — and validate it can never silently disagree with the flow type.

Business ownership is a real gap, not a nuance: the product vision names it explicitly as required parity with manual entry, and the underlying expense-type field already has a slot for it, but there's no path from a statement line to "this was a business expense" today.

---

## 05 · Shared expense workflow

The participant/split-type model (equal, custom, percentage) is solid and already the right shape for statement import — no redesign needed there. Two real gaps sit around its edges:

- **Already-settled imports.** Importing an old statement where a shared cost was already settled in cash shouldn't re-trigger a "they owe you" balance today. There's no "mark as already settled" option on a shared row at import time — without it, importing historical statements will systematically overstate what people owe.
- **Combinability.** As covered in §3, a line can't currently be both shared *and* an EMI, loan repayment, or business expense. Real households split exactly these kinds of costs.

---

## 06 · EMI workflow

The data model is genuinely good — per-payment breakdown of principal, interest, GST, IGST, fees, and penalty is more granular than most consumer finance apps bother with. The gaps are all upstream and downstream of that model, not in it:

- **Matching an EMI line to an existing EMI record** needs the same kind of confidence-scored matching duplicate detection already does (amount, month, reference) — right now the workflow assumes the reviewer manually finds the right EMI to attach to.
- **Foreclosure / prepayment charges** have no path to close an EMI record early when a statement shows one.
- **The commit path doesn't populate the breakdown fields** from a parsed EMI section yet — the richest part of the model is currently unreachable from an actual import.

---

## 07 · Loan workflow

The loan model is shaped for peer lending — a required person as counterparty, interest, a repayment schedule. That's the right model for "I lent my brother money," and wrong for "I took a personal loan from HDFC," which is one of the most common lines on a real bank statement. A bank or NBFC is not a Person, and forcing one into that slot (or omitting loans-from-institutions entirely) is the kind of schema decision that gets much more expensive to fix once real loan records — and reports built on top of them — exist.

Separately, neither `create_loan` nor `existing_loan` currently says whether the statement line is the disbursement (one-time credit, liability goes up) or an installment repayment (recurring debit, liability goes down). Those have opposite effects on net worth and need to be distinguishable, not inferred from direction alone.

---

## 08 · Transfer workflow

The most consequential gap in the whole review lives here: a real transfer between two of a user's own accounts appears twice in the raw data — once as a debit on the source statement, once as a credit on the destination statement — and those two statements are frequently imported separately, sometimes months apart. Nothing today pairs those two legs into one transfer. Left as is, every user who imports both sides of even one internal transfer will see it counted twice in cash flow and net worth, and no amount of correct duplicate-detection logic catches it, because the two legs are legitimately different amounts of information (different accounts, same amount, same date) — a different detection problem entirely from duplicate detection.

Recommend a dedicated transfer-pairing pass, run after both accounts have imported the surrounding period, that looks for an unmatched debit on one FlowFi account and an unmatched credit of the same amount within a few days on another FlowFi account, and offers to merge them into a single transfer rather than two independent transactions.

Credit card bill payments are the special case of this problem worth calling out on their own (see §2) — they're a transfer that also needs to reduce a liability and reconcile against a specific statement, not just move cash between two account balances.

---

## 09 · Monthly budgeting workflow

Budgets currently have no connection to Transaction Studio at all — a committed import doesn't get evaluated against the budget for the month its transactions actually fall in. The specific risk worth flagging: statements are frequently uploaded late (last month's card statement, imported today). If budget attribution is ever driven by *when the row was imported* rather than *the transaction's own date*, every late upload will misattribute spending to the wrong month's budget. This needs to be a deliberate rule — attribute by transaction date, always — decided before budgets and imports are wired together, not discovered after a user's March budget looks wrong because of a statement imported in April.

---

## 10 · Category workflow

Category suggestion today is a single registry lookup with no learning tier — every correction the user makes is thrown away rather than improving the next suggestion. That's a real gap but not an urgent one; it degrades gracefully into "more manual review," not incorrect data.

The workflow gap worth fixing before it's built on top of: category shouldn't be a fixed field on every row regardless of Action. A transfer, an EMI installment, or an investment movement don't have a meaningful spend category the way a normal expense does — today the field is presented uniformly, which either forces a meaningless choice or silently ignores it. Category's relevance should be conditional on flow type, not universal.

---

## 11 · Commit workflow

> **This is the sharpest edge in the whole review**
> The commit engine currently ignores `action` and `actionDetail` entirely. Every staged row becomes a plain expense or income based only on debit/credit direction, regardless of what the reviewer selected. A user who carefully marks fifteen rows as EMI, shared expense, transfer, and loan will get fifteen plain transactions on commit, with no error and no warning. This is not a "not yet built" gap in the ordinary sense — it's a workspace that will present choices it cannot yet honor.

Two workflow consequences follow, independent of when the engineering work happens:

- **Fail loud, not silent.** Until each Action is genuinely wired to its own commit path, rows using an unimplemented Action should block commit with a clear reason, not silently downgrade to a generic transaction. Silent downgrade is the one failure mode a financial ledger can never afford.
- **Partial-failure recovery needs a real design.** A rich Action model means one commit batch can touch several collections at once — a transaction, an EMI record, expense participants, a transfer's paired leg. A failure partway through a batch of sixty rows can leave cross-collection state inconsistent (an EMI created with no linked transaction, a shared expense with orphaned participant ledger entries) in a way a single-collection write never could. This needs an explicit rollback or repair story, not just "retry the rows that don't have a committed-id yet."

---

## 12 · Validation workflow

The validation panel's planned checklist (unknown merchants, duplicates, low confidence, missing categories/accounts/people, split errors) is a good baseline. Two additions belong on it given everything above:

- **No Action selected.** A row with a null Action should be a hard block on commit, not an implicit default — see §13 for why the default policy still matters even so.
- **Action/detail consistency.** A row claiming `existing_emi` with no `emiId` in its detail, or `owner: shared` disagreeing with the chosen Action (§4), should surface as a validation error, not pass through silently.

---

## 13 · Import workflow & one-click

One-click import for high-confidence statements is a strong design goal, but it has an unstated dependency worth making explicit: `action` starts `null` on every staged row, and confidence scoring today only covers extraction quality (date, amount, merchant) — not whether the row's business classification is settled. If one-click import is meant to work at all, there has to be an explicit default-action policy: plain debit → expense, plain credit → income, *and* a rule for when a detected signal should override that default before import rather than after — a row with `recurringDetected` or `transferDetected` true shouldn't quietly import as a plain expense just because no human looked at it. Otherwise "one click" and "fifteen possible actions" are in direct tension, and the feature will quietly resolve that tension in favor of the least informative outcome every time.

---

## 14 · Full lifecycle review

Upload → Extraction → Review → Approval → Import → Dashboard → Reports → Analytics → Budgets → Future Statements.

### Upload → AI Extraction → Human Review → Approval → Import

This half of the pipeline is well specified: non-destructive staging, confidence-gated review, an explicit approve-then-import boundary. The gaps here are the ones already covered above (§2–§13) — they're about *what* gets reviewed and committed, not the shape of the pipeline itself.

### Finance Dashboard → Reports → Analytics

Once an EMI or loan repayment is committed through its own path (once that path exists), Reports and cash-flow analysis need to treat it correctly on two axes at once: it's a real cash outflow for cash-flow purposes, but it should *not* count as discretionary spending in a spending-pattern report, and it should reduce a liability for net-worth purposes. This is a cross-engine consistency requirement, not something Transaction Studio can guarantee alone — worth confirming explicitly with whoever owns Reports/Net Worth before the richer Action set starts landing in production data, rather than after users start asking why their EMI payments show up as "Shopping."

### Budgets

Covered in §9 — attribute by transaction date, not import date.

### Future Statements

Nothing today makes review of month two easier than review of month one for the same account. Real competitors' core value proposition is exactly the opposite — a merchant classified once should stay classified. Recommend a per-merchant, per-account decision memory: the next time "Amazon" or "Landlord — Rent" appears, the Action, owner, and category chosen last time should be the pre-filled suggestion, with confidence scored the same way any other suggestion is. This is inexpensive to add now and expensive to bolt on later, once months of unlinked review history already exist with nothing connecting them to each other.

---

## 15 · What's already right

Worth stating plainly so nothing here reads as "start over" — it isn't.

- **Non-destructive staging.** Nothing touches live financial data until explicit approval — exactly the right boundary for a ledger.
- **EMI payment breakdown.** Principal/interest/GST/fee decomposition per payment is more rigorous than most consumer apps attempt.
- **Confidence engine design.** Per-field thresholds tuned by risk (amount stricter than category) is the right instinct, well specified.
- **Split vs. shared, kept separate.** Splitting one line into several categories and splitting one cost across people were deliberately kept as distinct mechanisms rather than conflated — that discipline should extend to the Action model itself (§3).
- **Merchant intelligence.** Deterministic, explainable normalization that refuses to guess rather than silently mislabeling an unknown merchant.
- **Document Type Registry.** A genuinely extensible plugin model for new statement types — the right foundation for investment statements and salary slips when those get built.

---

## 16 · Priority punch list

Ranked by how expensive each gets to fix the longer it waits — not by how hard it is to build.

1. **Split the Action enum into flow type + ownership before more UI is built on top of it**
   Every combinability gap in §2 (shared EMI, business cash withdrawal, split-and-shared purchase) traces back to this one decision.
   *Why now: staged data is ephemeral and cheap to change; once Review Workspace screens and commit logic are built against the flat enum, the redesign touches everything downstream instead of one schema.*

2. **Wire the commit engine to actually branch on Action — or block unimplemented ones outright**
   Right now every Action silently degrades to a plain transaction. That's a data-integrity trap the moment the Review Workspace ships.
   *Why now: every day this ships as-is is a day of real user data committed incorrectly and unrecoverable without a manual audit.*

3. **Add transfer-leg pairing across accounts, separate from duplicate detection**
   Without it, every user who imports both sides of an internal transfer double-counts it in cash flow and net worth.
   *Why now: this corrupts historical numbers retroactively and silently — the kind of bug users find by noticing their net worth is wrong, not by an error message.*

4. **Support institutional (non-person) loans and EMIs, and disbursement vs. repayment direction**
   The current Loan model assumes a person on the other end of every loan.
   *Why now: once real loan records exist against the current shape, migrating them to support institutional lenders means touching live user data, not a schema still in design.*

5. **Add a transaction status field — posted, pending, reversed**
   The canonical transaction model has no status concept at all today.
   *Why now: retrofitting a status field after transactions exist without one means backfilling an unknown value for every historical record, forever.*

6. **Decide the default-action-per-direction policy**
   One-click import for high-confidence statements can't work without an explicit rule for what an unreviewed row becomes.
   *Why now: this is a five-minute product decision now and a source of silently wrong imports later if left implicit.*

7. **Attribute budget periods by transaction date, never import date**
   Late statement uploads are common; the wrong attribution rule quietly misallocates spending to the wrong month.
   *Why now: cheap to fix before Budgets and Transaction Studio are wired together, expensive to reconcile after months of budgets have been computed on the wrong rule.*

8. **Add per-merchant decision memory for recurring review**
   Nothing today makes reviewing month two faster than reviewing month one.
   *Why now: cheap to add alongside the review workspace being built now; expensive to bolt onto months of disconnected review history later — and it's the core promise of "review effortless after the first pass."*

---

*Transaction Studio — Workflow Completeness Review · Architecture recommendations only, no implementation*
