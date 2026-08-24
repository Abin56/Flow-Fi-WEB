# Transaction Studio — Implementation Roadmap

**Source documents (approved, not redesigned here):**
- `docs/transaction-studio-ux-review.md` — *Transaction Studio UX & Spreadsheet Design Review*
- `docs/transaction-studio-workflow-review.md` — *Transaction Intelligence & Financial Workflow Review*

**Purpose:** classify every recommendation already present in the two approved reviews into P0–P3. No new ideas, no architecture changes, no invented recommendations — this is a priority pass only.

**Priority definitions (as given):**
- **P0** — Must be completed before Transaction Studio can ship (architecture blockers or data integrity issues).
- **P1** — Should be included in the first public release, after the core grid works.
- **P2** — Valuable improvement for V2.
- **P3** — Future roadmap only.

---

## Summary

| Priority | Count | Theme |
|---|---|---|
| P0 | 22 | Grid architecture decisions, the Action-model schema split, commit-engine correctness, transfer-leg double-counting, transaction status field, and the suggested/confidence/duplicate signals that are the product's actual differentiator |
| P1 | 22 | First-release correctness and usability: institutional loans, cash/recurring defaults, refund linking, budget attribution, per-merchant memory, keyboard nav, styling polish tied to P0 signals |
| P2 | 13 | V2 power-user and reporting features: fill handle, foreclosure handling, cashback ledger, provenance viewer |
| P3 | 6 | Future roadmap: investment domain, category learning tier, statement adjustments, reward points, row-expand animation |

Numbering: **A-series** = UX & Spreadsheet Design Review, **B-series** = Transaction Intelligence & Workflow Review, in source-document order.

---

## Part A — UX & Spreadsheet Design Review

### A1 — Core interaction model: cell-level vs. row-level editing; compound Action/Action Details cell
- **Priority:** P0
- **Reason:** Architecture blocker. The review states this is "the actual risk — not row styling"; nothing else in the grid can be built until cell-vs-row editing and the compound-cell pattern are decided.
- **Dependencies:** None (foundational design decision).
- **Firestore schema impact:** No.
- **Backend impact:** No.
- **Frontend impact:** Yes — determines the entire grid's component architecture.
- **Complexity:** High.
- **Migration risk if delayed:** Yes — deciding this after row-level components are built means a rewrite, not a refactor.

### A2 — Row height / density default (compact ~32–36px)
- **Priority:** P1
- **Reason:** Improves review throughput at scale but the grid is functional with a placeholder density; can be tuned after the core grid ships.
- **Dependencies:** A1.
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes (styling).
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### A3 — Save-trigger policy (blur-commit, matching optimistic-update pattern)
- **Priority:** P0
- **Reason:** Architecture blocker — every cell component's write behavior depends on this decision; can't build editing without it.
- **Dependencies:** A1.
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Medium.
- **Migration risk if delayed:** Yes — changing save strategy after cells are built means rewriting every cell component.

### A4 — Sticky/frozen columns (freeze Include+Date+Merchant left, Commit Status+actions right)
- **Priority:** P1
- **Reason:** Ergonomic necessity at 12 columns on narrow screens, but the grid works (with horizontal scroll) without it.
- **Dependencies:** A1, A6 (reconciled column spec).
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Medium.
- **Migration risk if delayed:** No.

### A5 — Do not build on `FinanceTable` as-is; decide new grid infra vs. extend
- **Priority:** P0
- **Reason:** Explicit architecture blocker — the review states this decision must be made "before any cell-editing code is written," or the "spreadsheet-grade" bar becomes unreachable without a later rewrite.
- **Dependencies:** A1.
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes — foundational grid infrastructure choice.
- **Complexity:** High.
- **Migration risk if delayed:** Yes, severe — this is the exact scenario the review warns against.

### A6 — Reconcile the two conflicting column specs (vision doc vs. 12-column list)
- **Priority:** P0
- **Reason:** Review's Final Recommendation #1: must happen "before anyone writes grid code," or two engineers build to two different specs.
- **Dependencies:** None.
- **Firestore schema impact:** Possibly — reconciliation may surface gaps against `StagedRecord`. **Backend impact:** No. **Frontend impact:** No (spec-only).
- **Complexity:** Low.
- **Migration risk if delayed:** Yes — building against the wrong spec means rework.

