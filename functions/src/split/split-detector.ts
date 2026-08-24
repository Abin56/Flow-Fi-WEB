/**
 * Split Detector — Statement Intelligence Layer, module 5. Feeds
 * `StatementWorkspaceModel.suggestedSplitRules` (a statement-level
 * aggregate, like `suggestedCategories`/`suggestedAccounts` — not a
 * per-transaction field, so this module doesn't reshape
 * `WorkspaceTransaction[]` the way the Category/Account/Tag suggesters do).
 *
 * Honest stub, same discipline as the People Suggestion Engine
 * (docs/parser-pipeline-design.md §7): a `SplitRuleSuggestion` requires a
 * real per-category share ratio (`approxShare`) for a recurring merchant —
 * e.g. "Amazon purchases are usually 60% Shopping / 40% Groceries" — and no
 * such ratio exists anywhere yet. The Merchant Registry records one
 * `expectedCategory` per merchant, not a distribution; inventing a share
 * split with no historical basis would be exactly the kind of fabricated
 * guess this pipeline's "never invent" discipline forbids. Recurrence
 * alone (`basedOnOccurrences`) is real and cheap to compute, but is not by
 * itself evidence that a merchant *should* be split across categories —
 * most recurring merchants (Netflix, Jio, Airtel) are single-category by
 * nature. Returns `[]` deterministically until a real signal exists (e.g.
 * a user's own prior manual splits, once that history is available) —
 * revisit then, not by guessing now.
 */

import type { SplitRuleSuggestion, WorkspaceTransaction } from "../workspace/statement-workspace-model";

export function detectSplitRules(_transactions: WorkspaceTransaction[]): SplitRuleSuggestion[] {
  return [];
}
