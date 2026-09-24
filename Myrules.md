MASTER RULE — WEB & APP FEATURE PARITY

The Web and Mobile App must have the same features, functionality, and business behavior.

For every task I give you:

1. FIRST check the Web implementation and identify what needs to be added/fixed.

2. THEN check the corresponding Mobile App implementation using the provided app file/path:
   [APP FILE/PATH]

3. Compare both implementations:
   - Features
   - UI behavior
   - Validation
   - Business rules
   - Calculations
   - Edge cases
   - Data handling
   - Error/loading/empty states

4. If the same issue exists in BOTH Web and App:
   → Fix it in BOTH.

5. If the issue exists ONLY in Web:
   → Fix ONLY Web.
   → Do not modify the App unnecessarily.

6. If the App already works correctly:
   → Treat the App behavior as the reference for the Web implementation.

IMPORTANT — DO NOT BREAK EXISTING CODE

- This project is currently in TESTING.
- Do NOT rewrite or restructure existing working code.
- Do NOT change backend logic, database structure, APIs, providers, repositories, or core business logic unless the task specifically requires it.
- Do NOT introduce unnecessary architecture changes.
- Make the smallest logical change required to solve the requested issue.
- Preserve all existing functionality.
- Do not "improve" unrelated code while working on the task.
- Do not change working App code just to make it match a different Web implementation.

WEB PRIORITY

The Web currently needs more work than the App.

Therefore:
- Use the existing App behavior as a reference where appropriate.
- Bring Web functionality up to the same feature level as the App.
- Do not remove or downgrade features that already work on the Web.
- If Web and App intentionally have platform-specific UI, keep the UI platform-appropriate while maintaining the same functionality and business behavior.

BEFORE MAKING CHANGES

First inspect the relevant Web and App code and clearly determine:
- What currently works
- What is missing
- Whether the issue exists in the App
- What files actually need modification

Then make only the necessary changes.

AFTER CHANGES

Verify:
- Web feature works
- App feature still works
- No existing functionality was broken
- Backend/data behavior is unchanged unless required
- No duplicate logic was unnecessarily introduced
- Relevant tests/build checks pass

Keep changes focused on the requested task.