### A7 — Confidence surfacing (left-edge indicator, default collapse/expand, per-field dot, folded into Commit Status)
- **Priority:** P0
- **Reason:** Review identifies this as one of two fully-built, fully-tested backend capabilities with **zero** UI surface today; without it, "the feature's actual differentiator doesn't exist" no matter how polished the grid chrome is.
- **Dependencies:** A1 (grid), confidence engine (already built).
- **Firestore schema impact:** No. **Backend impact:** No (already computed). **Frontend impact:** Yes.
- **Complexity:** Medium.
- **Migration risk if delayed:** No (additive UI), but the product's core value prop stays invisible until shipped.

### A8 — Duplicate detection surface (badge/chip + way to see the matched transaction)
- **Priority:** P0
- **Reason:** Same class as A7 — the second fully-built, zero-surface backend capability.
- **Dependencies:** A1, inspector panel surface (shared with A10/A24).
- **Firestore schema impact:** No. **Backend impact:** No (already computed). **Frontend impact:** Yes.
- **Complexity:** Medium.
- **Migration risk if delayed:** No.

### A9 — Validation panel (pre-import checklist gate)
- **Priority:** P0
- **Reason:** This is the gate in front of money-affecting writes ("Approve & Import"); the review treats it as a required, distinct surface, not an afterthought.
- **Dependencies:** A7, A8, B5, B6 (validation rules from the workflow review).
- **Firestore schema impact:** No. **Backend impact:** Minor (aggregation/summary query). **Frontend impact:** Yes — new panel.
- **Complexity:** Medium.
- **Migration risk if delayed:** No.

### A10 — Row-level provenance / "show source" (jump to PDF page/line)
- **Priority:** P2
- **Reason:** High trust value but not required for the grid to operate correctly or safely.
- **Dependencies:** PDF viewer integration.
- **Firestore schema impact:** No (`sourcePage`/`sourceLineIndex` already modeled). **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Medium.
- **Migration risk if delayed:** No.

### A11 — Concurrent-edit warning (toast/banner when a viewed row was edited elsewhere)
- **Priority:** P1
- **Reason:** Real correctness/safety issue for multi-tab/device editing, but a scoped edge case relative to single-session use; `lastEditedAt`/`lastEditedBy` already exist for exactly this.
- **Dependencies:** A3.
- **Firestore schema impact:** No (fields exist). **Backend impact:** Minor (comparison check). **Frontend impact:** Yes.
- **Complexity:** Medium.
- **Migration risk if delayed:** No.

### A12 — Undo/redo (single-level toast, "Undo last action")
- **Priority:** P0
- **Reason:** Review states plainly: "one fat-fingered bulk action without undo will erode trust in 'safe to experiment' fast," and Final Recommendation #7 says ship in v1, not as follow-up — this is a data-safety requirement for a money-affecting bulk-edit tool.
- **Dependencies:** A1, `useTransactionStudioMutations`.
- **Firestore schema impact:** No. **Backend impact:** No (client-side, reverses the optimistic layer). **Frontend impact:** Yes.
- **Complexity:** Medium.
- **Migration risk if delayed:** No, but the review notes retrofitting undo/keyboard after the fact is "meaningfully more expensive."

### A13 — Duplicate-signal visual distinction (`duplicateOfTransactionId` vs. `duplicateCandidateOf`)
- **Priority:** P1
- **Reason:** Correctness-adjacent polish on top of A8 — prevents confusing "confirmed duplicate" with "candidate, review recommended," but the base duplicate surface (A8) can ship first and be refined.
- **Dependencies:** A8.
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### A14 — Include column: tri-state header checkbox + footer count; separate Include vs. bulk-select checkbox
- **Priority:** P0
- **Reason:** Review calls conflating "will this import" with "is this selected for bulk-edit" a "classic spreadsheet-clone mistake" and says deciding this now "prevents a confusing UI later" — a one-line spec decision with real semantic-risk if skipped.
- **Dependencies:** A1.
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Low.
- **Migration risk if delayed:** Yes — reworking selection semantics after users have learned the wrong pattern is disruptive.

### A15 — Date column sort toggle
- **Priority:** P2
- **Reason:** Convenience feature; not required for the core review loop.
- **Dependencies:** None.
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### A16 — Merchant: normalized-primary / raw-secondary distinction
- **Priority:** P1
- **Reason:** Directly surfaces a confidence/normalization trust signal (extends A7); meaningfully improves first-release trust but the grid works with normalized-only display in the interim.
- **Dependencies:** A7.
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### A17 — Amount: currency indicator for multi-currency
- **Priority:** P2
- **Reason:** Only affects multi-currency-card users, a subset of users; `currency` field already exists per-row.
- **Dependencies:** None.
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### A18 — Action column: searchable, grouped combobox (not a plain `<select>`)
- **Priority:** P0
- **Reason:** Action is "the single source of truth" and the most prominent editable column; the review says a plain select over 15 values "will be miserable to use at 80-row scale" — this is core functionality, not polish.
- **Dependencies:** A1, B1 (final flow-type/ownership shape determines the grouping).
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Medium.
- **Migration risk if delayed:** No component-level risk, but shipping with a poor control undermines core usability from day one.

