# Statement Intelligence Workspace — Product Vision
### Permanent requirement — must guide every architecture, backend, frontend, and UX decision related to document import

**Status:** Living product vision document, first written 2026-08-03. This is **not** part of Architecture v1.0 (Locked) — it does not edit that document — but every future design/ADR touching document import must be checked against it. See §8 for exactly how the two relate.

---

## 1. What this feature is

The Credit Card Statement PDF feature is not a PDF importer and not a transaction list. It is a **Statement Intelligence Workspace**: a complete review and management environment where a user organizes, validates, edits, categorizes, splits, assigns people to, and approves transactions before they become part of their permanent financial records. Nothing is simplified for the web version relative to what FlowFi's mobile app already supports.

## 2. User journey

1. Upload Credit Card Statement PDF
2. Detect Bank & Card
3. Extract Statement Details
4. Extract Transactions
5. Build Statement Workspace
6. User Reviews & Manages Transactions
7. Import Approved Transactions
8. Dashboard Updates Automatically

**The Review Workspace (step 6) is the heart of this feature** — not a formality between extraction and import.

## 3. Statement Summary (auto-extracted)

Bank Name · Card Name · Last 4 Digits · Statement Number · Statement Date · Billing Period · Due Date · Credit Limit · Available Credit · Outstanding Amount · Minimum Due · Reward Points · Total Transactions · Parsing Confidence.

## 4. Transaction Workspace — spreadsheet-grade, not a list

Columns: `☐ Select` · Date · Merchant · Description · Amount · Debit/Credit · Suggested Category · FlowFi Account · Expense Type · Person · Split Status · Tags · Confidence · Status · Actions.

Required interaction features: search, sort, filters, multi-select, inline editing, keyboard shortcuts, bulk actions, sticky header, virtual scrolling, responsive layout.

**Design references:** Excel, Notion databases, Airtable, Linear, Apple's productivity apps, professional banking software. The experience must feel like a financial operations workspace, not a file upload page.

## 5. Full transaction capability parity — no simplified subset

Every imported transaction must support everything a manually created FlowFi transaction supports: Expense · Income · Transfer · Credit Card Payment · Loan · Borrow · Lend · EMI · Subscription · Recurring Payment · Business Expense · Personal Expense · Shared Expense · Split Expense · People Expense · Investment · Ignore Transaction.

This workspace **must use the same business logic as the mobile application** — not a reimplementation, not a reduced parallel version.

## 6. Split transactions

Example: Amazon ₹5000 → Shopping ₹2500 / Office ₹2000 / Gift ₹500. Each split behaves exactly like a manually created transaction in FlowFi — same model, same downstream engine treatment, no special-cased "imported split" behavior.

## 7. People management

Every transaction can be assigned to Me · Family · Friends · Employees · Custom People, with Equal Split · Custom Split · Percentage Split · Loan Assignment · Expense Recovery.

## 8. Merchant intelligence

Normalize merchants (`AMZN` / `Amazon Marketplace` / `Amazon India` → `Amazon`), suggest category, learn from user corrections, remember forever. (Already designed at the architecture level — Architecture v1.0 §11.2, backlog Milestone 5/13 — this vision confirms and doesn't change that design; see §9 below.)

## 9. Validation panel (pre-import)

Before import, surface: unknown merchants, duplicate transactions, low-confidence rows, missing categories, missing accounts, missing people, split errors, warnings.

## 10. Import discipline

Only approved transactions are committed. Nothing touches the database until the user confirms.

```
PDF → Extract → Review → User Edit → Validate → Approve → Import → Update Dashboard
```

## 11. Post-import — everything reuses existing FlowFi business logic

Accounts · Credit Cards · Outstanding Balance · Transactions · Budgets · Cash Flow · Net Worth · Reports · Calendar · AI Insights.

---

## 12. Relationship to Architecture v1.0 (Locked) and the backlog — read this before designing anything downstream

This vision **does not contradict** Architecture v1.0's principles — "One brain, many surfaces" (§1), Flutter as canonical behavioral source, non-destructive staging-before-commit (§19.2), the Confidence Engine (§7) — it **raises the bar** on two things the locked architecture described only loosely, and it surfaces one real, concrete schema gap worth fixing deliberately rather than discovering mid-build later:

1. **Review Workspace UI fidelity.** Architecture §10's "Review Screen — Interaction Model" describes the review UX in general terms (row actions, split/merge, filters-as-view-only). This vision is the authoritative, higher-fidelity spec for that same screen (backlog Milestone 8) — spreadsheet-grade, not a simple table. When Milestone 8 is designed, this document is the source of truth for what "Review Workspace" means, not a re-reading of Architecture §10 alone.

2. **Full Transaction capability reuse.** This is the more consequential one. `lib/models/transaction.ts` (the ported Flutter model, Milestone 1 parity-matrix Part 1) already has `transferId`, `linkedPersonId`, `owesPersonToggle`, `excludeFromCalculations` — i.e., people/transfer capability already exists in the canonical Transaction shape. But `lib/models/document-import.ts`'s `StagedRecord` (the staging shape a statement import currently produces, built in M1-T1) does **not** yet carry equivalents of those fields, nor a `transactionType` (expense/income/transfer/EMI/loan/subscription/...) or `expenseType` (business/personal/shared) field. **This is a real, concrete gap this vision surfaces**, not a new invention — `StagedRecord` was scoped, correctly, to what Milestone 1 needed at the time (category, tags, notes, split/merge audit trail), and this vision is what defines what it must grow into before Milestone 8 can honor §5–§7 above.

   **This is not being fixed right now.** Extending `StagedRecord`'s schema is real, scoped work that belongs to whichever task actually builds the Review Workspace / Import Engine's full field set — pulling it in now, disconnected from that task's tests, would be exactly the kind of premature, untested schema change this project's discipline exists to avoid. It is recorded here, explicitly, so it is a planned extension when that task starts, not a surprise discovered mid-build.

3. **What does NOT change right now:** the parser pipeline design currently awaiting approval (`docs/parser-pipeline-design.md`, Milestones 3–4 — metadata + transaction extraction with confidence scoring) is upstream of and unaffected by this vision. It produces `ParsedTransaction`/`StatementMetadata` with confidence per field; the Review Workspace (Milestone 8) is what will eventually consume that output and add category suggestions (Milestone 6), merchant normalization (Milestone 5), and now — per this vision — person/split/transaction-type assignment. The extraction pipeline doesn't need to know about people or splits at all; that's correctly a later stage's concern, and this vision doesn't ask the parser to produce them.

## 13. Open questions for you, not assumed

- Should this vision be reflected as a formal addition to Architecture v1.0, or does it stand permanently as this companion document (my working assumption, since the architecture is locked and this reads as a product-requirements refinement rather than a system-architecture change)?
- Given §12's schema gap: do you want a dedicated backlog task added now (even if not started yet) to track "extend `StagedRecord` with transaction-type/person/expense-type fields" ahead of Milestone 8, so it's on the record before that milestone starts — or is noting it here sufficient for now?
- Does `docs/parser-pipeline-design.md` (awaiting your approval, specifically §7's staging-write scope question) still stand as proposed, now that this vision is captured? Nothing in it appears to conflict with what's above, but confirming rather than assuming.
