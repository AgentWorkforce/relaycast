# Trajectory: Restore dev flags during release lock refresh

> **Status:** ✅ Completed
> **Task:** release-run-42461576035
> **Confidence:** 93%
> **Started:** November 8, 2026 at 07:41 AM
> **Completed:** November 8, 2026 at 07:46 AM

---

## Summary

Restores source peer/dev flag values and absence while preserving refreshed versions and source JSON order. Read-only --check guard runs after build/tests before packing. Regression fails before fix; focused tests2/2 and adjacent release tests21/21 pass. Actual failed12.9.0 artifact13610451059 replay restores26flags and unchanged exact version-only validator accepts it. Syntax and whitespace checks pass. Fullrelease suite attempted but stopped after unrelated Windows path/newline failures and Gitfixture stall; no fullsuite pass claimed. Two independent code reviews PASS. No release rerun, publish, tag or production action.

**Approach:** Standard approach

---

## Key Decisions

### Restore source peer and dev flags without weakening exact tag validation
- **Chose:** Restore source peer and dev flags without weakening exact tag validation
- **Reasoning:** The12.9.0 artifact differs only by26 nested esbuild dev flags. Add a read-only metadata check after build/tests and before packing so this drift fails before publishing.

---

## Chapters

### 1. Work
*Agent: default*

- Restore source peer and dev flags without weakening exact tag validation: Restore source peer and dev flags without weakening exact tag validation

---

## Artifacts

**Commits:** de4f388
**Files changed:** 4


Validation commands (run from the repository root):
- node --test --test-name-pattern='restores source metadata|restores peer and dev' scripts/release-workflow-contract.test.mjs — 2 passed.
- node --test scripts/npm-dist-tag.test.mjs scripts/refresh-docker-lock.test.mjs — 21 passed.
- node --check scripts/restore-release-lock-metadata.mjs and git diff --check — passed.
- npm run test:release — attempted; Windows path/newline assertions failed and Git fixtures stalled, so the run was stopped. This is not a full-suite pass.

Separate artifact replay: build-output artifact13610451059 from run42461576035 was downloaded without reading CI logs. A disposable fixture applied the fixed restoration to its lockfile, restored26flags, and compared it byte-for-byte with the original validator expectedRootLock transformation for12.9.0. The existing assertLockDiffIsReleaseOnly also accepted it. The committed nested-esbuild regression exercises the same dev-flag loss; no machine-local script is required to run that regression. No release/remote tag was created during replay.