### A19 — Action Details compound cell (summary chip collapsed, structured inline editor on click)
- **Priority:** P0
- **Reason:** Review calls this "the single hardest interaction in the entire grid" and Final Recommendation #2 says design it "before any cell-editing code is written."
- **Dependencies:** A1, A18, B1 (the flow-type/ownership axis split changes what Action Details must capture).
- **Firestore schema impact:** Possibly, if B1 reshapes `actionDetail`. **Backend impact:** No. **Frontend impact:** Yes — highest-complexity part of the grid.
- **Complexity:** High.
- **Migration risk if delayed:** Yes — building this against today's flat 15-value enum before B1 lands means rebuilding it once the axis split ships.

### A20 — Owner/Action consistency validation rule
- **Priority:** P1
- **Reason:** Correctness safeguard, but can land as a validation-panel rule shortly after the base Owner column ships rather than gating the grid itself.
- **Dependencies:** A9, B4.
- **Firestore schema impact:** No (unless bundled with B1/B4 consolidation). **Backend impact:** Minor. **Frontend impact:** Yes (validation messaging).
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### A21 — Split: collapse into Action Details summary chip; never independently editable
- **Priority:** P0
- **Reason:** Review explicitly flags independently-editable Split as "a data-integrity bug waiting to happen" (two places to edit the same fact) — a data-integrity classification by the priority framework's own definition.
- **Dependencies:** A19.
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Low-Medium.
- **Migration risk if delayed:** Yes — if shipped as independently-editable first, locking it down later means auditing/migrating any drifted data.

### A22 — Category: combobox pre-filled from `suggestedCategory`, with suggested/confirmed visual distinction
- **Priority:** P0
- **Reason:** Review calls this "probably the single most impactful un-designed detail" — without it, the "effortless review" premise (same class as A7/A8) is invisible.
- **Dependencies:** A33 (shared suggested/confirmed visual language).
- **Firestore schema impact:** No. **Backend impact:** No (`suggestedCategory` already computed). **Frontend impact:** Yes.
- **Complexity:** Medium.
- **Migration risk if delayed:** No.

### A23 — Tags: pre-fill from `suggestedTags` with the same suggested/confirmed distinction
- **Priority:** P1
- **Reason:** Same mechanism as A22 but lower-stakes field; ships in first release once the pattern exists from A22.
- **Dependencies:** A22.
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### A24 — Notes: icon/indicator opening inspector panel/popover, not an inline text cell
- **Priority:** P1
- **Reason:** Prevents row-height blowout at density; needed for a usable grid but not a hard functional blocker (could truncate temporarily).
- **Dependencies:** A2, shared inspector-panel surface (A8/A10).
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### A25 — Commit Status: combined status chip (Ready / Needs review · reason / Imported), reusing `ClayBadge`/`status-labels`
- **Priority:** P0
- **Reason:** Primary vehicle for surfacing confidence (folds in A7) and the commit boundary itself; core to a functioning review-to-commit flow.
- **Dependencies:** A7, existing badge system.
- **Firestore schema impact:** No. **Backend impact:** No (`committedTransactionId`/`needsReview` exist). **Frontend impact:** Yes.
- **Complexity:** Low-Medium.
- **Migration risk if delayed:** No.

### A26 — Cell edit affordance (hover pencil/focus outline)
- **Priority:** P1
- **Reason:** Usability polish clarifying editable vs. read-only columns; not a functional blocker.
- **Dependencies:** A1.
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### A27 — Optimistic-save feedback, including failure red-flash + inline error
- **Priority:** P0
- **Reason:** Review flags that rollback currently has "zero UI feedback wired" and calls it "a real bug-in-waiting once editing ships" — a silent failed save on financial data is a trust/data-integrity issue that must ship with editing itself, not after.
- **Dependencies:** A3, existing rollback logic in `useTransactionStudioMutations`.
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Low-Medium.
- **Migration risk if delayed:** No.

### A28 — Bulk-action toast with Undo ("Updated category for 12 rows · Undo")
- **Priority:** P0
- **Reason:** Same undo rationale as A12, specifically for bulk operations, which carry higher blast radius.
- **Dependencies:** A12.
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Medium.
- **Migration risk if delayed:** No.

