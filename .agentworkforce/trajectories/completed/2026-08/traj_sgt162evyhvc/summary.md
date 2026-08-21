# Trajectory: Finish PR 339 review and rebase

> **Status:** ✅ Completed
> **Task:** relaycast#339
> **Confidence:** 95%
> **Started:** August 19, 2026 at 08:33 AM
> **Completed:** August 19, 2026 at 08:37 AM

---

## Summary

Rebased PR #339 onto current main, addressed all remaining valid review findings, documented two invalid findings with executable evidence, corrected trajectory provenance, and passed full build, test, lint, and Rust gates.

**Approach:** Standard approach

---

## Key Decisions

### Redact observer provenance with an explicit public-field allowlist
- **Chose:** Redact observer provenance with an explicit public-field allowlist
- **Reasoning:** GET /workspace accepts observer tokens, so request actor, user, machine, and organization identity must remain workspace-key-only.

### Renumber attribution migration to 0039
- **Chose:** Renumber attribution migration to 0039
- **Reasoning:** Current main added session replay migration 0038 after the prior review repair, so attribution must follow it to preserve production ordering.

### Keep source_basis derivation unchanged and test missing-source rejection
- **Chose:** Keep source_basis derivation unchanged and test missing-source rejection
- **Reasoning:** The public HTTP schema requires provenance.source, making a declared provenance object without source invalid before buildWorkspaceProvenance runs.

### Keep E2E provenance options on the local SDK call
- **Chose:** Keep E2E provenance options on the local SDK call
- **Reasoning:** scripts/e2e.ts imports packages/sdk-typescript/src/index.ts directly; the published @agent-relay/sdk surface cited by the review is not used at this call site.

---

## Chapters

### 1. Work
*Agent: default*

- Redact observer provenance with an explicit public-field allowlist: Redact observer provenance with an explicit public-field allowlist
- Renumber attribution migration to 0039: Renumber attribution migration to 0039
- Keep source_basis derivation unchanged and test missing-source rejection: Keep source_basis derivation unchanged and test missing-source rejection
- Keep E2E provenance options on the local SDK call: Keep E2E provenance options on the local SDK call
- Rebased PR #339 onto origin/main, resolved the new migration collision, redacted observer-visible identity, retained two reviewed call sites after proving their contracts, and passed all local gates.

---

## Verification Evidence

- `mise exec node@22 -- npm test --workspace @relaycast/engine -- workspaceAttribution.test.ts observerToken.test.ts` — 2 files and 16 tests passed.
- `mise exec node@22 -- npx turbo build` — 9/9 tasks passed.
- `mise exec node@22 -- npx turbo test` — 18/18 tasks passed; the engine ran 654/654 tests.
- `mise exec node@22 -- npx turbo lint --output-logs=errors-only` — 13/13 tasks passed.
- Rust SDK `cargo test` with explicit Rust 1.97.1 `RUSTC`/`RUSTDOC` paths — 44 unit, 43 integration, and 5 doc tests passed.

---

## Artifacts

**Commits:** fc41e27, bb5dadc
**Files changed:** 13
