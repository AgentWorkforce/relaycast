# Trajectory: Architecture refactor toward cleaner relaycast internals

> **Status:** ✅ Completed
> **Confidence:** 88%
> **Started:** June 23, 2026 at 12:01 AM
> **Completed:** June 23, 2026 at 05:20 AM

---

## Summary

Refactored engine route response handling into shared helpers, migrated representative route modules, validated with local gates and live HTTP tests, opened ready PR #207, subscribed to feedback, and fixed/replied to review comments about preserving coded JSON errors.

**Approach:** Standard approach

---

## Key Decisions

### Centralized route JSON envelopes and malformed body handling
- **Chose:** Centralized route JSON envelopes and malformed body handling
- **Reasoning:** Route-local catches were duplicating response envelopes and bypassing the global malformed JSON mapper; a small shared helper establishes one pattern and fixes both migrated and unmigrated routes.

### Used local automated review substitute for first refactor slice
- **Chose:** Used local automated review substitute for first refactor slice
- **Reasoning:** External Codex autoreview was user-approved but tenant policy still rejected uploading uncommitted repository contents, so the safe available gate was scoped diff inspection plus diff-check, typecheck, lint, focused/full tests, build, and live HTTP exercise.

### Expanded route response helper only where it preserved semantics
- **Chose:** Expanded route response helper only where it preserved semantics
- **Reasoning:** System prompt, event subscriptions, and receipts had repeated success/not-found/no-content envelopes. Event subscriptions needed route-specific validation messages, so parseJsonBody now accepts a validation-message callback instead of forcing one generic error.

### Accepted PR feedback to narrow malformed JSON classification
- **Chose:** Accepted PR feedback to narrow malformed JSON classification
- **Reasoning:** Reviewers identified that matching any error message containing JSON could rewrite unrelated coded errors. Restricting to SyntaxError preserves parser failures while keeping engine-coded errors intact.

---

## Chapters

### 1. Work
*Agent: default*

- Centralized route JSON envelopes and malformed body handling: Centralized route JSON envelopes and malformed body handling
- First refactor slice implemented and locally verified; autoreview is the only gate not completed because external Codex review requires explicit upload approval.
- Local-only review pass found no issues in the scoped route response refactor, but external autoreview remains unapproved so the commit is still held.
- Blocked on explicit autoreview approval after repeated continuations; code is implemented and locally verified, but commit/PR cannot proceed without either Codex review upload approval or local-only acceptance.
- Used local automated review substitute for first refactor slice: Used local automated review substitute for first refactor slice
- Expanded route response helper only where it preserved semantics: Expanded route response helper only where it preserved semantics
- Accepted PR feedback to narrow malformed JSON classification: Accepted PR feedback to narrow malformed JSON classification

---

## Artifacts

**Commits:** 2a98936, 28f111c, 70b0fa7
**Files changed:** 9