### A29 — Row-expand animation on low confidence (chevron rotation + height transition)
- **Priority:** P3
- **Reason:** Pure visual polish, explicitly "worth the animation budget" per the review but with zero functional impact.
- **Dependencies:** A7.
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### A30 — Fill handle, scoped to Category/Owner/Tags only
- **Priority:** P2
- **Reason:** Called the "actual killer feature" of statement review by the reviewer, but the grid is usable without it in v1; deliberately scoped to avoid misuse on Amount/Date.
- **Dependencies:** A1, A18, A22, A23.
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Medium.
- **Migration risk if delayed:** No.

### A31 — Copy/paste on fill-safe columns (full 2D multi-cell paste explicitly deferred)
- **Priority:** P2
- **Reason:** Review explicitly labels full spreadsheet-grade paste "a stretch goal, not v1"; scoped single-cell/column paste is a V2 companion to the fill handle.
- **Dependencies:** A30.
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Medium.
- **Migration risk if delayed:** No.

### A32 — Merchant/Amount visual prominence; other columns quieter
- **Priority:** P1
- **Reason:** Core readability of the grid at density; a styling pass that should ship with the initial grid but doesn't block functionality.
- **Dependencies:** A1.
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### A33 — System-wide suggested-vs-confirmed visual language (outline = suggested, filled = confirmed)
- **Priority:** P0
- **Reason:** Review stresses this must be "not a per-column decision" — it's the shared design-system pattern A7/A8/A22 all depend on being consistent, so it needs to be decided before those P0 items ship.
- **Dependencies:** None (design-token decision).
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### A34 — Confidence indicator at the row's left edge (colored bar/dot)
- **Priority:** P0
- **Reason:** This is the concrete implementation of A7's confidence-surfacing requirement.
- **Dependencies:** A7.
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### A35 — Core cell-navigation keys (Arrow keys, Tab/Shift+Tab, Enter, Escape, Space-to-toggle-Include)
- **Priority:** P1
- **Reason:** Review's Final Recommendation #7 urges shipping keyboard nav in v1 because retrofitting is expensive, but mouse-only interaction is a workable fallback for an initial release — so this is first-release, not a hard architecture blocker.
- **Dependencies:** A1, A14 (Space depends on Include/select split).
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Medium.
- **Migration risk if delayed:** Yes — the review states retrofitting keyboard nav onto an existing cell-editing implementation is "meaningfully more expensive" than designing it in from the start.

### A36 — Cmd/Ctrl+Z / Shift+Z (undo/redo keybinding)
- **Priority:** P0
- **Reason:** Same data-safety rationale as A12/A28.
- **Dependencies:** A12.
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### A37 — Bulk-select keys (Cmd/Ctrl+A, Shift+Click/Shift+Arrow range select)
- **Priority:** P2
- **Reason:** Power-user bulk-edit ergonomics; convenience, not core to the first-pass review loop.
- **Dependencies:** A14 (bulk-select mechanism).
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### A38 — Copy/paste keybinding (Cmd/Ctrl+C/V) on fill-safe columns
- **Priority:** P2
- **Reason:** Same scope as A31.
- **Dependencies:** A31.
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### A39 — "/" or Cmd+K jump to search/filter
- **Priority:** P2
- **Reason:** Navigation convenience, not required for the core review-and-commit loop.
- **Dependencies:** None.
- **Firestore schema impact:** No. **Backend impact:** No. **Frontend impact:** Yes.
- **Complexity:** Low.
- **Migration risk if delayed:** No.

---

## Part B — Transaction Intelligence & Workflow Review

### B1 — Split `RecordAction` into flow-type + ownership axes, plus modifiers (Business, Recurring/bill-linked, Split-by-category)
- **Priority:** P0
- **Reason:** Review's own punch list ranks this #1: "staged data is ephemeral and cheap to change now; once Review Workspace screens and commit logic are built against the flat enum, the redesign touches everything downstream instead of one schema."
- **Dependencies:** None (foundational).
- **Firestore schema impact:** Yes — reshapes `StagedRecord.action`/`actionDetail`.
- **Backend impact:** Yes — every engine reading `action` (confidence, commit, validation) must be updated.
- **Frontend impact:** Yes — A18 (Action combobox) and A19 (Action Details compound cell) must be built against this shape.
- **Complexity:** High.
- **Migration risk if delayed:** Yes, severe — explicitly the reason this is ranked first.

