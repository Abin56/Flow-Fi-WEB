# Loan & EMI — manual acceptance checklist

## 1. Safe setup (test data only)

> **Normal `npm run dev` is PRODUCTION.** `.env.local` points to the live project `financeapp-585eb`, and no emulator is connected. `localhost` alone means nothing. The deployed site (flowfi.web.app) is production too.

1. In PowerShell, in the project folder: `node tests/e2e-qa/run.mjs --manual` (needs Java and Chrome). It runs a copy of the app **without any `.env` file**, with local Auth, Firestore and Storage emulators and the project `demo-flowfi-qa`.
2. Wait for **MANUAL TEST MODE**, then open `http://localhost:3210/dev/qa`.
3. **Stop unless the page shows "Emulator verified"** with every environment check ticked. A "blocked" page, or an address that isn't `localhost:3210`, means do not test.
4. Sign in as the QA user, reset the test fixtures, and add the shared EMI / card EMI fixtures as needed. Create anything else by hand.
5. Cloud Functions are not started, so features that need them won't work here.
6. Stop with Ctrl+C. Test data is discarded. The app is a snapshot: restart after any code change.

Everything below is a **test-mode action** on emulator data. **None of it should be repeated on your live account as a "test"** — there each save is a real record.

## 2. Test data to prepare

- One bank account, one second bank account, one credit card.
- Two people (A, B). A shared EMI with interest: you + A + B. A shared Loan.
- Note down before each step: bank balance, card outstanding, A's and B's balances.

## 3. Checks

"Unchanged" means the figure must be exactly what you noted.

| # | Do | Must move | Must NOT move | ✓ |
|---|---|---|---|---|
| 1 | **Pay Now** the scheduled amount from the bank | Bank −amount once; installment paid; one transaction | A and B balances; card. No confirmation or closure warning appears | |
| 1b | Pay Now on a card EMI, charged to card / paid from bank | Card mode: the card charge shown in the preview (may be interest & fees only), bank unchanged. Bank mode: bank debit shown in the preview, plus any card-balance payment it names | Anything the preview doesn't name | |
| 1c | Change amount → a part payment | Bank −part; the rest stays due | No confirmation or warning | |
| 2 | **Full amount:** type the whole scheduled total (don't save yet) | Pay stays disabled until you tick the confirmation; on an interest loan the closure warning shows; changing the amount unticks it | Closing the sheet saves nothing | |
| 2b | On an interest Loan, type an amount whose extra clears all principal, "Lower the loan balance" | Same confirmation, worded as paying off the balance | | |
| 3 | **Receive** from A on the Pay Now table | Chosen account +amount once; A owes that much less; saved at once even if you close without paying | Lender installment; B | |
| 4 | **Past Payment** (already paid before FlowFi) | Installment marked paid. A Loan keeps one record excluded from totals | Every bank and card balance; spending totals. People change only for people you mark as received ("add to my account" is the only choice that moves a balance, where offered) | |
| 5 | **Pay Several** from the bank | Bank −total, one transaction per installment | People balances (unless you answer for them). No repeat on retry | |
| 6 | **Person pays lender** (A pays A's part) | Installment paid by that amount; A's share reduced | Bank and card balances; Dashboard and Month Cycle spending | |
| 6b | Then try **Mark as unpaid** on it | Blocked, telling you to revert A's receipt first | Everything | |
| 7 | **Postpone** A's share | Only when it is expected (People: due now vs postponed) | All balances; lender due date; amount owed. A second postpone is refused until that cycle | |
| 8 | **Advance:** A gives money in advance | Account +amount once; shown as advance held | Installment shares until applied | |
| 8b | Apply the advance to a share | Share reduced; advance reduced | All account balances; no new transaction | |
| 9 | **Undo** an ordinary latest payment | Bank / card restored once; installment due again | People's own receipts | |
| 9b | **Combined undo** (Activity, or delete a receipt recorded with a payment): do it for a direct payment and for "paid from bank + received into bank" | Both sides reverse together; balances return exactly to the noted figures; a second attempt says already undone | No half-undone state | |
| 10 | **People Ledger:** switch off "repays me" after A repaid (share receipt, then a general payment only that share covers) | Refused with the reason | Link, balances, receipts | |
| 10b | Delete a person with records; delete a brand-new empty person | First refused with reasons; second deleted | The first person's history | |
| 11 | **Accounts:** open each account's breakdown | Each movement above appears once; balance equals opening + movements | No entry for past or direct payments that changes a balance | |
| 12 | **Transactions** | One row per real movement; excluded records don't count in totals | No duplicates after retries or double clicks | |
| 13 | **My Money** | Paid installments leave what's due once; your own spend counted once | Money people paid the lender directly isn't your spending | |
| 14 | **Month Cycle** | Each commitment once, in the right cycle, with its paid state | Postponing a person's share doesn't move the lender due | |

Also try a double click on every save button: one record only.

### Credit card EMI

Prepare two card EMIs: **A** with its original purchase recorded on the card and linked, **B** with no linked purchase. The `qa-seed-card-emi-a` and `qa-seed-card-emi` fixtures on `/dev/qa` are a starting point.

| # | Do | Must move | Must NOT move | ✓ |
|---|---|---|---|---|
| C1 | Open Pay Now on either | Screen says "Card EMI" / "card issuer", never "to lender"; a note says this doesn't pay the card bill | | |
| C2 | **A**, Charge to card | Installment paid; only interest and fees (if any) billed to the card, once | Bank; the principal is not billed again | |
| C3 | **B**, Charge to card | Installment billed to the card once; the locked principal is released | Bank | |
| C4 | Pay the card bill from the bank in **Credit Cards** | Bank −amount once; card outstanding down | No new expense; EMI schedule unchanged | |
| C5 | A card EMI "Pay from a bank account" (only for a separate issuer payment) | Exactly what the preview names, once. On **A** the principal moves bank → card as a card payment | Don't also record the same money as a card bill payment | |
| C6 | **A**, someone else paid the issuer | No such option; the screen explains why (also in Pay Several) | Everything | |
| C7 | **B**, a person paid the issuer | Installment paid; person's share reduced; locked principal released | Bank; card balance | |
| C8 | **A**, Receive from a person | Your chosen account +amount; their share reduced | Card | |
| C9 | A Loan financed on the card with its purchase linked | A warning says paying from the bank doesn't lower the card balance; no "paid the issuer" option | | |


## 4. Not covered by this setup

- Pay Several with every unpaid installment ticked has its own review step, not the new confirmation.
- Some older screens (recorded-payment details, schedule views, People postpone) may still say "lender" for a card EMI.
- The deployed site, old browser tabs and Firestore rules are not exercised.
