# Shared debt ownership: financial integrity audit (Web)

Status: audit only. No engine behaviour changed. The only product change is Debt Planner wording (§4, §11, §12).

Tests:
- `tests/integration/shared-loan-ownership-lifecycle.test.ts` runs the real repositories against the Firestore emulator.
- `lib/engines/debt-ownership-audit.test.ts` covers the pure engines.

## Expected accounting treatment

These rules were written down before the tests.

| Event | Account cash | Lender liability (Net Worth) | Person obligation (People) | Income |
|---|---|---|---|---|
| Borrow ₹30,000 with shares ⅓ each, deposited | +30,000 | +30,000 | none yet | none (principal disbursement) |
| Installment #1 (₹3,000) falls due | — | — | A and B each owe ₹1,000 | — |
| A reimburses ₹1,000 | +1,000 | — | A: ₹0 left | none (People cash leg) |
| I pay the lender ₹3,000 | −3,000 | −principal portion | unchanged | — (repayment) |
| I prepay an extra ₹6,000 | −6,000 | −6,000 | unchanged | — |
| Revert any of the above | exact inverse | exact inverse | exact inverse | — |

Ownership shares say whose liability it is economically. They never change:
- the cash received
- the liability the lender holds me to
- which installment is paid

## Findings

### F1. Net Worth counts a settled loan-share reimbursement as a debt to that person — FIXED (2026-10-02)

**Fix:** `personBalanceBreakdown` applies settlements carrying `obligationRef: emi-inst:/loan-inst:` to the EMI receivable, never to the direct side. Net Worth's People part is `peopleNetWorthPosition` = Σ (directBalance + emiReceivable), with gross components. A due share is now a receivable, and its reimbursement is an asset swap. Consequence: Net Worth rises by a share when it falls due, and is unchanged when it is reimbursed. Tests: `lib/engines/emi-share-settlement-components.test.ts`, plus the §2 and §20 emulator tests.

Original finding:

A person's installment share lives on the Loan as `PersonPosition.emiReceivable`. Net Worth excludes it, because Net Worth adds only `Σ directBalance`. The reimbursement, however, is a `receivedBack` ledger entry, and it lowers `directBalance`.

After A settles their ₹1,000 share:
- People correctly shows A at net ₹0.
- Net Worth and `peoplePayable` count it as "I owe A ₹1,000".

Net Worth stays numerically unchanged, because the +₹1,000 cash is offset by the phantom −₹1,000 people balance. The labels are still wrong, and the issue spreads to two places in the current uncommitted work:
- The Dashboard "Debt" now adds `peoplePayable`.
- `personBalanceBreakdown` would show A as "to give ₹1,000 / to receive ₹1,000".

A pinned test in the lifecycle suite covers this.

Possible fix (needs a decision): feed `directBalance + emiReceivable` into the People part of Net Worth and into `peoplePayable`. That is a Net Worth contract change, so it was not made here.

### F2. Card attribution cap ignores loan-share reimbursements — FIXED (2026-10-02, same root cause as F1)

`use-debt-planner-data` caps each person's card attribution at `max(directBalance, 0)`.

Example: AMMA owes ₹8,000 of card purchases and has reimbursed a ₹1,000 loan share. She is attributed only ₹7,000, although People shows that she owes ₹8,000. This has the same root cause as F1 and has a pinned test.

### No other inconsistency found

These all reconcile on live documents:
- account cash
- liability
- lender-vs-person independence
- partial payments
- advances
- reversals
- legacy documents
- paise splits

## §3 Card ownership netting: gross vs net

Current rule: the card share attributed to a person equals `min(unrecovered card share, max(directBalance, 0))`.

Example: AMMA owes ₹8,000 of card purchases and I separately owe her ₹5,000. The card shows AMMA ₹3,000 and me ₹5,000.

Two different questions are being answered:

- **A. Gross debt ownership.** Who caused the card liability? AMMA, ₹8,000.
- **B. People net balance.** After unrelated obligations, who owes whom? AMMA owes me ₹3,000.

The Debt Planner nets the ₹5,000 I owe AMMA away. There is no separate "Person" position, because `personDirectPayable` uses the same netting as People. If the card attributed the full ₹8,000 to AMMA, "My debt" would be ₹0, but I really owe ₹5,000. So given the netted People position, the current rule gives the correct *net* "My debt" (₹5,000).

The cost is that the planner position no longer holds the gross facts:
- AMMA caused ₹8,000 of card debt.
- I owe AMMA ₹5,000.

Recommendation (not implemented): keep both layers explicitly on the position, for example:
- `grossByPerson`: ₹8,000
- `offsetByPayable`: −₹5,000
- the net attribution: ₹3,000

Also show "Card debt caused by AMMA ₹8,000 · offset by ₹5,000 you owe her" in the UI. That gives gross information without double counting, because the offset line is the ₹5,000 that is otherwise invisible in the planner.

## §5 Prepayment policy (current, unchanged)

Ownership is the outstanding principal split by the original weights. So any lender payment reduces every party's ownership proportionally, whoever paid it.

Example: ₹30,000 remaining, shared ⅓ each. I prepay ₹6,000, so ₹24,000 remains.

| Party | Before | After |
|---|---|---|
| Me | ₹10,000 | ₹8,000 |
| A | ₹10,000 | ₹8,000 |
| B | ₹10,000 | ₹8,000 |

The emulator test checks this with a real prepayment (₹3,000 EMI + ₹6,000 extra, so ₹21,000 remains and each party owns ₹7,000). A and B each gain ₹2,000 of my money.

Their People obligations are unaffected: each still owes their share of each installment that falls due. Re-amortized installments split by the same weights.

Alternative model, for a product decision (not implemented): credit voluntary prepayment only against the payer's ownership. That would give Me ₹4,000, A ₹10,000 and B ₹10,000. It needs:
- per-party principal tracking, because weights would change after each prepayment
- a rule for how future installments split once the weights diverge
- Flutter parity

## §11 Debt Planner definitions

- **Total liability** is what lenders and card issuers are still legally owed. It is the sum of `DebtPosition.outstanding`.
- **My debt** is the part of that liability that the ownership engine allocates to me (`ownership.mine`).
- **Others' share** is the part of the lender liability allocated to other people (`ownership.othersTotal`). It is ownership, not a receivable, and it shrinks only when the lender is paid.
- **People receivable** is what a person still owes me (`PersonPosition.owesMe`, `snapshot.receivables.people`). It shrinks when they pay me.

These differ whenever someone has reimbursed me and I have not yet paid the lender. Example: A pays ₹1,000. Others' share stays ₹20,000, and People receivable is B's ₹1,000 only.

The UI wording now says this:
- "Lender debt allocated to others — not what they owe you now"
- "Others' allocated share"
- "Allocated to others (ownership, not receivable)"

## §12 Card cycle estimate

`requiredByOwnership` / `splitPaymentByOwnership` split the issuer-required payment by the card's overall mine/others ratio, paise-exact. The required amount is never reduced, and mine + others always equals required. This is tested at 100% mine, 100% others and mixed.

Card splits are now labelled as estimated in the Debt Planner.