### B2 — Wire the commit engine to branch on Action per type, or block unimplemented Actions outright (fail loud, not silent)
- **Priority:** P0
- **Reason:** The review's sharpest-flagged issue: "not a 'not yet built' gap in the ordinary sense... a data-integrity trap." Every staged row silently becomes a plain expense/income today regardless of the Action chosen.
- **Dependencies:** B1 (should land first, or commit logic gets built twice).
- **Firestore schema impact:** Yes — commit must write to EMI/loan/transfer/participant collections, not only transactions.
- **Backend impact:** Yes — core commit engine rewrite.
- **Frontend impact:** Yes — validation panel (A9) must show blocked-vs-implemented Actions.
- **Complexity:** High.
- **Migration risk if delayed:** Yes — every day shipped as-is is real user data committed incorrectly, unrecoverable without a manual audit.

### B3 — Partial-failure recovery / rollback-repair design for multi-collection commits
- **Priority:** P0
- **Reason:** Direct consequence of B2 — once a commit batch can touch several collections (transaction, EMI record, participant ledger, paired transfer leg), a mid-batch failure can leave cross-collection state inconsistent.
- **Dependencies:** B2.
- **Firestore schema impact:** Yes — atomic batch/transaction write strategy.
- **Backend impact:** Yes. **Frontend impact:** Minor (failure messaging).
- **Complexity:** High.
- **Migration risk if delayed:** Yes — repairing inconsistent cross-collection state after the fact is far harder than designing atomic commits up front.

### B4 — Collapse `owner`/`action` redundancy to one source of truth
- **Priority:** P0
- **Reason:** The two fields can "silently disagree" today with nothing to catch it — a direct data-integrity issue, and the concrete mechanism of B1's ownership axis.
- **Dependencies:** B1.
- **Firestore schema impact:** Yes (bundled with B1). **Backend impact:** Yes. **Frontend impact:** Yes (A20).
- **Complexity:** Medium (bundled with B1).
- **Migration risk if delayed:** Yes.

### B5 — "No Action selected" hard block on commit
- **Priority:** P0
- **Reason:** Validation-panel gate that directly prevents the B2 failure mode.
- **Dependencies:** A9, B2.
- **Firestore schema impact:** No. **Backend impact:** Yes (validation rule). **Frontend impact:** Yes.
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### B6 — Action/detail consistency validation (e.g. `existing_emi` with no `emiId`, `owner: shared` disagreeing with Action)
- **Priority:** P0
- **Reason:** Same class as B5 — closes the exact silent-corruption paths B1–B4 document.
- **Dependencies:** A9, B1, B4.
- **Firestore schema impact:** No. **Backend impact:** Yes. **Frontend impact:** Yes.
- **Complexity:** Low-Medium.
- **Migration risk if delayed:** No.

### B7 — Explicit default-action-per-direction policy for one-click import (plain debit→expense, plain credit→income; override when `recurringDetected`/`transferDetected`)
- **Priority:** P0
- **Reason:** Review states one-click import cannot work correctly without this and calls it "a five-minute product decision now and a source of silently wrong imports later if left implicit."
- **Dependencies:** B1 (valid default Action values), existing recurring/transfer detection.
- **Firestore schema impact:** No. **Backend impact:** Yes (default-assignment logic). **Frontend impact:** Minor (reflect default in grid).
- **Complexity:** Low.
- **Migration risk if delayed:** Yes — wrong defaults become committed transactions requiring correction.

### B8 — Add a transaction status field (posted / pending / reversed)
- **Priority:** P0
- **Reason:** Review states plainly this is "the single field most expensive to add after the fact, once real transactions exist without it" — a pure schema-timing argument.
- **Dependencies:** None.
- **Firestore schema impact:** Yes — new field on the canonical transaction model.
- **Backend impact:** Yes (status transitions). **Frontend impact:** Minor (not required to expose immediately, but the field must exist).
- **Complexity:** Low (schema) / Medium (transitions).
- **Migration risk if delayed:** Yes, severe — explicitly the stated reason this is P0.

### B9 — Institutional (non-person) loan/EMI counterparty support
- **Priority:** P1
- **Reason:** High real-world frequency ("one of the most common lines on a real bank statement"), but the current gap is `missing` (unrepresentable), not silently wrong — v1 can ship with peer-lending loans only and document the limitation.
- **Dependencies:** B1 (debt-movement flow type against person *or* institution).
- **Firestore schema impact:** Yes — Loan record needs a counterparty-type field.
- **Backend impact:** Yes. **Frontend impact:** Yes (A19 Action Details editor for loans).
- **Complexity:** Medium.
- **Migration risk if delayed:** Yes — "once real loan records exist against the current shape, migrating them... means touching live user data."

