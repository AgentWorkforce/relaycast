# Trajectory: Align authenticated Relayfile callbacks with segment glob matching

> **Status:** ✅ Completed
> **Confidence:** 94%
> **Started:** November 6, 2026 at 08:22 AM
> **Completed:** November 6, 2026 at 08:29 AM

---

## Summary

Aligned authenticated Relayfile callback path matching with released producer semantics. Baseline route regressions reproduce 18 passed / 2 failed; patched receiver+agreement tests: 41 passed; pinned upstream/core probe: 21/21 agree. Existing HMAC labels, GitHub identity opt-in and ingress controls preserved. No runtime/deployment/provider actions.

**Approach:** Standard approach

---

## Key Decisions

### Mirror released RelayFile matching semantics without changing target secret derivation
- **Chose:** Mirror released RelayFile matching semantics without changing target secret derivation
- **Reasoning:** Embedded and internal segment wildcards already match upstream; keep legacy trailing-prefix behavior, exact canonical matching and existing GitHub semantic opt-in while preserving old target HMAC labels.

---

## Chapters

### 1. Work
*Agent: default*

- Mirror released RelayFile matching semantics without changing target secret derivation: Mirror released RelayFile matching semantics without changing target secret derivation

---

## Artifacts

**Commits:** 604f2dd0
**Files changed:** 8

## Validation evidence

Product commit: `604f2dd03bdba2a62bc41e3ebb8ac8747ab59a8b`, based on `1ecb158404c877c63e31ee9e55f1c2786fab60ab`. The metadata-only completion commit records this stable product range, not itself.

- `npm exec --workspace=@relaycast/engine -- vitest run src/routes/__tests__/relayfileInbound.test.ts src/routes/__tests__/relayfilePathGlob.test.ts`: 41 passed (20 real SQLite/API route tests plus 21 matcher agreement cases). Existing GitHub semantic opt-in tests remain in the receiver suite.
- Baseline production route overlaid with the added route tests: 18 passed / 2 failed, both at expected delivery status 201 versus skipped status 200. The production file was restored in a finally block. This is a local regression, not a separate RelayFlow or deployed test.
- TypeScript 5.9.3 `tsc --noEmit -p packages/engine/tsconfig.typecheck.json`: passed. Pinned ESLint 9.39.2 on `packages/engine/src/routes/relayfileInbound.ts` and `relayfilePathGlob.ts`: passed with the repository config. No full-engine build was run.
- A local AST-extraction probe executed the actual four matcher functions from relayfile-cloud `ba8179660deac4cf251754859ccd3d5ac2948b4f` and `normalizePath` from its locked `@relayfile/core` 0.10.34 package against the 21 committed vectors: all agreed. The temporary probe is supplemental evidence, not a shipped dependency or CI check.
- `git diff --check`: passed. Logs: `/tmp/relaycast-globs-{baseline-final,targeted,typecheck,eslint,parity}.log` (local temporary artifacts).

Matching uses the upstream iterative segment-state dynamic program and star retry algorithm, without caller-controlled regular expressions or recursive backtracking. Its bound is polynomial in path/pattern size, not a strict whole-input linear-time claim. Canonicalization is matching-only: target HMAC labels and GitHub identity authorization logic are unchanged.

No provider calls, manual webhook replays, configuration/runtime changes, merge or deployment were performed. Hosted engine revision remains unverified; this PR is separate from deletion support in PR630.

## Review correction: root wildcard compatibility

Root-compatibility product commit: `c6f30bce4e3ed2ddb1a4f92c38d0a74c77925ade`. A faithful upstream port exposed its empty-prefix bug for `/*`, which previously matched root-level paths in Relaycast. The receiver now keeps that prefix empty, preserving existing root-file/root-path matches while rejecting nested files. This is a narrow intentional difference from upstream, not an authorization expansion.

The same two-suite Vitest command above now passes 45 tests (21 route tests and 24 matcher cases). Added regressions failed on the prior port with 42 passed / 3 failed, then passed after the fix. The original 21 shared upstream vectors still agree 21/21; the three root-compatibility cases are separate from that agreement set. TypeScript 5.9.3 and changed-source ESLint 9.39.2 were rerun successfully. Local review logs: `/tmp/relaycast-globs-root-{before,after}.log`.

The trajectory range now ends at this final product commit and records all commits/files in the actual git range, including the intervening evidence commit. The trace retains original product attribution and adds this correction's changed ranges. Subsequent evidence-only updates do not change executable code or tests.

## Review correction: wildcard token handling and documentation

Final product commit: `eda43a17a5f1e62673643d92d5aa3c73d9c3732f`. Pattern `*` remains a wildcard token even if the event path has a literal asterisk at that position. The literal-equality branch now excludes pattern stars. A real Jira callback plus leading/internal literal-star positive cases and an extension-mismatch denial reproduced 46 passed / 3 failed before this correction, then 49 passed afterward (22 route tests + 27 matcher cases). The original 21 shared vectors still agree with pinned upstream source; root and literal-star edge corrections are explicitly outside that shared agreement set.

The README overview now distinguishes GitHub identity opt-in from ordinary path globs, and the package changelog leads with valid Linear/Jira events no longer being dropped. TypeScript 5.9.3 and ESLint 9.39.2 were rerun successfully; the source-agreement probe remains 21/21. Logs: `/tmp/relaycast-globs-star-{before,after}.log`. The attribution range and trace include this final product correction; the subsequent evidence-only commit changes no code or tests.
