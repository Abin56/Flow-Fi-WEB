# FlowFi: Personal Finance Operating System

_Project status as of 8 Oct 2026_

**One line:** A finance workspace that tracks credit cards, loans, EMIs, shared expenses and monthly cash flow as one connected ledger, where every balance comes from real transactions.

## 1. The problem

Most finance apps only log expenses. Real money in India is messier:

- Credit card billing cycles don't line up with calendar months.
- EMIs are paid by card, loans get prepaid and recalculated, and you lend to or borrow from friends.
- A credit limit is often shared between a card and a facility.
- When you split a bill, part of it is your spend and part is a receivable.

Spreadsheets and typical apps don't keep these in sync.

## 2. The solution

FlowFi treats everything as a connected double-sided ledger. One transaction updates the card bill, the person's balance, the EMI schedule and the month-cycle totals together, so no stored balance can drift away from the real history.

## 3. Key features

- **Dashboard and month cycles:** salary-cycle views with inclusive date ranges (17 Aug → 16 Sep), your own spend vs. shared spend, and net worth.
- **Credit cards:** statement cycles, bill generation, pay-bill flows, utilization, and shared credit limits.
- **Loans and EMI:** amortization, prepayment recalculation policies, advance payments, and a debt payoff planner.
- **People ledger:** split expenses, settle up, and export a PDF statement for each person.
- **Transaction Studio:** a power-user editor with an inspector, a command palette (cmdk) and virtualized tables.
- **Statement intelligence:** imports bank and card statements and turns them into candidate transactions to review.

## 4. Engineering highlights

- **Stack:** Next.js 16, React 19, TypeScript, Firebase (Firestore, Storage, Cloud Functions), TanStack Query/Table/Virtual, Zustand, Zod, Tailwind, shadcn/Radix, Framer Motion, Recharts, pdf-lib.
- **Domain engine layer:** about 60 pure, tested financial engines (debt ownership, reconciliation, interest, cycle mapping) kept separate from the UI.
- **Testing:** 400+ test files with Vitest, including Firestore security-rules tests and integration tests on the Firebase emulator, plus regression tests for financial accuracy.
- **Architecture:** feature-sliced folders, a repository pattern over Firestore, and engines that detect and repair balance drift.
- **Security:** user-scoped Firestore and Storage rules, verified by tests.
- **Cross-platform:** Web plus a Flutter mobile app on one shared Firestore contract.

```
UI → hooks → engines → repositories → Firestore
```

## 5. Challenges solved

- Matching card billing cycles with personal salary cycles without counting anything twice.
- Recalculating an EMI after a prepayment while keeping the payment history intact.
- Splitting a card-paid expense between "my spend" and "a friend owes me" with the ledger staying balanced.

## 6. Visuals to include

- A hero screenshot of the dashboard in light and dark mode.
- A short GIF of a split expense updating the person ledger, the card and the dashboard live.
- One architecture diagram: UI → hooks → engines → repositories → Firestore.
- A sample PDF statement.

## 7. Numbers

**21 modules · 60+ finance engines · 400+ tests · rules-tested security**

## Presentation notes

- Use demo or mock data in screenshots, never real finances.
- If the repo is private, a live demo link plus a 1–2 minute walkthrough video works well.
- Frame the project as a system where correctness matters, not a CRUD app.