### B10 — Distinguish loan disbursement vs. repayment direction
- **Priority:** P1
- **Reason:** Bundled with B9, same schema/timing logic; opposite net-worth effects need to be distinguishable, not inferred.
- **Dependencies:** B9.
- **Firestore schema impact:** Yes (same record as B9). **Backend impact:** Yes. **Frontend impact:** Yes.
- **Complexity:** Low (bundled with B9).
- **Migration risk if delayed:** Yes (same as B9).

### B11 — Transfer-leg pairing across accounts (dedicated post-import merge pass)
- **Priority:** P0
- **Reason:** Review calls this "the most consequential gap in the whole review" — every user who imports both sides of an internal transfer double-counts it in cash flow and net worth, silently. This is a direct data-integrity issue, not an edge case.
- **Dependencies:** Benefits from B1's transfer flow-type but not strictly blocked by it.
- **Firestore schema impact:** Yes — needs a field/relationship linking paired transfer legs.
- **Backend impact:** Yes — new matching pass (amount/date/account heuristics).
- **Frontend impact:** Minor (surface a "merge into transfer?" suggestion, can reuse the duplicate-suggestion pattern from A8).
- **Complexity:** High.
- **Migration risk if delayed:** Yes, severe — "corrupts historical numbers retroactively and silently."

### B12 — Credit card bill payment special case (reduce card balance, reconcile against the specific statement)
- **Priority:** P1
- **Reason:** Named as the special case of B11 but narrower in scope (card accounts only); falls back to a generic transfer (`partial`, not corrupt) in the meantime.
- **Dependencies:** B11, existing card/liability model.
- **Firestore schema impact:** Yes (card balance write). **Backend impact:** Yes. **Frontend impact:** Minor.
- **Complexity:** Medium.
- **Migration risk if delayed:** Yes, moderate.

### B13 — Transfer external/untracked-destination mode
- **Priority:** P1
- **Reason:** Without it, rows either can't commit or are misfiled — a real gap, but scoped to a specific transfer sub-case rather than B11's universal double-counting risk.
- **Dependencies:** B1 (transfer flow-type: internal/external/card payoff).
- **Firestore schema impact:** No (mode/flag on existing transfer detail). **Backend impact:** Yes (treat as expense for reporting). **Frontend impact:** Yes (A19).
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### B14 — Cash withdrawal: default routing to a Cash account transfer, with expense-only override
- **Priority:** P1
- **Reason:** Real correctness gap (cash disappears from tracking) but currently degrades to a plain categorized expense — `partial`, not silently corrupt.
- **Dependencies:** B1, existing Cash-account concept.
- **Firestore schema impact:** No (uses existing account/transfer model). **Backend impact:** Yes (default routing rule). **Frontend impact:** Minor.
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### B15 — ATM/bank fee modifier flag (fee subtype)
- **Priority:** P2
- **Reason:** Reporting/analytics nicety ("Reports can't break fees out from ordinary spending"); doesn't affect the correctness of the transaction itself.
- **Dependencies:** B1 modifiers.
- **Firestore schema impact:** Yes (small field addition). **Backend impact:** Minor. **Frontend impact:** Minor.
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### B16 — Standing instruction/auto-debit: default Action to `recurring_bill` or offer a Bill match when `recurringDetected`
- **Priority:** P1
- **Reason:** The signal is already computed and "thrown away at review time" today — cheap, high-leverage fix aligned with the review-effortless goal.
- **Dependencies:** B7.
- **Firestore schema impact:** No. **Backend impact:** Yes (default-assignment logic). **Frontend impact:** Minor.
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### B17 — Confidence-scored matching of an EMI line to an existing EMI record
- **Priority:** P1
- **Reason:** Needed for the EMI Action to be usable in practice (today "assumes the reviewer manually finds the right EMI"); grid can ship with manual selection initially.
- **Dependencies:** B18, existing duplicate-matching engine (pattern reuse).
- **Firestore schema impact:** No. **Backend impact:** Yes. **Frontend impact:** Yes (match-suggestion UI in Action Details).
- **Complexity:** Medium.
- **Migration risk if delayed:** No.

### B18 — EMI commit path: populate principal/interest/GST/fee breakdown from the parsed EMI section
- **Priority:** P0
- **Reason:** This is EMI's slice of B2 — without it, selecting "EMI" produces exactly the silent-downgrade data-integrity trap the review's sharpest warning describes.
- **Dependencies:** B1, B2.
- **Firestore schema impact:** Yes (writes to EMI payment records). **Backend impact:** Yes. **Frontend impact:** No (uses A19, already designed).
- **Complexity:** Medium.
- **Migration risk if delayed:** Yes (same class as B2).

