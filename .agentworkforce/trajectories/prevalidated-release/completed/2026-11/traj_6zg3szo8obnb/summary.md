# Trajectory: Prepare immutable release candidate before npm publication

> **Status:** ✅ Completed
> **Task:** 640
> **Confidence:** 93%
> **Started:** November 8, 2026 at 09:36 AM
> **Completed:** November 8, 2026 at 09:38 AM

---

## Summary

Implemented version-only root-lock projection and prepublication exact release-candidate validation. Restore the same annotated tag/commit from a small bundle bound to an independent build-output SHA256. No extra release build/test/pack/registry work; integration fixtures run only in PR CI. Product revision 4822281 from 9eabbf1; unchanged validator and peer-restoration helper. New handoff suite 8/8 passes; final positive CLI/output/env check 1/1 passes after conversion; projector 3/3; workflow 19/20 with unchanged Windows CRLF retry failure. Prior broader release suite stopped on Windows path/newline/stall failures; no full-suite pass. Independent reviewers review_final_contract and review_relay_fix report PASS; follow-up reviews will be recorded on PR640. No release, remote tag, publication, deployment, or production access.

**Approach:** Preserve the immutable source dependency graph rather than repairing npm normalization. Move exact candidate validation before npm side effects and transport the same prevalidated identity afterward. Existing main reconciliation remains unchanged.

---

## Key Decisions

### Project workspace versions onto the source lock and validate the exact commit before publishing
- **Chose:** Project workspace versions onto the source lock and validate the exact commit before publishing
- **Reasoning:** Avoid dependency re-resolution and flag repair. Move the existing exact validator and full-history checkout to build, transport the prevalidated metadata commit with a bundle bound to an independent job-output digest, and restore it after publication. Keep integration fixtures in PR CI to avoid adding release build/test/pack work.

---

## Chapters

### 1. Work
*Agent: default*

- Project workspace versions onto the source lock and validate the exact commit before publishing: Project workspace versions onto the source lock and validate the exact commit before publishing

---

## Artifacts

**Commits:** 4822281
**Files changed:** 10