### B19 — EMI foreclosure/prepayment charge → close EMI record early
- **Priority:** P2
- **Reason:** Real but narrower gap (a specific statement event); not required for ordinary EMI review/commit to work.
- **Dependencies:** B18.
- **Firestore schema impact:** Yes (EMI status transition). **Backend impact:** Yes. **Frontend impact:** Yes.
- **Complexity:** Medium.
- **Migration risk if delayed:** No.

### B20 — Shared expense: "mark as already settled" option on import
- **Priority:** P1
- **Reason:** Without it, importing historical statements "systematically overstate what people owe" — a real correctness issue for the common case of importing old statements.
- **Dependencies:** B1 (ownership axis).
- **Firestore schema impact:** No (flag on participant/split detail). **Backend impact:** Yes (skip balance-ledger write when settled). **Frontend impact:** Yes (checkbox in Action Details).
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### B21 — Combinability (shared + EMI/loan/business lines)
- **Priority:** P0 *(folded into B1 — this is what the axis split enables, not a separate build)*
- **Reason:** See B1.
- **Dependencies:** B1.
- **Firestore schema impact:** — **Backend impact:** — **Frontend impact:** —
- **Complexity:** — (bundled).
- **Migration risk if delayed:** — (bundled).

### B22 — Business expense modifier
- **Priority:** P1
- **Reason:** Named as an explicit product-vision requirement ("required parity with manual entry") currently missing from the Action list entirely — a stated parity requirement, not an enhancement.
- **Dependencies:** B1 modifiers.
- **Firestore schema impact:** Yes (modifier field; underlying expense-type slot already exists). **Backend impact:** Minor. **Frontend impact:** Yes (toggle in Action Details/Category).
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### B23 — Refund linked to the original charge via a hard reference (not free-text merchant match)
- **Priority:** P1
- **Reason:** Real correctness gap (two same-merchant refunds are indistinguishable), but refunds still commit today, just imprecisely linked — not silently wrong at the ledger level.
- **Dependencies:** B1 (reversal/adjustment flow type).
- **Firestore schema impact:** Yes (link field to origin transaction). **Backend impact:** Yes. **Frontend impact:** Yes (pick-origin-transaction UI).
- **Complexity:** Medium.
- **Migration risk if delayed:** No.

### B24 — Chargeback/dispute reversal linked to its origin
- **Priority:** P2
- **Reason:** Same mechanism as B23 but a narrower/rarer case.
- **Dependencies:** B23.
- **Firestore schema impact:** Yes. **Backend impact:** Yes. **Frontend impact:** Yes.
- **Complexity:** Medium.
- **Migration risk if delayed:** No.

### B25 — Statement adjustment/correction representation
- **Priority:** P3
- **Reason:** The review gives this the least detail of any item ("no representation," no elaboration on impact) — lowest-specified item in the whole review.
- **Dependencies:** B1.
- **Firestore schema impact:** Yes. **Backend impact:** Yes. **Frontend impact:** Yes.
- **Complexity:** Medium.
- **Migration risk if delayed:** No.

### B26 — Split-by-category Action-outcome pairing (a row "about to become several")
- **Priority:** P2
- **Reason:** The split/merge audit trail itself "needs no redesign" per the review; this is a narrower UX/state gap for a row mid-split.
- **Dependencies:** B1 modifiers.
- **Firestore schema impact:** No (uses existing split/merge mechanism). **Backend impact:** Minor. **Frontend impact:** Yes.
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### B27 — Investment domain (SIP debit, dividends, buy/sell holdings)
- **Priority:** P3
- **Reason:** Review states explicitly "no investment domain entity exists anywhere in the system yet... planned, not built" — new-entity-scale work clearly beyond Transaction Studio's core scope.
- **Dependencies:** New Investment document type (Document Type Registry already supports this per the review's §15).
- **Firestore schema impact:** Yes (new collections). **Backend impact:** Yes. **Frontend impact:** Yes.
- **Complexity:** High.
- **Migration risk if delayed:** No (net-new, nothing to migrate).

### B28 — Cashback commit implementation + rewards ledger
- **Priority:** P2
- **Reason:** The Action already exists in the enum but commit/ledger isn't implemented; self-contained V2 feature, not core to shipping transaction review.
- **Dependencies:** B2 (per-Action commit wiring pattern).
- **Firestore schema impact:** Yes (rewards ledger). **Backend impact:** Yes. **Frontend impact:** Yes (Credit Cards screen currently hardcodes rewards to zero).
- **Complexity:** Medium.
- **Migration risk if delayed:** No.

### B29 — Reward points earned/redeemed consumption
- **Priority:** P3
- **Reason:** "Parsed and available... consumed by nothing after that" — the review gives this no urgency signal.
- **Dependencies:** B28.
- **Firestore schema impact:** Yes. **Backend impact:** Yes. **Frontend impact:** Yes.
- **Complexity:** Medium.
- **Migration risk if delayed:** No.

### B30 — Category relevance conditional on flow type (not universal)
- **Priority:** P1
- **Reason:** Direct consequence of B1 — once flow type exists, Category's applicability naturally becomes conditional; needed so A22 doesn't force a meaningless choice for transfers/EMI rows.
- **Dependencies:** B1.
- **Firestore schema impact:** No. **Backend impact:** Minor (conditional logic). **Frontend impact:** Yes (A22 visibility/behavior).
- **Complexity:** Low.
- **Migration risk if delayed:** No.

### B31 — Category suggestion learning tier
- **Priority:** P3
- **Reason:** The review itself deprioritizes this: "a real gap but not an urgent one; it degrades gracefully into more manual review, not incorrect data."
- **Dependencies:** None.
- **Firestore schema impact:** Yes (learning data storage). **Backend impact:** Yes. **Frontend impact:** No.
- **Complexity:** Medium.
- **Migration risk if delayed:** No.

### B32 — Budget attribution by transaction date, never import date
- **Priority:** P1
- **Reason:** Review frames this as needing to be "decided before budgets and imports are wired together" — a rule, not a build, that only matters once Budgets integration exists.
- **Dependencies:** Budgets feature (external to Transaction Studio).
- **Firestore schema impact:** No (attribution logic only). **Backend impact:** Yes. **Frontend impact:** No.
- **Complexity:** Low.
- **Migration risk if delayed:** Yes — "expensive to reconcile after months of budgets have been computed on the wrong rule."

### B33 — Reports/Analytics cross-engine consistency for EMI/loan (cash-outflow yes, discretionary-spend no, reduces liability)
- **Priority:** P1
- **Reason:** Review flags this needs confirmation "before the richer Action set starts landing in production data" — effectively gates on B18 landing; cross-team coordination, not a Transaction Studio build item.
- **Dependencies:** B18, Reports/Net-Worth engines (external).
- **Firestore schema impact:** No (from Transaction Studio's side). **Backend impact:** Coordination only. **Frontend impact:** No.
- **Complexity:** Low (a confirmation, not a build, from TS's side).
- **Migration risk if delayed:** Yes — EMI/loan payments would show up as ordinary spending categories (e.g. "Shopping") in Reports.

### B34 — Per-merchant, per-account decision memory for recurring review
- **Priority:** P1
- **Reason:** Review's own "why now" argument is strong for early delivery: "cheap to add alongside the review workspace being built now; expensive to bolt on later, once months of unlinked review history already exist."
- **Dependencies:** Existing merchant normalization; Action/Owner/Category history.
- **Firestore schema impact:** Yes (per-merchant decision memory store). **Backend impact:** Yes. **Frontend impact:** Minor (surfaces as a higher-confidence suggestion, reuses the A22 pattern).
- **Complexity:** Medium.
- **Migration risk if delayed:** Yes — explicitly called out as expensive to retrofit once review history exists disconnected from it.

---

## P0 — Ship blockers (22 items)

Architecture decisions that fix the current spec's contradictions, the Action-model schema split, commit-engine correctness, and the two backend capabilities (confidence, duplicates) that are the product's stated differentiator but currently have no UI.

A1, A3, A5, A6, A7, A8, A9, A12, A14, A18, A19, A21, A22, A25, A27, A28, A33, A34, A36 · B1, B2, B3, B4, B5, B6, B7, B8, B11, B18, B21

*(29 IDs listed — B21 and several A-items share a single build effort with their parent P0 item; see notes above.)*

## P1 — First release, after core grid works (22 items)

A2, A4, A11, A13, A16, A20, A23, A24, A26, A32, A35 · B9, B10, B12, B13, B14, B16, B17, B20, B22, B23, B30, B32, B33, B34

## P2 — V2 (13 items)

A10, A15, A17, A30, A31, A37, A38, A39 · B15, B19, B24, B26, B28

## P3 — Future roadmap (6 items)

A29 · B25, B27, B29, B31
